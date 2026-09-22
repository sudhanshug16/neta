use std::{
    collections::HashMap,
    fmt,
    fs::{self, Permissions},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command as StdCommand, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant},
};

use neta_protocol::{ConversationTail, MissionDetail, MissionList, Snapshot};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf},
    net::UnixStream,
    process::Command,
    sync::{mpsc, oneshot, Mutex},
    task::JoinHandle,
};

mod hosts;
pub use hosts::{HostRegistry, LauncherConfig, SavedHost};

pub const PROTOCOL_VERSION: u64 = 3;
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const RETRY_DELAY: Duration = Duration::from_millis(100);
const SSH_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DESCRIPTOR_BYTES: usize = 8 * 1024;
static FORWARD_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct Launcher {
    pub executable: PathBuf,
    pub args: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ConnectOptions {
    pub neta_dir: PathBuf,
    pub launcher: Launcher,
    pub timeout: Duration,
    pub remote: Option<RemoteNode>,
}

#[derive(Clone, Debug)]
pub struct RemoteNode {
    pub ssh_destination: String,
    pub ssh_executable: PathBuf,
    pub ssh_config: Option<PathBuf>,
    pub remote_neta_dir: PathBuf,
    pub remote_launcher: Option<Launcher>,
    pub local_working_directory: PathBuf,
}

impl ConnectOptions {
    pub fn from_environment() -> Result<Self, ClientError> {
        let neta_dir = match std::env::var_os("NETA_DIR") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => home_dir()?.join(".neta"),
        };
        let executable = std::env::var_os("NETA_NODE_EXECUTABLE")
            .map(PathBuf::from)
            .or_else(default_bun_path);
        let script = std::env::var_os("NETA_NODE_SCRIPT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/cli/main.ts")
            });
        let remote = std::env::var("NETA_REMOTE_SSH_DESTINATION")
            .ok()
            .filter(|value| !value.is_empty())
            .map(|ssh_destination| {
                validate_ssh_destination(&ssh_destination)?;
                let remote_neta_dir = std::env::var_os("NETA_REMOTE_NETA_DIR")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .ok_or_else(|| {
                        ClientError::Configuration(
                            "NETA_REMOTE_NETA_DIR is required with NETA_REMOTE_SSH_DESTINATION"
                                .into(),
                        )
                    })?;
                let remote_launcher = match std::env::var_os("NETA_REMOTE_NODE_EXECUTABLE") {
                    Some(executable) if !executable.is_empty() => {
                        let args = std::env::var("NETA_REMOTE_NODE_ARGS_JSON")
                            .ok()
                            .map(|raw| {
                                serde_json::from_str::<Vec<String>>(&raw).map_err(|error| {
                                    ClientError::Configuration(format!(
                                        "invalid NETA_REMOTE_NODE_ARGS_JSON: {error}"
                                    ))
                                })
                            })
                            .transpose()?
                            .unwrap_or_default();
                        Some(Launcher {
                            executable: PathBuf::from(executable),
                            args,
                        })
                    }
                    _ => None,
                };
                Ok(RemoteNode {
                    ssh_destination,
                    ssh_executable: std::env::var_os("NETA_REMOTE_SSH_EXECUTABLE")
                        .filter(|value| !value.is_empty())
                        .map(PathBuf::from)
                        .unwrap_or_else(|| PathBuf::from("ssh")),
                    ssh_config: std::env::var_os("NETA_REMOTE_SSH_CONFIG")
                        .filter(|value| !value.is_empty())
                        .map(PathBuf::from),
                    remote_neta_dir,
                    remote_launcher,
                    local_working_directory: std::env::var_os("NETA_REMOTE_LOCAL_DIRECTORY")
                        .filter(|value| !value.is_empty())
                        .map(PathBuf::from)
                        .unwrap_or(std::env::current_dir().map_err(|error| {
                            ClientError::Configuration(format!(
                                "read local working directory: {error}"
                            ))
                        })?),
                })
            })
            .transpose()?;
        let launcher = if remote.is_some() {
            Launcher {
                executable: executable.unwrap_or_else(|| PathBuf::from("remote-only")),
                args: Vec::new(),
            }
        } else {
            let executable = executable.ok_or_else(|| {
                ClientError::Configuration(
                    "cannot locate Bun; set NETA_NODE_EXECUTABLE to the exact executable path"
                        .into(),
                )
            })?;
            if !executable.is_file() {
                return Err(ClientError::Configuration(format!(
                    "Node launcher executable does not exist: {}",
                    executable.display()
                )));
            }
            if !script.is_file() {
                return Err(ClientError::Configuration(format!(
                    "Neta service launcher does not exist: {}",
                    script.display()
                )));
            }
            Launcher {
                executable,
                args: vec![
                    script.to_string_lossy().into_owned(),
                    "node".into(),
                    "start".into(),
                ],
            }
        };
        Ok(Self {
            neta_dir,
            launcher,
            timeout: Duration::from_secs(5),
            remote,
        })
    }
}

fn validate_ssh_destination(destination: &str) -> Result<(), ClientError> {
    if destination.is_empty()
        || destination.starts_with('-')
        || destination.chars().any(char::is_control)
    {
        return Err(ClientError::Configuration(
            "NETA_REMOTE_SSH_DESTINATION must be a non-option SSH destination".into(),
        ));
    }
    Ok(())
}

fn home_dir() -> Result<PathBuf, ClientError> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            ClientError::Configuration("HOME is unset and NETA_DIR was not provided".into())
        })
}

fn default_bun_path() -> Option<PathBuf> {
    let candidate = home_dir().ok()?.join(".bun/bin/bun");
    candidate.is_file().then_some(candidate)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub code: i64,
    pub symbol: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    Configuration(String),
    Unavailable(String),
    Protocol(String),
    Rpc(RpcError),
    Closed,
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(message) | Self::Unavailable(message) | Self::Protocol(message) => {
                f.write_str(message)
            }
            Self::Rpc(error) => write!(
                f,
                "{} ({})",
                error.message,
                error.symbol.as_deref().unwrap_or("RPC_ERROR")
            ),
            Self::Closed => f.write_str("the Neta Node connection closed"),
        }
    }
}

impl std::error::Error for ClientError {}

#[derive(Clone, Debug)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    socket: PathBuf,
    token: String,
    protocol_version: u64,
    pid: u32,
    started_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub protocol_version: u64,
    pub node_version: String,
    pub pid: u32,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceOpenResult {
    pub workspace: OpenedWorkspace,
}

#[derive(Debug, Deserialize)]
pub struct OpenedWorkspace {
    pub id: String,
}

type Pending = HashMap<String, oneshot::Sender<Result<Value, ClientError>>>;

#[derive(Clone)]
pub struct NodeClient {
    writer: Arc<Mutex<WriteHalf<UnixStream>>>,
    pending: Arc<Mutex<Pending>>,
    closed: Arc<AtomicBool>,
    next_id: Arc<AtomicU64>,
    reader: Arc<JoinHandle<()>>,
    resources: Arc<ConnectionResources>,
}

struct ConnectionResources {
    descriptor_path: PathBuf,
    remote: bool,
    forward: Option<StdMutex<Option<Child>>>,
    private_directory: Option<PathBuf>,
}

impl Drop for ConnectionResources {
    fn drop(&mut self) {
        if let Some(forward) = &self.forward {
            if let Ok(mut child) = forward.lock() {
                if let Some(child) = child.as_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        if let Some(directory) = &self.private_directory {
            let _ = fs::remove_dir_all(directory);
        }
    }
}

impl NodeClient {
    pub async fn connect(
        options: ConnectOptions,
    ) -> Result<(Self, mpsc::Receiver<Notification>), ClientError> {
        if let Some(remote) = &options.remote {
            return tokio::time::timeout(
                options.timeout,
                Self::connect_remote(remote, options.timeout),
            )
            .await
            .map_err(|_| {
                ClientError::Unavailable("timed out connecting to remote Neta Node".into())
            })?;
        }
        let deadline = Instant::now() + options.timeout;
        let mut spawned = false;
        loop {
            if let Some(descriptor) = read_descriptor(&options.neta_dir).await? {
                match Self::connect_descriptor(
                    &descriptor,
                    deadline,
                    Arc::new(ConnectionResources {
                        descriptor_path: options.neta_dir.join("node.json"),
                        remote: false,
                        forward: None,
                        private_directory: None,
                    }),
                )
                .await
                {
                    Ok(result) => return Ok(result),
                    Err(error @ ClientError::Rpc(_)) | Err(error @ ClientError::Protocol(_)) => {
                        return Err(error)
                    }
                    Err(ClientError::Configuration(message)) => {
                        return Err(ClientError::Configuration(message))
                    }
                    Err(ClientError::Closed) | Err(ClientError::Unavailable(_)) => {}
                }
            }
            if !spawned {
                start_node(&options.launcher, &options.neta_dir).await?;
                spawned = true;
            }
            if Instant::now() >= deadline {
                return Err(ClientError::Unavailable(format!(
                    "timed out connecting to the Neta Node in {}",
                    options.neta_dir.display()
                )));
            }
            tokio::time::sleep(RETRY_DELAY.min(deadline.saturating_duration_since(Instant::now())))
                .await;
        }
    }

    async fn connect_descriptor(
        descriptor: &Descriptor,
        deadline: Instant,
        resources: Arc<ConnectionResources>,
    ) -> Result<(Self, mpsc::Receiver<Notification>), ClientError> {
        if descriptor.protocol_version != PROTOCOL_VERSION {
            return Err(ClientError::Protocol(format!(
                "Neta Node descriptor speaks protocol {}, this client speaks {}",
                descriptor.protocol_version, PROTOCOL_VERSION
            )));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ClientError::Unavailable(
                "timed out before connecting to the Neta Node".into(),
            ));
        }
        let stream = tokio::time::timeout(remaining, UnixStream::connect(&descriptor.socket))
            .await
            .map_err(|_| {
                ClientError::Unavailable("timed out connecting to the Neta Node socket".into())
            })?
            .map_err(|error| {
                ClientError::Unavailable(format!(
                    "connect {}: {error}",
                    descriptor.socket.display()
                ))
            })?;
        let (reader, writer) = tokio::io::split(stream);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let (notification_tx, notification_rx) = mpsc::channel(256);
        let reader_pending = pending.clone();
        let reader_closed = closed.clone();
        let reader_task = tokio::spawn(async move {
            read_loop(reader, reader_pending, reader_closed, notification_tx).await;
        });
        let client = Self {
            writer: Arc::new(Mutex::new(writer)),
            pending,
            closed,
            next_id: Arc::new(AtomicU64::new(1)),
            reader: Arc::new(reader_task),
            resources,
        };
        let hello: HelloResult = tokio::time::timeout(
            deadline.saturating_duration_since(Instant::now()),
            client.request(
                "hello",
                json!({
                    "token": descriptor.token,
                    "client": "desktop",
                    "protocolVersion": PROTOCOL_VERSION,
                }),
            ),
        )
        .await
        .map_err(|_| ClientError::Unavailable("timed out waiting for Neta Node hello".into()))??;
        if hello.protocol_version != PROTOCOL_VERSION
            || descriptor.protocol_version != PROTOCOL_VERSION
        {
            return Err(ClientError::Protocol(format!(
                "Neta Node speaks protocol {}, this client speaks {}",
                hello.protocol_version, PROTOCOL_VERSION
            )));
        }
        Ok((client, notification_rx))
    }

    async fn connect_remote(
        remote: &RemoteNode,
        timeout: Duration,
    ) -> Result<(Self, mpsc::Receiver<Notification>), ClientError> {
        let deadline = Instant::now() + timeout;
        let mut descriptor = read_remote_descriptor(remote).await?;
        if descriptor.is_none() {
            let discovered;
            let launcher = match remote.remote_launcher.as_ref() {
                Some(launcher) => launcher,
                None => {
                    discovered = discover_remote_launcher(remote).await?;
                    &discovered
                }
            };
            start_remote_node(remote, launcher).await?;
            while descriptor.is_none() && Instant::now() < deadline {
                tokio::time::sleep(RETRY_DELAY).await;
                descriptor = read_remote_descriptor(remote).await?;
            }
        }
        let descriptor = descriptor.ok_or_else(|| {
            ClientError::Unavailable("timed out waiting for remote Neta Node descriptor".into())
        })?;
        if descriptor.protocol_version != PROTOCOL_VERSION {
            return Err(ClientError::Protocol(format!(
                "remote Neta Node speaks protocol {}, this client speaks {}",
                descriptor.protocol_version, PROTOCOL_VERSION
            )));
        }
        let resources = start_forward(remote, &descriptor, deadline).await?;
        let forwarded = descriptor_for_forward(&descriptor, &resources.descriptor_path)?;
        match Self::connect_descriptor(&forwarded, deadline, resources).await {
            Ok(connected) => Ok(connected),
            Err(original) => {
                let discovered;
                let launcher = match remote.remote_launcher.as_ref() {
                    Some(launcher) => launcher,
                    None => {
                        discovered = discover_remote_launcher(remote).await?;
                        &discovered
                    }
                };
                if remote_node_is_live(remote, launcher).await? {
                    return Err(original);
                }
                start_remote_node(remote, launcher).await?;
                let mut refreshed = None;
                while refreshed.is_none() && Instant::now() < deadline {
                    tokio::time::sleep(RETRY_DELAY).await;
                    refreshed = read_remote_descriptor(remote).await?;
                }
                let refreshed = refreshed.ok_or_else(|| {
                    ClientError::Unavailable(format!(
                        "remote Neta Node did not recover after stale descriptor: {original}"
                    ))
                })?;
                let resources = start_forward(remote, &refreshed, deadline).await?;
                let forwarded = descriptor_for_forward(&refreshed, &resources.descriptor_path)?;
                Self::connect_descriptor(&forwarded, deadline, resources).await
            }
        }
    }

    pub fn descriptor_path(&self) -> &Path {
        &self.resources.descriptor_path
    }

    pub fn is_remote(&self) -> bool {
        self.resources.remote
    }

    pub async fn request<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
    ) -> Result<T, ClientError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if self.closed.load(Ordering::Acquire) {
                return Err(ClientError::Closed);
            }
            pending.insert(id.clone(), tx);
        }
        let mut guard = PendingGuard::new(id.clone(), self.pending.clone());
        let bytes = serde_json::to_vec(
            &json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
        )
        .map_err(|error| ClientError::Protocol(error.to_string()))?;
        if bytes.len() > MAX_LINE_BYTES {
            self.pending.lock().await.remove(&id);
            guard.disarm();
            return Err(ClientError::Protocol("request exceeds 8 MiB".into()));
        }
        let write = async {
            let mut writer = self.writer.lock().await;
            writer.write_all(&bytes).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await
        }
        .await;
        if let Err(error) = write {
            self.pending.lock().await.remove(&id);
            guard.disarm();
            return Err(ClientError::Unavailable(error.to_string()));
        }
        let value = rx.await.map_err(|_| ClientError::Closed)??;
        guard.disarm();
        serde_json::from_value(value).map_err(|error| ClientError::Protocol(error.to_string()))
    }

    pub async fn open_workspace(&self, path: &Path) -> Result<WorkspaceOpenResult, ClientError> {
        self.request("workspace.open", json!({"path": path})).await
    }

    pub async fn snapshot(&self) -> Result<Snapshot, ClientError> {
        self.request("snapshot", json!({"windowDays":14})).await
    }

    pub async fn list_missions(
        &self,
        workspace_id: &str,
        cursor: Option<&str>,
    ) -> Result<MissionList, ClientError> {
        let mut params = json!({"workspaceId": workspace_id, "limit": 50});
        if let Some(cursor) = cursor {
            params["cursor"] = Value::String(cursor.into());
        }
        self.request("missions.list", params).await
    }

    pub async fn mission_detail(&self, mission_id: &str) -> Result<MissionDetail, ClientError> {
        self.request("missions.get", json!({"missionId": mission_id}))
            .await
    }

    pub async fn archive_tail(
        &self,
        session_id: &str,
        cursor: Option<&str>,
    ) -> Result<ConversationTail, ClientError> {
        let mut params = json!({"sessionId": session_id, "limit": 50, "direction": "backward"});
        if let Some(cursor) = cursor {
            params["cursor"] = Value::String(cursor.into());
        }
        let page = self.request("conversation.tail", params).await?;
        let _: serde_json::Value = self
            .request("conversation.untail", json!({"sessionId": session_id}))
            .await?;
        Ok(page)
    }
}

impl Drop for NodeClient {
    fn drop(&mut self) {
        if Arc::strong_count(&self.reader) == 1 {
            self.reader.abort();
        }
    }
}

async fn read_descriptor(neta_dir: &Path) -> Result<Option<Descriptor>, ClientError> {
    match tokio::fs::read(neta_dir.join("node.json")).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| ClientError::Configuration(format!("invalid node.json: {error}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ClientError::Unavailable(format!("read node.json: {error}"))),
    }
}

async fn start_node(launcher: &Launcher, neta_dir: &Path) -> Result<(), ClientError> {
    use std::os::unix::process::CommandExt;

    let mut command = Command::new(&launcher.executable);
    command
        .args(&launcher.args)
        .env("NETA_DIR", neta_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    command.as_std_mut().process_group(0);
    command.spawn().map(|_| ()).map_err(|error| {
        ClientError::Unavailable(format!(
            "start Neta Node with {}: {error}",
            launcher.executable.display()
        ))
    })
}

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn remote_descriptor_command(remote: &RemoteNode) -> String {
    format!(
        "head -c {MAX_DESCRIPTOR_BYTES} -- {}",
        posix_quote(&remote.remote_neta_dir.join("node.json").to_string_lossy())
    )
}

async fn ssh_output(
    remote: &RemoteNode,
    command: String,
) -> Result<std::process::Output, ClientError> {
    let mut ssh = Command::new(&remote.ssh_executable);
    if let Some(config) = &remote.ssh_config {
        ssh.arg("-F").arg(config);
    }
    let task = ssh
        .args([
            "-o",
            "ForwardAgent=no",
            "--",
            &remote.ssh_destination,
            &command,
        ])
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    tokio::time::timeout(SSH_COMMAND_TIMEOUT, task)
        .await
        .map_err(|_| ClientError::Unavailable("SSH command timed out".into()))?
        .map_err(|error| ClientError::Unavailable(format!("start SSH transport: {error}")))
}

async fn read_remote_descriptor(remote: &RemoteNode) -> Result<Option<Descriptor>, ClientError> {
    let output = ssh_output(remote, remote_descriptor_command(remote)).await?;
    if !output.status.success() {
        return match output.status.code() {
            Some(1) => Ok(None),
            _ => Err(ClientError::Unavailable(
                "read remote Neta Node descriptor over SSH".into(),
            )),
        };
    }
    serde_json::from_slice(&output.stdout)
        .map(Some)
        .map_err(|error| ClientError::Protocol(format!("invalid remote node descriptor: {error}")))
}

async fn start_remote_node(remote: &RemoteNode, launcher: &Launcher) -> Result<(), ClientError> {
    let mut argv = vec![
        "env".to_owned(),
        format!("NETA_DIR={}", remote.remote_neta_dir.to_string_lossy()),
        launcher.executable.to_string_lossy().into_owned(),
    ];
    argv.extend(launcher.args.clone());
    argv.extend(["node".into(), "start".into()]);
    let command = format!(
        "PATH=\"$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/opt/homebrew/bin:$PATH\"; export PATH; nohup {} >/dev/null 2>&1 </dev/null &",
        argv.iter()
            .map(|arg| posix_quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let output = ssh_output(remote, command).await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(ClientError::Unavailable(
            "remote Neta Node start command failed".into(),
        ))
    }
}

async fn discover_remote_launcher(remote: &RemoteNode) -> Result<Launcher, ClientError> {
    let marker = "__NETA_CLI__";
    let command = format!("for neta in \"$HOME/.local/bin/neta\" \"$HOME/.bun/bin/neta\" /usr/local/bin/neta /opt/homebrew/bin/neta; do [ -f \"$neta\" ] && [ -x \"$neta\" ] && {{ printf '%s%s\\n' '{marker}' \"$neta\"; exit 0; }}; done; neta=$(command -v neta); [ -n \"$neta\" ] && [ -f \"$neta\" ] && [ -x \"$neta\" ] && printf '%s%s\\n' '{marker}' \"$neta\"");
    let output = ssh_output(remote, command.into()).await?;
    if !output.status.success() {
        return Err(ClientError::Unavailable(
            "Neta is not installed on the remote machine".into(),
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let executable = stdout
        .lines()
        .find_map(|line| line.strip_prefix(marker))
        .filter(|path| !path.is_empty() && Path::new(path).is_absolute())
        .ok_or_else(|| {
            ClientError::Unavailable("Neta is not installed on the remote machine".into())
        })?;
    Ok(Launcher {
        executable: PathBuf::from(executable),
        args: Vec::new(),
    })
}

#[derive(Deserialize)]
struct RemoteNodeStatus {
    running: bool,
}

async fn remote_node_is_live(
    remote: &RemoteNode,
    launcher: &Launcher,
) -> Result<bool, ClientError> {
    let mut argv = vec![
        "env".to_owned(),
        format!("NETA_DIR={}", remote.remote_neta_dir.to_string_lossy()),
        launcher.executable.to_string_lossy().into_owned(),
    ];
    argv.extend(launcher.args.clone());
    argv.extend(["node".into(), "status".into(), "--json".into()]);
    let command = format!("PATH=\"$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/opt/homebrew/bin:$PATH\"; export PATH; {}", argv
        .iter()
        .map(|arg| posix_quote(arg))
        .collect::<Vec<_>>()
        .join(" "));
    let output = ssh_output(remote, command).await?;
    if !output.status.success() {
        return Err(ClientError::Unavailable(
            "check remote Neta Node status over SSH".into(),
        ));
    }
    serde_json::from_slice::<RemoteNodeStatus>(&output.stdout)
        .map(|status| status.running)
        .map_err(|error| ClientError::Protocol(format!("invalid remote Neta Node status: {error}")))
}

async fn start_forward(
    remote: &RemoteNode,
    descriptor: &Descriptor,
    deadline: Instant,
) -> Result<Arc<ConnectionResources>, ClientError> {
    let nonce = format!(
        "neta-ssh-{}-{}",
        std::process::id(),
        FORWARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let directory = std::env::temp_dir().join(nonce);
    fs::create_dir(&directory).map_err(|error| {
        ClientError::Unavailable(format!("create private SSH forward directory: {error}"))
    })?;
    if let Err(error) = fs::set_permissions(&directory, Permissions::from_mode(0o700)) {
        let _ = fs::remove_dir_all(&directory);
        return Err(ClientError::Unavailable(format!(
            "protect SSH forward directory: {error}"
        )));
    }
    let socket = directory.join("node.sock");
    let descriptor_path = directory.join("node.json");
    let local_descriptor = Descriptor {
        socket: socket.clone(),
        token: descriptor.token.clone(),
        protocol_version: descriptor.protocol_version,
        pid: descriptor.pid,
        started_at: descriptor.started_at.clone(),
    };
    let encoded = match serde_json::to_vec(&local_descriptor) {
        Ok(encoded) => encoded,
        Err(error) => {
            let _ = fs::remove_dir_all(&directory);
            return Err(ClientError::Protocol(error.to_string()));
        }
    };
    if let Err(error) = fs::write(&descriptor_path, encoded) {
        let _ = fs::remove_dir_all(&directory);
        return Err(ClientError::Unavailable(format!(
            "write local SSH descriptor: {error}"
        )));
    }
    if let Err(error) = fs::set_permissions(&descriptor_path, Permissions::from_mode(0o600)) {
        let _ = fs::remove_dir_all(&directory);
        return Err(ClientError::Unavailable(format!(
            "protect local SSH descriptor: {error}"
        )));
    }
    let mut command = StdCommand::new(&remote.ssh_executable);
    if let Some(config) = &remote.ssh_config {
        command.arg("-F").arg(config);
    }
    let forward = command
        .args([
            "-o",
            "ForwardAgent=no",
            "-o",
            "ExitOnForwardFailure=yes",
            "-N",
            "-L",
        ])
        .arg(format!(
            "{}:{}",
            socket.display(),
            descriptor.socket.display()
        ))
        .arg("--")
        .arg(&remote.ssh_destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            let _ = fs::remove_dir_all(&directory);
            ClientError::Unavailable(format!("start SSH Unix socket forward: {error}"))
        })?;
    let resources = Arc::new(ConnectionResources {
        descriptor_path,
        remote: true,
        forward: Some(StdMutex::new(Some(forward))),
        private_directory: Some(directory),
    });
    loop {
        if UnixStream::connect(&socket).await.is_ok() {
            return Ok(resources);
        }
        if Instant::now() >= deadline {
            return Err(ClientError::Unavailable(
                "timed out starting SSH Unix socket forward".into(),
            ));
        }
        if let Some(forward) = &resources.forward {
            if forward
                .lock()
                .ok()
                .and_then(|mut child| {
                    child
                        .as_mut()
                        .and_then(|child| child.try_wait().ok().flatten())
                })
                .is_some()
            {
                return Err(ClientError::Unavailable(
                    "SSH Unix socket forward exited before connecting".into(),
                ));
            }
        }
        tokio::time::sleep(RETRY_DELAY).await;
    }
}

fn descriptor_for_forward(_remote: &Descriptor, path: &Path) -> Result<Descriptor, ClientError> {
    serde_json::from_slice(
        &fs::read(path).map_err(|error| {
            ClientError::Unavailable(format!("read local SSH descriptor: {error}"))
        })?,
    )
    .map_err(|error| ClientError::Protocol(format!("invalid local SSH descriptor: {error}")))
}

async fn read_loop(
    mut reader: ReadHalf<UnixStream>,
    pending: Arc<Mutex<Pending>>,
    closed: Arc<AtomicBool>,
    notifications: mpsc::Sender<Notification>,
) {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    let failure = 'read: loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break ClientError::Closed,
            Ok(count) => {
                buffer.extend_from_slice(&chunk[..count]);
                match drain_frames(&mut buffer) {
                    Ok(frames) => {
                        for frame in frames {
                            if let Err(error) = dispatch(frame, &pending, &notifications).await {
                                break 'read error;
                            }
                        }
                    }
                    Err(error) => break error,
                }
            }
            Err(error) => break ClientError::Unavailable(error.to_string()),
        }
    };
    let entries = {
        let mut pending = pending.lock().await;
        closed.store(true, Ordering::Release);
        std::mem::take(&mut *pending)
    };
    for (_, sender) in entries {
        let _ = sender.send(Err(failure.clone()));
    }
}

fn drain_frames(buffer: &mut Vec<u8>) -> Result<Vec<Value>, ClientError> {
    let mut frames = Vec::new();
    while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
        if newline > MAX_LINE_BYTES {
            return Err(ClientError::Protocol("line exceeds 8 MiB".into()));
        }
        let line: Vec<u8> = buffer.drain(..=newline).collect();
        if line.len() == 1 {
            continue;
        }
        frames.push(
            serde_json::from_slice(&line[..line.len() - 1])
                .map_err(|_| ClientError::Protocol("malformed JSON from Neta Node".into()))?,
        );
    }
    if buffer.len() > MAX_LINE_BYTES {
        return Err(ClientError::Protocol(
            "unterminated line exceeds 8 MiB".into(),
        ));
    }
    Ok(frames)
}

async fn dispatch(
    frame: Value,
    pending: &Arc<Mutex<Pending>>,
    notifications: &mpsc::Sender<Notification>,
) -> Result<(), ClientError> {
    let Some(object) = frame.as_object() else {
        return Ok(());
    };
    if object.get("id").is_none() {
        if let Some(method) = object.get("method").and_then(Value::as_str) {
            notifications
                .try_send(Notification {
                    method: method.to_owned(),
                    params: object.get("params").cloned().unwrap_or(Value::Null),
                })
                .map_err(|_| {
                    ClientError::Protocol(
                        "notification overflow; reconnect for a fresh snapshot".into(),
                    )
                })?;
        }
        return Ok(());
    }
    let Some(id) = object.get("id").and_then(|id| match id {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }) else {
        return Ok(());
    };
    let Some(sender) = pending.lock().await.remove(&id) else {
        return Ok(());
    };
    let result = if let Some(error) = object.get("error") {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32603);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("malformed RPC error")
            .to_owned();
        let symbol = error
            .get("data")
            .and_then(|data| data.get("code"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Err(ClientError::Rpc(RpcError {
            code,
            symbol,
            message,
        }))
    } else {
        Ok(object.get("result").cloned().unwrap_or(Value::Null))
    };
    let _ = sender.send(result);
    Ok(())
}

struct PendingGuard {
    id: Option<String>,
    pending: Arc<Mutex<Pending>>,
}

impl PendingGuard {
    fn new(id: String, pending: Arc<Mutex<Pending>>) -> Self {
        Self {
            id: Some(id),
            pending,
        }
    }

    fn disarm(&mut self) {
        self.id = None;
    }
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        let Some(id) = self.id.take() else { return };
        let pending = self.pending.clone();
        tokio::spawn(async move {
            pending.lock().await.remove(&id);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::UnixListener,
    };

    #[test]
    fn fragmented_and_malformed_frames_are_bounded() {
        let mut buffer = br#"{"id":"1","result":"#.to_vec();
        assert!(drain_frames(&mut buffer).unwrap().is_empty());
        buffer.extend_from_slice(b"true}\n");
        assert_eq!(drain_frames(&mut buffer).unwrap()[0]["result"], true);
        buffer.extend_from_slice(b"not-json\n");
        assert!(matches!(
            drain_frames(&mut buffer),
            Err(ClientError::Protocol(_))
        ));
    }

    fn test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("neta-client-{label}-{}", std::process::id()))
    }

    async fn fixture(label: &str, token: &str) -> (PathBuf, UnixListener) {
        let dir = test_dir(label);
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let socket = dir.join("node.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        tokio::fs::write(
            dir.join("node.json"),
            serde_json::to_vec(&json!({
                "socket":socket,
                "token":token,
                "pid":std::process::id(),
                "protocolVersion":PROTOCOL_VERSION,
                "startedAt":"2026-01-01T00:00:00.000Z"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        (dir, listener)
    }

    fn options(dir: PathBuf) -> ConnectOptions {
        ConnectOptions {
            neta_dir: dir,
            launcher: Launcher {
                executable: PathBuf::from("/must/not/run"),
                args: Vec::new(),
            },
            timeout: Duration::from_secs(1),
            remote: None,
        }
    }

    fn remote_fixture(label: &str, body: &str, launcher: bool) -> (PathBuf, PathBuf, RemoteNode) {
        let dir = test_dir(label);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("controlled-ssh");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nset -eu\n{}\n",
                body.replace("@DIR@", &dir.to_string_lossy())
            ),
        )
        .unwrap();
        fs::set_permissions(&script, Permissions::from_mode(0o700)).unwrap();
        let marker = dir.join("controlled-ssh.starts");
        let remote = RemoteNode {
            ssh_destination: "fixture".into(),
            ssh_executable: script,
            ssh_config: None,
            remote_neta_dir: PathBuf::from("/remote/neta"),
            remote_launcher: launcher.then(|| Launcher {
                executable: PathBuf::from("/remote/node"),
                args: Vec::new(),
            }),
            local_working_directory: dir.clone(),
        };
        (dir, marker, remote)
    }

    fn descriptor_json() -> String {
        format!("{{\"socket\":\"/remote/neta/node.sock\",\"token\":\"fixture-token\",\"pid\":1,\"protocolVersion\":{PROTOCOL_VERSION},\"startedAt\":\"2026-01-01T00:00:00.000Z\"}}")
    }

    #[tokio::test]
    async fn remote_auth_failure_never_autostarts() {
        let (dir, marker, remote) = remote_fixture(
            "remote-auth",
            "printf '%s\\n' \"$*\" >> '@DIR@/calls'; exit 255",
            true,
        );
        let result = NodeClient::connect(ConnectOptions {
            neta_dir: dir.clone(),
            launcher: Launcher {
                executable: PathBuf::from("/must/not/run"),
                args: Vec::new(),
            },
            timeout: Duration::from_secs(2),
            remote: Some(remote),
        })
        .await;
        assert!(matches!(result, Err(ClientError::Unavailable(_))));
        assert!(!marker.exists());
        let calls = fs::read_to_string(dir.join("calls")).unwrap();
        assert_eq!(calls.lines().count(), 1);
        assert!(!calls.contains("nohup"));
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn remote_descriptor_read_respects_connect_timeout() {
        let (dir, _, remote) = remote_fixture("remote-read-timeout", "sleep 5", false);
        let started = Instant::now();
        let result = NodeClient::connect(ConnectOptions {
            neta_dir: dir.clone(),
            launcher: Launcher {
                executable: PathBuf::from("/must/not/run"),
                args: Vec::new(),
            },
            timeout: Duration::from_millis(150),
            remote: Some(remote),
        })
        .await;
        assert!(matches!(result, Err(ClientError::Unavailable(_))));
        assert!(started.elapsed() < Duration::from_secs(1));
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn failed_forward_times_out_and_removes_private_descriptor() {
        let (dir, _, remote) = remote_fixture(
            "remote-forward-timeout",
            r#"previous=''; for argument in "$@"; do if [ "$previous" = '-L' ]; then printf '%s' "${argument%%:*}" > '@DIR@/socket'; fi; previous=$argument; done; sleep 5"#,
            false,
        );
        let descriptor = Descriptor {
            socket: PathBuf::from("/remote/neta/node.sock"),
            token: "fixture-token".into(),
            protocol_version: PROTOCOL_VERSION,
            pid: 1,
            started_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let result = start_forward(
            &remote,
            &descriptor,
            Instant::now() + Duration::from_secs(3),
        )
        .await;
        assert!(matches!(result, Err(ClientError::Unavailable(_))));
        let socket = PathBuf::from(fs::read_to_string(dir.join("socket")).unwrap());
        assert!(!socket.parent().unwrap().exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stale_remote_descriptor_restarts_once_after_failed_hello() {
        let body = format!(
            r#"
case "$*" in
  *"head -c"*) printf '%s' '{}' ;;
  *status*) printf '%s\n' '{{"running":false}}' ;;
  *nohup*) printf 'start\n' >> "$0.starts" ;;
  *" -N "*)
    previous=''
    local_socket=''
    for argument in "$@"; do
      if [ "$previous" = '-L' ]; then local_socket=${{argument%%:*}}; break; fi
      previous=$argument
    done
    /usr/bin/python3 -c 'import socket,sys; server=socket.socket(socket.AF_UNIX); server.bind(sys.argv[1]); server.listen(2); [server.accept()[0].close() for _ in range(2)]' "$local_socket"
    ;;
esac
"#,
            descriptor_json()
        );
        let (dir, marker, remote) = remote_fixture("remote-stale", &body, true);
        let result = NodeClient::connect(ConnectOptions {
            neta_dir: dir.clone(),
            launcher: Launcher {
                executable: PathBuf::from("/must/not/run"),
                args: Vec::new(),
            },
            timeout: Duration::from_secs(2),
            remote: Some(remote),
        })
        .await;
        assert!(matches!(
            result,
            Err(ClientError::Closed) | Err(ClientError::Unavailable(_))
        ));
        assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    async fn accept_hello(
        listener: UnixListener,
    ) -> (BufReader<ReadHalf<UnixStream>>, WriteHalf<UnixStream>) {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = tokio::io::split(stream);
        let mut read = BufReader::new(read);
        let mut line = String::new();
        read.read_line(&mut line).await.unwrap();
        let request: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], "hello");
        assert_eq!(request["params"]["client"], "desktop");
        let reply = json!({"jsonrpc":"2.0", "id":request["id"], "result":{
            "machine":{"id":"m","name":"local","createdAt":"2026-01-01T00:00:00.000Z"},
            "protocolVersion":PROTOCOL_VERSION,"nodeVersion":"test","pid":std::process::id()
        }});
        let bytes = serde_json::to_vec(&reply).unwrap();
        let split = bytes.len() / 2;
        write.write_all(&bytes[..split]).await.unwrap();
        tokio::task::yield_now().await;
        write.write_all(&bytes[split..]).await.unwrap();
        write.write_all(b"\n").await.unwrap();
        (read, write)
    }

    #[tokio::test]
    async fn fragmented_hello_and_out_of_order_replies() {
        let (dir, listener) = fixture("ordering", "secret").await;
        let server = tokio::spawn(async move {
            let (mut read, mut write) = accept_hello(listener).await;
            let mut first = String::new();
            let mut second = String::new();
            read.read_line(&mut first).await.unwrap();
            read.read_line(&mut second).await.unwrap();
            let first: Value = serde_json::from_str(&first).unwrap();
            let second: Value = serde_json::from_str(&second).unwrap();
            for request in [second, first] {
                let reply =
                    json!({"jsonrpc":"2.0","id":request["id"],"result":request["params"]["value"]});
                write
                    .write_all(&serde_json::to_vec(&reply).unwrap())
                    .await
                    .unwrap();
                write.write_all(b"\n").await.unwrap();
            }
        });
        let (client, _) = NodeClient::connect(options(dir.clone())).await.unwrap();
        let (one, two) = tokio::join!(
            client.request::<u64>("one", json!({"value":1})),
            client.request::<u64>("two", json!({"value":2}))
        );
        assert_eq!(one.unwrap(), 1);
        assert_eq!(two.unwrap(), 2);
        server.await.unwrap();
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn eof_rejects_pending_and_later_requests() {
        let (dir, listener) = fixture("eof", "secret").await;
        let server = tokio::spawn(async move {
            let (mut read, _write) = accept_hello(listener).await;
            let mut request = String::new();
            read.read_line(&mut request).await.unwrap();
        });
        let (client, _) = NodeClient::connect(options(dir.clone())).await.unwrap();
        assert!(matches!(
            client.request::<Value>("wait", json!({})).await,
            Err(ClientError::Closed)
        ));
        server.await.unwrap();
        assert!(matches!(
            client.request::<Value>("late", json!({})).await,
            Err(ClientError::Closed)
        ));
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    #[ignore = "requires the isolated Docker SSH harness"]
    async fn remote_ssh_bundle_handshake_snapshot_request_and_notification() {
        if std::env::var_os("NETA_REMOTE_INTEGRATION").is_none() {
            return;
        }
        let remote = RemoteNode {
            ssh_destination: std::env::var("NETA_REMOTE_SSH_DESTINATION").unwrap(),
            ssh_executable: PathBuf::from("ssh"),
            ssh_config: Some(PathBuf::from(
                std::env::var_os("NETA_REMOTE_SSH_CONFIG").unwrap(),
            )),
            remote_neta_dir: PathBuf::from(std::env::var_os("NETA_REMOTE_NETA_DIR").unwrap()),
            remote_launcher: Some(Launcher {
                executable: PathBuf::from(std::env::var_os("NETA_REMOTE_NODE_EXECUTABLE").unwrap()),
                args: serde_json::from_str(&std::env::var("NETA_REMOTE_NODE_ARGS_JSON").unwrap())
                    .unwrap(),
            }),
            local_working_directory: std::env::current_dir().unwrap(),
        };
        let options = ConnectOptions {
            neta_dir: PathBuf::from("/must-not-start-local-node"),
            launcher: Launcher {
                executable: PathBuf::from("/must/not/run"),
                args: Vec::new(),
            },
            timeout: Duration::from_secs(15),
            remote: Some(remote),
        };
        let (client, mut notifications) = NodeClient::connect(options).await.unwrap();
        assert!(client.is_remote());
        assert!(client.descriptor_path().starts_with(std::env::temp_dir()));
        let opened = client.open_workspace(Path::new("/repo")).await.unwrap();
        assert!(!opened.workspace.id.is_empty());
        let snapshot = client.snapshot().await.unwrap();
        assert!(snapshot
            .workspaces
            .iter()
            .any(|workspace| workspace.id == opened.workspace.id));
        let leader = snapshot
            .leaders
            .iter()
            .find(|leader| leader.workspace_id == opened.workspace.id)
            .unwrap();
        let session_id = leader.session_id.clone();
        let _: Value = client
            .request(
                "conversation.tail",
                json!({"sessionId":session_id.clone(), "limit":1, "direction":"backward"}),
            )
            .await
            .unwrap();
        let prompted: Value = client
            .request(
                "conversation.prompt",
                json!({"sessionId":session_id.clone(), "text":"remote transport turn"}),
            )
            .await
            .unwrap();
        let turn_id = prompted["turnId"].as_str().unwrap().to_owned();
        let (assistant_reply, completed_turn) =
            tokio::time::timeout(Duration::from_secs(5), async {
                let mut assistant_reply = false;
                let mut completed_turn = false;
                loop {
                    let notification = notifications.recv().await.unwrap();
                    if notification.method == "turn"
                        && notification.params["sessionId"] == session_id
                    {
                        let block = &notification.params["block"];
                        assistant_reply |= block["turnId"] == turn_id
                            && block["role"] == "agent"
                            && block["kind"] == "text"
                            && block["text"] == "echo:remote transport turn";
                        let turn = &notification.params["turn"];
                        completed_turn |= turn["id"] == turn_id
                            && turn["endedAt"].is_string()
                            && turn["failed"] == false;
                        if assistant_reply && completed_turn {
                            break (assistant_reply, completed_turn);
                        }
                    }
                }
            })
            .await
            .unwrap();
        assert!(assistant_reply);
        assert!(completed_turn);
        let descriptor_path = client.descriptor_path().to_owned();
        drop(client);
        assert!(!descriptor_path.exists());
    }

    #[tokio::test]
    async fn authentication_refusal_is_returned_without_spawning() {
        let (dir, listener) = fixture("auth", "wrong").await;
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = tokio::io::split(stream);
            let mut read = BufReader::new(read);
            let mut line = String::new();
            read.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let reply = json!({"jsonrpc":"2.0","id":request["id"],"error":{
                "code":-32000,"message":"wrong token","data":{"code":"UNAUTHORIZED"}
            }});
            write
                .write_all(&serde_json::to_vec(&reply).unwrap())
                .await
                .unwrap();
            write.write_all(b"\n").await.unwrap();
        });
        let error = match NodeClient::connect(options(dir.clone())).await {
            Ok(_) => panic!("authentication unexpectedly succeeded"),
            Err(error) => error,
        };
        assert!(
            matches!(error, ClientError::Rpc(RpcError { symbol: Some(symbol), .. }) if symbol == "UNAUTHORIZED")
        );
        server.await.unwrap();
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn optional_cursors_are_omitted_from_mission_and_archive_requests() {
        let (dir, listener) = fixture("optional-cursors", "secret").await;
        let server = tokio::spawn(async move {
            let (mut read, mut write) = accept_hello(listener).await;
            for (expected_method, result) in [
                ("missions.list", json!({"missions":[]})),
                (
                    "conversation.tail",
                    json!({"sessionId":"saved","blocks":[]}),
                ),
                ("conversation.untail", json!({})),
            ] {
                let mut line = String::new();
                read.read_line(&mut line).await.unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["method"], expected_method);
                assert!(request["params"].get("cursor").is_none());
                let reply = json!({"jsonrpc":"2.0","id":request["id"],"result":result});
                write
                    .write_all(&serde_json::to_vec(&reply).unwrap())
                    .await
                    .unwrap();
                write.write_all(b"\n").await.unwrap();
            }
        });
        let (client, _) = NodeClient::connect(options(dir.clone())).await.unwrap();
        client.list_missions("workspace", None).await.unwrap();
        client.archive_tail("saved", None).await.unwrap();
        server.await.unwrap();
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
