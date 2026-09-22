use std::{
    fs::{self, File, OpenOptions, Permissions},
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{validate_ssh_destination, ClientError, Launcher, RemoteNode};

/// A client-owned saved SSH connection. Credentials and private keys are not
/// represented by this type and therefore cannot be persisted by the registry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedHost {
    pub id: String,
    pub display_name: String,
    pub ssh_destination: String,
    pub ssh_config: Option<PathBuf>,
    pub remote_neta_dir: PathBuf,
    pub remote_launcher: Option<LauncherConfig>,
    pub last_remote_workspace_path: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LauncherConfig {
    pub executable: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
}

impl SavedHost {
    pub fn validate(&self) -> Result<(), ClientError> {
        if self.id.trim().is_empty() {
            return Err(ClientError::Configuration(
                "saved host id must not be empty".into(),
            ));
        }
        if self.display_name.trim().is_empty() {
            return Err(ClientError::Configuration(
                "saved host display name must not be empty".into(),
            ));
        }
        validate_ssh_destination(&self.ssh_destination).map_err(|_| {
            ClientError::Configuration(format!(
                "saved host {} has an invalid SSH destination",
                self.id
            ))
        })?;
        if self.remote_neta_dir.as_os_str().is_empty() {
            return Err(ClientError::Configuration(format!(
                "saved host {} remote NETA_DIR must not be empty",
                self.id
            )));
        }
        if let Some(launcher) = &self.remote_launcher {
            if launcher.executable.as_os_str().is_empty() {
                return Err(ClientError::Configuration(format!(
                    "saved host {} launcher executable must not be empty",
                    self.id
                )));
            }
        }
        Ok(())
    }

    pub fn remote_node(&self, local_working_directory: PathBuf) -> Result<RemoteNode, ClientError> {
        self.validate()?;
        Ok(RemoteNode {
            ssh_destination: self.ssh_destination.clone(),
            ssh_executable: PathBuf::from("ssh"),
            ssh_config: self.ssh_config.clone(),
            remote_neta_dir: self.remote_neta_dir.clone(),
            remote_launcher: self.remote_launcher.as_ref().map(|launcher| Launcher {
                executable: launcher.executable.clone(),
                args: launcher.args.clone(),
            }),
            local_working_directory,
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostFile {
    #[serde(default)]
    hosts: Vec<SavedHost>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostRegistry {
    path: PathBuf,
    hosts: Vec<SavedHost>,
}

impl HostRegistry {
    pub fn default_path(neta_dir: &Path) -> PathBuf {
        neta_dir.join("client-hosts.json")
    }

    pub fn load(path: impl Into<PathBuf>) -> Result<Self, ClientError> {
        let path = path.into();
        let hosts = match fs::read(&path) {
            Ok(bytes) => {
                serde_json::from_slice::<HostFile>(&bytes)
                    .map_err(|error| {
                        ClientError::Configuration(format!(
                            "invalid saved host file {}: {error}",
                            path.display()
                        ))
                    })?
                    .hosts
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(ClientError::Configuration(format!(
                    "read saved host file {}: {error}",
                    path.display()
                )))
            }
        };
        let registry = Self { path, hosts };
        registry.validate_all()?;
        Ok(registry)
    }

    pub fn hosts(&self) -> &[SavedHost] {
        &self.hosts
    }
    pub fn get(&self, id: &str) -> Option<&SavedHost> {
        self.hosts.iter().find(|host| host.id == id)
    }

    pub fn insert(&mut self, host: SavedHost) -> Result<(), ClientError> {
        host.validate()?;
        if self.get(&host.id).is_some() {
            return Err(ClientError::Configuration(format!(
                "saved host id already exists: {}",
                host.id
            )));
        }
        self.ensure_endpoint_unique(&host, None)?;
        let mut hosts = self.hosts.clone();
        hosts.push(host);
        Self::persist_hosts(&self.path, &hosts)?;
        self.hosts = hosts;
        Ok(())
    }

    pub fn update(&mut self, id: &str, host: SavedHost) -> Result<(), ClientError> {
        host.validate()?;
        if host.id != id {
            return Err(ClientError::Configuration(format!(
                "saved host id is immutable: expected {id}, got {}",
                host.id
            )));
        }
        let index = self
            .hosts
            .iter()
            .position(|existing| existing.id == id)
            .ok_or_else(|| ClientError::Configuration(format!("saved host not found: {id}")))?;
        self.ensure_endpoint_unique(&host, Some(id))?;
        let mut hosts = self.hosts.clone();
        hosts[index] = host;
        Self::persist_hosts(&self.path, &hosts)?;
        self.hosts = hosts;
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> Result<SavedHost, ClientError> {
        let index = self
            .hosts
            .iter()
            .position(|host| host.id == id)
            .ok_or_else(|| ClientError::Configuration(format!("saved host not found: {id}")))?;
        let removed = self.hosts[index].clone();
        let mut hosts = self.hosts.clone();
        hosts.remove(index);
        Self::persist_hosts(&self.path, &hosts)?;
        self.hosts = hosts;
        Ok(removed)
    }

    fn validate_all(&self) -> Result<(), ClientError> {
        for (index, host) in self.hosts.iter().enumerate() {
            host.validate()?;
            if self.hosts[..index].iter().any(|other| other.id == host.id) {
                return Err(ClientError::Configuration(format!(
                    "duplicate saved host id: {}",
                    host.id
                )));
            }
            self.ensure_endpoint_unique(host, Some(&host.id))?;
        }
        Ok(())
    }

    fn ensure_endpoint_unique(
        &self,
        host: &SavedHost,
        except_id: Option<&str>,
    ) -> Result<(), ClientError> {
        if self
            .hosts
            .iter()
            .any(|other| Some(other.id.as_str()) != except_id && endpoint_equal(other, host))
        {
            return Err(ClientError::Configuration(format!(
                "duplicate saved host endpoint: {}",
                host.ssh_destination
            )));
        }
        Ok(())
    }

    fn persist_hosts(path: &Path, hosts: &[SavedHost]) -> Result<(), ClientError> {
        if let Some(parent) = path.parent() {
            let mut missing = Vec::new();
            let mut cursor = parent;
            while !cursor.exists() {
                missing.push(cursor);
                cursor = cursor.parent().unwrap_or(Path::new("."));
            }
            fs::create_dir_all(parent).map_err(|error| {
                ClientError::Configuration(format!("create saved host directory: {error}"))
            })?;
            for directory in missing {
                fs::set_permissions(directory, Permissions::from_mode(0o700)).map_err(|error| {
                    ClientError::Configuration(format!("protect saved host directory: {error}"))
                })?;
            }
        }
        let bytes = serde_json::to_vec_pretty(&HostFile {
            hosts: hosts.to_vec(),
        })
        .map_err(|error| ClientError::Configuration(format!("encode saved hosts: {error}")))?;
        let temp = path.with_extension(format!(
            "json.tmp.{}.{}",
            std::process::id(),
            unique_suffix()
        ));
        let mut file = match OpenOptions::new().create_new(true).write(true).open(&temp) {
            Ok(file) => file,
            Err(error) => {
                return Err(ClientError::Configuration(format!(
                    "write saved host file: {error}"
                )))
            }
        };
        if let Err(error) = file.set_permissions(Permissions::from_mode(0o600)) {
            drop(file);
            let _ = fs::remove_file(&temp);
            return Err(ClientError::Configuration(format!(
                "protect saved host file: {error}"
            )));
        }
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&temp);
            return Err(ClientError::Configuration(format!(
                "flush saved host file: {error}"
            )));
        }
        drop(file);
        if let Err(error) = fs::rename(&temp, path) {
            let _ = fs::remove_file(&temp);
            return Err(ClientError::Configuration(format!(
                "replace saved host file: {error}"
            )));
        }
        let directory = File::open(path.parent().unwrap_or(Path::new("."))).map_err(|error| {
            ClientError::Configuration(format!("open saved host directory: {error}"))
        })?;
        directory.sync_all().map_err(|error| {
            ClientError::Configuration(format!("flush saved host directory: {error}"))
        })
    }
}

fn unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn endpoint_equal(left: &SavedHost, right: &SavedHost) -> bool {
    left.ssh_destination == right.ssh_destination
        && left.ssh_config == right.ssh_config
        && left.remote_neta_dir == right.remote_neta_dir
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "neta-hosts-{label}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn host(id: &str, destination: &str, dir: &str) -> SavedHost {
        SavedHost {
            id: id.into(),
            display_name: id.into(),
            ssh_destination: destination.into(),
            ssh_config: None,
            remote_neta_dir: dir.into(),
            remote_launcher: None,
            last_remote_workspace_path: None,
        }
    }

    #[test]
    fn roundtrip_update_remove_and_two_endpoints() {
        let file = path("roundtrip");
        let mut registry = HostRegistry::load(&file).unwrap();
        registry
            .insert(host("one", "alice@example", "/one"))
            .unwrap();
        registry
            .insert(host("two", "alice@example", "/two"))
            .unwrap();
        let mut changed = host("one", "alice@example", "/one");
        changed.display_name = "First".into();
        registry.update("one", changed).unwrap();
        drop(registry);
        let mut loaded = HostRegistry::load(&file).unwrap();
        assert_eq!(loaded.get("one").unwrap().display_name, "First");
        assert_eq!(loaded.remove("two").unwrap().id, "two");
        assert_eq!(loaded.hosts().len(), 1);
        let _ = fs::remove_file(file);
    }

    #[test]
    fn rejects_duplicate_id_and_endpoint_but_allows_different_config() {
        let file = path("duplicates");
        let mut registry = HostRegistry::load(&file).unwrap();
        registry
            .insert(host("one", "alice@example", "/one"))
            .unwrap();
        assert!(registry
            .insert(host("one", "other@example", "/other"))
            .is_err());
        assert!(registry
            .insert(host("two", "alice@example", "/one"))
            .is_err());
        assert!(registry
            .update("one", host("renamed", "other@example", "/other"))
            .is_err());
        let mut different = host("three", "alice@example", "/one");
        different.ssh_config = Some("/tmp/ssh-config".into());
        registry.insert(different).unwrap();
        let _ = fs::remove_file(file);
    }

    #[test]
    fn corrupt_file_is_actionable_and_preserved() {
        let file = path("corrupt");
        fs::write(&file, b"{broken").unwrap();
        let error = HostRegistry::load(&file).unwrap_err().to_string();
        assert!(error.contains("invalid saved host file"));
        assert_eq!(fs::read(&file).unwrap(), b"{broken");
        let _ = fs::remove_file(file);
    }

    #[test]
    fn file_is_private_and_remote_conversion_keeps_workspace_hint_out_of_transport() {
        let file = path("privacy");
        let parent_mode = fs::metadata(file.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let mut registry = HostRegistry::load(&file).unwrap();
        let mut saved = host("one", "alice@example", "/one");
        saved.last_remote_workspace_path = Some("/workspace/project".into());
        saved.remote_launcher = Some(LauncherConfig {
            executable: "/bin/neta".into(),
            args: Vec::new(),
        });
        registry.insert(saved.clone()).unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(file.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            parent_mode
        );
        let remote = saved.remote_node("/local".into()).unwrap();
        assert_eq!(remote.remote_neta_dir, PathBuf::from("/one"));
        assert!(remote.remote_launcher.unwrap().args.is_empty());
        let raw = fs::read_to_string(file.clone()).unwrap();
        assert!(!raw.contains("privateKey") && !raw.contains("token"));
        let _ = fs::remove_file(file);
    }

    #[test]
    fn failed_write_preserves_memory_and_leaves_no_temp_file() {
        let root = path("failed-write");
        fs::create_dir(&root).unwrap();
        let file = root.join("hosts.json");
        let mut registry = HostRegistry::load(&file).unwrap();
        let before = registry.hosts().to_vec();
        fs::create_dir(&file).unwrap();
        let before_entries: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert!(registry
            .insert(host("one", "alice@example", "/one"))
            .is_err());
        assert_eq!(registry.hosts(), before.as_slice());
        let after_entries: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(after_entries, before_entries);
        let _ = fs::remove_dir_all(root);
    }
}
