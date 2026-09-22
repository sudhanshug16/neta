#![cfg(unix)]

mod common;

use std::error::Error;
use std::fs;
use std::time::Duration;

use common::{assert_success, stderr, stdout, CliHarness};

#[derive(Debug, PartialEq, Eq)]
struct WindowSnapshot {
    name: String,
    pane_command: String,
    automatic_rename: String,
}

fn set_global_automatic_rename(harness: &CliHarness, enabled: bool) -> Result<(), Box<dyn Error>> {
    let value = if enabled { "on" } else { "off" };
    assert_success(&harness.run(&["set-option", "-gw", "automatic-rename", value])?);
    Ok(())
}

fn snapshot(harness: &CliHarness, target: &str) -> Result<WindowSnapshot, Box<dyn Error>> {
    let output = harness.run(&[
        "display-message",
        "-p",
        "-t",
        target,
        "#{window_name}|#{pane_current_command}|#{automatic-rename}",
    ])?;
    assert_eq!(
        output.status.code(),
        Some(0),
        "stdout={:?} stderr={:?}",
        stdout(&output),
        stderr(&output)
    );
    assert!(stderr(&output).is_empty(), "stderr={:?}", stderr(&output));
    let rendered = stdout(&output);
    let mut fields = rendered.trim_end_matches('\n').splitn(3, '|');
    Ok(WindowSnapshot {
        name: fields.next().unwrap_or_default().to_owned(),
        pane_command: fields.next().unwrap_or_default().to_owned(),
        automatic_rename: fields.next().unwrap_or_default().to_owned(),
    })
}

fn assert_useful_initial_name(snapshot: &WindowSnapshot, expected: &str) {
    assert_eq!(snapshot.name, expected, "snapshot={snapshot:?}");
    assert_eq!(snapshot.pane_command, expected, "snapshot={snapshot:?}");
}

#[test]
fn automatic_rename_off_assigns_initial_names_to_new_sessions() -> Result<(), Box<dyn Error>> {
    let harness = CliHarness::new("automatic-rename-initial-session")?;
    let _daemon = harness.start_hidden_daemon()?;

    assert_success(&harness.run(&["new-session", "-d", "-s", "seed", "-n", "seed", "sleep 60"])?);
    set_global_automatic_rename(&harness, false)?;

    for session in ["command-first", "command-next"] {
        assert_success(&harness.run(&["new-session", "-d", "-s", session, "sleep 60"])?);
    }
    assert_success(&harness.run(&["new-session", "-d", "-s", "default-shell"])?);
    assert_success(&harness.run(&[
        "new-session",
        "-d",
        "-s",
        "explicit",
        "-n",
        "fixed",
        "sleep 60",
    ])?);
    assert_useful_initial_name(&snapshot(&harness, "command-first:0")?, "sleep");
    assert_useful_initial_name(&snapshot(&harness, "command-next:0")?, "sleep");
    let shell = snapshot(&harness, "default-shell:0")?;
    assert!(!shell.name.is_empty(), "snapshot={shell:?}");
    assert_eq!(shell.name, shell.pane_command, "snapshot={shell:?}");
    assert_eq!(snapshot(&harness, "explicit:0")?.name, "fixed");

    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(snapshot(&harness, "command-first:0")?.name, "sleep");
    Ok(())
}

#[test]
fn automatic_rename_initial_new_window_matrix_and_shared_queue() -> Result<(), Box<dyn Error>> {
    let harness = CliHarness::new("automatic-rename-initial-window")?;
    let _daemon = harness.start_hidden_daemon()?;

    assert_success(&harness.run(&[
        "new-session",
        "-d",
        "-s",
        "windows",
        "-n",
        "seed",
        "sleep 60",
    ])?);
    assert_success(&harness.run(&["new-window", "-d", "-t", "windows", "sleep 60"])?);

    let automatic_on = snapshot(&harness, "windows:1")?;
    assert!(!automatic_on.name.is_empty(), "snapshot={automatic_on:?}");

    set_global_automatic_rename(&harness, false)?;
    for _ in 0..2 {
        assert_success(&harness.run(&["new-window", "-d", "-t", "windows", "sleep 60"])?);
    }
    assert_success(&harness.run(&[
        "new-window",
        "-d",
        "-t",
        "windows",
        "-n",
        "fixed",
        "sleep 60",
    ])?);

    let source_file = harness.tmpdir().join("automatic-rename-queue.conf");
    fs::write(&source_file, "new-window -d -t windows sleep 60\n")?;
    assert_success(&harness.run(&[
        "source-file",
        source_file.to_str().expect("test path is utf-8"),
    ])?);
    assert_success(&harness.run(&["run-shell", "-C", "new-window -d -t windows sleep 60"])?);
    let control = harness.run(&["-C", "new-window", "-d", "-t", "windows", "sleep 60"])?;
    assert_eq!(
        control.status.code(),
        Some(0),
        "stdout={:?} stderr={:?}",
        stdout(&control),
        stderr(&control)
    );
    assert!(stderr(&control).is_empty(), "stderr={:?}", stderr(&control));

    assert_success(&harness.run(&[
        "split-window",
        "-d",
        "-t",
        "windows:2",
        "tail -f /dev/null",
    ])?);
    assert_success(&harness.run(&[
        "respawn-window",
        "-k",
        "-t",
        "windows:3",
        "tail -f /dev/null",
    ])?);

    assert_useful_initial_name(&snapshot(&harness, "windows:2")?, "sleep");
    assert_eq!(snapshot(&harness, "windows:2")?.automatic_rename, "0");
    assert_eq!(snapshot(&harness, "windows:3")?.name, "sleep");
    assert_eq!(snapshot(&harness, "windows:4")?.name, "fixed");
    assert_useful_initial_name(&snapshot(&harness, "windows:5")?, "sleep");
    assert_useful_initial_name(&snapshot(&harness, "windows:6")?, "sleep");
    assert_useful_initial_name(&snapshot(&harness, "windows:7")?, "sleep");
    Ok(())
}

#[test]
fn automatic_rename_off_assigns_initial_names_only_to_created_break_windows(
) -> Result<(), Box<dyn Error>> {
    let harness = CliHarness::new("automatic-rename-initial-break")?;
    let _daemon = harness.start_hidden_daemon()?;

    assert_success(&harness.run(&["new-session", "-d", "-s", "same", "-n", "seed", "sleep 60"])?);
    set_global_automatic_rename(&harness, false)?;
    for _ in 0..2 {
        assert_success(&harness.run(&["split-window", "-d", "-t", "same:0", "sleep 60"])?);
    }
    assert_success(&harness.run(&["break-pane", "-d", "-s", "same:0.2"])?);
    assert_success(&harness.run(&["break-pane", "-d", "-s", "same:0.1"])?);

    assert_useful_initial_name(&snapshot(&harness, "same:1")?, "sleep");
    assert_useful_initial_name(&snapshot(&harness, "same:2")?, "sleep");

    assert_success(&harness.run(&[
        "new-session",
        "-d",
        "-s",
        "shell-break",
        "-n",
        "seed",
        "sleep 60",
    ])?);
    assert_success(&harness.run(&["split-window", "-d", "-t", "shell-break:0"])?);
    assert_success(&harness.run(&["break-pane", "-d", "-s", "shell-break:0.1"])?);
    let shell = snapshot(&harness, "shell-break:1")?;
    assert!(!shell.name.is_empty(), "snapshot={shell:?}");
    assert_eq!(shell.name, shell.pane_command, "snapshot={shell:?}");

    assert_success(&harness.run(&[
        "new-session",
        "-d",
        "-s",
        "cross-source",
        "-n",
        "source",
        "sleep 60",
    ])?);
    assert_success(&harness.run(&[
        "new-session",
        "-d",
        "-s",
        "cross-target",
        "-n",
        "target",
        "sleep 60",
    ])?);
    assert_success(&harness.run(&["split-window", "-d", "-t", "cross-source:0", "sleep 60"])?);
    assert_success(&harness.run(&[
        "break-pane",
        "-d",
        "-s",
        "cross-source:0.1",
        "-t",
        "cross-target:",
    ])?);
    assert_useful_initial_name(&snapshot(&harness, "cross-target:1")?, "sleep");

    assert_success(&harness.run(&[
        "new-session",
        "-d",
        "-s",
        "mono-same",
        "-n",
        "carried-same",
        "sleep 60",
    ])?);
    assert_success(&harness.run(&[
        "break-pane",
        "-d",
        "-s",
        "mono-same:0.0",
        "-t",
        "mono-same:3",
    ])?);
    assert_eq!(snapshot(&harness, "mono-same:3")?.name, "carried-same");

    assert_success(&harness.run(&[
        "new-session",
        "-d",
        "-s",
        "mono-source",
        "-n",
        "carried-cross",
        "sleep 60",
    ])?);
    assert_success(&harness.run(&[
        "new-session",
        "-d",
        "-s",
        "mono-target",
        "-n",
        "target",
        "sleep 60",
    ])?);
    assert_success(&harness.run(&[
        "break-pane",
        "-d",
        "-s",
        "mono-source:0.0",
        "-t",
        "mono-target:",
    ])?);
    assert_eq!(snapshot(&harness, "mono-target:1")?.name, "carried-cross");

    assert_success(&harness.run(&[
        "new-session",
        "-d",
        "-s",
        "explicit-break",
        "-n",
        "seed",
        "sleep 60",
    ])?);
    assert_success(&harness.run(&["split-window", "-d", "-t", "explicit-break:0", "sleep 60"])?);
    assert_success(&harness.run(&[
        "break-pane",
        "-d",
        "-s",
        "explicit-break:0.1",
        "-n",
        "fixed",
    ])?);
    assert_eq!(snapshot(&harness, "explicit-break:1")?.name, "fixed");

    set_global_automatic_rename(&harness, true)?;
    assert_success(&harness.run(&[
        "new-session",
        "-d",
        "-s",
        "automatic-on",
        "-n",
        "seed",
        "sleep 60",
    ])?);
    assert_success(&harness.run(&["split-window", "-d", "-t", "automatic-on:0", "sleep 60"])?);
    assert_success(&harness.run(&["break-pane", "-d", "-s", "automatic-on:0.1"])?);
    let automatic_on = snapshot(&harness, "automatic-on:1")?;
    assert!(!automatic_on.name.is_empty(), "snapshot={automatic_on:?}");
    Ok(())
}

#[test]
fn explicit_empty_initial_names_are_preserved_product_divergence() -> Result<(), Box<dyn Error>> {
    let harness = CliHarness::new("automatic-rename-explicit-empty")?;
    let _daemon = harness.start_hidden_daemon()?;

    assert_success(&harness.run(&["new-session", "-d", "-s", "empty-on", "-n", "", "sleep 60"])?);
    assert_success(&harness.run(&["new-window", "-d", "-t", "empty-on", "-n", "", "sleep 60"])?);
    for target in ["empty-on:0", "empty-on:1"] {
        let snapshot = snapshot(&harness, target)?;
        assert_eq!(snapshot.name, "", "target={target}");
        assert_eq!(snapshot.automatic_rename, "0", "target={target}");
    }

    set_global_automatic_rename(&harness, false)?;
    assert_success(&harness.run(&[
        "new-session",
        "-d",
        "-s",
        "empty-off",
        "-n",
        "",
        "sleep 60",
    ])?);
    assert_success(&harness.run(&["new-window", "-d", "-t", "empty-off", "-n", "", "sleep 60"])?);
    assert_success(&harness.run(&["split-window", "-d", "-t", "empty-off:0", "sleep 60"])?);
    assert_success(&harness.run(&["break-pane", "-d", "-s", "empty-off:0.1", "-n", ""])?);

    for target in ["empty-off:0", "empty-off:1", "empty-off:2"] {
        let snapshot = snapshot(&harness, target)?;
        assert_eq!(snapshot.name, "", "target={target}");
        assert_eq!(snapshot.automatic_rename, "0", "target={target}");
    }
    Ok(())
}
