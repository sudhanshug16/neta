use tokio::sync::mpsc;

use super::RequestHandler;
use crate::control_notifications::{
    collect_control_notifications, ControlClientSnapshot, PreparedControlNotification,
};
use crate::pane_io::AttachControl;
use rmux_core::LifecycleEvent;
use rmux_proto::{
    DisplayMessageRequest, DisplayPanesRequest, DisplayPanesResponse, NewSessionRequest,
    NewWindowRequest, PaneTarget, Request, ResizePaneAdjustment, ResizePaneRequest, Response,
    SelectWindowRequest, SessionName, SplitDirection, SplitWindowRequest, SplitWindowTarget,
    Target, TerminalSize, WindowTarget,
};

fn session_name(value: &str) -> SessionName {
    SessionName::new(value).expect("valid session name")
}

async fn rendered_window_layouts(handler: &RequestHandler, target: PaneTarget) -> (String, String) {
    let response = handler
        .handle(Request::DisplayMessage(DisplayMessageRequest {
            target: Some(Target::Pane(target)),
            print: true,
            message: Some("#{window_layout}|#{window_visible_layout}".to_owned()),
            empty_target_context: false,
        }))
        .await;
    let Response::DisplayMessage(response) = response else {
        panic!("expected display-message response");
    };
    let output = response
        .command_output()
        .expect("display-message -p returns output");
    let rendered = std::str::from_utf8(output.stdout())
        .expect("layout output is utf-8")
        .trim_end();
    let (layout, visible_layout) = rendered
        .split_once('|')
        .expect("layout output contains the separator");
    (layout.to_owned(), visible_layout.to_owned())
}

async fn layout_change_notification(
    handler: &RequestHandler,
    target: &WindowTarget,
) -> PreparedControlNotification {
    let state = handler.state.lock().await;
    let event = LifecycleEvent::WindowLayoutChanged {
        target: target.clone(),
    };
    let clients = [ControlClientSnapshot {
        pid: 73,
        session_name: Some(target.session_name().clone()),
    }];
    let notifications = collect_control_notifications(&state, &event, None, &clients);
    assert_eq!(notifications.len(), 1);
    notifications.into_iter().next().expect("one notification")
}

#[tokio::test]
async fn resize_pane_zoom_toggles_the_target_window() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");

    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha.clone(),
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));
    assert!(matches!(
        handler
            .handle(Request::SplitWindow(SplitWindowRequest {
                target: SplitWindowTarget::Session(alpha.clone()),
                direction: SplitDirection::Horizontal,
                before: false,
                environment: None,
            }))
            .await,
        Response::SplitWindow(_)
    ));

    let response = handler
        .handle(Request::ResizePane(ResizePaneRequest {
            target: PaneTarget::new(alpha.clone(), 1),
            adjustment: ResizePaneAdjustment::Zoom,
        }))
        .await;

    assert_eq!(
        response,
        Response::ResizePane(rmux_proto::ResizePaneResponse {
            target: PaneTarget::new(alpha.clone(), 1),
            adjustment: ResizePaneAdjustment::Zoom,
        })
    );

    let state = handler.state.lock().await;
    assert!(state
        .sessions
        .session(&alpha)
        .expect("session exists")
        .window()
        .is_zoomed());
}

#[tokio::test]
async fn visible_layout_and_layout_change_follow_zoom_for_inactive_windows() {
    // tmux 3.7b oracle, measured 2026-07-26 at 80x24:
    // zoom publishes a full-window leaf as the visible layout, including when
    // the window is inactive; unzoom restores the complete split layout.
    let handler = RequestHandler::new();
    let alpha = session_name("visible-layout");
    let window_target = WindowTarget::with_window(alpha.clone(), 0);
    let pane_target = PaneTarget::with_window(alpha.clone(), 0, 0);

    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha.clone(),
                detached: true,
                size: Some(TerminalSize { cols: 80, rows: 24 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));

    let (single_layout, single_visible_layout) =
        rendered_window_layouts(&handler, pane_target.clone()).await;
    assert_eq!(single_layout, "b25d,80x24,0,0,0");
    assert_eq!(single_visible_layout, single_layout);

    assert!(matches!(
        handler
            .handle(Request::ResizePane(ResizePaneRequest {
                target: pane_target.clone(),
                adjustment: ResizePaneAdjustment::Zoom,
            }))
            .await,
        Response::ResizePane(_)
    ));
    assert!(
        !handler
            .state
            .lock()
            .await
            .sessions
            .session(&alpha)
            .expect("session exists")
            .window()
            .is_zoomed(),
        "tmux does not zoom a single-pane window"
    );

    assert!(matches!(
        handler
            .handle(Request::SplitWindow(SplitWindowRequest {
                target: SplitWindowTarget::Session(alpha.clone()),
                direction: SplitDirection::Vertical,
                before: false,
                environment: None,
            }))
            .await,
        Response::SplitWindow(_)
    ));
    let (split_layout, split_visible_layout) =
        rendered_window_layouts(&handler, pane_target.clone()).await;
    assert_eq!(split_visible_layout, split_layout);

    assert!(matches!(
        handler
            .handle(Request::ResizePane(ResizePaneRequest {
                target: pane_target.clone(),
                adjustment: ResizePaneAdjustment::Zoom,
            }))
            .await,
        Response::ResizePane(_)
    ));
    let (zoomed_layout, zoomed_visible_layout) =
        rendered_window_layouts(&handler, pane_target.clone()).await;
    assert_eq!(zoomed_layout, split_layout);
    assert_eq!(zoomed_visible_layout, "b25d,80x24,0,0,0");

    let notification = layout_change_notification(&handler, &window_target).await;
    assert_eq!(notification.pid, 73);
    let window_id = {
        let state = handler.state.lock().await;
        state
            .sessions
            .session(&alpha)
            .expect("session exists")
            .window_at(0)
            .expect("window 0 exists")
            .id()
            .as_u32()
    };
    assert_eq!(
        notification.line,
        format!("%layout-change @{window_id} {split_layout} b25d,80x24,0,0,0 *Z")
    );

    let new_window = handler
        .handle(Request::NewWindow(Box::new(NewWindowRequest {
            target: alpha.clone(),
            name: Some("active".to_owned()),
            detached: true,
            start_directory: None,
            environment: None,
            command: None,
            process_command: None,
            target_window_index: None,
            insert_at_target: false,
        })))
        .await;
    let Response::NewWindow(new_window) = new_window else {
        panic!("expected new-window response");
    };
    assert!(matches!(
        handler
            .handle(Request::SelectWindow(SelectWindowRequest {
                target: new_window.target,
            }))
            .await,
        Response::SelectWindow(_)
    ));

    let (inactive_layout, inactive_visible_layout) =
        rendered_window_layouts(&handler, pane_target.clone()).await;
    assert_eq!(inactive_layout, split_layout);
    assert_eq!(inactive_visible_layout, "b25d,80x24,0,0,0");
    assert_eq!(
        layout_change_notification(&handler, &window_target)
            .await
            .line,
        format!("%layout-change @{window_id} {split_layout} b25d,80x24,0,0,0 -Z")
    );

    assert!(matches!(
        handler
            .handle(Request::ResizePane(ResizePaneRequest {
                target: pane_target.clone(),
                adjustment: ResizePaneAdjustment::Zoom,
            }))
            .await,
        Response::ResizePane(_)
    ));
    let (unzoomed_layout, unzoomed_visible_layout) =
        rendered_window_layouts(&handler, pane_target).await;
    assert_eq!(unzoomed_layout, split_layout);
    assert_eq!(unzoomed_visible_layout, split_layout);
    assert_eq!(
        layout_change_notification(&handler, &window_target)
            .await
            .line,
        format!("%layout-change @{window_id} {split_layout} {split_layout} -")
    );
}

#[tokio::test]
async fn display_panes_sends_overlay_to_attached_session_without_waiting_for_clear() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    let (control_tx, mut control_rx) = mpsc::unbounded_channel();

    assert!(matches!(
        handler
            .handle(Request::NewSession(NewSessionRequest {
                session_name: alpha.clone(),
                detached: true,
                size: Some(TerminalSize { cols: 8, rows: 4 }),
                environment: None,
            }))
            .await,
        Response::NewSession(_)
    ));
    assert!(matches!(
        handler
            .handle(Request::SplitWindow(SplitWindowRequest {
                target: SplitWindowTarget::Session(alpha.clone()),
                direction: SplitDirection::Horizontal,
                before: false,
                environment: None,
            }))
            .await,
        Response::SplitWindow(_)
    ));
    handler.register_attach(42, alpha.clone(), control_tx).await;

    let response = handler
        .handle(Request::DisplayPanes(Box::new(DisplayPanesRequest {
            target: alpha.clone(),
            duration_ms: None,
            non_blocking: false,
            no_command: false,
            template: None,
            target_client: None,
        })))
        .await;

    assert_eq!(
        response,
        Response::DisplayPanes(DisplayPanesResponse {
            target: WindowTarget::new(alpha),
            pane_count: 2,
        })
    );
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    let mut saw_display_panes_overlay = false;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let next = tokio::time::timeout(remaining, control_rx.recv())
            .await
            .expect("display-panes control should arrive");
        let Some(next) = next else {
            break;
        };
        if let AttachControl::Overlay(overlay) = next {
            let frame = String::from_utf8(overlay.frame).expect("overlay is utf-8");
            if frame.contains("\u{1b}[41m") || frame.contains("\u{1b}[44m") {
                saw_display_panes_overlay = true;
                break;
            }
        }
    }
    assert!(
        saw_display_panes_overlay,
        "display-panes should emit an overlay frame with pane colours"
    );
}

#[tokio::test]
async fn display_panes_counts_only_labels_that_were_rendered() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    let (control_tx, mut control_rx) = mpsc::unbounded_channel();

    {
        let mut state = handler.state.lock().await;
        state
            .sessions
            .create_session(alpha.clone(), TerminalSize { cols: 3, rows: 4 })
            .expect("session create succeeds");
        state
            .sessions
            .session_mut(&alpha)
            .expect("session exists")
            .split_active_pane()
            .expect("split succeeds");
        state
            .sessions
            .session_mut(&alpha)
            .expect("session exists")
            .resize_terminal(TerminalSize { cols: 3, rows: 1 });
    }
    handler.register_attach(43, alpha.clone(), control_tx).await;

    let response = handler
        .handle(Request::DisplayPanes(Box::new(DisplayPanesRequest {
            target: alpha.clone(),
            duration_ms: None,
            non_blocking: false,
            no_command: false,
            template: None,
            target_client: None,
        })))
        .await;

    assert_eq!(
        response,
        Response::DisplayPanes(DisplayPanesResponse {
            target: WindowTarget::new(alpha),
            pane_count: 0,
        })
    );
    let overlay = control_rx.recv().await.expect("overlay control");
    let AttachControl::Overlay(overlay) = overlay else {
        panic!("expected display-panes overlay control");
    };
    assert!(overlay.frame.is_empty());
}
