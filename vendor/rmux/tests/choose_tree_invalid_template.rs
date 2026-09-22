#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::io::Write;
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use common::{assert_success, read_until_contains, terminate_child, AttachedSession, CliHarness};
use rmux_pty::TerminalSize;

const IO_TIMEOUT: Duration = Duration::from_secs(10);

type TestResult<T> = Result<T, Box<dyn Error>>;

#[derive(Clone, Debug, Eq, PartialEq)]
struct ListedClient {
    session_name: String,
    control_mode: bool,
}

struct ControlObserver {
    child: Child,
}

impl ControlObserver {
    fn spawn(harness: &CliHarness, session_name: &str) -> TestResult<Self> {
        let mut command = harness.base_command();
        let child = command
            .args(["-C", "attach-session", "-t", session_name])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(Self { child })
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn assert_running(&mut self) -> TestResult<()> {
        if let Some(status) = self.child.try_wait()? {
            return Err(format!("control observer exited early with {status}").into());
        }
        Ok(())
    }

    fn prove_command_channel(&mut self, harness: &CliHarness) -> TestResult<()> {
        const CONTROL_BUFFER: &str = "w13-control-still-usable";
        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or("control stdin is missing")?;
        stdin.write_all(
            format!("set-buffer -b {CONTROL_BUFFER} W13_CONTROL_STILL_USABLE\n").as_bytes(),
        )?;
        stdin.flush()?;

        let deadline = Instant::now() + IO_TIMEOUT;
        loop {
            let output = harness.run(&["show-buffer", "-b", CONTROL_BUFFER])?;
            if output.status.success()
                && common::stdout(&output).trim() == "W13_CONTROL_STILL_USABLE"
            {
                return Ok(());
            }
            self.assert_running()?;
            if Instant::now() >= deadline {
                return Err(format!(
                    "control command channel did not create {CONTROL_BUFFER}: status={}, stderr={}",
                    output.status,
                    common::stderr(&output)
                )
                .into());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

impl Drop for ControlObserver {
    fn drop(&mut self) {
        let _ = terminate_child(&mut self.child);
    }
}

#[derive(Clone, Copy)]
enum Invocation {
    Binding,
    SourceFile,
}

#[derive(Clone, Copy)]
enum Chooser {
    Tree,
    Client,
    Buffer,
}

impl Chooser {
    fn command_name(self) -> &'static str {
        match self {
            Self::Tree => "choose-tree",
            Self::Client => "choose-client",
            Self::Buffer => "choose-buffer",
        }
    }

    fn row_format(self) -> &'static str {
        match self {
            Self::Tree => "W13_TREE_ROW|#{session_name}",
            Self::Client => "W13_CLIENT_ROW|#{client_name}",
            Self::Buffer => "W13_BUFFER_ROW|#{buffer_name}",
        }
    }

    fn expected_row(self) -> &'static str {
        match self {
            Self::Tree => "W13_TREE_ROW|target",
            Self::Client => "W13_CLIENT_ROW|",
            Self::Buffer => "W13_BUFFER_ROW|w13buf",
        }
    }

    fn selection(self) -> &'static [u8] {
        match self {
            Self::Tree => b"1",
            Self::Client | Self::Buffer => b"\r",
        }
    }

    fn command_arguments(self, template: &str) -> Vec<String> {
        let mut arguments = vec![self.command_name().to_owned()];
        if matches!(self, Self::Tree) {
            arguments.push("-s".to_owned());
        }
        arguments.extend([
            "-F".to_owned(),
            self.row_format().to_owned(),
            template.to_owned(),
        ]);
        arguments
    }
}

#[derive(Clone, Copy)]
enum ExpectedOutcome {
    Rejected,
    SwitchedToTarget,
}

fn listed_clients(harness: &CliHarness) -> TestResult<BTreeMap<u32, ListedClient>> {
    let output = harness.run(&[
        "list-clients",
        "-F",
        "#{client_pid}|#{session_name}|#{client_control_mode}",
    ])?;
    if !output.status.success() {
        return Err(format!(
            "list-clients failed with {}: {}",
            output.status,
            common::stderr(&output)
        )
        .into());
    }
    common::stdout(&output)
        .lines()
        .map(|line| {
            let mut fields = line.split('|');
            let pid = fields
                .next()
                .ok_or_else(|| format!("missing PID in client row {line:?}"))?
                .parse::<u32>()?;
            let session_name = fields
                .next()
                .ok_or_else(|| format!("missing session in client row {line:?}"))?
                .to_owned();
            let control_mode = match fields.next() {
                Some("0") => false,
                Some("1") => true,
                value => {
                    return Err(format!(
                        "invalid control-mode field {value:?} in client row {line:?}"
                    )
                    .into())
                }
            };
            if fields.next().is_some() {
                return Err(format!("extra fields in client row {line:?}").into());
            }
            Ok((
                pid,
                ListedClient {
                    session_name,
                    control_mode,
                },
            ))
        })
        .collect()
}

fn wait_for_clients(
    harness: &CliHarness,
    actor_pid: u32,
    observer_pid: u32,
) -> TestResult<BTreeMap<u32, ListedClient>> {
    let deadline = Instant::now() + IO_TIMEOUT;
    loop {
        let clients = listed_clients(harness)?;
        if clients.contains_key(&actor_pid) && clients.contains_key(&observer_pid) {
            return Ok(clients);
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "timed out waiting for actor {actor_pid} and control observer \
                 {observer_pid}; clients={clients:?}"
            )
            .into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn pane_in_mode(harness: &CliHarness) -> TestResult<bool> {
    let output = harness.run(&[
        "display-message",
        "-p",
        "-t",
        "source:0.0",
        "#{pane_in_mode}",
    ])?;
    if !output.status.success() {
        return Err(format!(
            "display-message failed with {}: {}",
            output.status,
            common::stderr(&output)
        )
        .into());
    }
    Ok(common::stdout(&output).trim() == "1")
}

fn wait_for_action_to_settle(
    harness: &CliHarness,
    actor: &mut AttachedSession,
    actor_pid: u32,
) -> TestResult<()> {
    let deadline = Instant::now() + IO_TIMEOUT;
    loop {
        let clients = listed_clients(harness)?;
        let actor_exited = actor.child_mut().try_wait()?.is_some();
        if actor_exited || !clients.contains_key(&actor_pid) || !pane_in_mode(harness)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("invalid chooser action did not settle".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn invoke_chooser(
    harness: &CliHarness,
    actor: &mut AttachedSession,
    invocation: Invocation,
    chooser: Chooser,
    template: &str,
) -> TestResult<()> {
    let command_arguments = chooser.command_arguments(template);
    match invocation {
        Invocation::Binding => {
            let mut bind_arguments = vec!["bind-key".to_owned(), "z".to_owned()];
            bind_arguments.extend(command_arguments);
            let bind_argument_refs = bind_arguments
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            assert_success(&harness.run(&bind_argument_refs)?);
            actor.send_bytes(b"\x02z")?;
        }
        Invocation::SourceFile => {
            let source_path = harness.tmpdir().join("invalid-chooser.conf");
            let command = command_arguments
                .iter()
                .enumerate()
                .map(|(index, argument)| {
                    if index == 0 {
                        argument.clone()
                    } else {
                        format!("{argument:?}")
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            fs::write(&source_path, format!("{command}\n"))?;
            actor.send_bytes(b"\x02:")?;
            std::thread::sleep(Duration::from_millis(75));
            actor.send_bytes(format!("source-file {}\r", source_path.display()).as_bytes())?;
        }
    }

    let tree = read_until_contains(actor.master_mut(), chooser.expected_row(), IO_TIMEOUT)?;
    if matches!(chooser, Chooser::Tree) {
        assert!(
            tree.contains("(1)"),
            "target should retain shortcut 1 with source/target/observer creation order: {tree:?}"
        );
    }
    actor.send_bytes(chooser.selection())?;
    Ok(())
}

fn assert_explicit_template_keeps_clients(
    label: &str,
    invocation: Invocation,
    chooser: Chooser,
    template: &str,
    expected_outcome: ExpectedOutcome,
) -> TestResult<()> {
    let harness = CliHarness::new(label)?;
    let _daemon = harness.start_hidden_daemon()?;
    assert_success(&harness.run(&["new-session", "-d", "-s", "source"])?);
    assert_success(&harness.run(&["new-session", "-d", "-s", "target"])?);
    assert_success(&harness.run(&["new-session", "-d", "-s", "observer"])?);
    assert_success(&harness.run(&["set-buffer", "-b", "w13buf", "W13_BUFFER_PAYLOAD"])?);

    let mut actor = AttachedSession::spawn(&harness, "source", TerminalSize::new(100, 30))?;
    actor.wait_for_raw_mode(IO_TIMEOUT)?;
    let _ = read_until_contains(actor.master_mut(), "[source]", IO_TIMEOUT)?;
    let actor_pid = actor.child_mut().id();

    let mut observer = ControlObserver::spawn(&harness, "observer")?;
    let observer_pid = observer.pid();
    let before = wait_for_clients(&harness, actor_pid, observer_pid)?;
    assert_eq!(
        before.get(&actor_pid),
        Some(&ListedClient {
            session_name: "source".to_owned(),
            control_mode: false,
        })
    );
    assert_eq!(
        before.get(&observer_pid),
        Some(&ListedClient {
            session_name: "observer".to_owned(),
            control_mode: true,
        })
    );
    assert_eq!(before.len(), 2, "setup must expose exactly two clients");

    invoke_chooser(&harness, &mut actor, invocation, chooser, template)?;
    wait_for_action_to_settle(&harness, &mut actor, actor_pid)?;

    assert!(
        actor.child_mut().try_wait()?.is_none(),
        "an explicit chooser action must not terminate the actor PTY"
    );
    observer.assert_running()?;
    let after = listed_clients(&harness)?;
    let expected_actor_session = match expected_outcome {
        ExpectedOutcome::Rejected => "source",
        ExpectedOutcome::SwitchedToTarget => "target",
    };
    assert_eq!(
        after.get(&actor_pid),
        Some(&ListedClient {
            session_name: expected_actor_session.to_owned(),
            control_mode: false,
        }),
        "the actor identity and expected session must survive the chooser action"
    );
    assert_eq!(
        after.get(&observer_pid),
        before.get(&observer_pid),
        "the control observer identity and session must survive the chooser action"
    );
    assert_eq!(
        after.len(),
        before.len(),
        "the chooser action must not add or remove clients"
    );
    assert!(
        !pane_in_mode(&harness)?,
        "the chooser must leave a coherent non-mode pane after the action"
    );

    observer.prove_command_channel(&harness)?;
    actor.send_bytes(b"printf 'W13_ACTOR_STILL_USABLE\\n'\r")?;
    let reused = read_until_contains(actor.master_mut(), "W13_ACTOR_STILL_USABLE", IO_TIMEOUT)?;
    assert!(
        reused.contains("W13_ACTOR_STILL_USABLE"),
        "the attached actor PTY must remain usable after rejection"
    );
    Ok(())
}

#[test]
fn choose_tree_invalid_target_from_binding_keeps_actor_and_control_observer() -> TestResult<()> {
    assert_explicit_template_keeps_clients(
        "chooser-invalid-target-binding",
        Invocation::Binding,
        Chooser::Tree,
        "switch-client -t w13-no-session",
        ExpectedOutcome::Rejected,
    )
}

#[test]
fn choose_tree_invalid_nested_format_from_source_keeps_actor_and_control_observer() -> TestResult<()>
{
    assert_explicit_template_keeps_clients(
        "chooser-invalid-format-source",
        Invocation::SourceFile,
        Chooser::Tree,
        "switch-client -t '#{?#{==:#{session_name},target},target,source'",
        ExpectedOutcome::Rejected,
    )
}

#[test]
fn choose_tree_invalid_runtime_syntax_keeps_actor_and_control_observer() -> TestResult<()> {
    assert_explicit_template_keeps_clients(
        "chooser-invalid-syntax-binding",
        Invocation::Binding,
        Chooser::Tree,
        "run-shell {",
        ExpectedOutcome::Rejected,
    )
}

#[test]
fn choose_client_unknown_command_keeps_actor_and_control_observer() -> TestResult<()> {
    assert_explicit_template_keeps_clients(
        "chooser-client-unknown-command",
        Invocation::Binding,
        Chooser::Client,
        "w13-unknown-client-command -t '%%'",
        ExpectedOutcome::Rejected,
    )
}

#[test]
fn choose_buffer_missing_target_keeps_actor_and_control_observer() -> TestResult<()> {
    assert_explicit_template_keeps_clients(
        "chooser-buffer-missing-target",
        Invocation::SourceFile,
        Chooser::Buffer,
        "paste-buffer -b w13-no-buffer",
        ExpectedOutcome::Rejected,
    )
}

#[test]
fn choose_tree_valid_template_switches_actor_and_keeps_control_observer() -> TestResult<()> {
    assert_explicit_template_keeps_clients(
        "chooser-valid-switch",
        Invocation::Binding,
        Chooser::Tree,
        "switch-client -t '%%'",
        ExpectedOutcome::SwitchedToTarget,
    )
}
