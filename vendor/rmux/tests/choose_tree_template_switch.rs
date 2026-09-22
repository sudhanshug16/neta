#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::error::Error;
use std::time::{Duration, Instant};

use common::{
    assert_success, drain_attach_output, read_until_contains, terminate_child, AttachedSession,
    CliHarness,
};
use rmux_pty::TerminalSize;

const IO_TIMEOUT: Duration = Duration::from_secs(10);

type TestResult<T> = Result<T, Box<dyn Error>>;

fn listed_client_sessions(harness: &CliHarness) -> TestResult<BTreeMap<u32, String>> {
    let output = harness.run(&["list-clients", "-F", "#{client_pid}|#{session_name}"])?;
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
            let (pid, session_name) = line
                .split_once('|')
                .ok_or_else(|| format!("malformed list-clients row: {line:?}"))?;
            Ok((pid.parse::<u32>()?, session_name.to_owned()))
        })
        .collect()
}

fn assert_explicit_choose_tree_switch(template: &str, label: &str) -> TestResult<()> {
    let harness = CliHarness::new(label)?;
    let mut daemon = harness.start_hidden_daemon()?;
    assert_success(&harness.run(&["new-session", "-d", "-s", "source"])?);
    assert_success(&harness.run(&["new-session", "-d", "-s", "target"])?);
    assert_success(&harness.run(&[
        "bind-key",
        "z",
        "choose-tree",
        "-s",
        "-F",
        "W13|#{session_name}",
        template,
    ])?);

    let mut witness = AttachedSession::spawn(&harness, "source", TerminalSize::new(100, 30))?;
    witness.wait_for_raw_mode(IO_TIMEOUT)?;
    let _ = read_until_contains(witness.master_mut(), "[source]", IO_TIMEOUT)?;
    let witness_pid = witness.child_mut().id();

    let mut actor = AttachedSession::spawn(&harness, "source", TerminalSize::new(100, 30))?;
    actor.wait_for_raw_mode(IO_TIMEOUT)?;
    let _ = read_until_contains(actor.master_mut(), "[source]", IO_TIMEOUT)?;
    let actor_pid = actor.child_mut().id();

    let before = listed_client_sessions(&harness)?;
    assert_eq!(before.get(&actor_pid).map(String::as_str), Some("source"));
    assert_eq!(before.get(&witness_pid).map(String::as_str), Some("source"));
    assert_eq!(
        before.len(),
        2,
        "setup should expose exactly two PTY clients"
    );

    actor.send_bytes(b"\x02z")?;
    let tree = read_until_contains(actor.master_mut(), "W13|target", IO_TIMEOUT)?;
    assert!(
        tree.contains("(1)"),
        "the target session should own shortcut 1 in the two-session tree: {tree:?}"
    );
    actor.send_bytes(b"1")?;

    let deadline = Instant::now() + IO_TIMEOUT;
    let after = loop {
        let _ = drain_attach_output(actor.master_mut());
        drain_attach_output(witness.master_mut())?;
        let clients = listed_client_sessions(&harness)?;
        let actor_session = clients.get(&actor_pid).map(String::as_str);
        if actor_session == Some("target")
            || actor_session.is_none()
            || actor.child_mut().try_wait()?.is_some()
            || Instant::now() >= deadline
        {
            break clients;
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    assert!(
        actor.child_mut().try_wait()?.is_none(),
        "accepting an explicit choose-tree template must keep the actor PTY alive"
    );
    assert_eq!(
        after.get(&actor_pid).map(String::as_str),
        Some("target"),
        "the explicit choose-tree template must switch the actor session"
    );
    assert!(
        witness.child_mut().try_wait()?.is_none(),
        "the witness PTY must remain alive"
    );
    assert_eq!(
        after.get(&witness_pid).map(String::as_str),
        Some("source"),
        "the witness PTY must remain on its original session"
    );
    assert_eq!(
        after.len(),
        before.len(),
        "switching the actor must preserve the client count"
    );

    assert_success(&harness.run(&["kill-session", "-t", "source"])?);
    assert!(witness.wait_for_exit(IO_TIMEOUT)?.success());
    witness.assert_restored()?;
    assert_success(&harness.run(&["kill-session", "-t", "target"])?);
    assert!(actor.wait_for_exit(IO_TIMEOUT)?.success());
    actor.assert_restored()?;
    terminate_child(daemon.child_mut())?;
    Ok(())
}

#[test]
fn choose_tree_explicit_literal_switch_keeps_the_actor_attached() -> TestResult<()> {
    assert_explicit_choose_tree_switch("switch-client -t target", "choose-tree-template-literal")
}

#[test]
fn choose_tree_explicit_percent_switch_keeps_the_actor_attached() -> TestResult<()> {
    assert_explicit_choose_tree_switch("switch-client -t '%%'", "choose-tree-template-percent")
}

#[test]
fn choose_tree_explicit_zoom_percent_switch_keeps_the_actor_attached() -> TestResult<()> {
    assert_explicit_choose_tree_switch(
        "switch-client -Zt '%%'",
        "choose-tree-template-zoom-percent",
    )
}
