use super::support::*;

#[test]
fn tmux_compat_list_clients_reports_stable_session_id_for_pty_and_control_clients(
) -> Result<(), Box<dyn Error>> {
    let harness = TmuxCompatHarness::new("tmux-compat-list-clients-session-id")?;
    let Some(tmux_binary) = frozen_tmux_or_skip(&harness)? else {
        return Ok(());
    };
    let _guard = pty_tmux_compat_lock();
    let config = tmux_compat_config();

    for session in ["alpha", "beta"] {
        let create = harness.run_pair_with(
            &tmux_binary,
            &["new-session", "-d", "-s", session],
            config.clone(),
        )?;
        assert_quiet_success(&create);
    }

    let mut tmux_pty = spawn_tmux_attached_client(&harness, &tmux_binary, "alpha")?;
    let mut rmux_pty = spawn_rmux_attached_client(&harness, "alpha")?;
    let mut tmux_control =
        LiveControlClient::spawn(tmux_control_mode_command(&harness, &tmux_binary, &[], &[])?)?;
    let mut rmux_control =
        LiveControlClient::spawn(rmux_control_mode_command(&harness, &[], &[])?)?;
    tmux_control.send("attach-session -t alpha\n")?;
    rmux_control.send("attach-session -t alpha\n")?;

    let format = "#{session_id}|#{session_name}|#{client_session}|#{client_control_mode}";
    let listed = wait_for_pair_run(
        &harness,
        &tmux_binary,
        &["list-clients", "-F", format],
        config.clone(),
        Duration::from_secs(5),
        |run| {
            run.tmux.stdout_string().lines().count() == 2
                && run.rmux.stdout_string().lines().count() == 2
        },
    )?;

    tmux_pty.assert_running("tmux PTY")?;
    rmux_pty.assert_running("rmux PTY")?;
    tmux_control.assert_running("tmux control")?;
    rmux_control.assert_running("rmux control")?;
    assert_success_without_stderr(&listed);
    assert_eq!(
        listed.tmux.stdout_string(),
        "$0|alpha|alpha|0\n$0|alpha|alpha|1\n"
    );
    assert_exact_tmux_compat(&listed);

    tmux_control.send("switch-client -t beta\n")?;
    rmux_control.send("switch-client -t beta\n")?;
    let switched = wait_for_pair_run(
        &harness,
        &tmux_binary,
        &["list-clients", "-F", format],
        config.clone(),
        Duration::from_secs(5),
        |run| {
            run.tmux.stdout_string().contains("$1|beta|beta|1")
                && run.rmux.stdout_string().contains("$1|beta|beta|1")
        },
    )?;
    assert_success_without_stderr(&switched);
    assert_eq!(
        switched.tmux.stdout_string(),
        "$0|alpha|alpha|0\n$1|beta|beta|1\n"
    );
    assert_exact_tmux_compat(&switched);

    let rename = harness.run_pair_with(
        &tmux_binary,
        &["rename-session", "-t", "alpha", "renamed"],
        config.clone(),
    )?;
    assert_quiet_success(&rename);
    let renamed = wait_for_pair_run(
        &harness,
        &tmux_binary,
        &["list-clients", "-F", format],
        config,
        Duration::from_secs(5),
        |run| {
            run.tmux.stdout_string().contains("$0|renamed|renamed|0")
                && run.rmux.stdout_string().contains("$0|renamed|renamed|0")
        },
    )?;
    assert_success_without_stderr(&renamed);
    assert_eq!(
        renamed.tmux.stdout_string(),
        "$0|renamed|renamed|0\n$1|beta|beta|1\n"
    );
    assert_exact_tmux_compat(&renamed);

    Ok(())
}
