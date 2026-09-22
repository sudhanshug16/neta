use super::*;
use rmux_core::LifecycleEvent;

const CAPTURED_CLIENT_NAME: &str = "/dev/pts/captured-before-exit";

async fn register_named_attach(
    handler: &RequestHandler,
    attach_pid: u32,
    session: &SessionName,
) -> (u64, mpsc::UnboundedReceiver<AttachControl>) {
    let (control_tx, control_rx) = mpsc::unbounded_channel();
    let attach_id = handler
        .register_attach_with_client_name(
            attach_pid,
            CAPTURED_CLIENT_NAME.to_owned(),
            session.clone(),
            control_tx,
        )
        .await;
    (attach_id, control_rx)
}

fn detached_names(
    events: &mut tokio::sync::broadcast::Receiver<
        super::super::lifecycle_support::QueuedLifecycleEvent,
    >,
) -> Vec<(SessionName, String)> {
    std::iter::from_fn(|| events.try_recv().ok())
        .filter_map(|queued| match queued.event {
            LifecycleEvent::ClientDetached {
                session_name,
                client_name: Some(client_name),
            } => Some((session_name, client_name)),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn abrupt_attach_finish_keeps_the_captured_client_name() {
    let handler = RequestHandler::new();
    let session = session_name("captured-client-abrupt-finish");
    create_quiet_session(&handler, &session).await;
    let attach_pid = u32::MAX - 901;
    let (attach_id, _control_rx) = register_named_attach(&handler, attach_pid, &session).await;
    let mut events = handler.subscribe_lifecycle_events();

    handler.finish_attach(attach_pid, attach_id).await;

    assert_eq!(
        detached_names(&mut events),
        vec![(session, CAPTURED_CLIENT_NAME.to_owned())]
    );
}

#[tokio::test]
async fn normal_detach_emits_the_captured_client_name_once() {
    let handler = RequestHandler::new();
    let session = session_name("captured-client-normal-detach");
    create_quiet_session(&handler, &session).await;
    let attach_pid = u32::MAX - 902;
    let (attach_id, mut control_rx) = register_named_attach(&handler, attach_pid, &session).await;
    let identity = handler
        .active_attach_identity(attach_pid)
        .await
        .expect("named attach is active");
    let mut events = handler.subscribe_lifecycle_events();

    let response = handler.handle_detach_client_for_identity(identity).await;
    assert!(
        matches!(response, Response::DetachClient(_)),
        "{response:?}"
    );
    assert!(matches!(control_rx.try_recv(), Ok(AttachControl::Detach)));
    let response = handler
        .handle(Request::KillSession(KillSessionRequest {
            target: session.clone(),
            kill_all_except_target: false,
            clear_alerts: false,
            kill_group: false,
        }))
        .await;
    assert!(matches!(response, Response::KillSession(_)), "{response:?}");
    handler.finish_attach(attach_pid, attach_id).await;

    assert_eq!(
        detached_names(&mut events),
        vec![(session, CAPTURED_CLIENT_NAME.to_owned())],
        "the normal detach event must suppress session-destroy and finish duplicates"
    );
}

#[tokio::test]
async fn failed_detach_delivery_emits_the_captured_client_name() {
    let handler = RequestHandler::new();
    let session = session_name("captured-client-failed-detach");
    create_quiet_session(&handler, &session).await;
    let attach_pid = u32::MAX - 907;
    let (_attach_id, control_rx) = register_named_attach(&handler, attach_pid, &session).await;
    let identity = handler
        .active_attach_identity(attach_pid)
        .await
        .expect("named attach is active");
    let mut events = handler.subscribe_lifecycle_events();
    drop(control_rx);

    let response = handler.handle_detach_client_for_identity(identity).await;

    assert!(matches!(response, Response::Error(_)), "{response:?}");
    assert_eq!(
        detached_names(&mut events),
        vec![(session, CAPTURED_CLIENT_NAME.to_owned())]
    );
}

#[tokio::test]
async fn stale_client_cleanup_keeps_the_captured_client_name() {
    let handler = RequestHandler::new();
    let session = session_name("captured-client-stale-cleanup");
    create_quiet_session(&handler, &session).await;
    let attach_pid = u32::MAX - 903;
    let (_attach_id, control_rx) = register_named_attach(&handler, attach_pid, &session).await;
    let mut events = handler.subscribe_lifecycle_events();
    drop(control_rx);

    let removed = handler
        .prune_stale_attached_clients_for_session(&session)
        .await;

    assert_eq!(removed, vec![attach_pid]);
    assert_eq!(
        detached_names(&mut events),
        vec![(session, CAPTURED_CLIENT_NAME.to_owned())]
    );
}

#[tokio::test]
async fn session_destroy_keeps_the_captured_client_name() {
    let handler = RequestHandler::new();
    let session = session_name("captured-client-session-destroy");
    create_quiet_session(&handler, &session).await;
    let attach_pid = u32::MAX - 904;
    let (_attach_id, mut control_rx) = register_named_attach(&handler, attach_pid, &session).await;
    let mut events = handler.subscribe_lifecycle_events();

    let response = handler
        .handle(Request::KillSession(KillSessionRequest {
            target: session.clone(),
            kill_all_except_target: false,
            clear_alerts: false,
            kill_group: false,
        }))
        .await;

    assert!(matches!(response, Response::KillSession(_)), "{response:?}");
    assert!(matches!(control_rx.try_recv(), Ok(AttachControl::Exited)));
    assert_eq!(
        detached_names(&mut events),
        vec![(session, CAPTURED_CLIENT_NAME.to_owned())]
    );
}

#[tokio::test]
async fn switch_then_abrupt_finish_keeps_one_client_name_across_sessions() {
    let handler = RequestHandler::new();
    let source = session_name("captured-client-switch-source");
    let target = session_name("captured-client-switch-target");
    create_quiet_session(&handler, &source).await;
    create_quiet_session(&handler, &target).await;
    let attach_pid = u32::MAX - 905;
    let (attach_id, _control_rx) = register_named_attach(&handler, attach_pid, &source).await;
    let mut events = handler.subscribe_lifecycle_events();

    let response = handler
        .handle(Request::SwitchClient(SwitchClientRequest {
            target: target.clone(),
        }))
        .await;
    assert!(
        matches!(response, Response::SwitchClient(_)),
        "{response:?}"
    );
    handler.finish_attach(attach_pid, attach_id).await;

    let client_events = std::iter::from_fn(|| events.try_recv().ok())
        .filter_map(|queued| match queued.event {
            LifecycleEvent::ClientSessionChanged {
                session_name,
                client_name: Some(client_name),
            } => Some(("changed", session_name, client_name)),
            LifecycleEvent::ClientDetached {
                session_name,
                client_name: Some(client_name),
            } => Some(("detached", session_name, client_name)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        client_events,
        vec![
            ("changed", target.clone(), CAPTURED_CLIENT_NAME.to_owned()),
            ("detached", target, CAPTURED_CLIENT_NAME.to_owned()),
        ]
    );
}

#[tokio::test]
async fn failed_switch_delivery_emits_the_captured_client_name() {
    let handler = RequestHandler::new();
    let source = session_name("captured-client-failed-switch-source");
    let target = session_name("captured-client-failed-switch-target");
    create_quiet_session(&handler, &source).await;
    create_quiet_session(&handler, &target).await;
    let attach_pid = u32::MAX - 906;
    let (_attach_id, control_rx) = register_named_attach(&handler, attach_pid, &source).await;
    let mut events = handler.subscribe_lifecycle_events();
    drop(control_rx);

    let response = handler
        .handle(Request::SwitchClient(SwitchClientRequest { target }))
        .await;

    assert!(matches!(response, Response::Error(_)), "{response:?}");
    assert_eq!(
        detached_names(&mut events),
        vec![(source, CAPTURED_CLIENT_NAME.to_owned())]
    );
}
