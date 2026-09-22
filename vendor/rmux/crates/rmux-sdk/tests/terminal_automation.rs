#![cfg(unix)]

mod common;

use std::error::Error;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use rmux_proto::{encode_frame, FrameDecoder, HasSessionRequest, Request, Response};
use rmux_sdk::{
    EnsureSession, LocatorFilter, Pane, Rect, RmuxBuilder, SessionName, TerminalLoadState,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::Instant;

type TestResult<T = ()> = Result<T, Box<dyn Error>>;

static LIVE_DAEMON_LOCK: common::unix_smoke::LiveDaemonLock =
    common::unix_smoke::LiveDaemonLock::new();
static UNIQUE_ID: AtomicUsize = AtomicUsize::new(0);

#[tokio::test]
async fn terminal_automation_layer_drives_the_p3_user_flow() -> TestResult {
    let _lock = LIVE_DAEMON_LOCK.lock().await;
    let harness = Harness::start("terminal-automation").await?;
    let rmux = harness.rmux();
    let session = automation_session(session_name("sdkp3automation"))
        .ensure(&rmux)
        .await?;
    let pane = session.pane(0, 0);
    pane.set_title("rmux:automation").await?;

    // `Ready` and `Hello` are part of the command the pty echoes back, so
    // neither word proves the shell ran anything.  Establish readiness first
    // with a marker only `printf` can render.
    wait_for_shell_ready(&pane).await?;

    pane.keyboard()
        .type_text("printf 'Ready multiplexer Ready Hello from rmux\\n'")
        .await?;
    pane.keyboard().press("Enter").await?;

    let terminal = rmux.find_panes().title("rmux:automation").one().await?;
    terminal.get_by_text("Ready").wait_for().await?;
    terminal
        .get_by_text("Ready")
        .first()
        .expect()
        .to_be_visible()
        .timeout(Duration::from_secs(5))
        .await?;
    let strict_error =
        terminal.get_by_text("Ready").click().await.expect_err(
            "clicking a multi-match terminal locator should report a strictness violation",
        );
    assert!(
        strict_error
            .to_string()
            .contains("strict locator violation"),
        "unexpected strictness error: {strict_error}"
    );
    let strict_fill_error = terminal
        .get_by_text("Ready")
        .fill("should not be sent")
        .await
        .expect_err("filling a multi-match terminal locator should report a strictness violation");
    assert!(
        strict_fill_error
            .to_string()
            .contains("strict locator violation"),
        "unexpected strict fill error: {strict_fill_error}"
    );
    let strict_assertion_error = terminal
        .get_by_text("Ready")
        .expect()
        .to_be_visible()
        .timeout(Duration::from_secs(1))
        .await
        .expect_err("strict locator assertions should reject multiple matches");
    assert!(
        strict_assertion_error
            .to_string()
            .contains("strict locator violation"),
        "unexpected strict assertion error: {strict_assertion_error}"
    );
    let hidden_filter_error = terminal
        .get_by_text("Ready")
        .filter(LocatorFilter {
            visible: Some(false),
            ..LocatorFilter::default()
        })
        .expect()
        .to_be_hidden()
        .timeout(Duration::from_secs(1))
        .await
        .expect_err("visible=false filters should not fake hidden terminal text");
    assert!(
        hidden_filter_error.to_string().contains("visible=false"),
        "unexpected visible=false error: {hidden_filter_error}"
    );
    terminal
        .get_by_text("missing")
        .or(terminal.get_by_text("Hello"))
        .wait_for()
        .timeout(Duration::from_secs(5))
        .await?;
    terminal
        .get_by_text("Hello")
        .and(terminal.get_by_text("Hello"))
        .wait_for()
        .timeout(Duration::from_secs(5))
        .await?;
    let combined_filter_error = terminal
        .get_by_text("Ready")
        .first()
        .or(terminal.get_by_text("Hello"))
        .wait_for()
        .timeout(Duration::from_secs(1))
        .await
        .expect_err("composing selected locators should be rejected explicitly");
    assert!(
        combined_filter_error
            .to_string()
            .contains("only supports plain locators"),
        "unexpected locator composition error: {combined_filter_error}"
    );
    terminal
        .wait_for_load_state(TerminalLoadState::Quiet)
        .timeout(Duration::from_secs(5))
        .await?;
    terminal
        .expect_visible_text()
        .to_contain("Hello")
        .timeout(Duration::from_secs(5))
        .await?;

    let delayed_hover = tokio::spawn(
        terminal
            .get_by_text("DelayedReady")
            .timeout(Duration::from_secs(5))
            .hover(),
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    terminal
        .keyboard()
        .type_text("printf '\\104\\145\\154\\141\\171\\145\\144\\122\\145\\141\\144\\171\\n'")
        .await?;
    terminal.keyboard().press("Enter").await?;
    delayed_hover.await??;

    terminal
        .get_by_text("DelayedReady")
        .fill("printf 'FilledText\\n'")
        .await?;
    terminal.keyboard().press("Enter").await?;
    terminal
        .get_by_text("FilledText")
        .wait_for()
        .timeout(Duration::from_secs(5))
        .await?;

    let missing_sessions = rmux
        .find_sessions()
        .name("sdkp3automation-missing")
        .all()
        .await?;
    assert!(missing_sessions.is_empty());

    let panes = rmux
        .find_panes()
        .title_prefix("rmux:")
        .collect_paneset()
        .await?;
    assert_eq!(panes.len(), 1);
    panes
        .keyboard()
        .type_text("printf 'borrow multiplexer\\n'")
        .await?;
    panes.keyboard().press("Enter").await?;
    let any_outcome = panes
        .expect_any()
        .visible_text_contains("borrow")
        .timeout(Duration::from_secs(5))
        .await;
    let any = any_outcome.any().expect("expect_any returns any outcome");
    assert!(any.matched(), "PaneSet expect_any should match");

    let box_rect = terminal.get_by_text("Ready").first().bounding_box().await?;
    assert!(box_rect.cols >= 5);
    let capture = terminal.screenshot().await?;
    assert!(capture.text.contains("multiplexer"));
    let styled = terminal
        .capture_region(Rect::new(0, 0, 1, 20))
        .preserve_style(true)
        .await?;
    assert!(styled.styled_cells.is_some());

    let trace = rmux.tracing().start().await?;
    trace.record_action("p3 terminal automation test")?;
    trace.record_snapshot(&terminal).await?;
    let trace_path = trace.stop(harness.root_path().join("trace")).await?;
    let trace_text = std::fs::read_to_string(trace_path)?;
    assert!(trace_text.contains("trace.start"));
    assert!(trace_text.contains("snapshot"));

    let capped_trace = rmux.tracing().max_events(3).start().await?;
    capped_trace.record_action("trace event one")?;
    capped_trace.record_action("trace event two")?;
    capped_trace.record_action("trace event three")?;
    let capped_path = capped_trace
        .stop(harness.root_path().join("trace-capped"))
        .await?;
    let capped_text = std::fs::read_to_string(capped_path)?;
    assert!(!capped_text.contains("trace event one"));
    assert!(capped_text.contains("trace event three"));
    assert!(capped_text.contains("trace.stop"));

    terminal
        .keyboard()
        .type_text(
            "trap 'stty sane' EXIT; stty raw -echo; \
             printf '\\033[2J\\033[H\\103\\154\\151\\143\\153\\122\\145\\141\\144\\171\\n'; \
             bytes=$(dd bs=1 count=18 2>/dev/null | od -An -tx1 | tr -d ' \\n'); \
             stty sane; trap - EXIT; printf '\\nMouseDone:%s\\n' \"$bytes\"",
        )
        .await?;
    terminal.keyboard().press("Enter").await?;
    terminal.get_by_text("ClickReady").click().await?;
    terminal
        .get_by_text("MouseDone:1b5b3c303b313b314d1b5b3c303b313b316d")
        .wait_for()
        .timeout(Duration::from_secs(5))
        .await?;

    harness.finish().await
}

/// Marker the readiness sentinel prints.  Its literal bytes must never occur in
/// the typed command, so a wait for it cannot match the pty echo.
const SHELL_READY_MARKER: &str = "RmuxShellUp";
/// `printf` invocation that decodes to [`SHELL_READY_MARKER`]; every marker byte
/// is octal-escaped so the echoed input carries none of them.
const SHELL_READY_COMMAND: &str =
    "printf '\\122\\155\\165\\170\\123\\150\\145\\154\\154\\125\\160\\n'";
/// Shell the automation session pins for its panes.
const SESSION_SHELL: &str = "/bin/sh";
/// Bound on becoming interactive, which is not the bound on producing output.
///
/// This holds only because [`automation_session`] pins the pane shell: the wait
/// then measures rmux spawning a `/bin/sh` and that shell reaching a prompt,
/// which is the same class of latency every later stage bounds at five seconds.
/// Raising it instead would accept a startup regression anywhere below the new
/// value, so the bound stays and the shell is what is made deterministic.
const SHELL_READY_TIMEOUT: Duration = Duration::from_secs(5);
/// Bound on one readiness-timeout diagnostic query.
///
/// Readiness fails precisely when something is wedged or contended, so the
/// transport that would answer these queries is the least trustworthy thing
/// available. Each one is bounded separately: a query that cannot answer costs
/// one line of the report rather than the whole of it.
const DIAGNOSTIC_QUERY_TIMEOUT: Duration = Duration::from_secs(1);
/// Worst case [`shell_readiness_diagnostics`] may add to a readiness failure:
/// three bounded daemon queries plus one local `ps`.
const DIAGNOSTIC_BUDGET: Duration = Duration::from_secs(4);

/// Session the automation flow drives.
///
/// The pane shell is resolved from the `default-shell` option, then the
/// *session* environment, then the login shell in the password database, so the
/// `SHELL` that `Harness::start` puts on the daemon process never reaches the
/// spawn. Measured here: without this environment the pane runs the account's
/// login shell (`ps` reports `-zsh`), and a framework-driven one needs well over
/// five seconds to become interactive. Pinning the shell makes every bound in
/// this file a property of rmux instead of a property of the host account.
fn automation_session(name: SessionName) -> EnsureSession {
    EnsureSession::named(name)
        .create_only()
        .environment([format!("SHELL={SESSION_SHELL}")])
}

/// Reads the pane pid while the transport is known to answer.
///
/// A readiness failure often *is* a transport failure, and then no daemon query
/// can report the shell's state. This pid, taken beforehand, is what keeps the
/// OS-level rows of the report reachable in that case.
async fn known_pane_pid(pane: &Pane) -> Option<u32> {
    bounded_query("foreground", pane.foreground_state())
        .await
        .ok()
        .flatten()
        .and_then(|state| state.pid)
}

/// Waits until the pane shell has executed a command, not merely echoed one.
async fn wait_for_shell_ready(pane: &Pane) -> TestResult {
    let known_pid = known_pane_pid(pane).await;

    pane.keyboard().type_text(SHELL_READY_COMMAND).await?;
    pane.keyboard().press("Enter").await?;
    wait_for_readiness_marker(pane, SHELL_READY_MARKER, known_pid).await
}

/// Waits for `marker` under [`SHELL_READY_TIMEOUT`], reporting bounded
/// diagnostics when it never arrives.
async fn wait_for_readiness_marker(
    pane: &Pane,
    marker: &str,
    known_pid: Option<u32>,
) -> TestResult {
    if let Err(error) = pane
        .get_by_text(marker)
        .wait_for()
        .timeout(SHELL_READY_TIMEOUT)
        .await
    {
        return Err(format!(
            "pane shell did not run the readiness sentinel within {SHELL_READY_TIMEOUT:?}: \
             {error}\n{}",
            shell_readiness_diagnostics(pane, known_pid).await
        )
        .into());
    }
    Ok(())
}

/// Awaits one diagnostic query under [`DIAGNOSTIC_QUERY_TIMEOUT`], rendering a
/// failure or an expiry as the line the report should carry instead.
async fn bounded_query<T>(
    label: &str,
    query: impl Future<Output = rmux_sdk::Result<T>>,
) -> Result<T, String> {
    match tokio::time::timeout(DIAGNOSTIC_QUERY_TIMEOUT, query).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(format!("query failed: {error}")),
        Err(_) => Err(format!(
            "query did not answer within {DIAGNOSTIC_QUERY_TIMEOUT:?}"
        )),
    }
    .map_err(|reason| format!("{label}: {reason}\n"))
}

/// Sanitized readiness-timeout evidence: what the daemon knows about the pane
/// process, what the OS reports for that pid, and what the pane renders.
///
/// `known_pid` is the pid observed before the wait, and keeps the OS-level rows
/// available when the daemon is the component that stopped answering.
async fn shell_readiness_diagnostics(pane: &Pane, known_pid: Option<u32>) -> String {
    let mut report = String::new();

    let foreground_pid = match bounded_query("foreground", pane.foreground_state()).await {
        Ok(Some(state)) => {
            report.push_str(&format!(
                "foreground: pid={:?} command={:?}\n",
                state.pid, state.command
            ));
            state.pid
        }
        Ok(None) => {
            report.push_str("foreground: pane is not resolvable\n");
            None
        }
        Err(line) => {
            report.push_str(&line);
            None
        }
    };

    match bounded_query("daemon pane", pane.info()).await {
        Ok(info) => match info.panes.first() {
            Some(pane_info) => report.push_str(&format!(
                "daemon pane: id={:?} process={:?} exit={:?}\n",
                pane_info.id, pane_info.process, pane_info.exit_state
            )),
            None => report.push_str("daemon pane: no pane in snapshot\n"),
        },
        Err(line) => report.push_str(&line),
    }

    report.push_str(&process_state_and_group(foreground_pid.or(known_pid)));

    match bounded_query("snapshot", pane.snapshot()).await {
        Ok(snapshot) => report.push_str(&format!(
            "snapshot: revision={} cursor={},{} visible_text={:?}\n",
            snapshot.revision,
            snapshot.cursor.row,
            snapshot.cursor.col,
            snapshot.visible_text()
        )),
        Err(line) => report.push_str(&line),
    }

    report
}

/// Reports the OS process state and group for `pid`, which distinguishes an
/// unscheduled shell from a stopped one.
fn process_state_and_group(pid: Option<u32>) -> String {
    let Some(pid) = pid else {
        return "process: no pid to inspect\n".to_owned();
    };
    match Command::new("/bin/ps")
        .args(["-o", "state=,pgid=,comm=", "-p", &pid.to_string()])
        .output()
    {
        Ok(output) => format!(
            "process: pid={pid} state/pgid/comm={:?}\n",
            String::from_utf8_lossy(&output.stdout).trim()
        ),
        Err(error) => format!("process: pid={pid} inspection failed: {error}\n"),
    }
}

#[test]
fn the_readiness_command_cannot_echo_its_own_marker() {
    assert!(
        !SHELL_READY_COMMAND.contains(SHELL_READY_MARKER),
        "the readiness command must encode the marker so the pty echo cannot match it"
    );
}

/// The session environment, not the host account, decides the pane shell.
///
/// The daemon exports the shell it resolved, so the pane can report which one
/// actually spawned it. Without [`automation_session`]'s environment this
/// renders the account's login shell, and every bound in this file becomes a
/// measurement of that shell's startup.
#[tokio::test]
async fn the_automation_session_pins_the_pane_shell() -> TestResult {
    let _lock = LIVE_DAEMON_LOCK.lock().await;
    let harness = Harness::start("session-shell").await?;
    let rmux = harness.rmux();
    let session = automation_session(session_name("sdkshellpin"))
        .ensure(&rmux)
        .await?;
    let pane = session.pane(0, 0);
    wait_for_shell_ready(&pane).await?;

    // The echo carries `%s`, so only the shell's own output can carry the path.
    pane.keyboard()
        .type_text("printf 'ResolvedShell=%s\\n' \"$SHELL\"")
        .await?;
    pane.keyboard().press("Enter").await?;
    pane.get_by_text(format!("ResolvedShell={SESSION_SHELL}"))
        .wait_for()
        .timeout(SHELL_READY_TIMEOUT)
        .await?;

    harness.finish().await
}

/// Readiness gives up at its own bound, carrying the evidence a red needs.
///
/// A marker the shell never prints reproduces the final causal path exactly. It
/// pins the bound behaviourally: a wait that grew back to a minute could not
/// finish inside [`SHELL_READY_TIMEOUT`] plus [`DIAGNOSTIC_BUDGET`], so
/// collecting evidence can never become the long tail the bound exists to
/// prevent.
#[tokio::test]
async fn readiness_gives_up_at_its_bound_with_diagnostics() -> TestResult {
    let _lock = LIVE_DAEMON_LOCK.lock().await;
    let harness = Harness::start("readiness-bound").await?;
    let rmux = harness.rmux();
    let session = automation_session(session_name("sdkreadybound"))
        .ensure(&rmux)
        .await?;
    let pane = session.pane(0, 0);
    wait_for_shell_ready(&pane).await?;
    let known_pid = known_pane_pid(&pane).await;

    let started = Instant::now();
    let error = wait_for_readiness_marker(&pane, "RmuxMarkerNeverPrinted", known_pid)
        .await
        .expect_err("a marker no command prints must not be reported as readiness");
    let elapsed = started.elapsed();
    let rendered = error.to_string();

    assert!(
        elapsed < SHELL_READY_TIMEOUT + DIAGNOSTIC_BUDGET,
        "readiness and its diagnostics took {elapsed:?}, beyond the {SHELL_READY_TIMEOUT:?} \
         bound plus the {DIAGNOSTIC_BUDGET:?} diagnostic budget: {rendered}"
    );
    // The OS-level row is the one that does not need the daemon to still be
    // answering, which is why the pid is read before the wait.
    assert!(
        rendered.contains(&format!(
            "process: pid={}",
            known_pid.expect("pane has a pid")
        )),
        "readiness timeout report is missing the OS process row: {rendered}"
    );
    // Every daemon-sourced row is accounted for: with its data when the
    // transport answers, with a bounded reason when it does not, never absent.
    for category in ["foreground:", "daemon pane:", "snapshot:"] {
        assert!(
            rendered.contains(category),
            "readiness timeout report is missing the {category:?} row: {rendered}"
        );
    }

    harness.finish().await
}

/// The readiness contract this file is written around, pinned without a daemon.
#[test]
fn the_readiness_bounds_stay_at_their_contract() {
    assert_eq!(
        SHELL_READY_TIMEOUT,
        Duration::from_secs(5),
        "readiness measures a pinned /bin/sh becoming interactive, which is the same \
         five-second contract every later stage uses"
    );
    // Three bounded daemon queries plus one local `ps`.
    assert!(
        DIAGNOSTIC_BUDGET >= 3 * DIAGNOSTIC_QUERY_TIMEOUT,
        "the diagnostic budget must cover every bounded query it allows"
    );
}

fn session_name(value: &str) -> SessionName {
    SessionName::new(value).expect("valid session name")
}

async fn framed_request(socket_path: &Path, request: Request) -> TestResult<Response> {
    let mut stream = UnixStream::connect(socket_path).await?;
    let frame = encode_frame(&request)?;
    stream.write_all(&frame).await?;
    read_response(&mut stream).await
}

async fn read_response(stream: &mut UnixStream) -> TestResult<Response> {
    let mut decoder = FrameDecoder::new();
    let mut read_buffer = [0_u8; 8192];
    loop {
        if let Some(response) = decoder.next_frame::<Response>()? {
            return Ok(response);
        }
        let bytes_read = stream.read(&mut read_buffer).await?;
        if bytes_read == 0 {
            return Err("connection closed before response frame".into());
        }
        decoder.push_bytes(&read_buffer[..bytes_read]);
    }
}

struct Harness {
    root: TestRoot,
    socket_path: PathBuf,
    child: Option<Child>,
}

impl Harness {
    async fn start(label: &str) -> TestResult<Self> {
        let root = TestRoot::new(label);
        std::fs::create_dir_all(root.path())?;
        let socket_path = root.path().join("daemon.sock");
        let mut child = Command::new(rmux_binary()?)
            .arg("--__internal-daemon")
            .arg(&socket_path)
            .env("SHELL", "/bin/sh")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        wait_for_daemon_ready(&socket_path, &mut child).await?;
        Ok(Self {
            root,
            socket_path,
            child: Some(child),
        })
    }

    fn rmux(&self) -> rmux_sdk::Rmux {
        RmuxBuilder::new().unix_socket(&self.socket_path).build()
    }

    fn root_path(&self) -> &Path {
        self.root.path()
    }

    async fn finish(self) -> TestResult {
        let shutdown = self.rmux().shutdown().await;
        wait_for_child_exit(self, "server did not exit during cleanup").await?;
        if let Err(error) = shutdown {
            let rendered = error.to_string();
            assert!(
                rendered.contains("connect to rmux daemon")
                    || rendered.contains("rmux daemon closed the transport")
                    || rendered.contains("rmux transport actor is closed")
                    || rendered.contains("Connection reset by peer"),
                "unexpected cleanup shutdown error: {rendered}"
            );
        }
        Ok(())
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
        }
    }
}

async fn wait_for_child_exit(mut harness: Harness, timeout_message: &'static str) -> TestResult {
    let mut child = harness.child.take().expect("harness owns daemon child");
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(status) = child.try_wait()? {
            assert!(status.success(), "daemon exited with status {status}");
            return Ok(());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return Err(timeout_message.into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn wait_for_daemon_ready(socket_path: &Path, child: &mut Child) -> TestResult {
    let deadline = Instant::now() + Duration::from_secs(60);
    let probe = session_name("sdkprobe");
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(format!("daemon exited before accepting RPC: {status}").into());
        }
        if matches!(
            framed_request(
                socket_path,
                Request::HasSession(HasSessionRequest {
                    target: probe.clone()
                })
            )
            .await,
            Ok(Response::HasSession(_))
        ) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "daemon at '{}' did not accept RPC before timeout",
                socket_path.display()
            )
            .into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn rmux_binary() -> TestResult<&'static Path> {
    static RMUX_BINARY: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    match RMUX_BINARY.get_or_init(|| resolve_rmux_binary().map_err(|error| error.to_string())) {
        Ok(path) => Ok(path.as_path()),
        Err(error) => Err(std::io::Error::other(error.clone()).into()),
    }
}

fn resolve_rmux_binary() -> TestResult<PathBuf> {
    if let Some(path) = option_env!("CARGO_BIN_EXE_rmux") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    let target_dir = target_dir()?;
    let candidate = target_dir.join("debug").join("rmux");
    let status =
        std::process::Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
            .arg("build")
            .arg("--bin")
            .arg("rmux")
            .arg("--locked")
            .arg("--manifest-path")
            .arg(workspace_root().join("Cargo.toml"))
            .env("CARGO_TARGET_DIR", &target_dir)
            .status()?;
    if !status.success() {
        return Err(format!("failed to build rmux binary for daemon tests: {status}").into());
    }
    Ok(candidate)
}

fn target_dir() -> TestResult<PathBuf> {
    if let Some(target_dir) = std::env::var_os("CARGO_TARGET_DIR") {
        return Ok(PathBuf::from(target_dir));
    }
    let current = std::env::current_exe()?;
    current
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "test executable is not under a target directory".into())
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("rmux-sdk manifest lives under crates/rmux-sdk")
        .to_path_buf()
}

struct TestRoot {
    path: PathBuf,
}

impl TestRoot {
    fn new(label: &str) -> Self {
        let unique_id = UNIQUE_ID.fetch_add(1, Ordering::Relaxed);
        let path = PathBuf::from("/tmp").join(format!(
            "rmux-sdk-p3-{}-{}-{unique_id}",
            compact_label(label),
            std::process::id()
        ));
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn compact_label(label: &str) -> String {
    let compact = label
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(16)
        .collect::<String>();
    if compact.is_empty() {
        "x".to_owned()
    } else {
        compact
    }
}
