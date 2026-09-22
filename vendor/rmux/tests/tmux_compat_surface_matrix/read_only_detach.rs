use super::support::*;

#[test]
fn tmux_compat_read_only_attach_keeps_mutations_blocked_but_allows_local_detach_when_frozen_tmux_is_available(
) -> Result<(), Box<dyn Error>> {
    let harness = TmuxCompatHarness::new("tmux-compat-read-only-local-detach")?;
    let Some(tmux_binary) = frozen_tmux_or_skip(&harness)? else {
        return Ok(());
    };
    let _guard = pty_tmux_compat_lock();
    let config = attached_client_config();
    let deadline = AttachedClientDeadline::new();
    let created = harness.run_pair_with(
        &tmux_binary,
        &["new-session", "-d", "-s", "alpha"],
        config.clone(),
    )?;
    assert_quiet_success(&created);

    let mut rmux_attach = spawn_rmux_attached_client(&harness, "alpha")?;
    let mut tmux_attach = spawn_tmux_attached_client(&harness, &tmux_binary, "alpha")?;
    wait_for_attached_clients(&harness, &tmux_binary, config.clone(), &deadline)?;

    write_attached_keys(&mut rmux_attach, b"\x02", &deadline)?;
    write_attached_keys(&mut tmux_attach, b"\x02", &deadline)?;
    write_attached_keys(&mut rmux_attach, b"c", &deadline)?;
    write_attached_keys(&mut tmux_attach, b"c", &deadline)?;
    let blocked = wait_for_attached_pair(
        &harness,
        &tmux_binary,
        &["list-windows", "-t", "alpha", "-F", "#{window_index}"],
        config.clone(),
        &deadline,
        |run| run.rmux.stdout == b"0\n" && run.tmux.stdout == b"0\n",
    )?;
    assert_success_without_stderr(&blocked);

    write_attached_keys(&mut rmux_attach, b"\x02", &deadline)?;
    write_attached_keys(&mut tmux_attach, b"\x02", &deadline)?;
    write_attached_keys(&mut rmux_attach, b"d", &deadline)?;
    write_attached_keys(&mut tmux_attach, b"d", &deadline)?;
    let detached = wait_for_attached_pair(
        &harness,
        &tmux_binary,
        &["list-clients", "-F", "#{client_flags}"],
        config,
        &deadline,
        |run| run.rmux.stdout.is_empty() && run.tmux.stdout.is_empty(),
    )?;
    assert_success_without_stderr(&detached);

    Ok(())
}
