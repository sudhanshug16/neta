mod app;
mod diagnostics;
mod hosts;

use std::{
    collections::{HashMap, HashSet},
    error::Error,
    ffi::CString,
    io::{self, Read, Write},
    os::unix::ffi::OsStrExt,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncWriteExt, process::Command as TokioCommand};

use app::App;
use crossterm::{
    event::{
        DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEventKind,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures_util::StreamExt;
use hosts::{HostId, HostTransport, ScopedTarget, SessionKey};
use neta_client::{
    ConnectOptions, HostRegistry, LauncherConfig, NodeClient, Notification, SavedHost,
};
use neta_protocol::{ConversationTail, Snapshot};
use neta_terminal::{
    clipboard::Osc52Parser,
    input::{key_token, mouse_sequence},
    local_pi_process,
};
use ratatui::{backend::CrosstermBackend, layout::Rect, Terminal};
use ratatui_rmux::PaneDriver;
use rmux_sdk::{
    EnsureSession, EnsureSessionPolicy, PaneOutputChunk, Rmux, SessionName, TerminalSizeSpec,
    WindowRef,
};
use tokio::sync::mpsc;

type Result<T = ()> = std::result::Result<T, Box<dyn Error>>;

struct TerminalGuard;
impl TerminalGuard {
    fn enter() -> Result<Self> {
        enable_raw_mode()?;
        execute!(
            std::io::stdout(),
            EnterAlternateScreen,
            EnableMouseCapture,
            EnableBracketedPaste
        )?;
        Ok(Self)
    }
}

static READY_MARKER_ID: AtomicU64 = AtomicU64::new(0);

fn editor_ready(marker_dir: &std::path::Path, expected_session_id: &str) -> bool {
    std::fs::read_to_string(marker_dir.join("editor-ready"))
        .ok()
        .is_some_and(|session_id| session_id == expected_session_id)
}

struct CreatedDriver {
    driver: PaneDriver,
    marker_dir: PathBuf,
    session_root: PathBuf,
}

fn client_root_input(target: &ScopedTarget, root: PathBuf) -> diagnostics::ClientRootInput {
    diagnostics::ClientRootInput {
        host_id: target.key.host_id.as_str().into(),
        workspace_id: target.workspace_id.clone(),
        session_id: target.session_id.clone(),
        provider: target.provider.clone(),
        model: target.model.clone(),
        root,
    }
}

#[cfg(test)]
mod readiness_tests {
    use super::*;

    #[test]
    fn accepts_only_the_current_drivers_exact_session_marker() {
        let marker_dir = std::env::temp_dir().join(format!(
            "neta-rmux-ready-test-{}-{}",
            std::process::id(),
            READY_MARKER_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&marker_dir).unwrap();
        std::fs::write(marker_dir.join("editor-ready"), "leader").unwrap();
        assert!(editor_ready(&marker_dir, "leader"));
        assert!(!editor_ready(&marker_dir, "other"));
        std::fs::remove_dir_all(marker_dir).unwrap();
    }
}

enum NodeCommand {
    Snapshot {
        host_id: HostId,
    },
    Open {
        host_id: HostId,
        request_id: u64,
        path: PathBuf,
    },
    LoadArchives {
        host_id: HostId,
        workspace_id: String,
        cursor: Option<String>,
        leader: Option<(String, String)>,
    },
    LoadArchiveTail {
        host_id: HostId,
        request_id: u64,
        archive: app::ArchivedConversation,
        cursor: Option<String>,
    },
    ExportArchive {
        host_id: HostId,
        archive: app::ArchivedConversation,
        path: PathBuf,
    },
    FollowupObjective {
        host_id: HostId,
        archive: app::ArchivedConversation,
    },
}

enum NodeUpdate {
    Connected {
        host_id: HostId,
        generation: u64,
        client: NodeClient,
        notifications: mpsc::Receiver<Notification>,
        transport: HostTransport,
        workspace_root: PathBuf,
    },
    Snapshot {
        host_id: HostId,
        generation: u64,
        workspace_id: String,
        snapshot: Snapshot,
        open_request: Option<u64>,
    },
    Error {
        host_id: HostId,
        generation: u64,
        message: String,
        fatal: bool,
        open_request: Option<u64>,
    },
    Archives {
        host_id: HostId,
        generation: u64,
        workspace_id: String,
        archives: Vec<app::ArchivedConversation>,
        next_cursor: Option<String>,
    },
    ArchiveTail {
        host_id: HostId,
        generation: u64,
        request_id: u64,
        archive: app::ArchivedConversation,
        tail: ConversationTail,
        older: bool,
    },
    ArchiveFailed {
        host_id: HostId,
        generation: u64,
        request_id: u64,
        message: String,
    },
    ArchiveExported {
        host_id: HostId,
        generation: u64,
        path: String,
    },
    DiagnosticsExported {
        result: std::result::Result<String, String>,
    },
    DiscoveredHostHome {
        request: u64,
        submission: app::HostFormSubmission,
        result: std::result::Result<PathBuf, String>,
    },
    FollowupObjective {
        host_id: HostId,
        generation: u64,
        archive: app::ArchivedConversation,
        objective: String,
    },
    FollowupFailed {
        host_id: HostId,
        generation: u64,
        message: String,
    },
}

struct HostRuntime {
    generation: u64,
    commands: mpsc::Sender<NodeCommand>,
    client: Option<NodeClient>,
    transport: HostTransport,
    snapshot: Option<Snapshot>,
    workspace_id: Option<String>,
}

fn refresh_workspace_choices(
    app: &mut App,
    snapshots: &HashMap<HostId, Snapshot>,
    runtimes: &HashMap<HostId, HostRuntime>,
) {
    let live_hosts: HashSet<HostId> = runtimes
        .iter()
        .filter_map(|(host_id, runtime)| runtime.snapshot.as_ref().map(|_| host_id.clone()))
        .collect();
    let mut choices = Vec::new();
    for (host_id, snapshot) in snapshots {
        for workspace in &snapshot.workspaces {
            let running = snapshot
                .missions
                .iter()
                .filter(|mission| {
                    mission.workspace_id == workspace.id && mission.state == "running"
                })
                .count();
            let needs_you = snapshot
                .missions
                .iter()
                .filter(|mission| {
                    mission.workspace_id == workspace.id
                        && matches!(
                            mission.state.as_str(),
                            "blocked" | "failed" | "readyToClose" | "mergedNotClosed"
                        )
                })
                .count();
            let Some(root) = workspace.roots.first() else {
                continue;
            };
            let configured_label = app
                .hosts
                .iter()
                .find(|host| host.id == *host_id)
                .map(|host| host.label.as_str())
                .unwrap_or(snapshot.machine.name.as_str());
            let host_label = if configured_label == snapshot.machine.name {
                configured_label.to_owned()
            } else {
                format!("{} · {configured_label}", snapshot.machine.name)
            };
            choices.push(app::WorkspaceChoice {
                host_id: host_id.clone(),
                workspace_id: workspace.id.clone(),
                name: workspace.name.clone(),
                path: root.path.clone(),
                host_label,
                connected: live_hosts.contains(host_id),
                running,
                needs_you,
            });
        }
    }
    choices.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.host_label.cmp(&right.host_label))
            .then_with(|| left.host_id.cmp(&right.host_id))
            .then_with(|| left.workspace_id.cmp(&right.workspace_id))
    });
    app.set_live_hosts(live_hosts);
    app.set_workspace_choices(choices);
}

#[cfg(test)]
mod workspace_status_tests {
    use super::*;
    use neta_protocol::{Machine, Workspace, WorkspaceRoot};
    use ratatui_rmux::PaneState;

    fn snapshot(machine: &str, workspaces: &[(&str, &str)]) -> Snapshot {
        Snapshot {
            machine: Machine {
                name: machine.into(),
            },
            workspaces: workspaces
                .iter()
                .map(|(id, name)| Workspace {
                    id: (*id).into(),
                    name: (*name).into(),
                    roots: vec![WorkspaceRoot {
                        machine_id: None,
                        path: format!("/{id}"),
                    }],
                })
                .collect(),
            leaders: vec![],
            missions: vec![],
            agents: vec![],
        }
    }

    fn runtime(snapshot: Option<Snapshot>) -> HostRuntime {
        let (commands, _) = mpsc::channel(1);
        HostRuntime {
            commands,
            client: None,
            transport: HostTransport {
                descriptor_path: PathBuf::from("/tmp/neta-node.json"),
                local_working_directory: PathBuf::from("/tmp"),
                remote: false,
            },
            snapshot,
            workspace_id: None,
        }
    }

    #[test]
    fn status_uses_live_runtime_snapshots_not_workspace_or_saved_host_counts() {
        let local = HostId::local();
        let remote = HostId::saved("remote").unwrap();
        let other = HostId::saved("other").unwrap();
        let connecting = HostId::saved("connecting").unwrap();
        let local_snapshot = snapshot("local", &[("one", "one"), ("two", "two")]);
        let remote_snapshot = snapshot("noscrubsblr.local", &[("cached", "cached")]);
        let other_snapshot = snapshot("other", &[("third", "third")]);
        let mut app = App::default();
        app.set_hosts(vec![
            app::HostChoice {
                id: local.clone(),
                label: "Local".into(),
            },
            app::HostChoice {
                id: remote.clone(),
                label: "Remote".into(),
            },
            app::HostChoice {
                id: other.clone(),
                label: "Other".into(),
            },
            app::HostChoice {
                id: connecting.clone(),
                label: "Connecting".into(),
            },
        ]);
        app.select_host(remote.clone());
        app.replace_snapshot(remote_snapshot.clone());
        app.nav_focused = true;

        let snapshots = HashMap::from([
            (local.clone(), local_snapshot.clone()),
            (remote.clone(), remote_snapshot.clone()),
            (other.clone(), other_snapshot.clone()),
        ]);
        let mut runtimes = HashMap::from([
            (local, runtime(Some(local_snapshot))),
            (other.clone(), runtime(Some(other_snapshot))),
            (connecting, runtime(None)),
        ]);
        refresh_workspace_choices(&mut app, &snapshots, &runtimes);

        assert_eq!(app.workspace_choices.len(), 4);
        assert_eq!(
            app.workspace_choices
                .iter()
                .filter(|choice| choice.connected)
                .count(),
            3
        );
        let normal = app::render_buffer(&mut app, &PaneState::default(), Rect::new(0, 0, 80, 30));
        let normal_text: String = normal.content().iter().map(|cell| cell.symbol()).collect();
        assert!(normal_text.contains("ALL · NOSCRUB"));
        assert!(!normal_text.contains("NOSCRUBSBLR.LOCAL"));
        assert!(normal_text.contains("OFFLINE · 2 CONNECTED"));

        let narrow = app::render_buffer(&mut app, &PaneState::default(), Rect::new(0, 0, 40, 20));
        let narrow_text: String = narrow.content().iter().map(|cell| cell.symbol()).collect();
        assert!(narrow_text.contains("ALL · NOSCRUBSBLR.LOCAL"));
        assert!(narrow_text.contains("OFFLINE · 2 CONNECTED"));

        runtimes.insert(remote.clone(), runtime(Some(remote_snapshot.clone())));
        refresh_workspace_choices(&mut app, &snapshots, &runtimes);
        let connected =
            app::render_buffer(&mut app, &PaneState::default(), Rect::new(0, 0, 80, 30));
        let connected_text: String = connected
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(connected_text.contains("CONNECTED · 3 MACHINES"));

        runtimes.remove(&remote);
        refresh_workspace_choices(&mut app, &snapshots, &runtimes);
        let disconnected =
            app::render_buffer(&mut app, &PaneState::default(), Rect::new(0, 0, 80, 30));
        let disconnected_text: String = disconnected
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(disconnected_text.contains("OFFLINE · 2 CONNECTED"));
    }
}

async fn export_archive(
    client: &NodeClient,
    host_id: &str,
    archive: &app::ArchivedConversation,
    path: &std::path::Path,
) -> std::result::Result<(), String> {
    let parent = path.parent().ok_or("destination has no parent")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| error.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let pages_dir = {
        let mut created = None;
        for attempt in 0..32u32 {
            let candidate = parent.join(format!(
                ".neta-archive-{}-{stamp}-{attempt}",
                std::process::id()
            ));
            match tokio::fs::create_dir(&candidate).await {
                Ok(()) => {
                    tokio::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o700))
                        .await
                        .map_err(|error| error.to_string())?;
                    created = Some(candidate);
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        created.ok_or("could not create private archive staging directory")?
    };
    let mut pages = Vec::new();
    let mut seen_cursors = HashSet::new();
    let mut cursor: Option<String> = None;
    let result = async {
    loop {
        if let Some(cursor) = cursor.as_deref() {
            if !seen_cursors.insert(cursor.to_owned()) { return Err("archive cursor cycle detected".into()); }
        }
        let mut params = serde_json::json!({"sessionId": archive.session_id, "limit": 50, "direction": "backward"});
        if let Some(value) = cursor.as_deref() { params["cursor"] = serde_json::Value::String(value.to_owned()); }
        let raw_page: serde_json::Value = client.request("conversation.tail", params).await.map_err(|error| error.to_string())?;
        if raw_page.get("sessionId").and_then(serde_json::Value::as_str) != Some(archive.session_id.as_str()) {
            return Err("archive response belongs to a different session".into());
        }
        let prev = raw_page.get("prevCursor").and_then(serde_json::Value::as_str).map(str::to_owned);
        let page = pages_dir.join(format!("{:08}.json", pages.len()));
        let bytes = serde_json::to_vec(&raw_page).map_err(|error| error.to_string())?;
        let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&page).await.map_err(|error| error.to_string())?;
        tokio::fs::set_permissions(&page, std::fs::Permissions::from_mode(0o600)).await.map_err(|error| error.to_string())?;
        file.write_all(&bytes).await.map_err(|error| error.to_string())?;
        file.flush().await.map_err(|error| error.to_string())?;
        pages.push(page);
        match prev { Some(next) if cursor.as_ref() != Some(&next) => cursor = Some(next), Some(_) => return Err("archive cursor did not advance".into()), None => break }
    }
    let temporary = pages_dir.join("export.json");
    let mut output = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).await.map_err(|error| error.to_string())?;
    tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).await.map_err(|error| error.to_string())?;
    let first_page: serde_json::Value = serde_json::from_slice(&tokio::fs::read(pages.last().ok_or("archive returned no pages")?).await.map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    let header = serde_json::json!({"schemaVersion":1,"scope":"archived session","hostId":host_id,"workspaceId":archive.workspace_id,"missionId":archive.mission_id,"agentId":archive.agent_id,"sessionId":archive.session_id,"agentName":archive.agent_name,"missionName":archive.mission_name,"provider":first_page.get("provider"),"model":first_page.get("model")});
    let header_text = serde_json::to_string(&header).map_err(|error| error.to_string())?;
    output.write_all(header_text.trim_end_matches('}').as_bytes()).await.map_err(|error| error.to_string())?;
    output.write_all(b",\"pages\":[").await.map_err(|error| error.to_string())?;
    let mut first = true;
    for page in pages.iter().rev() {
        let bytes = tokio::fs::read(page).await.map_err(|error| error.to_string())?;
        if !first { output.write_all(b",").await.map_err(|error| error.to_string())?; }
        output.write_all(&bytes).await.map_err(|error| error.to_string())?;
        first = false;
    }
    output.write_all(b"]}\n").await.map_err(|error| error.to_string())?;
    output.flush().await.map_err(|error| error.to_string())?;
    tokio::fs::hard_link(&temporary, path).await.map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists { "destination already exists".into() } else { error.to_string() })?;
    Ok(())
    }.await;
    let _ = tokio::fs::remove_dir_all(&pages_dir).await;
    result
}

enum NotificationAction {
    Ignore,
    Refresh,
    Fatal(String),
}
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(
            std::io::stdout(),
            DisableBracketedPaste,
            DisableMouseCapture,
            LeaveAlternateScreen
        );
        let _ = disable_raw_mode();
    }
}

async fn discover_remote_home(
    destination: &str,
    ssh_config: Option<&str>,
) -> std::result::Result<PathBuf, String> {
    if destination.is_empty()
        || destination.starts_with('-')
        || destination.chars().any(char::is_control)
    {
        return Err("SSH destination is invalid".into());
    }
    let marker = "__NETA_HOME__";
    let mut ssh = TokioCommand::new("ssh");
    ssh.kill_on_drop(true).stdin(std::process::Stdio::null());
    if let Some(config) = ssh_config.filter(|value| !value.trim().is_empty()) {
        ssh.arg("-F").arg(config);
    }
    ssh.args([
        "-o",
        "ForwardAgent=no",
        "-o",
        "ConnectTimeout=5",
        "--",
        destination,
        &format!("printf '%s%s\\n' {marker} \"$HOME\""),
    ]);
    let output = tokio::time::timeout(Duration::from_secs(10), ssh.output())
        .await
        .map_err(|_| "SSH home discovery timed out".to_owned())?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let home = stdout
        .lines()
        .find_map(|line| line.strip_prefix(marker))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "SSH returned no home directory".to_owned())?;
    let path = PathBuf::from(home);
    if !path.is_absolute() {
        return Err("SSH returned a non-absolute home directory".into());
    }
    Ok(path)
}

#[tokio::main]
async fn main() -> Result {
    let options = ConnectOptions::from_environment()?;
    let base_options = options.clone();
    let mut saved_hosts = HostRegistry::load(HostRegistry::default_path(&options.neta_dir))?;
    let node_executable = options.launcher.executable.clone();
    let remote = options.remote.clone();
    let (client, node_events) = NodeClient::connect(options).await?;
    let descriptor = client.descriptor_path().to_owned();
    let remote_transport = client.is_remote();
    let local_pi_directory = remote
        .as_ref()
        .map(|remote| remote.local_working_directory.clone())
        .unwrap_or(std::env::current_dir()?);
    let workspace_root = if remote_transport {
        std::env::var_os("NETA_REMOTE_WORKSPACE_ROOT")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .ok_or("NETA_REMOTE_WORKSPACE_ROOT is required for a remote Node")?
    } else {
        std::env::var_os("NETA_WORKSPACE_ROOT")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?)
    };
    let local_transport = HostTransport {
        descriptor_path: descriptor.clone(),
        local_working_directory: local_pi_directory.clone(),
        remote: remote_transport,
    };
    let (node_command_tx, node_command_rx) = mpsc::channel(32);
    let (node_update_tx, mut node_update_rx) = mpsc::channel(32);
    let diagnostics_client = client.clone();
    tokio::spawn(run_node_actor(
        HostId::local(),
        0,
        client,
        node_events,
        node_command_rx,
        node_update_tx.clone(),
    ));
    node_command_tx
        .send(NodeCommand::Open {
            host_id: HostId::local(),
            request_id: 0,
            path: workspace_root,
        })
        .await?;
    let first = tokio::time::timeout(Duration::from_secs(8), node_update_rx.recv())
        .await?
        .ok_or("Neta Node actor closed before its first snapshot")?;
    let (workspace_id, snapshot) = match first {
        NodeUpdate::Snapshot {
            workspace_id,
            snapshot,
            ..
        } => (workspace_id, snapshot),
        NodeUpdate::Error { message, .. } => return Err(message.into()),
        NodeUpdate::Connected { .. } => {
            return Err("Neta Node actor connected a second host before its first snapshot".into())
        }
        NodeUpdate::Archives { .. }
        | NodeUpdate::ArchiveTail { .. }
        | NodeUpdate::ArchiveFailed { .. }
        | NodeUpdate::ArchiveExported { .. }
        | NodeUpdate::DiagnosticsExported { .. }
        | NodeUpdate::DiscoveredHostHome { .. }
        | NodeUpdate::FollowupObjective { .. }
        | NodeUpdate::FollowupFailed { .. } => {
            return Err("Neta Node actor sent archive data before initial snapshot".into())
        }
    };
    let mut host_runtimes = HashMap::from([(
        HostId::local(),
        HostRuntime {
            generation: 0,
            commands: node_command_tx.clone(),
            client: Some(diagnostics_client),
            transport: local_transport,
            snapshot: Some(snapshot.clone()),
            workspace_id: Some(workspace_id.clone()),
        },
    )]);
    let mut cached_snapshots = HashMap::from([(HostId::local(), snapshot.clone())]);
    let mut saved_hosts_by_id: HashMap<HostId, _> = saved_hosts
        .hosts()
        .iter()
        .filter_map(|host| HostId::saved(&host.id).ok().map(|id| (id, host.clone())))
        .collect();
    let mut connecting_hosts = HashSet::new();
    let mut host_generations = HashMap::from([(HostId::local(), 0_u64)]);
    let mut stale_sessions = HashSet::new();
    let mut failed_panes: HashMap<SessionKey, String> = HashMap::new();
    let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let pi_executable = std::env::var("NETA_PI_EXECUTABLE")
        .unwrap_or_else(|_| node_executable.to_string_lossy().into_owned());
    let pi_cli = std::env::var("NETA_PI_CLI").unwrap_or_else(|_| {
        source_root
            .join("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")
            .to_string_lossy()
            .into_owned()
    });
    if !PathBuf::from(&pi_cli).is_file() {
        return Err(format!("Pi runtime does not exist: {pi_cli}").into());
    }
    let acp_extension = std::env::var("NETA_PI_ACP_EXTENSION").unwrap_or_else(|_| {
        source_root
            .join("src/rmux/pi-acp-extension.ts")
            .to_string_lossy()
            .into_owned()
    });
    if !PathBuf::from(&acp_extension).is_file() {
        return Err(format!("Pi ACP extension does not exist: {acp_extension}").into());
    }
    if std::env::var_os("RMUX_SDK_DAEMON_BINARY").is_none() {
        let daemon = source_root.join(".cache/rmux/libexec/rmux/rmux");
        if !daemon.is_file() {
            return Err(format!(
                "rmux runtime does not exist at {}; run scripts/install-rmux-runtime.sh",
                daemon.display()
            )
            .into());
        }
        std::env::set_var("RMUX_SDK_DAEMON_BINARY", daemon);
    }
    let socket = isolated_socket();
    let rmux = Rmux::builder()
        .unix_socket(&socket)
        .default_timeout(Duration::from_secs(8))
        .connect_or_start()
        .await
        .map_err(|error| {
            format!(
                "start isolated rmux daemon at {}: {error}",
                socket.display()
            )
        })?;
    let first_target = ScopedTarget::new(
        HostId::local(),
        snapshot
            .leader_target(&workspace_id)
            .ok_or("workspace has no local leader")?,
    )?;
    let mut app = App::default();
    app.set_hosts(
        std::iter::once(app::HostChoice {
            id: HostId::local(),
            label: "Local machine".into(),
        })
        .chain(saved_hosts.hosts().iter().filter_map(|host| {
            HostId::saved(&host.id).ok().map(|id| app::HostChoice {
                id,
                label: host.display_name.clone(),
            })
        }))
        .collect(),
    );
    app.workspace_id = Some(workspace_id);
    app.replace_snapshot_for_host(&HostId::local(), snapshot);
    app.active_target = Some(first_target.clone());
    app.add_tab(first_target.clone());
    if let Some(snapshot) = cached_snapshots.get(&first_target.key.host_id) {
        app.sync_tab_presentations(&first_target.key.host_id, snapshot);
    }
    refresh_workspace_choices(&mut app, &cached_snapshots, &host_runtimes);
    let (cols, rows) = crossterm::terminal::size()?;
    let initial_area = App::initial_pane_area(Rect::new(0, 0, cols, rows));
    let (output_tx, mut output_rx) = mpsc::channel(256);
    let first_driver = create_driver(
        &rmux,
        &first_target,
        &pi_executable,
        &pi_cli,
        &acp_extension,
        initial_area,
        output_tx.clone(),
        &descriptor,
        &local_pi_directory,
        remote_transport,
    )
    .await
    .map_err(|error| format!("start Pi target {}: {error}", first_target.name))?;
    let mut drivers = HashMap::from([(first_target.key.clone(), first_driver.driver)]);
    let mut readiness_markers =
        HashMap::from([(first_target.key.clone(), first_driver.marker_dir)]);
    let mut diagnostics_client_roots = HashMap::from([(
        first_target.key.clone(),
        client_root_input(&first_target, first_driver.session_root),
    )]);
    let mut active_session = first_target.key.clone();
    let mut pane_sizes = HashMap::from([(
        active_session.clone(),
        (initial_area.width, initial_area.height),
    )]);
    let mut clipboard_parsers: HashMap<SessionKey, Osc52Parser> = HashMap::new();
    // A follow-up is always addressed to the leader's fully scoped session.
    // Keeping that tag until Pi has marked its editor ready avoids sending a
    // draft to the archived pane or losing it while a new leader pane starts.
    let mut pending_draft: Option<(SessionKey, String)> = None;
    let mut diagnostics_job: Option<(
        diagnostics::ExportCancellation,
        tokio::task::JoinHandle<()>,
    )> = None;
    let mut host_discovery_jobs: HashMap<u64, tokio::task::JoinHandle<()>> = HashMap::new();

    let _guard = TerminalGuard::enter()?;
    let mut terminal = Terminal::new(CrosstermBackend::new(std::io::stdout()))?;
    terminal.clear()?;
    let mut events = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_millis(40));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut running = true;
    let mut terminal_size = None;
    while running {
        if let Some(request) = app.take_cancelled_host_discovery() {
            if let Some(job) = host_discovery_jobs.remove(&request) {
                job.abort();
            }
        }
        let size = crossterm::terminal::size()?;
        if terminal_size != Some(size) {
            terminal.resize(Rect::new(0, 0, size.0, size.1))?;
            terminal_size = Some(size);
        }
        let driver = drivers
            .get(&active_session)
            .ok_or("active rmux pane missing")?;
        terminal.draw(|frame| app.render(frame, driver.state()))?;
        if !failed_panes.contains_key(&active_session) {
            resize_pane(&rmux, &app, &active_session, driver, &mut pane_sizes).await?;
        }
        tokio::select! {
            _ = tick.tick() => { if !failed_panes.contains_key(&active_session) { if let Some(driver) = drivers.get_mut(&active_session) { if let Err(error) = driver.refresh().await { app.error = Some(error.to_string()); } } } }
            update = node_update_rx.recv() => match update {
                Some(NodeUpdate::Connected { host_id, generation, client, notifications, transport, workspace_root }) => {
                    if host_generations.get(&host_id) != Some(&generation) { continue; }
                    connecting_hosts.remove(&host_id);
                    let (commands, command_rx) = mpsc::channel(32);
                    let diagnostics_client = client.clone();
                    tokio::spawn(run_node_actor(host_id.clone(), generation, client, notifications, command_rx, node_update_tx.clone()));
                    host_runtimes.insert(host_id.clone(), HostRuntime {
                        generation,
                        commands: commands.clone(),
                        client: Some(diagnostics_client),
                        transport,
                        snapshot: None,
                        workspace_id: None,
                    });
                    refresh_workspace_choices(&mut app, &cached_snapshots, &host_runtimes);
                    let requested = app.requested_host.as_ref() == Some(&host_id);
                    let command = if workspace_root.as_os_str().is_empty() {
                        NodeCommand::Snapshot { host_id: host_id.clone() }
                    } else {
                        let request_id = app.next_open_request();
                        if requested {
                            app.begin_open(request_id);
                        }
                        NodeCommand::Open { host_id: host_id.clone(), request_id, path: workspace_root }
                    };
                    if let Err(error) = commands.try_send(command) {
                        app.error = Some(format!("cannot queue selected machine: {error}"));
                    }
                }
                Some(NodeUpdate::Snapshot { host_id, generation, workspace_id, snapshot, open_request }) => {
                    if host_runtimes.get(&host_id).is_none_or(|runtime| runtime.generation != generation) { continue; }
                    let Some(runtime) = host_runtimes.get_mut(&host_id) else { continue; };
                    runtime.workspace_id = (!workspace_id.is_empty()).then_some(workspace_id.clone());
                    runtime.snapshot = Some(snapshot.clone());
                    cached_snapshots.insert(host_id.clone(), snapshot.clone());
                    refresh_workspace_choices(&mut app, &cached_snapshots, &host_runtimes);
                    app.sync_tab_presentations(&host_id, &snapshot);
                    if app.requested_host.as_ref() == Some(&host_id) {
                        app.select_host(host_id.clone());
                    }
                    if app.selected_host != host_id { continue; }
                    let host_changed = app.active_target.as_ref().is_some_and(|target| target.key.host_id != host_id);
                    let changed = !workspace_id.is_empty()
                        && (host_changed || app.workspace_id.as_deref() != Some(&workspace_id));
                    let active_stale = app.active_target.as_ref().is_some_and(|target| stale_sessions.contains(&target.key));
                    let active_present = app.active_target.as_ref().is_some_and(|target| {
                        target.key.host_id == host_id
                            && (snapshot.leaders.iter().any(|leader| {
                                leader.workspace_id == target.workspace_id
                                    && leader.session_id == target.session_id
                            })
                                || snapshot.agents.iter().any(|agent| {
                                    agent.session_id == target.session_id
                                        && snapshot.missions.iter().any(|mission| {
                                            mission.id == agent.mission_id
                                                && mission.workspace_id == target.workspace_id
                                        })
                                }))
                    });
                    if !workspace_id.is_empty() {
                        app.workspace_id = Some(workspace_id);
                    } else {
                        app.workspace_id = None;
                        app.active_target = None;
                        app.picker = true;
                        app.picker_path_mode = false;
                        app.nav_focused = true;
                    }
                    app.replace_snapshot_for_host(&host_id, snapshot);
                    if let Some(request_id) = open_request {
                        app.finish_open(request_id, None);
                    }
                    if changed || (active_stale && !active_present) {
                        app.select_leader();
                    } else if active_stale
                        && app.active_target.as_ref().is_none_or(|target| !failed_panes.contains_key(&target.key))
                    {
                        app.refresh_active_target();
                    }
                }
                Some(NodeUpdate::Error { host_id, generation, message, fatal, open_request }) => {
                    if host_generations.get(&host_id) != Some(&generation) { continue; }
                    if host_runtimes.get(&host_id).is_some_and(|runtime| runtime.generation != generation) { continue; }
                    connecting_hosts.remove(&host_id);
                    if fatal {
                        host_runtimes.remove(&host_id);
                        stale_sessions.extend(
                            drivers.keys().filter(|key| key.host_id == host_id).cloned(),
                        );
                        app.mark_tabs_offline(&host_id);
                    }
                    refresh_workspace_choices(&mut app, &cached_snapshots, &host_runtimes);
                    let requested = app.requested_host.as_ref() == Some(&host_id);
                    if requested {
                        app.requested_host = None;
                    }
                    if !requested && app.selected_host != host_id { continue; }
                    if let Some(request_id) = open_request {
                        app.finish_open(request_id, Some(message.clone()));
                    } else {
                        app.error = Some(message.clone());
                    }
                    // A Node disconnect is scoped to its host.  Other Node
                    // actors and their panes remain usable.
                    if fatal { app.error = Some(message); }
                }
                Some(NodeUpdate::Archives { host_id, generation, workspace_id, archives, next_cursor }) => if host_runtimes.get(&host_id).is_some_and(|runtime| runtime.generation == generation) && app.selected_host == host_id { app.set_archives(&workspace_id, archives, next_cursor) },
                Some(NodeUpdate::ArchiveTail { host_id, generation, request_id, archive, tail, older }) => if host_runtimes.get(&host_id).is_some_and(|runtime| runtime.generation == generation) && app.selected_host == host_id { app.set_saved_transcript(request_id, archive, tail.blocks, tail.prev_cursor, older) },
                Some(NodeUpdate::ArchiveFailed { host_id, generation, request_id, message }) => if host_runtimes.get(&host_id).is_some_and(|runtime| runtime.generation == generation) && app.selected_host == host_id { app.archive_failed(request_id, message) },
                Some(NodeUpdate::ArchiveExported { host_id, generation, path }) => if host_runtimes.get(&host_id).is_some_and(|runtime| runtime.generation == generation) && app.selected_host == host_id { app.error = Some(format!("Exported archived session to {path}")); },
                Some(NodeUpdate::DiagnosticsExported { result }) => { diagnostics_job = None; app.finish_diagnostics_export(result); },
                Some(NodeUpdate::DiscoveredHostHome { request, mut submission, result }) if app.finish_host_discovery(request) => match result {
                    Ok(home) => { submission.fields[2] = home.join(".neta").display().to_string(); app.pending_add_host = Some(submission); }
                    Err(error) => { app.add_host_form = true; app.editing_host = submission.editing; app.add_host_fields = submission.fields; app.error = Some(format!("could not discover remote home: {error}")); }
                },
                Some(NodeUpdate::DiscoveredHostHome { .. }) => {},
                Some(NodeUpdate::FollowupObjective { host_id, generation, archive, objective }) => if host_runtimes.get(&host_id).is_some_and(|runtime| runtime.generation == generation) { app.set_followup_objective(&host_id, &archive, objective) },
                Some(NodeUpdate::FollowupFailed { host_id, generation, message }) => if host_runtimes.get(&host_id).is_some_and(|runtime| runtime.generation == generation) && app.fixed_preview.as_ref().is_some_and(|preview| preview.host_id == host_id) { app.followup_failed(message) },
                None => { running = false; }
            },
            Some((session_id, chunk)) = output_rx.recv() => {
                let parser = clipboard_parsers.entry(session_id.clone()).or_default();
                match chunk {
                    PaneOutputChunk::Bytes { bytes, .. } => {
                        if session_id == active_session && !failed_panes.contains_key(&session_id) {
                        for sequence in parser.feed(&bytes) { std::io::stdout().write_all(&sequence)?; std::io::stdout().flush()?; }
                        } else { parser.reset(); }
                    }
                    PaneOutputChunk::Lag(_) => parser.reset(),
                    _ => {}
                }
            }
            Some(event) = events.next() => {
                match event? {
                    Event::Key(key) if key.kind == KeyEventKind::Press => {
                        let driver = drivers.get(&active_session).ok_or("active rmux pane missing")?;
                        running = handle_key(&mut app, driver, &host_runtimes, failed_panes.contains_key(&active_session), key).await?;
                    }
                    Event::Paste(text) => {
                        if let Some(path) = &mut app.diagnostics_export_path {
                            path.push_str(&text);
                        } else if app.is_read_only_archive() || app.tab_overflow_open {
                            continue;
                        } else if app.picker {
                            if app.host_picker && app.add_host_form { app.add_host_fields[app.add_host_field].push_str(&text); }
                            else { app.picker_input.push_str(&text); app.picker_cursor = 0; }
                        } else if !app.nav_focused && !app.help && !app.is_read_only_archive() {
                            if failed_panes.contains_key(&active_session) { app.error = Some("Pi pane unavailable — reselect the tab to retry".into()); continue; }
                            if !host_runtimes.contains_key(&active_session.host_id) { app.error = Some("Machine offline — reconnect to send".into()); continue; }
                            drivers.get(&active_session).ok_or("active rmux pane missing")?.pane().send_text(format!("\x1b[200~{text}\x1b[201~")).await?;
                        }
                    }
                    Event::Mouse(mouse) => {
                        if app.diagnostics_export_path.is_some() {
                            continue;
                        } else if app.tab_overflow_open {
                            if matches!(mouse.kind, MouseEventKind::Down(_)) {
                                if let Some(session_id) = app.overflow_tab_at((mouse.column, mouse.row)) {
                                    app.select_tab(&session_id);
                                } else if !app.overflow_at((mouse.column, mouse.row)) {
                                    app.toggle_tab_overflow();
                                }
                            }
                            continue;
                        }
                        if app.is_read_only_archive() {
                            match mouse.kind {
                                MouseEventKind::ScrollUp => app.scroll_saved(-3),
                                MouseEventKind::ScrollDown => app.scroll_saved(3),
                                _ => {}
                            }
                            continue;
                        } else if app.picker || app.help {
                            continue;
                        } else if matches!(mouse.kind, MouseEventKind::Down(_)) && app.host_header_at((mouse.column, mouse.row)) {
                            app.open_host_picker();
                        } else if matches!(mouse.kind, MouseEventKind::Down(_)) && app.status_filter_at((mouse.column, mouse.row)) {
                            app.nav_focused = true;
                            app.cycle_status_filter();
                        } else if matches!(mouse.kind, MouseEventKind::Down(_)) && app.sidebar_area.contains((mouse.column, mouse.row).into()) {
                            app.nav_focused = true;
                            if let Some(row) = app.row_at((mouse.column, mouse.row)) {
                                app.cursor = row;
                                app.activate();
                            }
                        } else if matches!(mouse.kind, MouseEventKind::Down(_)) && app.overflow_tab_at((mouse.column, mouse.row)).is_some() {
                            if let Some(session_id) = app.overflow_tab_at((mouse.column, mouse.row)) { app.select_tab(&session_id); }
                        } else if matches!(mouse.kind, MouseEventKind::Down(_)) && app.overflow_at((mouse.column, mouse.row)) {
                            app.toggle_tab_overflow();
                        } else if matches!(mouse.kind, MouseEventKind::Down(_)) && app.tab_close_at((mouse.column, mouse.row)).is_some() {
                            if let Some(session_id) = app.tab_close_at((mouse.column, mouse.row)) { app.close_tab(&session_id); }
                        } else if matches!(mouse.kind, MouseEventKind::Down(_)) && app.tab_at((mouse.column, mouse.row)).is_some() {
                            if let Some(session_id) = app.tab_at((mouse.column, mouse.row)) { app.select_tab(&session_id); }
                        } else if app.pane_area.contains((mouse.column, mouse.row).into()) {
                            app.nav_focused = false;
                            if !app.is_read_only_archive() {
                                if failed_panes.contains_key(&active_session) { app.error = Some("Pi pane unavailable — reselect the tab to retry".into()); continue; }
                                if !host_runtimes.contains_key(&active_session.host_id) { app.error = Some("Machine offline — reconnect to send".into()); continue; }
                                if let Some(sequence) = mouse_sequence(mouse, app.pane_area.x, app.pane_area.y) { drivers.get(&active_session).ok_or("active rmux pane missing")?.pane().send_text(sequence).await?; }
                            }
                        }
                    }
                    Event::Resize(_, _) => {}
                    _ => {}
                }
            }
        }
        if let Some(path) = app.take_diagnostics_export() {
            let inputs = app
                .hosts
                .iter()
                .map(|host| {
                    let client = host_runtimes
                        .get(&host.id)
                        .filter(|runtime| runtime.snapshot.is_some())
                        .and_then(|runtime| runtime.client.clone());
                    diagnostics::HostInput {
                        id: host.id.as_str().into(),
                        label: host.label.clone(),
                        unavailable: client.is_none().then_some("no fresh snapshot".into()),
                        client,
                    }
                })
                .collect();
            let client_roots = diagnostics_client_roots.values().cloned().collect();
            let updates = node_update_tx.clone();
            let cancellation = diagnostics::ExportCancellation::default();
            let task_cancellation = cancellation.clone();
            diagnostics_job = Some((
                cancellation,
                tokio::spawn(async move {
                    let destination = PathBuf::from(path);
                    let display = destination.display().to_string();
                    let result = diagnostics::export_all(
                        destination,
                        inputs,
                        client_roots,
                        task_cancellation,
                    )
                    .await
                    .map(|summary| {
                        if summary.complete {
                            display
                        } else {
                            format!("{display} (partial)")
                        }
                    });
                    let _ = updates
                        .send(NodeUpdate::DiagnosticsExported { result })
                        .await;
                }),
            ));
        }
        if let Some(host_id) = app.take_host() {
            if let Some(runtime) = host_runtimes.get(&host_id) {
                if let Some(snapshot) = &runtime.snapshot {
                    app.select_host(host_id.clone());
                    if let Some(workspace_id) = &runtime.workspace_id {
                        app.workspace_id = Some(workspace_id.clone());
                    }
                    app.replace_snapshot_for_host(&host_id, snapshot.clone());
                    app.select_leader();
                }
            } else if connecting_hosts.insert(host_id.clone()) {
                let generation = {
                    let next = host_generations.entry(host_id.clone()).or_insert(0);
                    *next = next.wrapping_add(1);
                    *next
                };
                let Some(saved) = saved_hosts_by_id.get(&host_id).cloned() else {
                    connecting_hosts.remove(&host_id);
                    app.error = Some(format!("unknown machine: {host_id}"));
                    continue;
                };
                let workspace_root = saved.last_remote_workspace_path.clone().unwrap_or_default();
                app.requested_host = Some(host_id.clone());
                let local_directory = std::env::current_dir()?;
                let remote = saved.remote_node(local_directory.clone())?;
                let connect_options = ConnectOptions {
                    neta_dir: base_options.neta_dir.clone(),
                    launcher: base_options.launcher.clone(),
                    timeout: base_options.timeout,
                    remote: Some(remote),
                };
                let updates = node_update_tx.clone();
				tokio::spawn(async move {
                    match NodeClient::connect(connect_options).await {
                        Ok((client, notifications)) => {
                            let transport = HostTransport {
                                descriptor_path: client.descriptor_path().to_owned(),
                                local_working_directory: local_directory,
                                remote: client.is_remote(),
                            };
                            let _ = updates
                                .send(NodeUpdate::Connected {
                                    host_id,
                                    generation,
                                    client,
                                    notifications,
                                    transport,
                                    workspace_root,
                                })
                                .await;
                        }
                        Err(error) => {
                            let _ = updates
                                .send(NodeUpdate::Error {
                                    host_id,
                                    generation,
                                    message: error.to_string(),
                                    fatal: false,
                                    open_request: None,
                                })
                                .await;
                        }
                    }
                });
            }
        }
        if let Some(choice) = app.take_workspace_choice() {
            if !choice.connected {
                app.error = Some(format!(
                    "{} is offline; cached workspace cannot open",
                    choice.host_label
                ));
                continue;
            }
            let Some(runtime) = host_runtimes.get(&choice.host_id) else {
                app.error = Some(format!(
                    "{} disconnected before workspace switch",
                    choice.host_label
                ));
                continue;
            };
            if let Some(tab) = app
                .tabs
                .iter()
                .find(|tab| {
                    tab.key.host_id == choice.host_id && tab.workspace_id == choice.workspace_id
                })
                .cloned()
            {
                app.select_tab(&tab.key);
                if let Some(snapshot) = cached_snapshots.get(&choice.host_id).cloned() {
                    app.select_host(choice.host_id.clone());
                    app.replace_snapshot_for_host(&choice.host_id, snapshot);
                }
                app.workspace_id = Some(choice.workspace_id);
                app.picker = false;
                app.nav_focused = false;
                continue;
            }
            let request_id = app.next_open_request();
            if let Err(error) = runtime.commands.try_send(NodeCommand::Open {
                host_id: choice.host_id.clone(),
                request_id,
                path: PathBuf::from(choice.path),
            }) {
                app.error = Some(format!("cannot queue workspace switch: {error}"));
            } else {
                app.requested_host = Some(choice.host_id);
                app.begin_open(request_id);
            }
        }
        if let Some(host_id) = app.take_edit_host() {
            let Some(saved_id) = host_id.as_str().strip_prefix("saved:") else {
                app.error = Some("Local machine cannot be edited".into());
                continue;
            };
            let Some(host) = saved_hosts.get(saved_id) else {
                app.error = Some("saved machine no longer exists".into());
                continue;
            };
            app.open_edit_host(
                host_id,
                [
                    host.ssh_destination.clone(),
                    host.display_name.clone(),
                    host.remote_neta_dir.display().to_string(),
                    host.last_remote_workspace_path
                        .as_ref()
                        .map(|path| path.display().to_string())
                        .unwrap_or_default(),
                    host.ssh_config
                        .as_ref()
                        .map(|path| path.display().to_string())
                        .unwrap_or_default(),
                    host.remote_launcher
                        .as_ref()
                        .map(|launcher| launcher.executable.display().to_string())
                        .unwrap_or_default(),
                ],
            );
        }
        if let Some(submission) = app.take_add_host() {
            let original_submission = submission.clone();
            let [destination, display_name, remote_neta_dir, workspace, ssh_config, remote_launcher] =
                submission.fields;
            if remote_neta_dir.trim().is_empty() {
                let Some(request) = app.begin_host_discovery() else {
                    continue;
                };
                let updates = node_update_tx.clone();
                let mut retry = original_submission;
                retry.fields = [
                    destination.clone(),
                    display_name,
                    remote_neta_dir,
                    workspace,
                    ssh_config.clone(),
                    remote_launcher,
                ];
                let job = tokio::spawn(async move {
                    let result = discover_remote_home(&destination, Some(&ssh_config)).await;
                    let _ = updates
                        .send(NodeUpdate::DiscoveredHostHome {
                            request,
                            submission: retry,
                            result,
                        })
                        .await;
                });
                host_discovery_jobs.insert(request, job);
                continue;
            }
            if !PathBuf::from(&remote_neta_dir).is_absolute()
                || (!workspace.trim().is_empty() && !PathBuf::from(&workspace).is_absolute())
            {
                app.error =
                    Some("remote NETA dir and workspace must be absolute remote paths".into());
                continue;
            }
            let editing_id = submission
                .editing
                .as_ref()
                .and_then(|host_id| host_id.as_str().strip_prefix("saved:"));
            let id = editing_id.map(str::to_owned).unwrap_or_else(|| {
                format!(
                    "host-{:x}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .expect("system clock after epoch")
                        .as_nanos()
                )
            });
            let prior = editing_id.and_then(|id| saved_hosts.get(id));
            let host = SavedHost {
                id: id.clone(),
                display_name: if display_name.trim().is_empty() {
                    destination.clone()
                } else {
                    display_name
                },
                ssh_destination: destination,
                ssh_config: (!ssh_config.trim().is_empty()).then(|| PathBuf::from(ssh_config)),
                remote_neta_dir: PathBuf::from(remote_neta_dir),
                remote_launcher: (!remote_launcher.trim().is_empty()).then(|| LauncherConfig {
                    executable: PathBuf::from(remote_launcher),
                    args: prior
                        .and_then(|host| host.remote_launcher.as_ref())
                        .map(|launcher| launcher.args.clone())
                        .unwrap_or_default(),
                }),
                last_remote_workspace_path: (!workspace.trim().is_empty())
                    .then(|| PathBuf::from(workspace)),
            };
            let saved = if submission.editing.is_some() {
                saved_hosts.update(&id, host.clone())
            } else {
                saved_hosts.insert(host.clone())
            };
            match saved {
                Ok(()) => {
                    let host_id = HostId::saved(&id)?;
                    if submission.editing.is_some() {
                        *host_generations.entry(host_id.clone()).or_insert(0) = host_generations
                            .get(&host_id)
                            .copied()
                            .unwrap_or(0)
                            .wrapping_add(1);
                        // A saved ID is stable across edits. Drop its local forwarding
                        // resources and every pane that was bound to the prior endpoint;
                        // selecting it again establishes a fresh descriptor and snapshot.
                        host_runtimes.remove(&host_id);
                        cached_snapshots.remove(&host_id);
                        connecting_hosts.remove(&host_id);
                        app.mark_tabs_offline(&host_id);
                        let discarded: Vec<_> = drivers
                            .keys()
                            .filter(|key| key.host_id == host_id)
                            .cloned()
                            .collect();
                        for key in discarded {
                            if let Ok(session) =
                                rmux.session(SessionName::new(key.rmux_name())?).await
                            {
                                let _ = session.kill().await;
                            }
                            drivers.remove(&key);
                            if let Some(marker) = readiness_markers.remove(&key) {
                                let _ = std::fs::remove_dir_all(marker);
                            }
                            diagnostics_client_roots.remove(&key);
                            pane_sizes.remove(&key);
                            clipboard_parsers.remove(&key);
                            stale_sessions.remove(&key);
                            failed_panes.remove(&key);
                        }
                        if active_session.host_id == host_id {
                            let local = drivers
                                .keys()
                                .find(|key| key.host_id == HostId::local())
                                .cloned()
                                .ok_or("local Pi pane missing after machine edit")?;
                            active_session = local.clone();
                            app.select_tab(&local);
                        }
                    }
                    saved_hosts_by_id.insert(host_id, host);
                    app.set_hosts(
                        std::iter::once(app::HostChoice {
                            id: HostId::local(),
                            label: "Local machine".into(),
                        })
                        .chain(saved_hosts.hosts().iter().filter_map(|host| {
                            HostId::saved(&host.id).ok().map(|id| app::HostChoice {
                                id,
                                label: host.display_name.clone(),
                            })
                        }))
                        .collect(),
                    );
                    app.add_host_form = false;
                    app.picker_cursor = app.hosts.len().saturating_sub(1);
                    app.add_host_fields = std::array::from_fn(|_| String::new());
                    app.add_host_field = 0;
                    app.editing_host = None;
                }
                Err(error) => app.error = Some(error.to_string()),
            }
        }
        if let Some(host_id) = app.take_remove_host() {
            let Some(saved_id) = host_id.as_str().strip_prefix("saved:") else {
                app.error = Some("Local machine cannot be removed".into());
                continue;
            };
            match saved_hosts.remove(saved_id) {
                Ok(_) => {
                    *host_generations.entry(host_id.clone()).or_insert(0) = host_generations
                        .get(&host_id)
                        .copied()
                        .unwrap_or(0)
                        .wrapping_add(1);
                    saved_hosts_by_id.remove(&host_id);
                    host_runtimes.remove(&host_id);
                    cached_snapshots.remove(&host_id);
                    connecting_hosts.remove(&host_id);
                    app.mark_tabs_offline(&host_id);
                    let discarded: Vec<_> = drivers
                        .keys()
                        .filter(|key| key.host_id == host_id)
                        .cloned()
                        .collect();
                    for key in discarded {
                        if let Ok(session) = rmux.session(SessionName::new(key.rmux_name())?).await
                        {
                            let _ = session.kill().await;
                        }
                        drivers.remove(&key);
                        if let Some(marker) = readiness_markers.remove(&key) {
                            let _ = std::fs::remove_dir_all(marker);
                        }
                        diagnostics_client_roots.remove(&key);
                        pane_sizes.remove(&key);
                        clipboard_parsers.remove(&key);
                        stale_sessions.remove(&key);
                        failed_panes.remove(&key);
                    }
                    app.set_hosts(
                        std::iter::once(app::HostChoice {
                            id: HostId::local(),
                            label: "Local machine".into(),
                        })
                        .chain(saved_hosts.hosts().iter().filter_map(|host| {
                            HostId::saved(&host.id).ok().map(|id| app::HostChoice {
                                id,
                                label: host.display_name.clone(),
                            })
                        }))
                        .collect(),
                    );
                    if active_session.host_id == host_id {
                        let local = drivers
                            .keys()
                            .find(|key| key.host_id == HostId::local())
                            .cloned()
                            .ok_or("local Pi pane missing after machine removal")?;
                        active_session = local.clone();
                        app.select_tab(&local);
                    }
                    app.error = Some(
                        "Forgot saved SSH connection; remote files and service were not changed"
                            .into(),
                    );
                }
                Err(error) => app.error = Some(error.to_string()),
            }
        }
        if app.take_archive_load() {
            if let Some(workspace_id) = app.workspace_id.clone() {
                let Some(runtime) = host_runtimes.get(&app.selected_host) else {
                    app.error = Some("selected machine is disconnected".into());
                    continue;
                };
                let _ = runtime.commands.try_send(NodeCommand::LoadArchives {
                    host_id: app.selected_host.clone(),
                    workspace_id,
                    cursor: app.archive_next_cursor.clone(),
                    leader: app.workspace_id.as_deref().and_then(|workspace_id| {
                        app.snapshot.as_ref().and_then(|snapshot| {
                            snapshot
                                .leaders
                                .iter()
                                .find(|leader| leader.workspace_id == workspace_id)
                                .map(|leader| (leader.name.clone(), leader.session_id.clone()))
                        })
                    }),
                });
            }
        }
        if let Some((request_id, archive, cursor)) = app.take_archive_tail() {
            let Some(runtime) = host_runtimes.get(&app.selected_host) else {
                app.archive_failed(request_id, "selected machine is disconnected".into());
                continue;
            };
            if let Err(error) = runtime.commands.try_send(NodeCommand::LoadArchiveTail {
                host_id: app.selected_host.clone(),
                request_id,
                archive,
                cursor,
            }) {
                app.archive_failed(
                    request_id,
                    format!("cannot queue saved transcript: {error}"),
                );
            }
        }
        if let Some((archive, path)) = app.take_archive_export() {
            let host_id = app.selected_host.clone();
            let Some(runtime) = host_runtimes.get(&host_id) else {
                app.error = Some("selected machine is disconnected".into());
                continue;
            };
            if let Err(error) = runtime.commands.try_send(NodeCommand::ExportArchive {
                host_id,
                archive,
                path: PathBuf::from(path),
            }) {
                app.error = Some(format!("cannot queue archive export: {error}"));
            }
        }
        if let Some((host_id, archive)) = app.take_followup_objective_request() {
            let Some(runtime) = host_runtimes.get(&host_id) else {
                app.followup_failed("source mission host is disconnected".into());
                continue;
            };
            if let Err(error) = runtime
                .commands
                .try_send(NodeCommand::FollowupObjective { host_id, archive })
            {
                app.followup_failed(format!("cannot load source mission objective: {error}"));
            }
        }
        if let Some(target) = app.take_target() {
            {
                let followup_draft = app.take_followup_draft();
                let replacing_stale = stale_sessions.contains(&target.key);
                let previous = app
                    .tabs
                    .iter()
                    .find(|tab| tab.key == active_session && drivers.contains_key(&tab.key))
                    .cloned();
                if host_runtimes.contains_key(&target.key.host_id) && replacing_stale {
                    let session_name = SessionName::new(target.key.rmux_name())?;
                    if let Ok(session) = rmux.session(session_name).await {
                        let _ = session.kill().await;
                    }
                }
                if replacing_stale || !drivers.contains_key(&target.key) {
                    let Some(transport) = host_runtimes
                        .get(&target.key.host_id)
                        .map(|runtime| &runtime.transport)
                    else {
                        app.error = Some(format!(
                            "cannot open Pi target {}: target host missing",
                            target.name
                        ));
                        if let Some(previous) = previous {
                            active_session = previous.key.clone();
                            app.select_tab(&previous.key);
                            let _ = app.take_target();
                            if let Some(snapshot) = cached_snapshots.get(&previous.key.host_id) {
                                app.replace_snapshot_for_host(
                                    &previous.key.host_id,
                                    snapshot.clone(),
                                );
                            }
                        }
                        continue;
                    };
                    let created = match create_driver(
                        &rmux,
                        &target,
                        &pi_executable,
                        &pi_cli,
                        &acp_extension,
                        app.pane_area,
                        output_tx.clone(),
                        &transport.descriptor_path,
                        &transport.local_working_directory,
                        transport.remote,
                    )
                    .await
                    {
                        Ok(created) => created,
                        Err(error) => {
                            if replacing_stale {
                                failed_panes.insert(target.key.clone(), error.to_string());
                                active_session = target.key.clone();
                                let presentation_host = target.key.host_id.clone();
                                app.add_tab(target);
                                if let Some(snapshot) = cached_snapshots.get(&presentation_host) {
                                    app.sync_tab_presentations(&presentation_host, snapshot);
                                }
                                app.error = Some(format!(
                                    "Pi pane unavailable — reselect the tab to retry: {error}"
                                ));
                                continue;
                            }
                            app.error =
                                Some(format!("cannot open Pi target {}: {error}", target.name));
                            if let Some(previous) = previous {
                                active_session = previous.key.clone();
                                app.select_tab(&previous.key);
                                let _ = app.take_target();
                                if let Some(snapshot) = cached_snapshots.get(&previous.key.host_id)
                                {
                                    app.replace_snapshot_for_host(
                                        &previous.key.host_id,
                                        snapshot.clone(),
                                    );
                                }
                            }
                            continue;
                        }
                    };
                    if let Some(marker_dir) =
                        readiness_markers.insert(target.key.clone(), created.marker_dir)
                    {
                        let _ = std::fs::remove_dir_all(marker_dir);
                    }
                    diagnostics_client_roots.insert(
                        target.key.clone(),
                        client_root_input(&target, created.session_root),
                    );
                    drivers.insert(target.key.clone(), created.driver);
                    pane_sizes.insert(
                        target.key.clone(),
                        (app.pane_area.width, app.pane_area.height),
                    );
                    if replacing_stale {
                        stale_sessions.remove(&target.key);
                        failed_panes.remove(&target.key);
                        app.error = None;
                    }
                }
                active_session = target.key.clone();
                let presentation_host = target.key.host_id.clone();
                if !failed_panes.contains_key(&active_session)
                    && app
                        .error
                        .as_deref()
                        .is_some_and(|error| error.starts_with("Pi pane unavailable"))
                {
                    app.error = None;
                }
                app.add_tab(target);
                if let Some(draft) = followup_draft {
                    pending_draft = Some((active_session.clone(), draft));
                }
                if let Some(snapshot) = cached_snapshots.get(&presentation_host) {
                    app.sync_tab_presentations(&presentation_host, snapshot);
                }
            }
        }
        if let Some((session_id, draft)) = pending_draft.take() {
            if failed_panes.contains_key(&session_id) {
                app.error = Some("Pi pane unavailable — reselect the tab to retry".into());
                pending_draft = Some((session_id, draft));
            } else if session_id == active_session
                && readiness_markers
                    .get(&session_id)
                    .is_some_and(|marker_dir| editor_ready(marker_dir, &session_id.session_id))
            {
                // Bracketed paste inserts without clearing the editor or
                // submitting it.
                drivers
                    .get(&session_id)
                    .ok_or("follow-up leader pane missing")?
                    .pane()
                    .send_text(format!("\x1b[200~{draft}\x1b[201~"))
                    .await?;
            } else {
                pending_draft = Some((session_id, draft));
            }
        }
    }
    terminal.show_cursor()?;
    if let Some((cancellation, mut job)) = diagnostics_job {
        cancellation.cancel();
        if tokio::time::timeout(Duration::from_secs(5), &mut job)
            .await
            .is_err()
        {
            job.abort();
        }
    }
    rmux.shutdown().await?;
    for marker_dir in readiness_markers.into_values() {
        let _ = std::fs::remove_dir_all(marker_dir);
    }
    let _ = std::fs::remove_file(socket);
    Ok(())
}

async fn run_node_actor(
    host_id: HostId,
    generation: u64,
    client: NodeClient,
    mut notifications: mpsc::Receiver<Notification>,
    mut commands: mpsc::Receiver<NodeCommand>,
    updates: mpsc::Sender<NodeUpdate>,
) {
    let mut workspace_id: Option<String> = None;
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(NodeCommand::Snapshot { host_id: command_host }) if command_host == host_id => match client.snapshot().await {
                    Ok(snapshot) => {
                        let selected_workspace_id = snapshot.workspaces.first().map(|workspace| workspace.id.clone()).unwrap_or_default();
                        workspace_id = (!selected_workspace_id.is_empty()).then_some(selected_workspace_id.clone());
                        if updates.send(NodeUpdate::Snapshot { host_id: host_id.clone(), generation, workspace_id: selected_workspace_id, snapshot, open_request: None }).await.is_err() { return; }
                    }
                    Err(error) => {
                        let _ = updates.send(NodeUpdate::Error { host_id: host_id.clone(), generation, message: error.to_string(), fatal: false, open_request: None }).await;
                    }
                },
                Some(NodeCommand::Open { host_id: command_host, request_id, path }) if command_host == host_id => match client.open_workspace(&path).await {
                    Ok(opened) => {
                        workspace_id = Some(opened.workspace.id.clone());
                        match client.snapshot().await {
                            Ok(snapshot) => {
                                if updates.send(NodeUpdate::Snapshot { host_id: host_id.clone(), generation, workspace_id: opened.workspace.id, snapshot, open_request: Some(request_id) }).await.is_err() { return; }
                            }
                            Err(error) => {
                                let _ = updates.send(NodeUpdate::Error { host_id: host_id.clone(), generation, message: error.to_string(), fatal: false, open_request: Some(request_id) }).await;
                            }
                        }
                    }
                    Err(error) => {
                        let _ = updates.send(NodeUpdate::Error { host_id: host_id.clone(), generation, message: error.to_string(), fatal: false, open_request: Some(request_id) }).await;
                    }
                },
                Some(NodeCommand::LoadArchives { host_id: command_host, workspace_id, cursor, leader }) if command_host == host_id => {
                    match client.list_missions(&workspace_id, cursor.as_deref()).await {
                        Ok(page) => {
                            let mut archives = Vec::new();
                            for mission in page.missions {
                                match client.mission_detail(&mission.id).await {
                                    Ok(detail) => {
                                        let closed = mission.state == "closed";
                                        for agent in detail.agents.into_iter().filter(|agent| closed || agent.state == "archived") {
                                            if !archives.iter().any(|archive: &app::ArchivedConversation| archive.agent_id == agent.id) {
                                                archives.push(app::ArchivedConversation { workspace_id: workspace_id.clone(), agent_id: agent.id, session_id: agent.session_id, mission_id: mission.id.clone(), mission_name: mission.name.clone(), agent_name: agent.name, task: agent.task });
                                            }
                                        }
                                        if closed && matches!(mission.lead, neta_protocol::MissionLead::Leader) {
                                            if let Some((leader_name, leader_session_id)) = &leader {
                                                let archive_id = format!("{}:leader", mission.id);
                                                if !archives.iter().any(|archive: &app::ArchivedConversation| archive.agent_id == archive_id) {
                                                    archives.push(app::ArchivedConversation { workspace_id: workspace_id.clone(), agent_id: archive_id, session_id: leader_session_id.clone(), mission_id: mission.id.clone(), mission_name: mission.name.clone(), agent_name: leader_name.clone(), task: "Workspace leader · shared conversation".into() });
                                                }
                                            }
                                        }
                                    }
                                    Err(error) => { let _ = updates.send(NodeUpdate::Error { host_id: host_id.clone(), generation, message: error.to_string(), fatal: false, open_request: None }).await; }
                                }
                            }
                            if updates.send(NodeUpdate::Archives { host_id: host_id.clone(), generation, workspace_id, archives, next_cursor: page.next_cursor }).await.is_err() { return; }
                        }
                        Err(error) => { let _ = updates.send(NodeUpdate::Error { host_id: host_id.clone(), generation, message: error.to_string(), fatal: false, open_request: None }).await; }
                    }
                }
                Some(NodeCommand::LoadArchiveTail { host_id: command_host, request_id, archive, cursor }) if command_host == host_id => match client.archive_tail(&archive.session_id, cursor.as_deref()).await {
                    Ok(tail) => { if updates.send(NodeUpdate::ArchiveTail { host_id: host_id.clone(), generation, request_id, archive, tail, older: cursor.is_some() }).await.is_err() { return; } }
                    Err(error) => { let _ = updates.send(NodeUpdate::ArchiveFailed { host_id: host_id.clone(), generation, request_id, message: error.to_string() }).await; }
                },
                Some(NodeCommand::ExportArchive { host_id: command_host, archive, path }) if command_host == host_id => {
                    let result = export_archive(&client, command_host.as_str(), &archive, &path).await;
                    let update = match result { Ok(()) => NodeUpdate::ArchiveExported { host_id: host_id.clone(), generation, path: path.display().to_string() }, Err(error) => NodeUpdate::Error { host_id: host_id.clone(), generation, message: format!("archive export failed: {error}"), fatal: false, open_request: None } };
                    if updates.send(update).await.is_err() { return; }
                },
                Some(NodeCommand::FollowupObjective { host_id: command_host, archive }) if command_host == host_id => {
                    let response = client
                        .request::<serde_json::Value>("missions.get", serde_json::json!({"missionId": archive.mission_id}))
                        .await
                        .map_err(|error| error.to_string());
                    let update = match response {
                        Ok(response) => match response.pointer("/mission/objective").and_then(serde_json::Value::as_str) {
                            Some(objective) => NodeUpdate::FollowupObjective {
                                host_id: host_id.clone(), generation, archive, objective: objective.to_owned(),
                            },
                            None => NodeUpdate::FollowupFailed {
                                host_id: host_id.clone(), generation, message: "source mission has no original objective".into(),
                            },
                        },
                        Err(error) => NodeUpdate::FollowupFailed {
                            host_id: host_id.clone(), generation, message: format!("could not load source mission objective: {error}"),
                        },
                    };
                    if updates.send(update).await.is_err() { return; }
                },
                Some(_) => continue,
                None => return,
            },
            notification = notifications.recv() => match notification {
                Some(notification) => match notification_action(notification, &mut notifications) {
                    NotificationAction::Ignore => {}
                    NotificationAction::Refresh => {
                        let Some(selected) = workspace_id.clone() else { continue; };
                        match client.snapshot().await {
                            Ok(snapshot) => {
                                if updates.send(NodeUpdate::Snapshot { host_id: host_id.clone(), generation, workspace_id: selected, snapshot, open_request: None }).await.is_err() { return; }
                            }
                            Err(error) => {
                                let _ = updates.send(NodeUpdate::Error { host_id: host_id.clone(), generation, message: error.to_string(), fatal: false, open_request: None }).await;
                            }
                        }
                    }
                    NotificationAction::Fatal(message) => {
                        let _ = updates.send(NodeUpdate::Error { host_id: host_id.clone(), generation, message, fatal: true, open_request: None }).await;
                        return;
                    }
                }
                None => {
                    let _ = updates.send(NodeUpdate::Error { host_id: host_id.clone(), generation, message: "Neta Node connection closed".into(), fatal: true, open_request: None }).await;
                    return;
                }
            }
        }
    }
}

fn notification_action(
    first: Notification,
    notifications: &mut mpsc::Receiver<Notification>,
) -> NotificationAction {
    let mut refresh = false;
    let mut fatal = None;
    for notification in
        std::iter::once(first).chain(std::iter::from_fn(|| notifications.try_recv().ok()))
    {
        if notification.method == "state" || notification.method == "event" {
            refresh = true;
        } else if notification.method == "node" {
            let phase = notification
                .params
                .get("phase")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("changed state");
            fatal = Some(format!("Neta Node {phase}"));
        }
    }
    match fatal {
        Some(message) => NotificationAction::Fatal(message),
        None if refresh => NotificationAction::Refresh,
        None => NotificationAction::Ignore,
    }
}

async fn resize_pane(
    rmux: &Rmux,
    app: &App,
    session_id: &SessionKey,
    driver: &PaneDriver,
    sizes: &mut HashMap<SessionKey, (u16, u16)>,
) -> Result {
    let size = (app.pane_area.width, app.pane_area.height);
    if size.0 >= 2 && size.1 >= 2 && sizes.get(session_id) != Some(&size) {
        let target = driver.pane().target();
        rmux.window(WindowRef::new(
            target.session_name.clone(),
            target.window_index,
        ))
        .await?
        .resize(Some(size.0), Some(size.1))
        .await?;
        driver
            .pane()
            .resize(TerminalSizeSpec::new(
                app.pane_area.width,
                app.pane_area.height,
            ))
            .await?;
        sizes.insert(session_id.clone(), size);
    }
    Ok(())
}

async fn handle_key(
    app: &mut App,
    driver: &PaneDriver,
    hosts: &HashMap<HostId, HostRuntime>,
    pane_failed: bool,
    key: KeyEvent,
) -> Result<bool> {
    if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('q')) {
        return Ok(false);
    }
    let navigation_key = (key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char(' ')))
        || key.code == KeyCode::Null;
    let opens_modal = key.code == KeyCode::F(1)
        || (key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('k') | KeyCode::Char('o')));
    if app.copy_view && (navigation_key || opens_modal) {
        app.leave_copy_view();
        if navigation_key {
            return Ok(true);
        }
    }
    if app.is_read_only_archive() {
        if app.fixed_preview.is_some() {
            match key.code {
                KeyCode::Esc => app.cancel_followup_preview(),
                KeyCode::Enter => app.submit_followup_preview(),
                _ => {}
            }
            return Ok(true);
        }
        if let Some(path) = &mut app.export_path {
            match key.code {
                KeyCode::Esc => app.export_path = None,
                KeyCode::Enter => app.submit_archive_export(),
                KeyCode::Backspace => {
                    path.pop();
                }
                KeyCode::Char('u') if key.modifiers == KeyModifiers::CONTROL => {
                    path.clear();
                }
                KeyCode::Char(ch)
                    if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT =>
                {
                    path.push(ch)
                }
                _ => {}
            }
            return Ok(true);
        }
        match key.code {
            KeyCode::Up => app.scroll_saved(-1),
            KeyCode::Down => app.scroll_saved(1),
            KeyCode::End => app.scroll_saved(isize::MAX),
            KeyCode::PageUp => app.request_older_archive(),
            KeyCode::Char('e') => {
                let session = app
                    .saved_transcript
                    .as_ref()
                    .map(|saved| saved.archive.session_id.clone())
                    .unwrap_or_default();
                let path =
                    std::env::current_dir()?.join(format!("neta-archived-session-{session}.json"));
                app.begin_archive_export(path.display().to_string());
            }
            KeyCode::Char('f') => app.begin_followup_preview(),
            KeyCode::Esc => {
                app.clear_saved_transcript();
                app.nav_focused = true;
            }
            _ => {}
        }
        return Ok(true);
    }
    if let Some(path) = &mut app.diagnostics_export_path {
        match key.code {
            KeyCode::Esc => app.diagnostics_export_path = None,
            KeyCode::Enter => app.submit_diagnostics_export(),
            KeyCode::Backspace => {
                path.pop();
            }
            KeyCode::Char('u') if key.modifiers == KeyModifiers::CONTROL => path.clear(),
            KeyCode::Char(ch)
                if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT =>
            {
                path.push(ch)
            }
            _ => {}
        }
        return Ok(true);
    }
    if key.code == KeyCode::F(1) {
        if app.help {
            app.help = false;
            app.help_scroll = 0;
            return Ok(true);
        }
        app.help = true;
        app.help_scroll = 0;
        app.picker = false;
        return Ok(true);
    }
    if app.help {
        match key.code {
            KeyCode::Esc | KeyCode::F(1) => {
                app.help = false;
                app.help_scroll = 0;
            }
            KeyCode::Up => app.help_scroll = app.help_scroll.saturating_sub(1),
            KeyCode::Down => app.help_scroll = app.help_scroll.saturating_add(1),
            KeyCode::PageUp => app.help_scroll = app.help_scroll.saturating_sub(8),
            KeyCode::PageDown => app.help_scroll = app.help_scroll.saturating_add(8),
            _ => {}
        }
        return Ok(true);
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('k')) {
        app.picker = true;
        app.host_picker = false;
        app.nav_focused = true;
        app.picker_path_mode = false;
        app.picker_input.clear();
        app.picker_cursor = 0;
        return Ok(true);
    }
    if !app.picker
        && !app.help
        && app.nav_focused
        && key.modifiers.is_empty()
        && matches!(key.code, KeyCode::Char('m') | KeyCode::Char('M'))
    {
        app.open_host_picker();
        return Ok(true);
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('o')) {
        app.picker = true;
        app.host_picker = false;
        app.nav_focused = true;
        app.picker_path_mode = true;
        app.picker_input.clear();
        app.picker_cursor = 0;
        return Ok(true);
    }
    if app.picker {
        if app.host_picker && app.remove_confirmation().is_some() {
            match key.code {
                KeyCode::Esc => app.cancel_remove_host(),
                KeyCode::Enter => app.confirm_remove_host(),
                _ => {}
            }
            return Ok(true);
        }
        if app.host_picker && app.add_host_form {
            if app.host_discovery_request.is_some() {
                if key.code == KeyCode::Esc {
                    app.cancel_host_discovery();
                    app.add_host_form = false;
                    app.editing_host = None;
                }
                return Ok(true);
            }
            match key.code {
                KeyCode::Esc => {
                    app.add_host_form = false;
                    app.editing_host = None;
                }
                KeyCode::Tab | KeyCode::Down => {
                    app.add_host_field = (app.add_host_field + 1) % app::MACHINE_FORM_FIELDS
                }
                KeyCode::BackTab | KeyCode::Up => {
                    app.add_host_field = (app.add_host_field + app::MACHINE_FORM_FIELDS - 1)
                        % app::MACHINE_FORM_FIELDS
                }
                KeyCode::Backspace => {
                    app.add_host_fields[app.add_host_field].pop();
                }
                KeyCode::Enter => {
                    app.pending_add_host = Some(app::HostFormSubmission {
                        editing: app.editing_host.clone(),
                        fields: app.add_host_fields.clone(),
                    });
                }
                KeyCode::Char(ch)
                    if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT =>
                {
                    app.add_host_fields[app.add_host_field].push(ch)
                }
                _ => {}
            }
            return Ok(true);
        }
        match key.code {
            KeyCode::Esc => {
                app.picker = false;
                app.host_picker = false;
            }
            KeyCode::Up => app.picker_move(-1),
            KeyCode::Down => app.picker_move(1),
            KeyCode::Backspace => {
                app.picker_input.pop();
                app.picker_cursor = 0;
            }
            KeyCode::Enter if app.host_picker => {
                if app.picker_cursor == app.hosts.len() {
                    app.open_add_host();
                } else if let Some(host) =
                    app.hosts.get(app.picker_cursor).map(|host| host.id.clone())
                {
                    app.pending_host = Some(host);
                    app.host_picker = false;
                    app.picker = false;
                }
            }
            KeyCode::Char('e') if app.host_picker => app.request_edit_selected_host(),
            KeyCode::Char('d') if app.host_picker => app.request_remove_selected_host(),
            KeyCode::Enter if app.picker_path_mode && !app.picker_input.trim().is_empty() => {
                let path = expand_path(app.picker_input.trim());
                let request_id = app.next_open_request();
                let Some(host) = hosts.get(&app.selected_host) else {
                    app.error = Some("selected machine is disconnected".into());
                    return Ok(true);
                };
                if let Err(error) = host.commands.try_send(NodeCommand::Open {
                    host_id: app.selected_host.clone(),
                    request_id,
                    path,
                }) {
                    app.error = Some(format!("cannot queue project switch: {error}"));
                } else {
                    app.begin_open(request_id);
                }
            }
            KeyCode::Enter if !app.picker_path_mode => {
                app.select_workspace_choice();
            }
            KeyCode::Char(ch)
                if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT =>
            {
                app.picker_input.push(ch);
                app.picker_cursor = 0;
            }
            _ => {}
        }
        return Ok(true);
    }
    if (key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char(' ')))
        || key.code == KeyCode::Null
    {
        app.nav_focused = !app.nav_focused;
        return Ok(true);
    }
    if app.tab_overflow_open {
        match key.code {
            KeyCode::Esc | KeyCode::Char('t') => app.toggle_tab_overflow(),
            KeyCode::Up => app.move_overflow_cursor(-1),
            KeyCode::Down => app.move_overflow_cursor(1),
            KeyCode::Enter => app.select_overflow_cursor(),
            _ => {}
        }
        return Ok(true);
    }
    if app.nav_focused {
        match key.code {
            KeyCode::Char('E') => {
                let path = std::env::current_dir()?.join("neta-session-diagnostics");
                app.begin_diagnostics_export(path.display().to_string());
            }
            KeyCode::Char('c') => app.enter_copy_view(),
            KeyCode::Char('s') => app.cycle_status_filter(),
            KeyCode::Up => app.move_cursor(-1),
            KeyCode::Down => app.move_cursor(1),
            KeyCode::Left => app.expand_selected(false),
            KeyCode::Right => app.expand_selected(true),
            KeyCode::Enter => app.activate(),
            KeyCode::Home => app.move_cursor_home(),
            KeyCode::End => app.move_cursor_end(),
            KeyCode::PageUp => app.move_cursor_page(-1),
            KeyCode::PageDown => app.move_cursor_page(1),
            KeyCode::Char('0') => app.select_leader(),
            KeyCode::Char('[') => app.select_next_tab(-1),
            KeyCode::Char(']') => app.select_next_tab(1),
            KeyCode::Char('x') => app.close_active_tab(),
            KeyCode::Char('t') => app.toggle_tab_overflow(),
            _ => {}
        }
        return Ok(true);
    }
    if let KeyCode::Char(ch) = key.code {
        if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT {
            if pane_failed {
                app.error = Some("Pi pane unavailable — reselect the tab to retry".into());
                return Ok(true);
            }
            if !hosts.contains_key(
                &app.active_target
                    .as_ref()
                    .map(|target| target.key.host_id.clone())
                    .unwrap_or_else(HostId::local),
            ) {
                app.error = Some("Machine offline — reconnect to send".into());
                return Ok(true);
            }
            driver.pane().send_text(ch.to_string()).await?;
            return Ok(true);
        }
    }
    if let Some(token) = key_token(key) {
        if pane_failed {
            app.error = Some("Pi pane unavailable — reselect the tab to retry".into());
            return Ok(true);
        }
        if !hosts.contains_key(
            &app.active_target
                .as_ref()
                .map(|target| target.key.host_id.clone())
                .unwrap_or_else(HostId::local),
        ) {
            app.error = Some("Machine offline — reconnect to send".into());
            return Ok(true);
        }
        driver.pane().send_key(token).await?;
    }
    Ok(true)
}

fn isolated_socket() -> PathBuf {
    std::env::temp_dir().join(format!("neta-rmux-{}.sock", std::process::id()))
}

fn expand_path(input: &str) -> PathBuf {
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(input)
}

#[cfg(test)]
mod node_actor_tests {
    use super::*;
    use serde_json::json;

    fn notification(method: &str, params: serde_json::Value) -> Notification {
        Notification {
            method: method.into(),
            params,
        }
    }

    #[test]
    fn state_and_event_burst_becomes_one_snapshot_action() {
        let (tx, mut rx) = mpsc::channel(8);
        tx.try_send(notification("event", json!({}))).unwrap();
        tx.try_send(notification("turn", json!({}))).unwrap();
        assert!(matches!(
            notification_action(notification("state", json!({})), &mut rx),
            NotificationAction::Refresh
        ));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn node_lifecycle_wins_over_refresh_in_same_burst() {
        let (tx, mut rx) = mpsc::channel(8);
        tx.try_send(notification("state", json!({}))).unwrap();
        tx.try_send(notification("node", json!({"phase":"stopping"})))
            .unwrap();
        assert!(matches!(
            notification_action(notification("event", json!({})), &mut rx),
            NotificationAction::Fatal(message) if message == "Neta Node stopping"
        ));
    }
}

#[cfg(test)]
mod host_routing_tests {
    use super::*;

    fn runtime(commands: mpsc::Sender<NodeCommand>) -> HostRuntime {
        HostRuntime {
            commands,
            client: None,
            transport: HostTransport {
                descriptor_path: PathBuf::from("/tmp/fake/node.json"),
                local_working_directory: PathBuf::from("/tmp/fake"),
                remote: false,
            },
            snapshot: None,
            workspace_id: None,
        }
    }

    #[tokio::test]
    async fn two_host_command_channels_never_cross_route() {
        let local = HostId::local();
        let remote = HostId::saved("fake-remote").unwrap();
        let (local_tx, mut local_rx) = mpsc::channel(1);
        let (remote_tx, mut remote_rx) = mpsc::channel(1);
        let hosts = HashMap::from([
            (local.clone(), runtime(local_tx)),
            (remote.clone(), runtime(remote_tx)),
        ]);

        hosts[&remote]
            .commands
            .send(NodeCommand::Open {
                host_id: remote.clone(),
                request_id: 7,
                path: PathBuf::from("/remote/project"),
            })
            .await
            .unwrap();

        assert!(local_rx.try_recv().is_err());
        match remote_rx.recv().await.expect("remote command") {
            NodeCommand::Open {
                host_id,
                request_id,
                path,
            } => {
                assert_eq!(host_id, remote);
                assert_eq!(request_id, 7);
                assert_eq!(path, PathBuf::from("/remote/project"));
            }
            _ => panic!("expected remote open command"),
        }
    }
}

async fn create_driver(
    rmux: &Rmux,
    target: &ScopedTarget,
    executable: &str,
    pi_cli: &str,
    acp_extension: &str,
    area: Rect,
    output_tx: mpsc::Sender<(SessionKey, PaneOutputChunk)>,
    descriptor: &std::path::Path,
    local_pi_directory: &std::path::Path,
    remote: bool,
) -> Result<CreatedDriver> {
    let session_name = SessionName::new(target.key.rmux_name())?;
    let session_root = prepare_session_root(
        target,
        &std::env::temp_dir().join("neta-rmux-pi-sessions"),
        remote,
    )?;
    let marker_root = std::env::temp_dir().join("neta-rmux-editor-ready");
    std::fs::create_dir_all(&marker_root)?;
    let marker_dir = (0..32)
        .find_map(|_| {
            let candidate = marker_root.join(format!(
                "{}-{}",
                std::process::id(),
                READY_MARKER_ID.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&candidate) {
                Ok(()) => Some(Ok(candidate)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(error)),
            }
        })
        .transpose()?
        .ok_or("could not allocate a private Pi readiness directory")?;
    std::fs::set_permissions(&marker_dir, std::fs::Permissions::from_mode(0o700))?;
    let marker = marker_dir.join("editor-ready");
    let process = local_pi_process(
        &target.target,
        executable,
        pi_cli,
        acp_extension,
        &session_root,
        &marker,
        descriptor,
        remote,
    );
    let session = match rmux
        .ensure_session(
            EnsureSession::named(session_name)
                .policy(EnsureSessionPolicy::CreateOrReuse)
                .detached(true)
                .working_directory(pi_working_directory(target, local_pi_directory, remote))
                .size(TerminalSizeSpec::new(area.width.max(2), area.height.max(2)))
                .window_name(target.name.clone())
                .process(process),
        )
        .await
    {
        Ok(session) => session,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&marker_dir);
            return Err(error.into());
        }
    };
    let pane = session.pane(0, 0);
    let mut stream = match pane.output_stream().await {
        Ok(stream) => stream,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&marker_dir);
            return Err(error.into());
        }
    };
    let stream_session = target.key.clone();
    tokio::spawn(async move {
        loop {
            match stream.next().await {
                Ok(Some(chunk)) => {
                    if output_tx
                        .send((stream_session.clone(), chunk))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                _ => break,
            }
        }
    });
    let mut driver = PaneDriver::new(pane);
    if let Err(error) = driver.refresh().await {
        let _ = std::fs::remove_dir_all(&marker_dir);
        return Err(error.into());
    }
    Ok(CreatedDriver {
        driver,
        marker_dir,
        session_root,
    })
}

fn pi_working_directory(target: &ScopedTarget, local_pi_directory: &Path, remote: bool) -> String {
    if remote {
        local_pi_directory.to_string_lossy().into_owned()
    } else {
        target.cwd.clone()
    }
}

fn prepare_session_root(target: &ScopedTarget, parent: &Path, remote: bool) -> Result<PathBuf> {
    let session_root = parent.join(target.key.cache_component());
    let legacy_root = parent.join(target.key.legacy_cache_component());
    if session_root.exists() {
        return Ok(session_root);
    }

    let legacy = match std::fs::symlink_metadata(&legacy_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            std::fs::create_dir_all(&session_root)?;
            return Ok(session_root);
        }
        Err(error) => return Err(error.into()),
    };
    if !legacy.file_type().is_dir() {
        return preserved_legacy_error(&legacy_root, target);
    }

    let entries = std::fs::read_dir(&legacy_root)?.collect::<std::result::Result<Vec<_>, _>>()?;
    if entries.is_empty() {
        std::fs::create_dir_all(&session_root)?;
        return Ok(session_root);
    }

    if remote
        || !target.key.host_id.as_str().eq("local")
        || !legacy_matches_local_target(&entries, target)?
    {
        return preserved_legacy_error(&legacy_root, target);
    }

    match rename_no_replace(&legacy_root, &session_root) {
        Ok(()) => Ok(session_root),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            preserved_legacy_error(&legacy_root, target)
        }
        Err(error) => Err(error.into()),
    }
}

fn legacy_matches_local_target(
    entries: &[std::fs::DirEntry],
    target: &ScopedTarget,
) -> Result<bool> {
    let mut jsonl_count = 0;
    for entry in entries {
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if !metadata.file_type().is_file() {
            return Ok(false);
        }
        if entry
            .path()
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            jsonl_count += 1;
            let mut first_chunk = Vec::new();
            std::fs::File::open(entry.path())?
                .take(64 * 1024 + 1)
                .read_to_end(&mut first_chunk)?;
            let Some(header_end) = first_chunk.iter().position(|byte| *byte == b'\n') else {
                return Ok(false);
            };
            if header_end > 64 * 1024 {
                return Ok(false);
            }
            let header: LegacyPiSessionHeader =
                match serde_json::from_slice(&first_chunk[..header_end]) {
                    Ok(header) => header,
                    Err(_) => return Ok(false),
                };
            if header.entry_type != "session"
                || header.id != target.session_id
                || header.cwd != target.cwd
            {
                return Ok(false);
            }
        }
    }
    Ok(jsonl_count > 0)
}

#[derive(serde::Deserialize)]
struct LegacyPiSessionHeader {
    #[serde(rename = "type")]
    entry_type: String,
    id: String,
    cwd: String,
}

fn preserved_legacy_error<T>(legacy_root: &Path, target: &ScopedTarget) -> Result<T> {
    Err(format!("preserved legacy Pi session data at {}; no history was deleted; export or migrate it before opening workspace {}", legacy_root.display(), target.workspace_id).into())
}

#[cfg(target_os = "macos")]
fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_no_replace(_source: &Path, _destination: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Pi legacy migration requires macOS or Linux no-replace rename support",
    ))
}

#[cfg(test)]
mod archive_export_tests {
    use super::*;
    use std::{
        fs,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        },
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::{io::AsyncBufReadExt, net::UnixListener};

    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    fn local_target(session_id: &str, cwd: &str) -> ScopedTarget {
        ScopedTarget::new(
            HostId::local(),
            neta_protocol::Target {
                session_id: session_id.into(),
                workspace_id: "workspace".into(),
                name: "Pi".into(),
                role: "agent".into(),
                cwd: cwd.into(),
                provider: "pi".into(),
                model: "m".into(),
            },
        )
        .unwrap()
    }

    fn legacy_parent(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "neta-rmux-{name}-{}",
            FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn pi_header(session_id: &str, cwd: &str) -> String {
        serde_json::json!({"type":"session", "id":session_id, "cwd":cwd}).to_string()
    }

    #[test]
    fn migrates_matching_local_legacy_history_without_changing_bytes() {
        let parent = legacy_parent("legacy-migration");
        let target = local_target("shared", "/repo");
        let legacy = parent.join(target.key.legacy_cache_component());
        std::fs::create_dir_all(&legacy).unwrap();
        let history = format!(
            "{}\n{{\"type\":\"message\"}}\n",
            pi_header("shared", "/repo")
        );
        std::fs::write(legacy.join("history.jsonl"), &history).unwrap();
        std::fs::write(legacy.join("attachment.bin"), b"exact attachment bytes").unwrap();

        let scoped = prepare_session_root(&target, &parent, false).unwrap();
        assert_eq!(scoped, parent.join(target.key.cache_component()));
        assert!(!legacy.exists());
        assert_eq!(
            std::fs::read(scoped.join("history.jsonl")).unwrap(),
            history.as_bytes()
        );
        assert_eq!(
            std::fs::read(scoped.join("attachment.bin")).unwrap(),
            b"exact attachment bytes"
        );
        assert_eq!(
            prepare_session_root(&target, &parent, false).unwrap(),
            scoped
        );
        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn preserves_malformed_or_mismatched_legacy_history() {
        for (name, header) in [
            ("malformed", "not json".into()),
            ("session-id", pi_header("another", "/repo")),
            ("cwd", pi_header("shared", "/another-repo")),
        ] {
            let parent = legacy_parent(name);
            let target = local_target("shared", "/repo");
            let legacy = parent.join(target.key.legacy_cache_component());
            std::fs::create_dir_all(&legacy).unwrap();
            std::fs::write(legacy.join("history.jsonl"), format!("{header}\n")).unwrap();

            let error = prepare_session_root(&target, &parent, false)
                .unwrap_err()
                .to_string();
            assert!(error.contains("no history was deleted"));
            assert!(legacy.exists());
            assert!(!parent.join(target.key.cache_component()).exists());
            let _ = std::fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn preserves_symlinked_or_remote_legacy_history() {
        let parent = legacy_parent("legacy-symlink");
        let target = local_target("shared", "/repo");
        let legacy = parent.join(target.key.legacy_cache_component());
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(
            legacy.join("history.jsonl"),
            format!("{}\n", pi_header("shared", "/repo")),
        )
        .unwrap();
        std::os::unix::fs::symlink("history.jsonl", legacy.join("linked-history")).unwrap();
        assert!(prepare_session_root(&target, &parent, false).is_err());
        assert!(legacy.exists());
        assert!(!parent.join(target.key.cache_component()).exists());
        let _ = std::fs::remove_dir_all(parent);

        let parent = legacy_parent("legacy-remote");
        let mut target = local_target("shared", "/repo");
        target.key.host_id = HostId::saved("remote").unwrap();
        let legacy = parent.join(target.key.legacy_cache_component());
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(
            legacy.join("history.jsonl"),
            format!("{}\n", pi_header("shared", "/repo")),
        )
        .unwrap();
        assert!(prepare_session_root(&target, &parent, false).is_err());
        assert!(legacy.exists());
        assert!(!parent.join(target.key.cache_component()).exists());
        let _ = std::fs::remove_dir_all(parent);

        // A direct remote launch still uses the built-in local HostId. Its
        // client-local cwd cannot prove that this history belongs to the
        // remote workspace, so it must not migrate even with valid headers.
        let parent = legacy_parent("legacy-direct-remote");
        let target = local_target("shared", "/repo");
        let legacy = parent.join(target.key.legacy_cache_component());
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(
            legacy.join("history.jsonl"),
            format!("{}\n", pi_header("shared", "/repo")),
        )
        .unwrap();
        assert!(prepare_session_root(&target, &parent, true).is_err());
        assert!(legacy.exists());
        assert!(!parent.join(target.key.cache_component()).exists());
        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn never_overwrites_an_existing_scoped_root() {
        let parent = std::env::temp_dir().join(format!(
            "neta-rmux-legacy-{}",
            FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let target = local_target("shared", "/repo");
        let legacy = parent.join(target.key.legacy_cache_component());
        std::fs::create_dir_all(&legacy).unwrap();
        let scoped = parent.join(target.key.cache_component());
        std::fs::create_dir_all(&scoped).unwrap();
        std::fs::write(scoped.join("keep"), b"scoped").unwrap();
        std::fs::write(
            legacy.join("history.jsonl"),
            format!("{}\n", pi_header("shared", "/repo")),
        )
        .unwrap();
        assert_eq!(
            prepare_session_root(&target, &parent, false).unwrap(),
            scoped
        );
        assert_eq!(
            std::fs::read(parent.join(target.key.cache_component()).join("keep")).unwrap(),
            b"scoped"
        );
        assert!(legacy.exists());
        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn launches_local_panes_in_the_target_workspace_and_remote_panes_locally() {
        let target = local_target("shared", "/repo");
        assert_eq!(
            pi_working_directory(&target, Path::new("/client"), false),
            "/repo"
        );
        assert_eq!(
            pi_working_directory(&target, Path::new("/client"), true),
            "/client"
        );
    }

    fn archive() -> app::ArchivedConversation {
        app::ArchivedConversation {
            workspace_id: "workspace".into(),
            agent_id: "agent".into(),
            session_id: "saved".into(),
            mission_id: "mission".into(),
            mission_name: "Mission".into(),
            agent_name: "Ada".into(),
            task: "task".into(),
        }
    }

    async fn fixture(
        pages: Vec<serde_json::Value>,
    ) -> (NodeClient, PathBuf, tokio::task::JoinHandle<()>) {
        let dir = std::env::temp_dir().join(format!(
            "neta-rmux-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
                + u128::from(FIXTURE_ID.fetch_add(1, Ordering::Relaxed))
        ));
        fs::create_dir(&dir).unwrap();
        let socket = dir.join("node.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        fs::write(dir.join("node.json"), serde_json::json!({"socket":socket,"token":"secret","protocolVersion":3,"pid":std::process::id(),"startedAt":"2026-01-01T00:00:00Z"}).to_string()).unwrap();
        let pages = Arc::new(pages);
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = tokio::io::split(stream);
            let mut read = tokio::io::BufReader::new(read);
            let mut line = String::new();
            read.read_line(&mut line).await.unwrap();
            let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
            let reply = serde_json::json!({"jsonrpc":"2.0","id":hello["id"],"result":{"machine":{"id":"machine","name":"test","createdAt":"2026-01-01T00:00:00Z"},"protocolVersion":3,"nodeVersion":"test","pid":std::process::id()}});
            write
                .write_all(serde_json::to_string(&reply).unwrap().as_bytes())
                .await
                .unwrap();
            write.write_all(b"\n").await.unwrap();
            loop {
                line.clear();
                if read.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
                let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                if request["method"] != "conversation.tail" {
                    continue;
                }
                let index = match request["params"]["cursor"].as_str() {
                    None => 0,
                    Some("c1") => 1,
                    _ => 0,
                };
                let result = pages[index].clone();
                let reply = serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":result});
                write
                    .write_all(serde_json::to_string(&reply).unwrap().as_bytes())
                    .await
                    .unwrap();
                write.write_all(b"\n").await.unwrap();
            }
        });
        let options = ConnectOptions {
            neta_dir: dir.clone(),
            launcher: neta_client::Launcher {
                executable: PathBuf::from("unused"),
                args: Vec::new(),
            },
            timeout: Duration::from_secs(2),
            remote: None,
        };
        let (client, _) = NodeClient::connect(options).await.unwrap();
        (client, dir, server)
    }

    #[tokio::test]
    async fn exports_raw_pages_and_preserves_metadata() {
        let (client, dir, server) = fixture(vec![serde_json::json!({"sessionId":"saved","provider":"pi","model":"m1","turns":[{"id":"t2","at":"later"}],"blocks":[{"turnId":"t2","seq":2,"at":"later","text":"new"}],"prevCursor":"c1"}), serde_json::json!({"sessionId":"saved","provider":"pi","model":"m1","turns":[{"id":"t1","at":"early"}],"blocks":[{"turnId":"t1","seq":1,"at":"early","text":"old"}]})]).await;
        let target = dir.join("archive.json");
        export_archive(&client, "host", &archive(), &target)
            .await
            .unwrap();
        let output: serde_json::Value =
            serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        eprintln!("{output}");
        assert_eq!(output["pages"][0]["blocks"][0]["seq"], 1);
        assert_eq!(output["pages"][1]["turns"][0]["at"], "later");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 3);
        server.abort();
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn rejects_wrong_session_cycle_and_existing_target() {
        let (client, dir, server) = fixture(vec![
            serde_json::json!({"sessionId":"other","blocks":[],"prevCursor":null}),
        ])
        .await;
        let target = dir.join("wrong.json");
        assert!(export_archive(&client, "host", &archive(), &target)
            .await
            .is_err());
        assert!(!target.exists());
        server.abort();
        let _ = fs::remove_dir_all(&dir);
        let (client, dir, server) = fixture(vec![
            serde_json::json!({"sessionId":"saved","blocks":[],"prevCursor":"c1"}),
            serde_json::json!({"sessionId":"saved","blocks":[],"prevCursor":"c2"}),
            serde_json::json!({"sessionId":"saved","blocks":[],"prevCursor":"c1"}),
        ])
        .await;
        let target = dir.join("cycle.json");
        assert!(export_archive(&client, "host", &archive(), &target)
            .await
            .is_err());
        assert!(!target.exists());
        server.abort();
        let _ = fs::remove_dir_all(&dir);
        let (client, dir, server) = fixture(vec![
            serde_json::json!({"sessionId":"saved","blocks":[],"prevCursor":null}),
        ])
        .await;
        let target = dir.join("existing.json");
        fs::write(&target, b"keep").unwrap();
        assert!(export_archive(&client, "host", &archive(), &target)
            .await
            .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        server.abort();
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn read_error_leaves_no_partial_output() {
        let (client, dir, server) = fixture(vec![serde_json::json!({
            "sessionId": "saved",
            "blocks": [],
            "prevCursor": null
        })])
        .await;
        let parent = dir.join("parent-file");
        fs::write(&parent, b"not a directory").unwrap();
        let target = parent.join("archive.json");
        assert!(export_archive(&client, "host", &archive(), &target)
            .await
            .is_err());
        assert!(!target.exists());
        assert_eq!(fs::read(&parent).unwrap(), b"not a directory");
        server.abort();
        let _ = fs::remove_dir_all(dir);
    }
}
