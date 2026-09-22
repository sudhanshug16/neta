#![cfg(unix)]

mod common;

use std::error::Error;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use common::{assert_success, stderr, stdout, terminate_child, CliHarness};

const FILE_TIMEOUT: Duration = Duration::from_secs(5);

#[test]
fn pane_transfer_commands_round_trip_through_the_binary() -> Result<(), Box<dyn Error>> {
    let harness = CliHarness::new("pane-transfer-binary")?;
    let mut daemon = harness.start_hidden_daemon()?;
    let join_path = harness.tmpdir().join("join.txt");
    let break_path = harness.tmpdir().join("break.txt");
    let swap_source_path = harness.tmpdir().join("swap-source.txt");
    let swap_target_path = harness.tmpdir().join("swap-target.txt");

    assert_success(&harness.run(&["new-session", "-d", "-s", "alpha"])?);
    assert_success(&harness.run(&["split-window", "-v", "-t", "alpha"])?);
    assert_success(&harness.run(&["select-pane", "-t", "alpha:0.1"])?);
    assert_success(&harness.run(&["select-pane", "-t", "alpha:0.0"])?);
    assert_success(&harness.run(&["last-pane", "-t", "alpha:0"])?);
    assert_success(&harness.run(&[
        "send-keys",
        "-t",
        "alpha:0.1",
        "export RMUX_TRANSFER_MARK=joined",
        "Enter",
    ])?);

    assert_success(&harness.run(&["new-window", "-t", "alpha", "-d", "-n", "dest"])?);
    assert_success(&harness.run(&["join-pane", "-d", "-s", "alpha:0.1", "-t", "alpha:1.0"])?);
    assert_success(&harness.run(&[
        "send-keys",
        "-t",
        "alpha:1.1",
        &format!(
            "printf \"$RMUX_TRANSFER_MARK\" > {}",
            shell_quote(&join_path)
        ),
        "Enter",
    ])?);
    wait_for_file_contents(&join_path, "joined", FILE_TIMEOUT)?;

    assert_success(&harness.run(&[
        "break-pane",
        "-d",
        "-s",
        "alpha:1.1",
        "-t",
        "alpha:2",
        "-n",
        "broken",
    ])?);
    assert_success(&harness.run(&[
        "send-keys",
        "-t",
        "alpha:2.0",
        &format!(
            "printf \"$RMUX_TRANSFER_MARK\" > {}",
            shell_quote(&break_path)
        ),
        "Enter",
    ])?);
    wait_for_file_contents(&break_path, "joined", FILE_TIMEOUT)?;

    assert_success(&harness.run(&["new-window", "-t", "alpha", "-d", "-n", "swap"])?);
    assert_success(&harness.run(&["split-window", "-v", "-t", "alpha:3.0"])?);
    assert_success(&harness.run(&["kill-pane", "-t", "alpha:3.0"])?);
    assert_success(&harness.run(&[
        "send-keys",
        "-t",
        "alpha:3.0",
        "export RMUX_TRANSFER_MARK=swapped",
        "Enter",
    ])?);
    assert_success(&harness.run(&["swap-pane", "-d", "-s", "alpha:2.0", "-t", "alpha:3.0"])?);
    assert_success(&harness.run(&[
        "send-keys",
        "-t",
        "alpha:2.0",
        &format!(
            "printf \"$RMUX_TRANSFER_MARK\" > {}",
            shell_quote(&swap_source_path)
        ),
        "Enter",
    ])?);
    assert_success(&harness.run(&[
        "send-keys",
        "-t",
        "alpha:3.0",
        &format!(
            "printf \"$RMUX_TRANSFER_MARK\" > {}",
            shell_quote(&swap_target_path)
        ),
        "Enter",
    ])?);
    wait_for_file_contents(&swap_source_path, "swapped", FILE_TIMEOUT)?;
    wait_for_file_contents(&swap_target_path, "joined", FILE_TIMEOUT)?;

    assert_success(&harness.run(&["new-window", "-t", "alpha", "-d", "-n", "relative"])?);
    assert_success(&harness.run(&["split-window", "-v", "-t", "alpha:4.0"])?);
    let relative = harness.run(&["swap-pane", "-U", "-t", "alpha:4.1"])?;
    assert_success(&relative);
    assert!(
        stderr(&relative).is_empty(),
        "relative swap-pane should stay silent on success"
    );

    terminate_child(daemon.child_mut())?;
    Ok(())
}

#[test]
fn cross_session_join_pane_renumbers_colliding_source_pane_index() -> Result<(), Box<dyn Error>> {
    let harness = CliHarness::new("cross-session-join-pane-renumber")?;
    let mut daemon = harness.start_hidden_daemon()?;

    assert_success(&harness.run(&["new-session", "-d", "-s", "alpha", "sleep 60"])?);
    assert_success(&harness.run(&["new-session", "-d", "-s", "beta", "sleep 60"])?);
    assert_success(&harness.run(&["split-window", "-d", "-t", "alpha:0.0", "sleep 60"])?);
    assert_success(&harness.run(&["join-pane", "-d", "-s", "alpha:0.0", "-t", "beta:0.0"])?);

    let listed = harness.run(&[
        "list-panes",
        "-t",
        "beta:0",
        "-F",
        "#{pane_index}:#{pane_id}",
    ])?;
    assert_eq!(listed.status.code(), Some(0));
    assert_eq!(stdout(&listed).lines().count(), 2);
    assert!(stdout(&listed).starts_with("0:%"));
    assert!(stdout(&listed).contains("\n1:%"));
    assert!(stderr(&listed).is_empty());

    terminate_child(daemon.child_mut())?;
    Ok(())
}

#[test]
fn source_file_join_and_move_renumber_destroyed_source() -> Result<(), Box<dyn Error>> {
    for command in ["join-pane", "move-pane"] {
        let harness = CliHarness::new(&format!("source-file-{command}-renumber"))?;
        let mut daemon = harness.start_hidden_daemon()?;
        create_renumber_transfer_source(&harness, "alpha")?;
        let config = harness.tmpdir().join(format!("{command}-renumber.conf"));
        fs::write(&config, format!("{command} -d -s alpha:1.0 -t alpha:0.0\n"))?;

        assert_success(
            &harness.run(&["source-file", config.to_str().expect("UTF-8 config path")])?,
        );
        assert_contiguous_windows(&harness, "alpha")?;
        terminate_child(daemon.child_mut())?;
    }
    Ok(())
}

#[test]
fn startup_join_and_move_renumber_destroyed_source() -> Result<(), Box<dyn Error>> {
    for command in ["join-pane", "move-pane"] {
        let harness = CliHarness::new(&format!("startup-{command}-renumber"))?;
        let config = harness.tmpdir().join(format!("startup-{command}.conf"));
        fs::write(
            &config,
            format!(
                "new-session -d -s alpha sleep 60\n\
                 new-window -d -t alpha:1 -n SOURCE sleep 60\n\
                 new-window -d -t alpha:2 -n SURVIVOR sleep 60\n\
                 set-option -t alpha renumber-windows on\n\
                 {command} -d -s alpha:1.0 -t alpha:0.0\n"
            ),
        )?;

        assert_success(&harness.run(&[
            "-f",
            config.to_str().expect("UTF-8 startup config path"),
            "new-session",
            "-d",
            "-s",
            "boot",
            "sleep",
            "60",
        ])?);
        assert_contiguous_windows(&harness, "alpha")?;
    }
    Ok(())
}

fn create_renumber_transfer_source(
    harness: &CliHarness,
    session: &str,
) -> Result<(), Box<dyn Error>> {
    assert_success(&harness.run(&["new-session", "-d", "-s", session, "sleep", "60"])?);
    assert_success(&harness.run(&[
        "new-window",
        "-d",
        "-t",
        &format!("{session}:1"),
        "-n",
        "SOURCE",
        "sleep",
        "60",
    ])?);
    assert_success(&harness.run(&[
        "new-window",
        "-d",
        "-t",
        &format!("{session}:2"),
        "-n",
        "SURVIVOR",
        "sleep",
        "60",
    ])?);
    assert_success(&harness.run(&["set-option", "-t", session, "renumber-windows", "on"])?);
    Ok(())
}

fn assert_contiguous_windows(harness: &CliHarness, session: &str) -> Result<(), Box<dyn Error>> {
    let listed = harness.run(&["list-windows", "-t", session, "-F", "#{window_index}"])?;
    assert_eq!(listed.status.code(), Some(0), "{}", stderr(&listed));
    assert_eq!(stdout(&listed), "0\n1\n");
    assert!(stderr(&listed).is_empty());
    Ok(())
}

fn wait_for_file_contents(
    path: &Path,
    expected: &str,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        match fs::read_to_string(path) {
            Ok(contents) if contents == expected => return Ok(()),
            Ok(_) | Err(_) => std::thread::sleep(Duration::from_millis(25)),
        }
    }

    Err(std::io::Error::other(format!(
        "timed out waiting for '{}' to contain '{}'",
        path.display(),
        expected
    ))
    .into())
}

fn shell_quote(path: &Path) -> String {
    let path = path.display().to_string();
    format!("'{}'", path.replace('\'', r"'\''"))
}
