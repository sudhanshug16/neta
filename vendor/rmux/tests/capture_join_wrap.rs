#![cfg(unix)]

mod common;

use std::error::Error;
use std::path::Path;
use std::time::Duration;

use common::{
    FrozenTmuxBinary, TmuxCompatHarness, TmuxCompatRun, TmuxCompatRunConfig, FROZEN_TMUX_ENV,
};

const TARGET: &str = "alpha:0.0";

#[test]
fn capture_join_after_continuation_erase_matches_tmux_3_7b_when_available(
) -> Result<(), Box<dyn Error>> {
    let harness = TmuxCompatHarness::new("capture-join-wrap-erase")?;
    let tmux_binary = match FrozenTmuxBinary::discover() {
        FrozenTmuxBinary::Available(path) => path,
        FrozenTmuxBinary::Unavailable {
            checked_path,
            reason,
        } => {
            eprintln!(
                "runtime skip: frozen tmux binary unavailable via {FROZEN_TMUX_ENV} or default '{}': {reason}",
                checked_path.display()
            );
            return Ok(());
        }
    };
    let config = TmuxCompatRunConfig::default();

    assert_pair_equal(&harness.run_pair_with(
        &tmux_binary,
        &[
            "new-session",
            "-d",
            "-x",
            "8",
            "-y",
            "6",
            "-s",
            "alpha",
            "printf 'abcdefghijklmnopqrst\\033[2;2H\\033[X\\033[4;1HNEXT'; sleep 10",
        ],
        config.clone(),
    )?);
    assert_capture_equal_when_ready(
        &harness,
        &tmux_binary,
        &config,
        &["capture-pane", "-p", "-t", TARGET],
    )?;
    assert_capture_equal_when_ready(
        &harness,
        &tmux_binary,
        &config,
        &["capture-pane", "-pJ", "-t", TARGET],
    )?;

    assert_pair_equal(&harness.run_pair_with(
        &tmux_binary,
        &[
            "respawn-pane",
            "-k",
            "-t",
            TARGET,
            "printf 'abcdefghijklmnopqrst\\033[2;1H\\033[2K\\033[4;1HNEXT'; sleep 10",
        ],
        config.clone(),
    )?);
    let physical = assert_capture_equal_when_ready(
        &harness,
        &tmux_binary,
        &config,
        &["capture-pane", "-p", "-t", TARGET],
    )?;
    assert_eq!(physical.tmux.stdout, b"abcdefgh\n\nqrst\nNEXT\n\n\n");
    let joined = assert_capture_equal_when_ready(
        &harness,
        &tmux_binary,
        &config,
        &["capture-pane", "-pJ", "-t", TARGET],
    )?;
    assert_eq!(joined.tmux.stdout, physical.tmux.stdout);

    assert_pair_equal(&harness.run_pair_with(
        &tmux_binary,
        &["resize-window", "-t", "alpha:0", "-x", "5", "-y", "6"],
        config.clone(),
    )?);
    assert_capture_equal_when_ready(
        &harness,
        &tmux_binary,
        &config,
        &["capture-pane", "-p", "-S", "-", "-E", "-", "-t", TARGET],
    )?;
    assert_capture_equal_when_ready(
        &harness,
        &tmux_binary,
        &config,
        &["capture-pane", "-pJ", "-S", "-", "-E", "-", "-t", TARGET],
    )?;

    assert_pair_equal(&harness.run_pair_with(
        &tmux_binary,
        &["resize-window", "-t", "alpha:0", "-x", "8", "-y", "3"],
        config.clone(),
    )?);
    assert_pair_equal(&harness.run_pair_with(
        &tmux_binary,
        &["resize-window", "-t", "alpha:0", "-x", "8", "-y", "6"],
        config.clone(),
    )?);
    assert_capture_equal_when_ready(
        &harness,
        &tmux_binary,
        &config,
        &["capture-pane", "-pJ", "-S", "-", "-E", "-", "-t", TARGET],
    )?;

    assert_pair_equal(&harness.run_pair_with(
        &tmux_binary,
        &[
            "respawn-pane",
            "-k",
            "-t",
            TARGET,
            "printf 'MAIN\\033[?1049h\\033[Habcdefghijkl\\033[2;1H\\033[2K\\033[3;1HNEXT'; sleep 10",
        ],
        config.clone(),
    )?);
    assert_capture_equal_when_ready(
        &harness,
        &tmux_binary,
        &config,
        &["capture-pane", "-pJ", "-t", TARGET],
    )?;
    let saved_main = wait_for_pair(
        &harness,
        &tmux_binary,
        &config,
        &["capture-pane", "-paJ", "-t", TARGET],
        |run| run.tmux.stdout.starts_with(b"MAIN") && run.rmux.stdout.starts_with(b"MAIN"),
    )?;
    assert_pair_equal(&saved_main);

    Ok(())
}

fn assert_capture_equal_when_ready(
    harness: &TmuxCompatHarness,
    tmux_binary: &Path,
    config: &TmuxCompatRunConfig,
    argv: &[&str],
) -> Result<TmuxCompatRun, Box<dyn Error>> {
    let run = wait_for_pair(harness, tmux_binary, config, argv, |run| {
        run.tmux.stdout.windows(4).any(|bytes| bytes == b"NEXT")
            && run.rmux.stdout.windows(4).any(|bytes| bytes == b"NEXT")
    })?;
    assert_pair_equal(&run);
    Ok(run)
}

fn wait_for_pair(
    harness: &TmuxCompatHarness,
    tmux_binary: &Path,
    config: &TmuxCompatRunConfig,
    argv: &[&str],
    ready: impl Fn(&TmuxCompatRun) -> bool,
) -> Result<TmuxCompatRun, Box<dyn Error>> {
    let mut last = None;
    for _ in 0..100 {
        let run = harness.run_pair_with(tmux_binary, argv, config.clone())?;
        if ready(&run) {
            return Ok(run);
        }
        last = Some(run);
        std::thread::sleep(Duration::from_millis(20));
    }

    let last = last.expect("capture pair was attempted");
    Err(format!(
        "capture pair never became ready; argv={argv:?}; tmux={:?}; rmux={:?}",
        last.tmux.stdout_string(),
        last.rmux.stdout_string()
    )
    .into())
}

fn assert_pair_equal(run: &TmuxCompatRun) {
    assert_eq!(run.tmux.status_code, run.rmux.status_code);
    assert_eq!(run.tmux.timed_out, run.rmux.timed_out);
    assert_eq!(run.tmux.stdout, run.rmux.stdout);
    assert_eq!(run.tmux.stderr, run.rmux.stderr);
}
