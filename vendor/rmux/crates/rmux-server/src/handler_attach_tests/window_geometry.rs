use super::*;

use crate::control::{ControlModeUpgrade, ControlServerEvent, CONTROL_SERVER_EVENT_CAPACITY};
use rmux_proto::{BreakPaneRequest, ControlMode, ResizeWindowAdjustment, ResizeWindowRequest};

const EXTERNAL_SIZE: TerminalSize = TerminalSize {
    cols: 101,
    rows: 41,
};
const STATUS_ON_CONTENT_SIZE: TerminalSize = TerminalSize {
    cols: 101,
    rows: 40,
};
const STATUS_THREE_CONTENT_SIZE: TerminalSize = TerminalSize {
    cols: 101,
    rows: 38,
};

#[tokio::test]
async fn attached_status_split_and_last_detach_keep_terminal_and_content_geometry_distinct() {
    let handler = RequestHandler::new();
    let session_name = session_name("window-geometry-status");
    let attach_pid = 91_801;
    let _attach_rx = create_attached_session(&handler, attach_pid, &session_name).await;
    handler
        .handle_attached_resize(attach_pid, EXTERNAL_SIZE)
        .await
        .expect("101x41 attached resize succeeds");

    assert_session_geometry(
        &handler,
        &session_name,
        0,
        EXTERNAL_SIZE,
        STATUS_ON_CONTENT_SIZE,
    )
    .await;
    assert_eq!(
        pane_terminal_size(&handler, &session_name, 0, 0).await,
        STATUS_ON_CONTENT_SIZE
    );

    assert!(matches!(
        handler
            .handle(Request::SplitWindow(SplitWindowRequest {
                target: SplitWindowTarget::Session(session_name.clone()),
                direction: rmux_proto::SplitDirection::Vertical,
                before: false,
                environment: None,
            }))
            .await,
        Response::SplitWindow(_)
    ));
    assert_pane_rows(&handler, &session_name, 0, &[20, 19]).await;
    assert_eq!(
        pane_terminal_size(&handler, &session_name, 0, 0).await.rows,
        20
    );
    assert_eq!(
        pane_terminal_size(&handler, &session_name, 0, 1).await.rows,
        19
    );

    let control_pid = 91_802;
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(CONTROL_SERVER_EVENT_CAPACITY);
    let control_id = handler
        .register_control_with_closing(
            control_pid,
            ControlModeUpgrade {
                initial_command_count: 0,
                mode: ControlMode::Plain,
                terminal_context: OuterTerminalContext::default(),
            },
            event_tx,
            Arc::new(AtomicBool::new(false)),
        )
        .await;
    handler
        .set_control_session(control_pid, Some(session_name.clone()))
        .await
        .expect("control client selects geometry session");
    drain_control_events(&mut event_rx).await;

    set_status(&handler, &session_name, "3").await;
    let notifications = drain_control_events(&mut event_rx).await;
    let layout_changes = notifications
        .iter()
        .filter(|line| line.starts_with("%layout-change "))
        .collect::<Vec<_>>();
    assert_eq!(
        layout_changes.len(),
        1,
        "status 3 must publish exactly one layout change: {notifications:?}"
    );
    assert!(
        layout_changes[0].contains(",101x38,0,0[101x19,0,0,0,101x18,0,20,1]"),
        "status 3 layout must preserve tmux split rounding: {}",
        layout_changes[0]
    );
    assert_session_geometry(
        &handler,
        &session_name,
        0,
        EXTERNAL_SIZE,
        STATUS_THREE_CONTENT_SIZE,
    )
    .await;
    assert_pane_rows(&handler, &session_name, 0, &[19, 18]).await;
    assert_eq!(
        pane_terminal_size(&handler, &session_name, 0, 0).await.rows,
        19
    );
    assert_eq!(
        pane_terminal_size(&handler, &session_name, 0, 1).await.rows,
        18
    );

    handler.finish_control(control_pid, control_id).await;
    let attach_identity = handler.active_attach_identity_for_test(attach_pid).await;
    handler
        .finish_attach(attach_pid, attach_identity.attach_id())
        .await;
    set_status(&handler, &session_name, "on").await;
    assert_window_size(&handler, &session_name, 0, STATUS_THREE_CONTENT_SIZE).await;
    set_status(&handler, &session_name, "off").await;
    assert_window_size(&handler, &session_name, 0, STATUS_THREE_CONTENT_SIZE).await;
    assert_pane_rows(&handler, &session_name, 0, &[19, 18]).await;
}

#[tokio::test]
async fn attached_new_break_resize_and_formats_use_content_geometry() {
    let handler = RequestHandler::new();
    let session_name = session_name("window-geometry-commands");
    let attach_pid = std::process::id();
    let _attach_rx = create_attached_session(&handler, attach_pid, &session_name).await;
    handler
        .handle_attached_resize(attach_pid, EXTERNAL_SIZE)
        .await
        .expect("101x41 attached resize succeeds");
    set_status(&handler, &session_name, "3").await;

    let active_window = new_window(&handler, &session_name, false).await;
    let detached_window = new_window(&handler, &session_name, true).await;
    assert_eq!(active_window, 1);
    assert_eq!(detached_window, 2);
    for window_index in 0..=2 {
        assert_window_size(
            &handler,
            &session_name,
            window_index,
            STATUS_THREE_CONTENT_SIZE,
        )
        .await;
        assert_eq!(
            pane_terminal_size(&handler, &session_name, window_index, 0).await,
            STATUS_THREE_CONTENT_SIZE
        );
    }
    assert_eq!(
        handler
            .state
            .lock()
            .await
            .sessions
            .session(&session_name)
            .expect("session exists")
            .terminal_size(),
        EXTERNAL_SIZE
    );

    assert!(matches!(
        handler
            .handle(Request::SplitWindow(SplitWindowRequest {
                target: SplitWindowTarget::Pane(PaneTarget::with_window(
                    session_name.clone(),
                    active_window,
                    0,
                )),
                direction: rmux_proto::SplitDirection::Vertical,
                before: false,
                environment: None,
            }))
            .await,
        Response::SplitWindow(_)
    ));
    assert_pane_rows(&handler, &session_name, active_window, &[19, 18]).await;
    let response = handler
        .handle(Request::BreakPane(Box::new(BreakPaneRequest {
            source: PaneTarget::with_window(session_name.clone(), active_window, 1),
            target: None,
            name: None,
            detached: true,
            after: false,
            before: false,
            print_target: false,
            format: None,
        })))
        .await;
    let Response::BreakPane(response) = response else {
        panic!("break-pane succeeds: {response:?}");
    };
    let broken_window = response.target.window_index();
    assert_eq!(broken_window, 3);
    for window_index in [active_window, broken_window] {
        assert_window_size(
            &handler,
            &session_name,
            window_index,
            STATUS_THREE_CONTENT_SIZE,
        )
        .await;
        assert_eq!(
            pane_terminal_size(&handler, &session_name, window_index, 0).await,
            STATUS_THREE_CONTENT_SIZE
        );
    }

    let list_windows = handler
        .handle(Request::ListWindows(Box::new(ListWindowsRequest {
            target: session_name.clone(),
            format: Some(
                "#{window_index}:#{window_width}x#{window_height}:#{pane_height}".to_owned(),
            ),
            filter: None,
            sort_order: None,
            reversed: false,
        })))
        .await;
    let Response::ListWindows(list_windows) = list_windows else {
        panic!("list-windows succeeds: {list_windows:?}");
    };
    assert_eq!(
        list_windows.output.stdout(),
        b"0:101x38:38\n1:101x38:38\n2:101x38:38\n3:101x38:38\n"
    );
    let list_inactive_pane = handler
        .handle(Request::ListPanes(Box::new(ListPanesRequest {
            target: session_name.clone(),
            format: Some("#{pane_width}x#{pane_height}".to_owned()),
            filter: None,
            sort_order: None,
            reversed: false,
            target_window_index: Some(detached_window),
        })))
        .await;
    let Response::ListPanes(list_inactive_pane) = list_inactive_pane else {
        panic!("list-panes succeeds: {list_inactive_pane:?}");
    };
    assert_eq!(list_inactive_pane.output.stdout(), b"101x38\n");

    resize_window(
        &handler,
        &session_name,
        active_window,
        None,
        None,
        Some(ResizeWindowAdjustment::Left(2)),
    )
    .await;
    assert_window_size(
        &handler,
        &session_name,
        active_window,
        TerminalSize { cols: 99, rows: 38 },
    )
    .await;
    resize_window(
        &handler,
        &session_name,
        active_window,
        None,
        None,
        Some(ResizeWindowAdjustment::Right(2)),
    )
    .await;
    assert_window_size(
        &handler,
        &session_name,
        active_window,
        STATUS_THREE_CONTENT_SIZE,
    )
    .await;
    resize_window(
        &handler,
        &session_name,
        active_window,
        None,
        None,
        Some(ResizeWindowAdjustment::Up(2)),
    )
    .await;
    assert_window_size(
        &handler,
        &session_name,
        active_window,
        TerminalSize {
            cols: 101,
            rows: 36,
        },
    )
    .await;
    resize_window(
        &handler,
        &session_name,
        active_window,
        None,
        None,
        Some(ResizeWindowAdjustment::Down(2)),
    )
    .await;
    assert_window_size(
        &handler,
        &session_name,
        active_window,
        STATUS_THREE_CONTENT_SIZE,
    )
    .await;
    resize_window(
        &handler,
        &session_name,
        active_window,
        Some(90),
        Some(30),
        None,
    )
    .await;
    assert_window_size(
        &handler,
        &session_name,
        active_window,
        TerminalSize { cols: 90, rows: 30 },
    )
    .await;
    assert_eq!(
        handler.state.lock().await.options.resolve_for_window(
            &session_name,
            active_window,
            OptionName::WindowSize
        ),
        Some("manual")
    );
    set_status(&handler, &session_name, "on").await;
    assert_window_size(
        &handler,
        &session_name,
        active_window,
        TerminalSize { cols: 90, rows: 30 },
    )
    .await;
    set_status(&handler, &session_name, "off").await;
    assert_window_size(
        &handler,
        &session_name,
        active_window,
        TerminalSize { cols: 90, rows: 30 },
    )
    .await;
}

async fn set_status(handler: &RequestHandler, session_name: &SessionName, value: &str) {
    assert!(matches!(
        handler
            .handle(Request::SetOption(SetOptionRequest {
                scope: ScopeSelector::Session(session_name.clone()),
                option: OptionName::Status,
                value: value.to_owned(),
                mode: SetOptionMode::Replace,
            }))
            .await,
        Response::SetOption(_)
    ));
}

async fn new_window(handler: &RequestHandler, session_name: &SessionName, detached: bool) -> u32 {
    let response = handler
        .handle(Request::NewWindow(Box::new(NewWindowRequest {
            target: session_name.clone(),
            name: None,
            detached,
            environment: None,
            command: None,
            process_command: None,
            start_directory: None,
            target_window_index: None,
            insert_at_target: false,
        })))
        .await;
    let Response::NewWindow(response) = response else {
        panic!("new-window succeeds: {response:?}");
    };
    response.target.window_index()
}

async fn resize_window(
    handler: &RequestHandler,
    session_name: &SessionName,
    window_index: u32,
    width: Option<u16>,
    height: Option<u16>,
    adjustment: Option<ResizeWindowAdjustment>,
) {
    assert!(matches!(
        handler
            .handle(Request::ResizeWindow(ResizeWindowRequest {
                target: WindowTarget::with_window(session_name.clone(), window_index),
                width,
                height,
                adjustment,
            }))
            .await,
        Response::ResizeWindow(_)
    ));
}

async fn assert_session_geometry(
    handler: &RequestHandler,
    session_name: &SessionName,
    window_index: u32,
    terminal_size: TerminalSize,
    content_size: TerminalSize,
) {
    let state = handler.state.lock().await;
    let session = state
        .sessions
        .session(session_name)
        .expect("session exists");
    assert_eq!(session.terminal_size(), terminal_size);
    assert_eq!(
        session
            .window_at(window_index)
            .expect("window exists")
            .size(),
        content_size
    );
}

async fn assert_window_size(
    handler: &RequestHandler,
    session_name: &SessionName,
    window_index: u32,
    expected: TerminalSize,
) {
    let state = handler.state.lock().await;
    assert_eq!(
        state
            .sessions
            .session(session_name)
            .expect("session exists")
            .window_at(window_index)
            .expect("window exists")
            .size(),
        expected
    );
}

async fn assert_pane_rows(
    handler: &RequestHandler,
    session_name: &SessionName,
    window_index: u32,
    expected: &[u16],
) {
    let state = handler.state.lock().await;
    let rows = state
        .sessions
        .session(session_name)
        .expect("session exists")
        .window_at(window_index)
        .expect("window exists")
        .panes()
        .iter()
        .map(|pane| pane.geometry().rows())
        .collect::<Vec<_>>();
    assert_eq!(rows, expected);
}

async fn drain_control_events(
    event_rx: &mut tokio::sync::mpsc::Receiver<ControlServerEvent>,
) -> Vec<String> {
    tokio::time::sleep(Duration::from_millis(50)).await;
    let mut notifications = Vec::new();
    while let Ok(event) = event_rx.try_recv() {
        if let ControlServerEvent::Notification(line) = event {
            notifications.push(line);
        }
    }
    notifications
}
