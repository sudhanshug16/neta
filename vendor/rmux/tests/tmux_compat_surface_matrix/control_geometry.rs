use super::support::*;

#[derive(Clone, Copy)]
struct GeometryCase {
    label: &'static str,
    policy: &'static str,
    first: PtyTerminalSize,
    second: PtyTerminalSize,
    combined: PtyTerminalSize,
    remove_first: bool,
}

#[test]
fn tmux_compat_refresh_client_size_echo_matrix_when_frozen_tmux_is_available(
) -> Result<(), Box<dyn Error>> {
    let harness = TmuxCompatHarness::new("tmux-compat-refresh-size-echo")?;
    let Some(tmux_binary) = frozen_tmux_or_skip(&harness)? else {
        return Ok(());
    };
    let _guard = pty_tmux_compat_lock();
    let config = config();

    // Frozen tmux 3.7b oracle, measured 2026-07-26 with two windows and one
    // command per flush. First declaration, same-size declaration, changed
    // declaration and its same-size repeat each emit exactly one layout per
    // window in window order. `manual` emits the same matrix without changing
    // either window from 80x24.
    for policy in ["latest", "manual"] {
        let session = format!("refresh-size-echo-{policy}");
        let first_window = format!("{session}:0");
        let second_window = format!("{session}:1");
        for argv in [
            [
                "new-session",
                "-d",
                "-s",
                session.as_str(),
                "-x",
                "80",
                "-y",
                "24",
            ]
            .as_slice(),
            ["set-option", "-t", session.as_str(), "status", "off"].as_slice(),
            ["new-window", "-d", "-t", session.as_str()].as_slice(),
            [
                "set-option",
                "-w",
                "-t",
                first_window.as_str(),
                "window-size",
                policy,
            ]
            .as_slice(),
            [
                "set-option",
                "-w",
                "-t",
                second_window.as_str(),
                "window-size",
                policy,
            ]
            .as_slice(),
        ] {
            let run = harness.run_pair_with(&tmux_binary, argv, config.clone())?;
            assert_quiet_success(&run);
        }
        let windows = harness.run_pair_with(
            &tmux_binary,
            &["list-windows", "-t", session.as_str(), "-F", "#{window_id}"],
            config.clone(),
        )?;
        assert_success_without_stderr(&windows);
        let tmux_window_ids = windows
            .tmux
            .stdout_string()
            .lines()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let rmux_window_ids = windows
            .rmux
            .stdout_string()
            .lines()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        assert_eq!(tmux_window_ids.len(), 2);
        assert_eq!(rmux_window_ids.len(), 2);
        let tmux_second_layout = format!("%layout-change {} ", tmux_window_ids[1]);
        let rmux_second_layout = format!("%layout-change {} ", rmux_window_ids[1]);

        let mut tmux_control = LiveControlClient::spawn_capturing(tmux_control_mode_command(
            &harness,
            &tmux_binary,
            &[],
            &[],
        )?)?;
        let mut rmux_control =
            LiveControlClient::spawn_capturing(rmux_control_mode_command(&harness, &[], &[])?)?;
        let attach = format!("attach-session -t {session}\n");
        tmux_control.send(&attach)?;
        rmux_control.send(&attach)?;
        for (client, label) in [
            (&tmux_control, "tmux refresh attach"),
            (&rmux_control, "rmux refresh attach"),
        ] {
            client.wait_for_notification(0, Duration::from_secs(5), label, |line| {
                line.starts_with("%session-changed ")
            })?;
        }

        for (step, declared) in [
            ("first", "100x40"),
            ("idempotent", "100x40"),
            ("change", "101x41"),
            ("second-idempotent", "101x41"),
        ] {
            let tmux_cursor = tmux_control.notification_cursor();
            let rmux_cursor = rmux_control.notification_cursor();
            let refresh = format!("refresh-client -C {declared}\n");
            tmux_control.send(&refresh)?;
            rmux_control.send(&refresh)?;
            tmux_control.wait_for_notification(
                tmux_cursor,
                Duration::from_secs(5),
                "tmux refresh layout",
                |line| line.starts_with(&tmux_second_layout),
            )?;
            rmux_control.wait_for_notification(
                rmux_cursor,
                Duration::from_secs(5),
                "rmux refresh layout",
                |line| line.starts_with(&rmux_second_layout),
            )?;
            let marker = format!("REFRESH-SIZE-ECHO-{policy}-{step}");
            let marker_command = format!("display-message -p {marker}\n");
            tmux_control.send(&marker_command)?;
            rmux_control.send(&marker_command)?;
            tmux_control.wait_for_notification(
                tmux_cursor,
                Duration::from_secs(5),
                "tmux refresh boundary",
                |line| line == marker,
            )?;
            rmux_control.wait_for_notification(
                rmux_cursor,
                Duration::from_secs(5),
                "rmux refresh boundary",
                |line| line == marker,
            )?;

            let tmux_layouts =
                control_layout_summaries(&tmux_control.notifications_since(tmux_cursor));
            let rmux_layouts =
                control_layout_summaries(&rmux_control.notifications_since(rmux_cursor));
            assert_eq!(
                tmux_layouts
                    .iter()
                    .map(|line| line.0.clone())
                    .collect::<Vec<_>>(),
                tmux_window_ids,
                "frozen tmux oracle changed for {policy}/{step}: {tmux_layouts:?}"
            );
            assert_eq!(
                rmux_layouts
                    .iter()
                    .map(|line| line.0.clone())
                    .collect::<Vec<_>>(),
                rmux_window_ids,
                "rmux must emit each window exactly once for {policy}/{step}: {rmux_layouts:?}"
            );
            if policy == "manual" {
                assert_eq!(
                    rmux_layouts
                        .iter()
                        .map(|line| line.1.as_str())
                        .collect::<Vec<_>>(),
                    tmux_layouts
                        .iter()
                        .map(|line| line.1.as_str())
                        .collect::<Vec<_>>(),
                    "manual must echo the unchanged oracle layouts for {step}"
                );
            }
        }

        tmux_control.assert_running("tmux refresh echo control")?;
        rmux_control.assert_running("rmux refresh echo control")?;
    }

    Ok(())
}

fn control_layout_summaries(lines: &[String]) -> Vec<(String, String)> {
    lines
        .iter()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            (fields.next()? == "%layout-change").then_some(())?;
            let window_id = fields.next()?.to_owned();
            let geometry = fields
                .next()?
                .split(',')
                .nth(1)
                .expect("layout cell contains geometry")
                .to_owned();
            Some((window_id, geometry))
        })
        .collect()
}

#[test]
fn tmux_compat_status_geometry_follows_the_row_owning_client_when_frozen_tmux_is_available(
) -> Result<(), Box<dyn Error>> {
    let harness = TmuxCompatHarness::new("tmux-compat-status-geometry-owner")?;
    let Some(tmux_binary) = frozen_tmux_or_skip(&harness)? else {
        return Ok(());
    };
    let _guard = pty_tmux_compat_lock();
    let config = config();
    let session = "status-geometry-owner";

    for argv in [
        ["new-session", "-d", "-s", session, "-x", "80", "-y", "24"].as_slice(),
        ["set-option", "-w", "-t", session, "window-size", "largest"].as_slice(),
        ["set-option", "-t", session, "status", "on"].as_slice(),
    ] {
        let run = harness.run_pair_with(&tmux_binary, argv, config.clone())?;
        assert_quiet_success(&run);
    }

    let mut tmux_control = LiveControlClient::spawn_capturing(tmux_control_mode_command(
        &harness,
        &tmux_binary,
        &[],
        &[],
    )?)?;
    let mut rmux_control =
        LiveControlClient::spawn_capturing(rmux_control_mode_command(&harness, &[], &[])?)?;
    attach_control_pair(&mut tmux_control, &mut rmux_control, session, size(60, 20))?;
    wait_for_state(
        &harness,
        &tmux_binary,
        session,
        &[size(60, 20)],
        size(60, 20),
        config.clone(),
    )?;

    let tmux_cursor = tmux_control.notification_cursor();
    let rmux_cursor = rmux_control.notification_cursor();
    let tmux_pty =
        spawn_tmux_attached_input_client_at_size(&harness, &tmux_binary, session, size(101, 41))?;
    let rmux_pty = spawn_rmux_attached_input_client_at_size(&harness, session, size(101, 41))?;
    wait_for_state(
        &harness,
        &tmux_binary,
        session,
        &[size(60, 20), size(101, 41)],
        size(101, 40),
        config.clone(),
    )?;

    let pty_layout = |line: &str| line.starts_with("%layout-change ") && line.contains(",101x40,");
    let tmux_layout = tmux_control.wait_for_notification(
        tmux_cursor,
        Duration::from_secs(5),
        "tmux status geometry control",
        pty_layout,
    )?;
    let rmux_layout = rmux_control.wait_for_notification(
        rmux_cursor,
        Duration::from_secs(5),
        "rmux status geometry control",
        pty_layout,
    )?;
    assert_eq!(rmux_layout, tmux_layout);

    let status_three = harness.run_pair_with(
        &tmux_binary,
        &["set-option", "-t", session, "status", "3"],
        config.clone(),
    )?;
    assert_quiet_success(&status_three);
    wait_for_state(
        &harness,
        &tmux_binary,
        session,
        &[size(60, 20), size(101, 41)],
        size(101, 38),
        config.clone(),
    )?;

    drop(tmux_pty);
    drop(rmux_pty);
    wait_for_state(
        &harness,
        &tmux_binary,
        session,
        &[size(60, 20)],
        size(60, 20),
        config.clone(),
    )?;

    // Frozen tmux 3.7b also accepts the documented comma form.
    tmux_control.send("refresh-client -C 100,40\n")?;
    rmux_control.send("refresh-client -C 100,40\n")?;
    let tmux_small_pty =
        spawn_tmux_attached_input_client_at_size(&harness, &tmux_binary, session, size(70, 20))?;
    let rmux_small_pty = spawn_rmux_attached_input_client_at_size(&harness, session, size(70, 20))?;
    wait_for_state(
        &harness,
        &tmux_binary,
        session,
        &[size(100, 40), size(70, 20)],
        size(100, 40),
        config.clone(),
    )?;

    let status_one = harness.run_pair_with(
        &tmux_binary,
        &["set-option", "-t", session, "status", "on"],
        config.clone(),
    )?;
    assert_quiet_success(&status_one);
    wait_for_state(
        &harness,
        &tmux_binary,
        session,
        &[size(100, 40), size(70, 20)],
        size(100, 40),
        config.clone(),
    )?;

    drop(tmux_small_pty);
    drop(rmux_small_pty);

    tmux_control.send("refresh-client -C 101x20\n")?;
    rmux_control.send("refresh-client -C 101x20\n")?;
    wait_for_state(
        &harness,
        &tmux_binary,
        session,
        &[size(101, 20)],
        size(101, 20),
        config.clone(),
    )?;
    let tmux_tied_pty =
        spawn_tmux_attached_input_client_at_size(&harness, &tmux_binary, session, size(101, 21))?;
    let rmux_tied_pty = spawn_rmux_attached_input_client_at_size(&harness, session, size(101, 21))?;
    wait_for_state(
        &harness,
        &tmux_binary,
        session,
        &[size(101, 20), size(101, 21)],
        size(101, 20),
        config.clone(),
    )?;

    let status_three = harness.run_pair_with(
        &tmux_binary,
        &["set-option", "-t", session, "status", "3"],
        config.clone(),
    )?;
    assert_quiet_success(&status_three);
    wait_for_state(
        &harness,
        &tmux_binary,
        session,
        &[size(101, 20), size(101, 21)],
        size(101, 20),
        config,
    )?;

    drop(tmux_tied_pty);
    drop(rmux_tied_pty);
    tmux_control.assert_running("tmux status geometry control")?;
    rmux_control.assert_running("rmux status geometry control")?;
    Ok(())
}

#[test]
fn tmux_compat_detached_window_retains_pty_content_geometry_when_frozen_tmux_is_available(
) -> Result<(), Box<dyn Error>> {
    let harness = TmuxCompatHarness::new("tmux-compat-detached-pty-content-geometry")?;
    let Some(tmux_binary) = frozen_tmux_or_skip(&harness)? else {
        return Ok(());
    };
    let _guard = pty_tmux_compat_lock();
    let config = config();
    let session = "detached-pty-content";

    for argv in [
        ["new-session", "-d", "-s", session, "-x", "80", "-y", "24"].as_slice(),
        ["set-option", "-w", "-t", session, "window-size", "latest"].as_slice(),
        ["set-option", "-t", session, "status", "3"].as_slice(),
    ] {
        let run = harness.run_pair_with(&tmux_binary, argv, config.clone())?;
        assert_quiet_success(&run);
    }

    let tmux_pty =
        spawn_tmux_attached_input_client_at_size(&harness, &tmux_binary, session, size(101, 41))?;
    let rmux_pty = spawn_rmux_attached_input_client_at_size(&harness, session, size(101, 41))?;
    wait_for_state(
        &harness,
        &tmux_binary,
        session,
        &[size(101, 41)],
        size(101, 38),
        config.clone(),
    )?;

    drop(tmux_pty);
    drop(rmux_pty);
    wait_for_state(&harness, &tmux_binary, session, &[], size(101, 38), config)?;
    Ok(())
}

#[test]
fn tmux_compat_explicit_window_size_remains_content_based_when_frozen_tmux_is_available(
) -> Result<(), Box<dyn Error>> {
    let harness = TmuxCompatHarness::new("tmux-compat-explicit-content-geometry")?;
    let Some(tmux_binary) = frozen_tmux_or_skip(&harness)? else {
        return Ok(());
    };
    let _guard = pty_tmux_compat_lock();
    let config = config();
    let session = "explicit-content";

    for argv in [
        ["new-session", "-d", "-s", session, "-x", "80", "-y", "24"].as_slice(),
        ["set-option", "-t", session, "status", "on"].as_slice(),
        ["resize-window", "-t", session, "-x", "90", "-y", "30"].as_slice(),
    ] {
        let run = harness.run_pair_with(&tmux_binary, argv, config.clone())?;
        assert_quiet_success(&run);
    }

    for status in ["on", "3"] {
        let set_status = harness.run_pair_with(
            &tmux_binary,
            &["set-option", "-t", session, "status", status],
            config.clone(),
        )?;
        assert_quiet_success(&set_status);
        let geometry = harness.run_pair_with(
            &tmux_binary,
            &[
                "display-message",
                "-p",
                "-t",
                session,
                "#{window_width}x#{window_height}",
            ],
            config.clone(),
        )?;
        assert_success_without_stderr(&geometry);
        assert_eq!(geometry.tmux.stdout_string(), "90x30\n");
        assert_eq!(geometry.rmux.stdout, geometry.tmux.stdout);
    }

    Ok(())
}

#[test]
fn tmux_compat_control_geometry_survives_attach_and_control_departures_when_frozen_tmux_is_available(
) -> Result<(), Box<dyn Error>> {
    let harness = TmuxCompatHarness::new("tmux-compat-control-geometry-lifecycle")?;
    let Some(tmux_binary) = frozen_tmux_or_skip(&harness)? else {
        return Ok(());
    };
    let _guard = pty_tmux_compat_lock();

    // Frozen tmux 3.7b oracle, measured 2026-07-25. These cases pin the
    // server-global client ordering used by latest as well as the full client
    // set used by largest and smallest.
    for case in [
        GeometryCase {
            label: "mixed-latest",
            policy: "latest",
            first: size(100, 40),
            second: size(60, 20),
            combined: size(60, 20),
            remove_first: false,
        },
        GeometryCase {
            label: "mixed-largest",
            policy: "largest",
            first: size(100, 40),
            second: size(60, 20),
            combined: size(100, 40),
            remove_first: false,
        },
        GeometryCase {
            label: "mixed-smallest",
            policy: "smallest",
            first: size(60, 20),
            second: size(100, 40),
            combined: size(60, 20),
            remove_first: false,
        },
    ] {
        assert_control_and_attach_departure(&harness, &tmux_binary, case)?;
    }

    for case in [
        GeometryCase {
            label: "controls-latest",
            policy: "latest",
            first: size(100, 40),
            second: size(60, 20),
            combined: size(60, 20),
            remove_first: false,
        },
        GeometryCase {
            label: "controls-largest",
            policy: "largest",
            first: size(100, 40),
            second: size(60, 20),
            combined: size(100, 40),
            remove_first: true,
        },
        GeometryCase {
            label: "controls-smallest",
            policy: "smallest",
            first: size(60, 20),
            second: size(100, 40),
            combined: size(60, 20),
            remove_first: true,
        },
    ] {
        assert_control_departure(&harness, &tmux_binary, case)?;
    }

    Ok(())
}

#[test]
fn tmux_compat_destroy_rehome_reconciles_control_geometry_when_frozen_tmux_is_available(
) -> Result<(), Box<dyn Error>> {
    let harness = TmuxCompatHarness::new("tmux-compat-control-destroy-rehome-geometry")?;
    let Some(tmux_binary) = frozen_tmux_or_skip(&harness)? else {
        return Ok(());
    };
    let _guard = pty_tmux_compat_lock();
    let config = config();

    for argv in [
        ["new-session", "-d", "-s", "target", "-x", "60", "-y", "20"].as_slice(),
        ["new-session", "-d", "-s", "source"].as_slice(),
        ["set-option", "-t", "target", "status", "off"].as_slice(),
        ["set-option", "-t", "source", "status", "off"].as_slice(),
        ["set-option", "-w", "-t", "target", "window-size", "latest"].as_slice(),
        ["set-option", "-g", "detach-on-destroy", "off"].as_slice(),
    ] {
        let run = harness.run_pair_with(&tmux_binary, argv, config.clone())?;
        assert_quiet_success(&run);
    }

    let mut tmux_command = tmux_control_mode_command(&harness, &tmux_binary, &[], &[])?;
    tmux_command.args(["attach-session", "-t", "source"]);
    let mut tmux_control = LiveControlClient::spawn(tmux_command)?;
    let mut rmux_command = rmux_control_mode_command(&harness, &[], &[])?;
    rmux_command.args(["attach-session", "-t", "source"]);
    let mut rmux_control = LiveControlClient::spawn(rmux_command)?;
    tmux_control.send("refresh-client -C 101x41\n")?;
    rmux_control.send("refresh-client -C 101x41\n")?;
    wait_for_state(
        &harness,
        &tmux_binary,
        "source",
        &[size(101, 41)],
        size(101, 41),
        config.clone(),
    )?;

    tmux_control.send("kill-session -t source\n")?;
    rmux_control.send("kill-session -t source\n")?;
    wait_for_state(
        &harness,
        &tmux_binary,
        "target",
        &[size(101, 41)],
        size(101, 41),
        config,
    )?;
    tmux_control.assert_running("tmux rehomed control")?;
    rmux_control.assert_running("rmux rehomed control")?;
    Ok(())
}

#[test]
fn tmux_compat_control_switch_reconciles_source_geometry_when_frozen_tmux_is_available(
) -> Result<(), Box<dyn Error>> {
    let harness = TmuxCompatHarness::new("tmux-compat-control-switch-source-geometry")?;
    let Some(tmux_binary) = frozen_tmux_or_skip(&harness)? else {
        return Ok(());
    };
    let _guard = pty_tmux_compat_lock();
    let config = config();

    for argv in [
        ["new-session", "-d", "-s", "source"].as_slice(),
        ["new-session", "-d", "-s", "target"].as_slice(),
        ["set-option", "-t", "source", "status", "off"].as_slice(),
        ["set-option", "-t", "target", "status", "off"].as_slice(),
        ["set-option", "-w", "-t", "source", "window-size", "largest"].as_slice(),
        ["set-option", "-w", "-t", "target", "window-size", "largest"].as_slice(),
    ] {
        let run = harness.run_pair_with(&tmux_binary, argv, config.clone())?;
        assert_quiet_success(&run);
    }

    let mut tmux_switching =
        LiveControlClient::spawn(tmux_control_mode_command(&harness, &tmux_binary, &[], &[])?)?;
    let mut rmux_switching =
        LiveControlClient::spawn(rmux_control_mode_command(&harness, &[], &[])?)?;
    let mut tmux_surviving = LiveControlClient::spawn_capturing(tmux_control_mode_command(
        &harness,
        &tmux_binary,
        &[],
        &[],
    )?)?;
    let mut rmux_surviving =
        LiveControlClient::spawn_capturing(rmux_control_mode_command(&harness, &[], &[])?)?;
    attach_control_pair(
        &mut tmux_switching,
        &mut rmux_switching,
        "source",
        size(101, 41),
    )?;
    attach_control_pair(
        &mut tmux_surviving,
        &mut rmux_surviving,
        "source",
        size(60, 20),
    )?;
    wait_for_state(
        &harness,
        &tmux_binary,
        "source",
        &[size(101, 41), size(60, 20)],
        size(101, 41),
        config.clone(),
    )?;

    let tmux_cursor = tmux_surviving.notification_cursor();
    let rmux_cursor = rmux_surviving.notification_cursor();
    tmux_switching.send("switch-client -t target\n")?;
    rmux_switching.send("switch-client -t target\n")?;
    let switched = wait_for_pair_run(
        &harness,
        &tmux_binary,
        &[
            "display-message",
            "-p",
            "-t",
            "source",
            "#{window_width}x#{window_height}",
            ";",
            "display-message",
            "-p",
            "-t",
            "target",
            "#{window_width}x#{window_height}",
        ],
        config,
        Duration::from_secs(5),
        |run| {
            run.tmux.stdout_string() == "60x20\n101x41\n"
                && run.rmux.stdout_string() == "60x20\n101x41\n"
        },
    )?;
    assert_success_without_stderr(&switched);
    assert_eq!(switched.rmux.stdout, switched.tmux.stdout);

    // The server state is only half the contract: tmux also pushes the new
    // source geometry to the control client that stayed behind, so a -C
    // frontend does not keep rendering the pre-switch layout.
    let is_shrunk_layout =
        |line: &str| line.starts_with("%layout-change ") && line.contains(",60x20,");
    let tmux_layout = tmux_surviving.wait_for_notification(
        tmux_cursor,
        Duration::from_secs(5),
        "tmux source control",
        is_shrunk_layout,
    )?;
    let rmux_layout = rmux_surviving.wait_for_notification(
        rmux_cursor,
        Duration::from_secs(5),
        "rmux source control",
        is_shrunk_layout,
    )?;
    assert_eq!(rmux_layout, tmux_layout);

    // Order matters as much as the line: tmux reports the client move first and
    // the layout it causes second, so a -C frontend never applies the new
    // layout to the session the client just left.
    let tmux_order = tmux_surviving.notification_index_pair(
        tmux_cursor,
        |line| line.starts_with("%client-session-changed "),
        is_shrunk_layout,
    );
    let rmux_order = rmux_surviving.notification_index_pair(
        rmux_cursor,
        |line| line.starts_with("%client-session-changed "),
        is_shrunk_layout,
    );
    assert!(
        matches!(tmux_order, Some((changed, layout)) if changed < layout),
        "frozen tmux oracle changed: {tmux_order:?}"
    );
    assert!(
        matches!(rmux_order, Some((changed, layout)) if changed < layout),
        "rmux must report %client-session-changed before the %layout-change it causes: \
         {rmux_order:?}"
    );

    tmux_switching.assert_running("tmux switched control")?;
    rmux_switching.assert_running("rmux switched control")?;
    tmux_surviving.assert_running("tmux source control")?;
    rmux_surviving.assert_running("rmux source control")?;
    Ok(())
}

#[test]
fn tmux_compat_new_session_attach_existing_reconciles_control_geometry_when_frozen_tmux_is_available(
) -> Result<(), Box<dyn Error>> {
    let harness = TmuxCompatHarness::new("tmux-compat-control-new-session-attach-geometry")?;
    let Some(tmux_binary) = frozen_tmux_or_skip(&harness)? else {
        return Ok(());
    };
    let _guard = pty_tmux_compat_lock();
    let config = config();

    for argv in [
        ["new-session", "-d", "-s", "source"].as_slice(),
        ["new-session", "-d", "-s", "target"].as_slice(),
        ["set-option", "-t", "source", "status", "off"].as_slice(),
        ["set-option", "-t", "target", "status", "off"].as_slice(),
        ["set-option", "-w", "-t", "source", "window-size", "largest"].as_slice(),
        ["set-option", "-w", "-t", "target", "window-size", "largest"].as_slice(),
    ] {
        let run = harness.run_pair_with(&tmux_binary, argv, config.clone())?;
        assert_quiet_success(&run);
    }

    let mut tmux_switching =
        LiveControlClient::spawn(tmux_control_mode_command(&harness, &tmux_binary, &[], &[])?)?;
    let mut rmux_switching =
        LiveControlClient::spawn(rmux_control_mode_command(&harness, &[], &[])?)?;
    let mut tmux_surviving =
        LiveControlClient::spawn(tmux_control_mode_command(&harness, &tmux_binary, &[], &[])?)?;
    let mut rmux_surviving =
        LiveControlClient::spawn(rmux_control_mode_command(&harness, &[], &[])?)?;
    attach_control_pair(
        &mut tmux_switching,
        &mut rmux_switching,
        "source",
        size(101, 41),
    )?;
    attach_control_pair(
        &mut tmux_surviving,
        &mut rmux_surviving,
        "source",
        size(60, 20),
    )?;
    wait_for_state(
        &harness,
        &tmux_binary,
        "source",
        &[size(101, 41), size(60, 20)],
        size(101, 41),
        config.clone(),
    )?;

    tmux_switching.send("new-session -A -s target\n")?;
    rmux_switching.send("new-session -A -s target\n")?;
    let attached = wait_for_pair_run(
        &harness,
        &tmux_binary,
        &[
            "display-message",
            "-p",
            "-t",
            "source",
            "#{window_width}x#{window_height}",
            ";",
            "display-message",
            "-p",
            "-t",
            "target",
            "#{window_width}x#{window_height}",
        ],
        config,
        Duration::from_secs(5),
        |run| {
            run.tmux.stdout_string() == "60x20\n101x41\n"
                && run.rmux.stdout_string() == "60x20\n101x41\n"
        },
    )?;
    assert_success_without_stderr(&attached);
    assert_eq!(attached.rmux.stdout, attached.tmux.stdout);

    tmux_switching.assert_running("tmux new-session -A control")?;
    rmux_switching.assert_running("rmux new-session -A control")?;
    tmux_surviving.assert_running("tmux source control")?;
    rmux_surviving.assert_running("rmux source control")?;
    Ok(())
}

#[test]
fn tmux_compat_switch_notifies_the_destination_geometry_when_frozen_tmux_is_available(
) -> Result<(), Box<dyn Error>> {
    // The arrival half of the same contract: the client that already sits on
    // the destination watches its window grow, and must be told, in the same
    // order (`%client-session-changed` then `%layout-change`).
    let harness = TmuxCompatHarness::new("tmux-compat-control-switch-destination-geometry")?;
    let Some(tmux_binary) = frozen_tmux_or_skip(&harness)? else {
        return Ok(());
    };
    let _guard = pty_tmux_compat_lock();
    let config = config();

    for argv in [
        ["new-session", "-d", "-s", "source"].as_slice(),
        ["new-session", "-d", "-s", "target"].as_slice(),
        ["set-option", "-t", "source", "status", "off"].as_slice(),
        ["set-option", "-t", "target", "status", "off"].as_slice(),
        ["set-option", "-w", "-t", "source", "window-size", "largest"].as_slice(),
        ["set-option", "-w", "-t", "target", "window-size", "largest"].as_slice(),
    ] {
        let run = harness.run_pair_with(&tmux_binary, argv, config.clone())?;
        assert_quiet_success(&run);
    }

    let mut tmux_switching =
        LiveControlClient::spawn(tmux_control_mode_command(&harness, &tmux_binary, &[], &[])?)?;
    let mut rmux_switching =
        LiveControlClient::spawn(rmux_control_mode_command(&harness, &[], &[])?)?;
    let mut tmux_destination = LiveControlClient::spawn_capturing(tmux_control_mode_command(
        &harness,
        &tmux_binary,
        &[],
        &[],
    )?)?;
    let mut rmux_destination =
        LiveControlClient::spawn_capturing(rmux_control_mode_command(&harness, &[], &[])?)?;
    attach_control_pair(
        &mut tmux_switching,
        &mut rmux_switching,
        "source",
        size(101, 41),
    )?;
    attach_control_pair(
        &mut tmux_destination,
        &mut rmux_destination,
        "target",
        size(60, 20),
    )?;
    wait_for_state(
        &harness,
        &tmux_binary,
        "target",
        &[size(60, 20)],
        size(60, 20),
        config.clone(),
    )?;

    let tmux_cursor = tmux_destination.notification_cursor();
    let rmux_cursor = rmux_destination.notification_cursor();
    tmux_switching.send("switch-client -t target\n")?;
    rmux_switching.send("switch-client -t target\n")?;
    let switched = wait_for_pair_run(
        &harness,
        &tmux_binary,
        &[
            "display-message",
            "-p",
            "-t",
            "target",
            "#{window_width}x#{window_height}",
        ],
        config,
        Duration::from_secs(5),
        |run| run.tmux.stdout_string() == "101x41\n" && run.rmux.stdout_string() == "101x41\n",
    )?;
    assert_success_without_stderr(&switched);
    assert_eq!(switched.rmux.stdout, switched.tmux.stdout);

    let is_grown_layout =
        |line: &str| line.starts_with("%layout-change ") && line.contains(",101x41,");
    let tmux_layout = tmux_destination.wait_for_notification(
        tmux_cursor,
        Duration::from_secs(5),
        "tmux destination control",
        is_grown_layout,
    )?;
    let rmux_layout = rmux_destination.wait_for_notification(
        rmux_cursor,
        Duration::from_secs(5),
        "rmux destination control",
        is_grown_layout,
    )?;
    assert_eq!(rmux_layout, tmux_layout);

    let tmux_order = tmux_destination.notification_index_pair(
        tmux_cursor,
        |line| line.starts_with("%client-session-changed "),
        is_grown_layout,
    );
    let rmux_order = rmux_destination.notification_index_pair(
        rmux_cursor,
        |line| line.starts_with("%client-session-changed "),
        is_grown_layout,
    );
    assert!(
        matches!(tmux_order, Some((changed, layout)) if changed < layout),
        "frozen tmux oracle changed: {tmux_order:?}"
    );
    assert!(
        matches!(rmux_order, Some((changed, layout)) if changed < layout),
        "rmux must report %client-session-changed before the %layout-change it causes: \
         {rmux_order:?}"
    );

    tmux_switching.assert_running("tmux switched control")?;
    rmux_switching.assert_running("rmux switched control")?;
    tmux_destination.assert_running("tmux destination control")?;
    rmux_destination.assert_running("rmux destination control")?;
    Ok(())
}

#[test]
fn tmux_compat_latest_control_order_survives_an_older_client_resize_when_frozen_tmux_is_available(
) -> Result<(), Box<dyn Error>> {
    let harness = TmuxCompatHarness::new("tmux-compat-control-latest-resize-order")?;
    let Some(tmux_binary) = frozen_tmux_or_skip(&harness)? else {
        return Ok(());
    };
    let _guard = pty_tmux_compat_lock();
    let case = GeometryCase {
        label: "controls-latest-resize",
        policy: "latest",
        first: size(100, 40),
        second: size(60, 20),
        combined: size(60, 20),
        remove_first: false,
    };
    setup_session(&harness, &tmux_binary, case)?;
    let config = config();
    let mut tmux_first =
        LiveControlClient::spawn(tmux_control_mode_command(&harness, &tmux_binary, &[], &[])?)?;
    let mut rmux_first = LiveControlClient::spawn(rmux_control_mode_command(&harness, &[], &[])?)?;
    let mut tmux_latest =
        LiveControlClient::spawn(tmux_control_mode_command(&harness, &tmux_binary, &[], &[])?)?;
    let mut rmux_latest = LiveControlClient::spawn(rmux_control_mode_command(&harness, &[], &[])?)?;

    attach_control_pair(&mut tmux_first, &mut rmux_first, case.label, case.first)?;
    wait_for_state(
        &harness,
        &tmux_binary,
        case.label,
        &[case.first],
        case.first,
        config.clone(),
    )?;
    attach_control_pair(&mut tmux_latest, &mut rmux_latest, case.label, case.second)?;
    wait_for_state(
        &harness,
        &tmux_binary,
        case.label,
        &[case.first, case.second],
        case.combined,
        config.clone(),
    )?;

    let resized_first = size(101, 41);
    let refresh = format!(
        "refresh-client -C {}x{}\n",
        resized_first.cols, resized_first.rows
    );
    tmux_first.send(&refresh)?;
    rmux_first.send(&refresh)?;
    wait_for_state(
        &harness,
        &tmux_binary,
        case.label,
        &[resized_first, case.second],
        case.second,
        config,
    )?;
    tmux_first.assert_running("tmux older control")?;
    rmux_first.assert_running("rmux older control")?;
    tmux_latest.assert_running("tmux latest control")?;
    rmux_latest.assert_running("rmux latest control")?;
    Ok(())
}

fn assert_control_and_attach_departure(
    harness: &TmuxCompatHarness,
    tmux_binary: &Path,
    case: GeometryCase,
) -> Result<(), Box<dyn Error>> {
    setup_session(harness, tmux_binary, case)?;
    let config = config();
    let mut tmux_control =
        LiveControlClient::spawn(tmux_control_mode_command(harness, tmux_binary, &[], &[])?)?;
    let mut rmux_control = LiveControlClient::spawn(rmux_control_mode_command(harness, &[], &[])?)?;
    attach_control_pair(&mut tmux_control, &mut rmux_control, case.label, case.first)?;
    wait_for_state(
        harness,
        tmux_binary,
        case.label,
        &[case.first],
        case.first,
        config.clone(),
    )?;

    let tmux_attach =
        spawn_tmux_attached_input_client_at_size(harness, tmux_binary, case.label, case.second)?;
    let rmux_attach = spawn_rmux_attached_input_client_at_size(harness, case.label, case.second)?;
    wait_for_state(
        harness,
        tmux_binary,
        case.label,
        &[case.first, case.second],
        case.combined,
        config.clone(),
    )?;

    drop(tmux_attach);
    drop(rmux_attach);
    wait_for_state(
        harness,
        tmux_binary,
        case.label,
        &[case.first],
        case.first,
        config,
    )?;
    tmux_control.assert_running("tmux surviving control")?;
    rmux_control.assert_running("rmux surviving control")?;
    Ok(())
}

fn assert_control_departure(
    harness: &TmuxCompatHarness,
    tmux_binary: &Path,
    case: GeometryCase,
) -> Result<(), Box<dyn Error>> {
    setup_session(harness, tmux_binary, case)?;
    let config = config();
    let mut tmux_first =
        LiveControlClient::spawn(tmux_control_mode_command(harness, tmux_binary, &[], &[])?)?;
    let mut rmux_first = LiveControlClient::spawn(rmux_control_mode_command(harness, &[], &[])?)?;
    let mut tmux_second =
        LiveControlClient::spawn(tmux_control_mode_command(harness, tmux_binary, &[], &[])?)?;
    let mut rmux_second = LiveControlClient::spawn(rmux_control_mode_command(harness, &[], &[])?)?;
    attach_control_pair(&mut tmux_first, &mut rmux_first, case.label, case.first)?;
    wait_for_state(
        harness,
        tmux_binary,
        case.label,
        &[case.first],
        case.first,
        config.clone(),
    )?;
    attach_control_pair(&mut tmux_second, &mut rmux_second, case.label, case.second)?;
    wait_for_state(
        harness,
        tmux_binary,
        case.label,
        &[case.first, case.second],
        case.combined,
        config.clone(),
    )?;

    let surviving = if case.remove_first {
        drop(tmux_first);
        drop(rmux_first);
        case.second
    } else {
        drop(tmux_second);
        drop(rmux_second);
        case.first
    };
    wait_for_state(
        harness,
        tmux_binary,
        case.label,
        &[surviving],
        surviving,
        config,
    )?;
    Ok(())
}

fn setup_session(
    harness: &TmuxCompatHarness,
    tmux_binary: &Path,
    case: GeometryCase,
) -> Result<(), Box<dyn Error>> {
    let config = config();
    for argv in [
        ["new-session", "-d", "-s", case.label].as_slice(),
        ["set-option", "-t", case.label, "status", "off"].as_slice(),
        [
            "set-option",
            "-w",
            "-t",
            case.label,
            "window-size",
            case.policy,
        ]
        .as_slice(),
    ] {
        let run = harness.run_pair_with(tmux_binary, argv, config.clone())?;
        assert_quiet_success(&run);
    }
    Ok(())
}

fn attach_control_pair(
    tmux: &mut LiveControlClient,
    rmux: &mut LiveControlClient,
    session: &str,
    geometry: PtyTerminalSize,
) -> Result<(), Box<dyn Error>> {
    let commands = format!(
        "attach-session -t {session}\nrefresh-client -C {}x{}\n",
        geometry.cols, geometry.rows
    );
    tmux.send(&commands)?;
    rmux.send(&commands)?;
    Ok(())
}

fn wait_for_state(
    harness: &TmuxCompatHarness,
    tmux_binary: &Path,
    session: &str,
    expected_clients: &[PtyTerminalSize],
    expected_window: PtyTerminalSize,
    config: TmuxCompatRunConfig,
) -> Result<(), Box<dyn Error>> {
    let expected = state_output(expected_clients, expected_window);
    let run = wait_for_pair_run(
        harness,
        tmux_binary,
        &[
            "list-clients",
            "-t",
            session,
            "-F",
            "#{client_width}",
            ";",
            "display-message",
            "-p",
            "-t",
            session,
            "window=#{window_width}x#{window_height}",
        ],
        config,
        Duration::from_secs(5),
        |run| {
            normalized_state(&run.tmux.stdout_string()) == expected
                && normalized_state(&run.rmux.stdout_string()) == expected
        },
    )?;
    assert_success_without_stderr(&run);
    assert_eq!(
        normalized_state(&run.rmux.stdout_string()),
        normalized_state(&run.tmux.stdout_string())
    );
    Ok(())
}

fn normalized_state(output: &str) -> String {
    let mut clients = output
        .lines()
        .filter(|line| !line.starts_with("window="))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    clients.sort();
    clients.extend(
        output
            .lines()
            .filter(|line| line.starts_with("window="))
            .map(ToOwned::to_owned),
    );
    format!("{}\n", clients.join("\n"))
}

fn state_output(clients: &[PtyTerminalSize], window: PtyTerminalSize) -> String {
    let mut clients = clients
        .iter()
        .map(|size| size.cols.to_string())
        .collect::<Vec<_>>();
    clients.sort();
    clients.push(format!("window={}x{}", window.cols, window.rows));
    format!("{}\n", clients.join("\n"))
}

const fn size(cols: u16, rows: u16) -> PtyTerminalSize {
    PtyTerminalSize { cols, rows }
}

fn config() -> TmuxCompatRunConfig {
    tmux_compat_config().with_timeout(Duration::from_secs(10))
}
