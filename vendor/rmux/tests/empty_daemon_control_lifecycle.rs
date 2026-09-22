#![cfg(target_os = "linux")]

mod common;

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Output, Stdio};
use std::time::{Duration, Instant};

use common::{assert_success, CliHarness, BINARY_OVERRIDE_ENV};

const PROCESS_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProcessGeneration {
    pid: u32,
    start_tick: u64,
}

#[test]
fn unadmitted_control_input_cannot_keep_an_auto_started_empty_daemon() -> Result<(), Box<dyn Error>>
{
    let harness = CliHarness::new("control-empty-input")?;
    let _cleanup = harness.auto_start_cleanup()?;
    let cases = [
        ("valid-line", b"list-sessions\n".as_slice()),
        ("invalid-line", b"w13-not-a-command\n".as_slice()),
        ("partial-line", b"list-sessions".as_slice()),
        ("blank", b" \t\r\n".as_slice()),
    ];
    let mut failures = Vec::new();

    for (label, input) in cases {
        let _ = fs::remove_file(harness.pid_path());
        let (output, generation) = run_control_start_server(&harness, input)?;
        let rendered = String::from_utf8_lossy(&output.stdout);
        if output.status.code() != Some(0) {
            failures.push(format!(
                "{label}: status={:?}, stderr={:?}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        if !output.stderr.is_empty() {
            failures.push(format!(
                "{label}: stderr={:?}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        if rendered.matches("%begin ").count() != 1 {
            failures.push(format!(
                "{label}: the stdin command was admitted, so this run does not isolate the unadmitted-input boundary: {rendered:?}"
            ));
        }
        if !rendered.ends_with("%exit\n") {
            failures.push(format!("{label}: incomplete control output {rendered:?}"));
        }

        if !wait_for_generation_exit(generation, SHUTDOWN_TIMEOUT)? {
            failures.push(format!("{label}: {generation:?} remained alive"));
            let killed = harness.run(&["kill-server"])?;
            assert_success(&killed);
            assert!(
                wait_for_generation_exit(generation, SHUTDOWN_TIMEOUT)?,
                "{label}: cleanup could not stop {generation:?}"
            );
        }
    }

    assert!(
        failures.is_empty(),
        "unadmitted stdin suppressed typed empty-server cleanup: {}",
        failures.join("; ")
    );
    Ok(())
}

#[test]
fn admitted_control_command_finishes_before_typed_empty_cleanup() -> Result<(), Box<dyn Error>> {
    let harness = CliHarness::new("control-empty-admitted")?;
    let _cleanup = harness.auto_start_cleanup()?;
    let arguments = [
        "-C",
        "start-server",
        ";",
        "new-session",
        "-s",
        "alpha",
        "/bin/sleep 20",
        ";",
        "display-message",
        "-p",
        "PID=#{pid}",
    ];
    let input = b"display-message -p ADMITTED\nw13-not-a-command\nkill-session -t alpha\n";

    let (output, generation) = run_control(&harness, &arguments, input)?;

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr={:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let rendered = String::from_utf8(output.stdout)?;
    assert!(rendered.contains("ADMITTED\n"), "{rendered:?}");
    assert!(
        rendered.lines().any(|line| line.starts_with("%error ")),
        "the admitted invalid command must receive a typed control error: {rendered:?}"
    );
    assert!(rendered.ends_with("%exit\n"), "{rendered:?}");
    assert!(
        wait_for_generation_exit(generation, SHUTDOWN_TIMEOUT)?,
        "the admitted kill must drain before typed cleanup stops {generation:?}"
    );
    Ok(())
}

fn run_control_start_server(
    harness: &CliHarness,
    input: &[u8],
) -> Result<(Output, ProcessGeneration), Box<dyn Error>> {
    run_control(harness, &["-C", "start-server"], input)
}

fn run_control(
    harness: &CliHarness,
    arguments: &[&str],
    input: &[u8],
) -> Result<(Output, ProcessGeneration), Box<dyn Error>> {
    let mut child = harness
        .base_command()
        .args(arguments)
        .env(BINARY_OVERRIDE_ENV, harness.launcher_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = Some(child.stdin.take().expect("control stdin is piped"));
    stdin
        .as_mut()
        .expect("control stdin remains open")
        .write_all(input)?;
    stdin
        .as_mut()
        .expect("control stdin remains open")
        .flush()?;
    drop(stdin.take());

    let generation = wait_for_recorded_generation(harness.pid_path(), PROCESS_TIMEOUT)?;
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("timed out waiting for control start-server to exit".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    drop(stdin.take());
    Ok((child.wait_with_output()?, generation))
}

fn wait_for_recorded_generation(
    pid_path: &Path,
    timeout: Duration,
) -> Result<ProcessGeneration, Box<dyn Error>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(pid) = fs::read_to_string(pid_path)
            .and_then(|value| value.trim().parse::<u32>().map_err(std::io::Error::other))
        {
            if let Some(start_tick) = process_start_tick(pid)? {
                return Ok(ProcessGeneration { pid, start_tick });
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "timed out reading a live daemon generation from '{}'",
                pid_path.display()
            )
            .into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn wait_for_generation_exit(
    generation: ProcessGeneration,
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    let deadline = Instant::now() + timeout;
    loop {
        if process_start_tick(generation.pid)? != Some(generation.start_tick) {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn process_start_tick(pid: u32) -> Result<Option<u64>, Box<dyn Error>> {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ESRCH) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    let fields = stat
        .rsplit_once(") ")
        .ok_or_else(|| format!("malformed /proc/{pid}/stat"))?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    let start_tick = fields
        .get(19)
        .ok_or_else(|| format!("missing start tick in /proc/{pid}/stat"))?
        .parse::<u64>()?;
    Ok(Some(start_tick))
}
