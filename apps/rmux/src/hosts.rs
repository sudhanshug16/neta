//! Client-side ownership for Node connections.
//!
//! Node IDs, workspace IDs, and ACP session IDs are only unique within one
//! Node.  This module keeps that namespace boundary explicit so a remote Node
//! cannot replace the active view or rmux pane belonging to another host.

use std::{collections::HashMap, fmt, path::PathBuf};

use neta_client::NodeClient;
use neta_protocol::{Snapshot, Target};

/// A stable client-owned host namespace.  The local Node uses `local`.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct HostId(String);

impl HostId {
    pub fn new(value: impl Into<String>) -> Result<Self, HostKeyError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(HostKeyError::EmptyHostId);
        }
        Ok(Self(value))
    }

    pub fn local() -> Self {
        Self("local".into())
    }

    /// Saved registry IDs occupy a separate namespace so an existing saved
    /// host called `local` can coexist with the built-in local Node.
    pub fn saved(saved_id: &str) -> Result<Self, HostKeyError> {
        Self::new(format!("saved:{saved_id}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for HostId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// The complete identity of an ACP session as displayed by rmux.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct SessionKey {
    pub host_id: HostId,
    pub workspace_id: String,
    pub session_id: String,
}

/// A Node target paired with its owning namespace.  `Target.session_id` stays
/// exactly as it arrived on the wire; only client-side identity is scoped.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopedTarget {
    pub key: SessionKey,
    pub target: Target,
}

impl ScopedTarget {
    pub fn new(host_id: HostId, target: Target) -> Result<Self, HostKeyError> {
        let key = SessionKey::new(
            host_id,
            target.workspace_id.clone(),
            target.session_id.clone(),
        )?;
        Ok(Self { key, target })
    }

    pub fn local(target: Target) -> Self {
        Self::new(HostId::local(), target).expect("Node targets always have a session id")
    }
}

impl std::ops::Deref for ScopedTarget {
    type Target = Target;

    fn deref(&self) -> &Self::Target {
        &self.target
    }
}

impl SessionKey {
    pub fn new(
        host_id: HostId,
        workspace_id: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Result<Self, HostKeyError> {
        let workspace_id = workspace_id.into();
        let session_id = session_id.into();
        if workspace_id.is_empty() || session_id.is_empty() {
            return Err(HostKeyError::EmptySessionId);
        }
        Ok(Self {
            host_id,
            workspace_id,
            session_id,
        })
    }

    /// An injective, filesystem-safe name.  Hex encodes bytes rather than
    /// relying on rmux's display-name sanitization, which can collide.
    pub fn rmux_name(&self) -> String {
        format!(
            "neta-h{}-w{}-s{}",
            hex_bytes(self.host_id.as_str()),
            hex_bytes(&self.workspace_id),
            hex_bytes(&self.session_id)
        )
    }

    pub fn cache_component(&self) -> String {
        format!(
            "h{}-w{}-s{}",
            hex_bytes(self.host_id.as_str()),
            hex_bytes(&self.workspace_id),
            hex_bytes(&self.session_id)
        )
    }

    pub fn legacy_cache_component(&self) -> String {
        format!(
            "h{}-s{}",
            hex_bytes(self.host_id.as_str()),
            hex_bytes(&self.session_id)
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostKeyError {
    EmptyHostId,
    EmptySessionId,
}

impl fmt::Display for HostKeyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyHostId => formatter.write_str("host id must not be empty"),
            Self::EmptySessionId => formatter.write_str("session id must not be empty"),
        }
    }
}

impl std::error::Error for HostKeyError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostStatus {
    Connecting,
    Connected,
    Disconnected { message: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostTransport {
    pub descriptor_path: PathBuf,
    pub local_working_directory: PathBuf,
    pub remote: bool,
}

/// A connection and all view state that must stay in its host namespace.
pub struct HostConnection<C> {
    pub client: C,
    pub transport: HostTransport,
    pub status: HostStatus,
    pub snapshot: Option<Snapshot>,
}

/// Events emitted by host actors.  Every asynchronous result is tagged before
/// it reaches the UI, so stale or failing host work cannot affect another host.
#[derive(Clone, Debug)]
pub enum HostUpdate {
    Snapshot { host_id: HostId, snapshot: Snapshot },
    Disconnected { host_id: HostId, message: String },
}

impl HostUpdate {
    pub fn host_id(&self) -> &HostId {
        match self {
            Self::Snapshot { host_id, .. } | Self::Disconnected { host_id, .. } => host_id,
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum HostManagerError {
    DuplicateHost(HostId),
    UnknownHost(HostId),
}

impl fmt::Display for HostManagerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateHost(host) => write!(formatter, "host already connected: {host}"),
            Self::UnknownHost(host) => write!(formatter, "unknown host: {host}"),
        }
    }
}

impl std::error::Error for HostManagerError {}

/// Owns all Node connections currently visible in one rmux process.
pub struct HostConnectionManager<C> {
    connections: HashMap<HostId, HostConnection<C>>,
}

pub type NodeHostConnectionManager = HostConnectionManager<NodeClient>;

impl<C> Default for HostConnectionManager<C> {
    fn default() -> Self {
        Self {
            connections: HashMap::new(),
        }
    }
}

impl<C> HostConnectionManager<C> {
    pub fn connect(
        &mut self,
        host_id: HostId,
        client: C,
        transport: HostTransport,
    ) -> Result<(), HostManagerError> {
        if self.connections.contains_key(&host_id) {
            return Err(HostManagerError::DuplicateHost(host_id));
        }
        self.connections.insert(
            host_id,
            HostConnection {
                client,
                transport,
                status: HostStatus::Connecting,
                snapshot: None,
            },
        );
        Ok(())
    }

    pub fn get(&self, host_id: &HostId) -> Option<&HostConnection<C>> {
        self.connections.get(host_id)
    }

    pub fn get_mut(&mut self, host_id: &HostId) -> Option<&mut HostConnection<C>> {
        self.connections.get_mut(host_id)
    }

    pub fn hosts(&self) -> impl Iterator<Item = (&HostId, &HostConnection<C>)> {
        self.connections.iter()
    }

    pub fn apply(&mut self, update: HostUpdate) -> Result<(), HostManagerError> {
        let host_id = update.host_id().clone();
        let connection = self
            .connections
            .get_mut(&host_id)
            .ok_or(HostManagerError::UnknownHost(host_id))?;
        match update {
            HostUpdate::Snapshot { snapshot, .. } => {
                connection.snapshot = Some(snapshot);
                connection.status = HostStatus::Connected;
            }
            HostUpdate::Disconnected { message, .. } => {
                connection.status = HostStatus::Disconnected { message };
            }
        }
        Ok(())
    }
}

fn hex_bytes(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use neta_protocol::{Machine, Snapshot};

    #[derive(Debug)]
    struct FakeUnixNode(&'static str);

    fn transport(name: &str) -> HostTransport {
        HostTransport {
            descriptor_path: PathBuf::from(format!("/tmp/{name}/node.json")),
            local_working_directory: PathBuf::from(format!("/tmp/{name}")),
            remote: name != "local",
        }
    }

    fn snapshot(machine: &str) -> Snapshot {
        Snapshot {
            machine: Machine {
                name: machine.into(),
            },
            workspaces: Vec::new(),
            leaders: Vec::new(),
            missions: Vec::new(),
            agents: Vec::new(),
        }
    }

    #[test]
    fn two_fake_nodes_with_the_same_session_id_keep_separate_snapshots() {
        let left = HostId::new("alpha").unwrap();
        let right = HostId::new("beta").unwrap();
        let mut manager = HostConnectionManager::default();
        manager
            .connect(left.clone(), FakeUnixNode("left"), transport("left"))
            .unwrap();
        manager
            .connect(right.clone(), FakeUnixNode("right"), transport("right"))
            .unwrap();
        manager
            .apply(HostUpdate::Snapshot {
                host_id: left.clone(),
                snapshot: snapshot("left-node"),
            })
            .unwrap();
        manager
            .apply(HostUpdate::Snapshot {
                host_id: right.clone(),
                snapshot: snapshot("right-node"),
            })
            .unwrap();

        assert_eq!(
            manager
                .get(&left)
                .unwrap()
                .snapshot
                .as_ref()
                .unwrap()
                .machine
                .name,
            "left-node"
        );
        assert_eq!(
            manager
                .get(&right)
                .unwrap()
                .snapshot
                .as_ref()
                .unwrap()
                .machine
                .name,
            "right-node"
        );
        assert_eq!(manager.get(&left).unwrap().client.0, "left");
        assert_eq!(manager.get(&right).unwrap().client.0, "right");
    }

    #[test]
    fn disconnecting_one_host_leaves_other_host_connected() {
        let left = HostId::new("alpha").unwrap();
        let right = HostId::new("beta").unwrap();
        let mut manager = HostConnectionManager::default();
        manager
            .connect(left.clone(), FakeUnixNode("left"), transport("left"))
            .unwrap();
        manager
            .connect(right.clone(), FakeUnixNode("right"), transport("right"))
            .unwrap();
        manager
            .apply(HostUpdate::Snapshot {
                host_id: left.clone(),
                snapshot: snapshot("left"),
            })
            .unwrap();
        manager
            .apply(HostUpdate::Snapshot {
                host_id: right.clone(),
                snapshot: snapshot("right"),
            })
            .unwrap();
        manager
            .apply(HostUpdate::Disconnected {
                host_id: left.clone(),
                message: "socket closed".into(),
            })
            .unwrap();

        assert!(matches!(
            manager.get(&left).unwrap().status,
            HostStatus::Disconnected { .. }
        ));
        assert_eq!(manager.get(&right).unwrap().status, HostStatus::Connected);
        assert_eq!(
            manager
                .get(&right)
                .unwrap()
                .snapshot
                .as_ref()
                .unwrap()
                .machine
                .name,
            "right"
        );
    }

    #[test]
    fn host_and_session_encoding_cannot_collide_after_rmux_sanitization() {
        let cases = [
            ("host/A", "same:id"),
            ("host:A", "same/id"),
            ("HOST", "session"),
            ("host", "SESSION"),
            ("a-b", "c"),
            ("a", "b-c"),
        ];
        let keys: Vec<_> = cases
            .into_iter()
            .map(|(host, session)| {
                SessionKey::new(HostId::new(host).unwrap(), "workspace", session).unwrap()
            })
            .collect();
        let names: std::collections::HashSet<_> = keys.iter().map(SessionKey::rmux_name).collect();
        let cache_components: std::collections::HashSet<_> =
            keys.iter().map(SessionKey::cache_component).collect();
        assert_eq!(names.len(), keys.len());
        assert_eq!(cache_components.len(), keys.len());
        assert_ne!(keys[0], keys[1]);
    }
}
