use std::{
    collections::HashSet,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::stream::{FuturesUnordered, StreamExt};
use neta_client::NodeClient;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{
    fs,
    io::AsyncWriteExt,
    sync::Notify,
    time::{timeout, Duration},
};

const FILE_PAGE: usize = 100;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

struct DestinationGuard {
    path: PathBuf,
    keep: bool,
}

impl Drop for DestinationGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

#[derive(Default)]
struct CancellationState {
    cancelled: AtomicBool,
    notified: Notify,
}

#[derive(Clone, Default)]
pub struct ExportCancellation(Arc<CancellationState>);

impl ExportCancellation {
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
        self.0.notified.notify_waiters();
    }

    fn check(&self) -> Result<(), String> {
        if self.0.cancelled.load(Ordering::Acquire) {
            Err("diagnostics export cancelled".into())
        } else {
            Ok(())
        }
    }

    async fn cancelled(&self) {
        loop {
            let wait = self.0.notified.notified();
            if self.0.cancelled.load(Ordering::Acquire) {
                return;
            }
            wait.await;
        }
    }
}

async fn request<T: DeserializeOwned>(
    client: &NodeClient,
    method: &str,
    params: serde_json::Value,
    cancellation: Option<&ExportCancellation>,
) -> Result<T, String> {
    if let Some(cancellation) = cancellation {
        cancellation.check()?;
    }
    match cancellation {
        Some(cancellation) => tokio::select! {
            result = client.request(method, params) => result.map_err(|error| error.to_string()),
            _ = cancellation.cancelled() => Err("diagnostics export cancelled".into()),
        },
        None => client
            .request(method, params)
            .await
            .map_err(|error| error.to_string()),
    }
}

async fn cleanup_remote(client: &NodeClient, prepared: &Prepared) -> Result<(), String> {
    timeout(
        CLEANUP_TIMEOUT,
        request::<serde_json::Value>(
            client,
            "diagnostics.cleanup",
            json!({"exportId": prepared.export_id, "cleanupToken": prepared.cleanup_token}),
            None,
        ),
    )
    .await
    .map_err(|_| "diagnostics.cleanup timed out".to_owned())?
    .map(|_| ())
}

#[derive(Clone)]
pub struct HostInput {
    pub id: String,
    pub label: String,
    pub client: Option<NodeClient>,
    pub unavailable: Option<String>,
}
#[derive(Clone)]
pub struct ClientRootInput {
    pub host_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub provider: String,
    pub model: String,
    pub root: PathBuf,
}
pub struct ExportSummary {
    pub complete: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    export_id: String,
    cleanup_token: String,
    manifest_file: ManifestFile,
    file_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    file_id: String,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFile {
    file_id: String,
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilePage {
    files: Vec<RemoteFile>,
    next_offset: usize,
    eof: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    data_base64: String,
    next_offset: u64,
    eof: bool,
}

#[derive(Deserialize)]
struct ManifestSummary {
    #[serde(default)]
    errors: Vec<serde_json::Value>,
}

fn safe_host(id: &str) -> String {
    id.as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn safe_relative(path: &str) -> Result<&Path, String> {
    let path = Path::new(path);
    if !path.to_string_lossy().starts_with("data/")
        || path.to_string_lossy().split('/').any(str::is_empty)
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("diagnostic file path is not a safe relative data path".into());
    }
    Ok(path)
}

async fn private_dir(path: &Path) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder.create(path).map_err(|error| error.to_string())?;
    Ok(())
}

async fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("diagnostic path has no parent")?;
    private_dir(parent).await?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .await
        .map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .await
        .map_err(|error| error.to_string())?;
    file.flush().await.map_err(|error| error.to_string())
}

async fn copy_file(
    client: &NodeClient,
    prepared: &Prepared,
    file_id: &str,
    expected_bytes: u64,
    expected_sha: &str,
    destination: &Path,
    cancellation: &ExportCancellation,
) -> Result<(), String> {
    let mut offset = 0_u64;
    let parent = destination
        .parent()
        .ok_or("diagnostic path has no parent")?;
    private_dir(parent).await?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(destination)
        .await
        .map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    loop {
        cancellation.check()?;
        let chunk: Chunk = request(client, "diagnostics.read", json!({"exportId": prepared.export_id, "cleanupToken": prepared.cleanup_token, "fileId": file_id, "offset": offset}), Some(cancellation)).await?;
        cancellation.check()?;
        if chunk.next_offset < offset || chunk.next_offset > expected_bytes {
            return Err("diagnostic chunk offset is invalid".into());
        }
        let decoded = STANDARD
            .decode(chunk.data_base64)
            .map_err(|_| "diagnostic chunk is not base64")?;
        if decoded.len() > 256 * 1024 {
            return Err("diagnostic chunk exceeds the protocol limit".into());
        }
        if u64::try_from(decoded.len()).map_err(|_| "diagnostic chunk is too large")?
            != chunk.next_offset - offset
        {
            return Err("diagnostic chunk length does not match its offset".into());
        }
        if decoded.is_empty() && !chunk.eof {
            return Err("diagnostic chunk made no progress".into());
        }
        output
            .write_all(&decoded)
            .await
            .map_err(|error| error.to_string())?;
        hash.update(&decoded);
        offset = chunk.next_offset;
        if chunk.eof {
            break;
        }
    }
    output.flush().await.map_err(|error| error.to_string())?;
    if offset != expected_bytes
        || hash
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
            != expected_sha
    {
        return Err("diagnostic file checksum does not match prepared export".into());
    }
    Ok(())
}

async fn export_host(
    client: NodeClient,
    input: &HostInput,
    root: &Path,
    cancellation: ExportCancellation,
) -> Result<serde_json::Value, String> {
    // Once prepare returns its opaque cleanup token, every exit path awaits its
    // cleanup. It deliberately is not cancelled mid-request: abandoning a
    // successful prepare before receiving that token would leave its remote
    // staging directory unreachable by this client.
    cancellation.check()?;
    let prepared: Prepared = request(
        &client,
        "diagnostics.prepare",
        json!({"compact": true}),
        None,
    )
    .await?;
    let result = async {
        cancellation.check()?;
        let host_root = root.join("machines").join(safe_host(&input.id));
        private_dir(&host_root).await?;
        let manifest_path = host_root.join("manifest.json");
        copy_file(&client, &prepared, &prepared.manifest_file.file_id, prepared.manifest_file.bytes, &prepared.manifest_file.sha256, &manifest_path, &cancellation).await?;
        let manifest: ManifestSummary = serde_json::from_reader(std::fs::File::open(&manifest_path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
        let manifest_errors = manifest.errors.len();
        let mut offset = 0;
        let mut seen = HashSet::new();
        loop {
            cancellation.check()?;
            let page: FilePage = request(&client, "diagnostics.files", json!({"exportId": prepared.export_id, "cleanupToken": prepared.cleanup_token, "offset": offset}), Some(&cancellation)).await?;
            if page.files.len() > FILE_PAGE || page.next_offset < offset || page.next_offset > prepared.file_count || page.next_offset - offset != page.files.len() || (!page.eof && page.next_offset == offset) { return Err("diagnostic file page is invalid".into()); }
            for file in page.files {
                if !seen.insert(file.file_id.clone()) { return Err("diagnostic file id repeated".into()); }
                let path = safe_relative(&file.path)?;
                copy_file(&client, &prepared, &file.file_id, file.bytes, &file.sha256, &host_root.join(path), &cancellation).await?;
            }
            offset = page.next_offset;
            if page.eof { break; }
        }
        if offset != prepared.file_count { return Err("diagnostic file pages ended early".into()); }
        Ok(json!({"id": input.id, "label": input.label, "availability": if manifest_errors == 0 { "available" } else { "partial" }, "files": prepared.file_count, "copyErrors": manifest_errors}))
    }.await;
    let cleanup = cleanup_remote(&client, &prepared).await;
    match (result, cleanup) {
        (Ok(status), Ok(_)) => Ok(status),
        (Ok(_), Err(error)) => Err(format!("clean diagnostic export: {error}")),
        (Err(error), Ok(_)) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; clean diagnostic export: {cleanup}")),
    }
}

async fn export_client_root(
    root: ClientRootInput,
    stage: &Path,
    cancellation: &ExportCancellation,
) -> serde_json::Value {
    let target = stage
        .join("client")
        .join(safe_host(&root.host_id))
        .join(safe_host(&root.workspace_id))
        .join(safe_host(&root.session_id));
    let metadata = json!({"hostId":root.host_id,"workspaceId":root.workspace_id,"sessionId":root.session_id,"provider":root.provider,"model":root.model,"rootKey":root.root.file_name().and_then(|name| name.to_str()).unwrap_or_default()});
    let info = match std::fs::symlink_metadata(&root.root) {
        Ok(info) if info.file_type().is_dir() && !info.file_type().is_symlink() => info,
        Ok(_) => {
            return json!({"metadata":metadata,"availability":"partial","error":"registered Pi root is not a directory"})
        }
        Err(error) => {
            return json!({"metadata":metadata,"availability":"partial","error":format!("registered Pi root unavailable: {error}")})
        }
    };
    let _ = info;
    let mut stack = vec![root.root.clone()];
    let mut copied_files = Vec::new();
    let mut errors = 0_u64;
    while let Some(directory) = stack.pop() {
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                errors += 1;
                continue;
            }
        };
        for entry in entries {
            if cancellation.check().is_err() {
                return json!({"metadata":metadata,"availability":"cancelled"});
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    errors += 1;
                    continue;
                }
            };
            let path = entry.path();
            let info = match std::fs::symlink_metadata(&path) {
                Ok(info) => info,
                Err(_) => {
                    errors += 1;
                    continue;
                }
            };
            if info.file_type().is_symlink() {
                continue;
            }
            if info.is_dir() {
                stack.push(path);
                continue;
            }
            if !info.is_file() {
                continue;
            }
            if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
                continue;
            }
            let relative = match path.strip_prefix(&root.root) {
                Ok(relative) => relative,
                Err(_) => {
                    errors += 1;
                    continue;
                }
            };
            if relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
            {
                errors += 1;
                continue;
            }
            let output = target.join(relative);
            let result: Result<(u64, String), String> = async {
                let parent = output
                    .parent()
                    .ok_or("client diagnostic path has no parent")?;
                private_dir(parent).await?;
                let mut input = fs::File::open(&path)
                    .await
                    .map_err(|error| error.to_string())?;
                let opened = input.metadata().await.map_err(|error| error.to_string())?;
                if !opened.is_file() || opened.dev() != info.dev() || opened.ino() != info.ino() {
                    return Err("Pi transcript changed before reading".into());
                }
                let mut output_file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&output)
                    .await
                    .map_err(|error| error.to_string())?;
                let mut remaining = info.len();
                let mut buffer = vec![0_u8; 64 * 1024];
                let mut hash = Sha256::new();
                while remaining > 0 {
                    cancellation.check()?;
                    let limit = usize::try_from(remaining)
                        .unwrap_or(usize::MAX)
                        .min(buffer.len());
                    let read = tokio::io::AsyncReadExt::read(&mut input, &mut buffer[..limit])
                        .await
                        .map_err(|error| error.to_string())?;
                    if read == 0 {
                        return Err("Pi transcript changed while reading".into());
                    }
                    output_file
                        .write_all(&buffer[..read])
                        .await
                        .map_err(|error| error.to_string())?;
                    hash.update(&buffer[..read]);
                    remaining -=
                        u64::try_from(read).map_err(|_| "Pi transcript read is too large")?;
                }
                output_file
                    .flush()
                    .await
                    .map_err(|error| error.to_string())?;
                Ok((
                    info.len(),
                    hash.finalize()
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect(),
                ))
            }
            .await;
            match result {
                Ok((bytes, sha256)) => copied_files.push(json!({
                    "relativePath": relative.to_string_lossy(),
                    "bytes": bytes,
                    "sha256": sha256,
                })),
                Err(_) => errors += 1,
            }
        }
    }
    copied_files.sort_by(|a, b| a["relativePath"].as_str().cmp(&b["relativePath"].as_str()));
    json!({"metadata":metadata,"availability":if errors == 0 {"available"} else {"partial"},"fileCount":copied_files.len(),"files":copied_files,"copyErrors":errors})
}

pub async fn export_all(
    destination: PathBuf,
    inputs: Vec<HostInput>,
    client_roots: Vec<ClientRootInput>,
    cancellation: ExportCancellation,
) -> Result<ExportSummary, String> {
    if destination.exists() {
        return Err("diagnostics destination already exists".into());
    }
    let parent = destination
        .parent()
        .ok_or("diagnostics destination has no parent")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&destination)
        .map_err(|error| error.to_string())?;
    let mut destination_guard = DestinationGuard {
        path: destination.clone(),
        keep: false,
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let stage = destination.join(format!(".neta-diagnostics-{}-{stamp}", std::process::id()));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&stage)
        .map_err(|error| error.to_string())?;
    private_dir(&stage.join("machines")).await?;
    let mut tasks = FuturesUnordered::new();
    let mut statuses = Vec::new();
    for input in inputs {
        if let Some(client) = input.client.clone() {
            let stage = stage.clone();
            let cancellation = cancellation.clone();
            tasks.push(async move {
                let status = export_host(client, &input, &stage, cancellation).await;
                match status { Ok(status) => status, Err(error) => json!({"id": input.id, "label": input.label, "availability": "error", "error": error}) }
            });
        } else {
            statuses.push(json!({"id": input.id, "label": input.label, "availability": "offline", "reason": input.unavailable.unwrap_or_else(|| "no fresh snapshot".into())}));
        }
    }
    while let Some(status) = tasks.next().await {
        statuses.push(status);
    }
    let mut client_statuses = Vec::new();
    for root in client_roots {
        client_statuses.push(export_client_root(root, &stage, &cancellation).await);
    }
    cancellation.check()?;
    statuses.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    client_statuses.sort_by(|a, b| {
        let left = &a["metadata"];
        let right = &b["metadata"];
        (
            left["hostId"].as_str(),
            left["workspaceId"].as_str(),
            left["sessionId"].as_str(),
        )
            .cmp(&(
                right["hostId"].as_str(),
                right["workspaceId"].as_str(),
                right["sessionId"].as_str(),
            ))
    });
    let complete = statuses
        .iter()
        .all(|status| status["availability"] == "available")
        && client_statuses
            .iter()
            .all(|status| status["availability"] == "available");
    let top = serde_json::to_vec_pretty(&json!({"schemaVersion": 1, "scope": "all connected machines", "status": if complete { "complete" } else { "partial" }, "machines": statuses, "clientPiSessions": client_statuses, "exclusions": ["stored authentication files", "provider credential stores", "process environment and argv", "SSH credentials and tokens"]})).map_err(|error| error.to_string())?;
    write_file(&stage.join("manifest.json"), &top).await?;
    fs::rename(stage.join("machines"), destination.join("machines"))
        .await
        .map_err(|error| error.to_string())?;
    if stage.join("client").exists() {
        fs::rename(stage.join("client"), destination.join("client"))
            .await
            .map_err(|error| error.to_string())?;
    }
    fs::rename(
        stage.join("manifest.json"),
        destination.join("manifest.json"),
    )
    .await
    .map_err(|error| error.to_string())?;
    fs::remove_dir(stage)
        .await
        .map_err(|error| error.to_string())?;
    destination_guard.keep = true;
    Ok(ExportSummary { complete })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs as stdfs, sync::atomic::AtomicU64};
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::UnixListener,
        sync::mpsc,
    };

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    #[derive(Clone, Copy)]
    enum Mode {
        Good,
        ManifestError,
        CorruptChunk,
        UnsafePath,
        BadCursor,
        PauseRead,
    }

    fn digest(bytes: &[u8]) -> String {
        let mut hash = Sha256::new();
        hash.update(bytes);
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    async fn fixture(
        mode: Mode,
    ) -> (
        NodeClient,
        PathBuf,
        mpsc::Receiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        let dir = std::env::temp_dir().join(format!(
            "neta-rmux-diagnostics-test-{}-{}",
            std::process::id(),
            FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        stdfs::create_dir(&dir).unwrap();
        let socket = dir.join("node.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        stdfs::write(dir.join("node.json"), serde_json::json!({"socket":socket,"token":"secret","protocolVersion":3,"pid":std::process::id(),"startedAt":"2026-01-01T00:00:00Z"}).to_string()).unwrap();
        let (call_tx, call_rx) = mpsc::channel(32);
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = tokio::io::split(stream);
            let mut read = BufReader::new(read);
            let mut line = String::new();
            while read.read_line(&mut line).await.unwrap() != 0 {
                let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                line.clear();
                let method = request["method"].as_str().unwrap().to_owned();
                let _ = call_tx.send(method.clone()).await;
                let manifest = match mode {
                    Mode::ManifestError => br#"{"errors":[{"message":"partial"}]}"#.to_vec(),
                    _ => br#"{"errors":[]}"#.to_vec(),
                };
                let data = b"diagnostic output".to_vec();
                let result = match method.as_str() {
                    "hello" => {
                        serde_json::json!({"protocolVersion":3,"nodeVersion":"test","pid":std::process::id()})
                    }
                    "diagnostics.prepare" => {
                        serde_json::json!({"exportId":"export","cleanupToken":"token","manifestFile":{"fileId":"manifest","bytes":manifest.len(),"sha256":digest(&manifest)},"fileCount":1})
                    }
                    "diagnostics.files" => match mode {
                        Mode::BadCursor => {
                            serde_json::json!({"files":[],"nextOffset":2,"eof":true})
                        }
                        Mode::UnsafePath => {
                            serde_json::json!({"files":[{"fileId":"data","path":"../escape","bytes":data.len(),"sha256":digest(&data)}],"nextOffset":1,"eof":true})
                        }
                        _ => {
                            serde_json::json!({"files":[{"fileId":"data","path":"data/output.txt","bytes":data.len(),"sha256":digest(&data)}],"nextOffset":1,"eof":true})
                        }
                    },
                    "diagnostics.read" => {
                        if matches!(mode, Mode::PauseRead)
                            && request["params"]["fileId"] == "manifest"
                        {
                            tokio::time::sleep(Duration::from_millis(80)).await;
                        }
                        let file_id = request["params"]["fileId"].as_str().unwrap();
                        let bytes = if file_id == "manifest" {
                            manifest
                        } else {
                            data
                        };
                        let offset = request["params"]["offset"].as_u64().unwrap() as usize;
                        let chunk = &bytes[offset..];
                        let next = offset + chunk.len();
                        if matches!(mode, Mode::CorruptChunk) && file_id == "manifest" {
                            serde_json::json!({"dataBase64":"%%%","nextOffset":next,"eof":true})
                        } else {
                            serde_json::json!({"dataBase64":STANDARD.encode(chunk),"nextOffset":next,"eof":true})
                        }
                    }
                    "diagnostics.cleanup" => serde_json::json!({}),
                    _ => serde_json::json!({}),
                };
                let reply = serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":result});
                write
                    .write_all(serde_json::to_string(&reply).unwrap().as_bytes())
                    .await
                    .unwrap();
                write.write_all(b"\n").await.unwrap();
                write.flush().await.unwrap();
            }
        });
        let (client, _) = NodeClient::connect(neta_client::ConnectOptions {
            neta_dir: dir.clone(),
            launcher: neta_client::Launcher {
                executable: PathBuf::from("unused"),
                args: Vec::new(),
            },
            timeout: Duration::from_secs(2),
            remote: None,
        })
        .await
        .unwrap();
        (client, dir, call_rx, server)
    }

    fn host(id: &str, client: NodeClient) -> HostInput {
        HostInput {
            id: id.into(),
            label: id.into(),
            client: Some(client),
            unavailable: None,
        }
    }

    #[tokio::test]
    async fn exports_two_live_hosts_and_records_an_offline_host() {
        let (one, one_dir, _, one_server) = fixture(Mode::Good).await;
        let (two, two_dir, _, two_server) = fixture(Mode::Good).await;
        let destination = one_dir.join("bundle");
        let summary = export_all(
            destination.clone(),
            vec![
                host("one", one),
                host("two", two),
                HostInput {
                    id: "offline".into(),
                    label: "offline".into(),
                    client: None,
                    unavailable: Some("disconnected".into()),
                },
            ],
            vec![],
            ExportCancellation::default(),
        )
        .await
        .unwrap();
        assert!(!summary.complete);
        let manifest: serde_json::Value =
            serde_json::from_slice(&stdfs::read(destination.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["status"], "partial");
        assert_eq!(manifest["machines"].as_array().unwrap().len(), 3);
        assert!(destination
            .join("machines")
            .join(safe_host("one"))
            .join("data/output.txt")
            .is_file());
        one_server.abort();
        two_server.abort();
        let _ = stdfs::remove_dir_all(one_dir);
        let _ = stdfs::remove_dir_all(two_dir);
    }

    #[tokio::test]
    async fn manifest_errors_make_a_copied_host_partial() {
        let (client, dir, _, server) = fixture(Mode::ManifestError).await;
        let destination = dir.join("bundle");
        let summary = export_all(
            destination.clone(),
            vec![host("one", client)],
            vec![],
            ExportCancellation::default(),
        )
        .await
        .unwrap();
        assert!(!summary.complete);
        let manifest: serde_json::Value =
            serde_json::from_slice(&stdfs::read(destination.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["machines"][0]["availability"], "partial");
        server.abort();
        let _ = stdfs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn rejects_corrupt_chunks_unsafe_paths_and_bad_file_cursors() {
        for mode in [Mode::CorruptChunk, Mode::UnsafePath, Mode::BadCursor] {
            let (client, dir, _, server) = fixture(mode).await;
            let destination = dir.join("bundle");
            let summary = export_all(
                destination.clone(),
                vec![host("one", client)],
                vec![],
                ExportCancellation::default(),
            )
            .await
            .unwrap();
            assert!(!summary.complete);
            let manifest: serde_json::Value =
                serde_json::from_slice(&stdfs::read(destination.join("manifest.json")).unwrap())
                    .unwrap();
            assert_eq!(manifest["machines"][0]["availability"], "error");
            assert!(!destination
                .join("machines")
                .join(safe_host("one"))
                .join("escape")
                .exists());
            server.abort();
            let _ = stdfs::remove_dir_all(dir);
        }
    }

    #[tokio::test]
    async fn preserves_an_existing_destination_and_writes_a_usable_all_offline_manifest() {
        let root = std::env::temp_dir().join(format!(
            "neta-rmux-diagnostics-destination-{}",
            FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = stdfs::remove_dir_all(&root);
        stdfs::create_dir(&root).unwrap();
        let existing = root.join("existing");
        stdfs::create_dir(&existing).unwrap();
        stdfs::write(existing.join("keep"), b"keep").unwrap();
        assert!(export_all(
            existing.clone(),
            vec![],
            vec![],
            ExportCancellation::default()
        )
        .await
        .is_err());
        assert_eq!(stdfs::read(existing.join("keep")).unwrap(), b"keep");
        let offline = root.join("offline");
        let summary = export_all(
            offline.clone(),
            vec![HostInput {
                id: "offline".into(),
                label: "offline".into(),
                client: None,
                unavailable: None,
            }],
            vec![],
            ExportCancellation::default(),
        )
        .await
        .unwrap();
        assert!(!summary.complete);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &stdfs::read(offline.join("manifest.json")).unwrap()
            )
            .unwrap()["machines"][0]["availability"],
            "offline"
        );
        let _ = stdfs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancellation_awaits_cleanup_and_leaves_no_destination_writes() {
        let (client, dir, mut calls, server) = fixture(Mode::PauseRead).await;
        let destination = dir.join("bundle");
        let cancellation = ExportCancellation::default();
        let task = tokio::spawn(export_all(
            destination.clone(),
            vec![host("one", client)],
            vec![],
            cancellation.clone(),
        ));
        while calls.recv().await.as_deref() != Some("diagnostics.read") {}
        cancellation.cancel();
        assert!(task.await.unwrap().is_err());
        let mut saw_cleanup = false;
        while let Ok(method) = tokio::time::timeout(Duration::from_millis(100), calls.recv()).await
        {
            if method.as_deref() == Some("diagnostics.cleanup") {
                saw_cleanup = true;
                break;
            }
        }
        assert!(saw_cleanup);
        assert!(!destination.exists());
        server.abort();
        let _ = stdfs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn copies_only_registered_regular_client_pi_files_and_marks_missing_roots_partial() {
        let root = std::env::temp_dir().join(format!(
            "neta-rmux-client-root-{}",
            FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let registered = root.join("registered");
        let sibling = root.join("sibling");
        stdfs::create_dir_all(&registered).unwrap();
        stdfs::create_dir_all(&sibling).unwrap();
        stdfs::write(registered.join("transcript.jsonl"), b"initial transcript").unwrap();
        stdfs::write(sibling.join("secret.jsonl"), b"not registered").unwrap();
        std::os::unix::fs::symlink(
            sibling.join("secret.jsonl"),
            registered.join("linked.jsonl"),
        )
        .unwrap();
        std::os::unix::fs::symlink(&registered, root.join("linked-root")).unwrap();
        let destination = root.join("bundle");
        let roots = vec![
            ClientRootInput {
                host_id: "local".into(),
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                provider: "pi".into(),
                model: "m".into(),
                root: registered.clone(),
            },
            ClientRootInput {
                host_id: "local".into(),
                workspace_id: "workspace".into(),
                session_id: "missing".into(),
                provider: "pi".into(),
                model: "m".into(),
                root: root.join("missing"),
            },
            ClientRootInput {
                host_id: "local".into(),
                workspace_id: "workspace".into(),
                session_id: "linked-root".into(),
                provider: "pi".into(),
                model: "m".into(),
                root: root.join("linked-root"),
            },
        ];
        let summary = export_all(
            destination.clone(),
            vec![],
            roots,
            ExportCancellation::default(),
        )
        .await
        .unwrap();
        assert!(!summary.complete);
        let client = destination
            .join("client")
            .join(safe_host("local"))
            .join(safe_host("workspace"))
            .join(safe_host("session"));
        assert_eq!(
            stdfs::read(client.join("transcript.jsonl")).unwrap(),
            b"initial transcript"
        );
        assert!(!client.join("linked.jsonl").exists());
        assert!(!destination
            .join("client")
            .join(safe_host("local"))
            .join(safe_host("workspace"))
            .join("secret.jsonl")
            .exists());
        assert!(!destination
            .join("client")
            .join(safe_host("local"))
            .join(safe_host("workspace"))
            .join(safe_host("missing"))
            .exists());
        let manifest: serde_json::Value =
            serde_json::from_slice(&stdfs::read(destination.join("manifest.json")).unwrap())
                .unwrap();
        let sessions = manifest["clientPiSessions"].as_array().unwrap();
        let registered = sessions
            .iter()
            .find(|status| status["metadata"]["sessionId"] == "session")
            .unwrap();
        assert_eq!(registered["files"][0]["relativePath"], "transcript.jsonl");
        assert_eq!(registered["files"][0]["bytes"], 18);
        assert_eq!(
            registered["files"][0]["sha256"],
            digest(b"initial transcript")
        );
        for session_id in ["missing", "linked-root"] {
            assert_eq!(
                sessions
                    .iter()
                    .find(|status| status["metadata"]["sessionId"] == session_id)
                    .unwrap()["availability"],
                "partial"
            );
        }
        let _ = stdfs::remove_dir_all(root);
    }
}
