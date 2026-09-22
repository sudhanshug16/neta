#![cfg(unix)]

mod common;

use std::error::Error;
use std::io::{self, Read, Write};
use std::process::{Child, ChildStdin, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use common::{assert_success, terminate_child, CliHarness};

const PROCESS_TIMEOUT: Duration = Duration::from_secs(5);
type SharedOutput = Arc<Mutex<Vec<u8>>>;
type OutputCollector = JoinHandle<io::Result<Vec<u8>>>;

#[test]
fn non_attaching_cli_list_sessions_exits_with_open_stdin_and_ignores_follow_on_input(
) -> Result<(), Box<dyn Error>> {
    let harness = CliHarness::new("control-cli-list-exit")?;
    let _daemon = harness.start_hidden_daemon()?;
    assert_success(&harness.run(&["new-session", "-d", "-s", "alpha", "sleep 30"])?);

    let mut control = ControlProcess::spawn(&harness, &["list-sessions"])?;
    control.write_input("display-message -p SHOULD-NOT-RUN\n")?;
    let output = control.wait_for_exit_with_open_stdin()?;

    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty(), "stderr={:?}", output.stderr);
    assert!(
        output.stdout.contains("alpha: 1 windows"),
        "{:?}",
        output.stdout
    );
    assert!(output.stdout.ends_with("%exit\n"), "{:?}", output.stdout);
    assert!(
        !output.stdout.contains("SHOULD-NOT-RUN"),
        "{:?}",
        output.stdout
    );
    Ok(())
}

#[test]
fn non_attaching_cli_new_session_detached_exits_with_open_stdin() -> Result<(), Box<dyn Error>> {
    let harness = CliHarness::new("control-cli-new-detached-exit")?;
    let _daemon = harness.start_hidden_daemon()?;
    let mut control = ControlProcess::spawn(&harness, &["new-session", "-d", "-s", "alpha"])?;

    let output = control.wait_for_exit_with_open_stdin()?;

    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty(), "stderr={:?}", output.stderr);
    assert!(
        output.stdout.contains("%sessions-changed\n"),
        "{:?}",
        output.stdout
    );
    assert!(output.stdout.ends_with("%exit\n"), "{:?}", output.stdout);
    Ok(())
}

#[test]
fn attaching_cli_attach_session_stays_interactive_until_stdin_eof() -> Result<(), Box<dyn Error>> {
    let harness = CliHarness::new("control-cli-attach-interactive")?;
    let _daemon = harness.start_hidden_daemon()?;
    assert_success(&harness.run(&["new-session", "-d", "-s", "alpha", "sleep 30"])?);
    let mut control = ControlProcess::spawn(&harness, &["attach-session", "-t", "alpha"])?;

    control.wait_for_output("%session-changed $0 alpha\n")?;
    control.assert_running()?;
    control.write_input("display-message -p FOLLOW-ON\n")?;
    control.wait_for_output("FOLLOW-ON\n")?;
    control.assert_running()?;
    let output = control.close_stdin_and_wait()?;

    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty(), "stderr={:?}", output.stderr);
    assert!(output.stdout.contains("FOLLOW-ON\n"), "{:?}", output.stdout);
    assert!(output.stdout.ends_with("%exit\n"), "{:?}", output.stdout);
    Ok(())
}

#[test]
fn attaching_cli_new_session_stays_interactive_until_stdin_eof() -> Result<(), Box<dyn Error>> {
    let harness = CliHarness::new("control-cli-new-interactive")?;
    let _daemon = harness.start_hidden_daemon()?;
    let mut control = ControlProcess::spawn(&harness, &["new-session", "-s", "alpha"])?;

    control.wait_for_output("%session-changed $0 alpha\n")?;
    control.assert_running()?;
    control.write_input("display-message -p FOLLOW-ON\n")?;
    control.wait_for_output("FOLLOW-ON\n")?;
    control.assert_running()?;
    let output = control.close_stdin_and_wait()?;

    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty(), "stderr={:?}", output.stderr);
    assert!(output.stdout.contains("FOLLOW-ON\n"), "{:?}", output.stdout);
    assert!(output.stdout.ends_with("%exit\n"), "{:?}", output.stdout);
    Ok(())
}

struct ControlProcess {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout: SharedOutput,
    stdout_collector: Option<OutputCollector>,
    stderr_collector: Option<OutputCollector>,
}

impl ControlProcess {
    fn spawn(harness: &CliHarness, command_args: &[&str]) -> Result<Self, Box<dyn Error>> {
        let mut command = harness.base_command();
        command
            .arg("-C")
            .args(command_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        let stdin = child.stdin.take().expect("control stdin is piped");
        let stdout = child.stdout.take().expect("control stdout is piped");
        let stderr = child.stderr.take().expect("control stderr is piped");
        let (stdout, stdout_collector) = spawn_output_collector(stdout);
        let (_stderr, stderr_collector) = spawn_output_collector(stderr);

        Ok(Self {
            child: Some(child),
            stdin: Some(stdin),
            stdout,
            stdout_collector: Some(stdout_collector),
            stderr_collector: Some(stderr_collector),
        })
    }

    fn write_input(&mut self, input: &str) -> Result<(), Box<dyn Error>> {
        let stdin = self.stdin.as_mut().expect("control stdin remains open");
        stdin.write_all(input.as_bytes())?;
        stdin.flush()?;
        Ok(())
    }

    fn wait_for_output(&self, expected: &str) -> Result<(), Box<dyn Error>> {
        let deadline = Instant::now() + PROCESS_TIMEOUT;
        while Instant::now() < deadline {
            let output = {
                let bytes = self.stdout.lock().expect("control output lock");
                String::from_utf8_lossy(&bytes).into_owned()
            };
            if output.contains(expected) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(10));
        }
        let output = {
            let bytes = self.stdout.lock().expect("control output lock");
            String::from_utf8_lossy(&bytes).into_owned()
        };
        Err(format!("timed out waiting for {expected:?} in {output:?}").into())
    }

    fn assert_running(&mut self) -> Result<(), Box<dyn Error>> {
        if let Some(status) = self.child_mut().try_wait()? {
            return Err(format!("control client exited unexpectedly with {status}").into());
        }
        Ok(())
    }

    fn wait_for_exit_with_open_stdin(&mut self) -> Result<ControlOutput, Box<dyn Error>> {
        let status = self.wait_for_exit()?;
        self.collect_output(status)
    }

    fn close_stdin_and_wait(&mut self) -> Result<ControlOutput, Box<dyn Error>> {
        drop(self.stdin.take());
        let status = self.wait_for_exit()?;
        self.collect_output(status)
    }

    fn wait_for_exit(&mut self) -> Result<ExitStatus, Box<dyn Error>> {
        let deadline = Instant::now() + PROCESS_TIMEOUT;
        while Instant::now() < deadline {
            if let Some(status) = self.child_mut().try_wait()? {
                return Ok(status);
            }
            thread::sleep(Duration::from_millis(10));
        }
        Err(format!(
            "timed out waiting for control client process {}",
            self.child_mut().id()
        )
        .into())
    }

    fn collect_output(&mut self, status: ExitStatus) -> Result<ControlOutput, Box<dyn Error>> {
        drop(self.stdin.take());
        drop(self.child.take());
        let stdout = join_output_collector(&mut self.stdout_collector, "stdout")?;
        let stderr = join_output_collector(&mut self.stderr_collector, "stderr")?;
        Ok(ControlOutput {
            status,
            stdout: String::from_utf8(stdout)?,
            stderr: String::from_utf8(stderr)?,
        })
    }

    fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("control child remains owned")
    }
}

impl Drop for ControlProcess {
    fn drop(&mut self) {
        drop(self.stdin.take());
        if let Some(child) = self.child.as_mut() {
            let _ = terminate_child(child);
        }
        drop(self.child.take());
        let _ = join_output_collector(&mut self.stdout_collector, "stdout");
        let _ = join_output_collector(&mut self.stderr_collector, "stderr");
    }
}

struct ControlOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

fn spawn_output_collector<R>(mut reader: R) -> (SharedOutput, OutputCollector)
where
    R: Read + Send + 'static,
{
    let shared = Arc::new(Mutex::new(Vec::new()));
    let mirror = Arc::clone(&shared);
    let handle = thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => return Ok(output),
                Ok(count) => {
                    output.extend_from_slice(&buffer[..count]);
                    mirror
                        .lock()
                        .expect("control output mirror lock")
                        .extend_from_slice(&buffer[..count]);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
    });
    (shared, handle)
}

fn join_output_collector(
    collector: &mut Option<OutputCollector>,
    label: &str,
) -> Result<Vec<u8>, Box<dyn Error>> {
    match collector.take() {
        Some(collector) => collector
            .join()
            .map_err(|_| format!("{label} collector thread panicked"))?
            .map_err(Into::into),
        None => Ok(Vec::new()),
    }
}
