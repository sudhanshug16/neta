use super::*;
use crate::daemon::ShutdownHandle;

#[test]
fn normal_request_close_linearizes_against_drain_admission() {
    let handler = RequestHandler::new();
    let admitted = handler
        .try_begin_normal_request(true)
        .expect("request is admitted before quiesce");

    handler.close_normal_request_admission();

    assert!(!handler.normal_requests_quiesced());
    assert!(!handler.normal_drain_requests_quiesced());
    assert!(
        handler.try_begin_normal_request(true).is_none(),
        "requests after the close linearization point are rejected"
    );

    drop(admitted);
    assert!(handler.normal_requests_quiesced());
    assert!(handler.normal_drain_requests_quiesced());
}

#[test]
fn cancel_safe_requests_do_not_hold_the_drain_barrier() {
    let handler = RequestHandler::new();
    let admitted = handler
        .try_begin_normal_request(false)
        .expect("cancel-safe request is admitted before quiesce");
    handler.close_normal_request_admission();

    assert!(!handler.normal_requests_quiesced());
    assert!(handler.normal_drain_requests_quiesced());

    drop(admitted);
    assert!(handler.normal_requests_quiesced());
}

#[tokio::test]
async fn later_full_reevaluation_tightens_a_scheduled_requester_exclusion() {
    let handler = RequestHandler::new();
    let (shutdown_handle, mut shutdown_rx) = ShutdownHandle::new();
    handler.install_shutdown_handle(shutdown_handle);

    let requester_connection_id = 7;
    let requester_connection = handler.begin_detached_connection(requester_connection_id);
    let forwarder = handler.begin_attach_forwarder();
    handler.queue_shutdown_request(PendingShutdownReason::ExitEmpty);

    assert!(
        !handler.request_shutdown_if_pending_excluding_detached_connection(Some(
            requester_connection_id
        )),
        "the attached wire drain should schedule a requester-excluding retry"
    );
    drop(forwarder);
    assert!(
        !handler.request_shutdown_if_pending(),
        "the later full reevaluation must count every detached connection"
    );

    assert!(
        tokio::time::timeout(SHUTDOWN_RETRY_DELAY * 3, &mut shutdown_rx)
            .await
            .is_err(),
        "the old requester exclusion survived the later full reevaluation"
    );

    drop(requester_connection);
    tokio::time::timeout(SHUTDOWN_RETRY_DELAY * 3, shutdown_rx)
        .await
        .expect("shutdown should follow the SDK connection close")
        .expect("shutdown receiver should complete cleanly");
}

#[tokio::test]
async fn idle_shutdown_retry_preserves_excluded_detached_connection() {
    let handler = RequestHandler::new();
    let (shutdown_handle, shutdown_rx) = ShutdownHandle::new();
    handler.install_shutdown_handle(shutdown_handle);

    let requester_connection_id = 7;
    let _requester_connection = handler.begin_detached_connection(requester_connection_id);
    handler.queue_shutdown_request(PendingShutdownReason::SeamlessUpgradeIdle);

    let active_connections = handler
        .active_detached_connections
        .lock()
        .expect("active detached connection mutex must not be poisoned");
    assert!(!handler
        .request_shutdown_if_pending_excluding_detached_connection(Some(requester_connection_id)));
    drop(active_connections);

    tokio::time::timeout(std::time::Duration::from_millis(500), shutdown_rx)
        .await
        .expect("retry should preserve requester exclusion and request shutdown")
        .expect("shutdown receiver should complete cleanly");
}

#[tokio::test]
async fn idle_shutdown_retries_after_in_flight_detached_request() {
    let handler = RequestHandler::new();
    let (shutdown_handle, shutdown_rx) = ShutdownHandle::new();
    handler.install_shutdown_handle(shutdown_handle);
    let _request = handler.begin_detached_request();

    handler.queue_shutdown_request(PendingShutdownReason::ExitEmpty);
    assert!(
        !handler.request_shutdown_if_pending(),
        "in-flight detached requests should defer, not cancel, exit-empty shutdown"
    );
    drop(_request);

    tokio::time::timeout(std::time::Duration::from_millis(500), shutdown_rx)
        .await
        .expect("retry should request shutdown after detached request finishes")
        .expect("shutdown receiver should complete cleanly");
}

#[tokio::test]
async fn idle_shutdown_retries_after_attach_forwarder_drain() {
    let handler = RequestHandler::new();
    let (shutdown_handle, shutdown_rx) = ShutdownHandle::new();
    handler.install_shutdown_handle(shutdown_handle);
    let forwarder = handler.begin_attach_forwarder();

    handler.queue_shutdown_request(PendingShutdownReason::ExitEmpty);
    assert!(
        !handler.request_shutdown_if_pending(),
        "an attached wire drain should defer, not cancel, exit-empty shutdown"
    );
    drop(forwarder);

    tokio::time::timeout(std::time::Duration::from_millis(500), shutdown_rx)
        .await
        .expect("retry should request shutdown after the attach forwarder drains")
        .expect("shutdown receiver should complete cleanly");
}

#[tokio::test]
async fn lifecycle_close_cancels_pending_shutdown_retry() {
    let handler = RequestHandler::new();
    let (shutdown_handle, shutdown_rx) = ShutdownHandle::new();
    handler.install_shutdown_handle(shutdown_handle);
    let state = handler.state.lock().await;

    handler.queue_shutdown_request(PendingShutdownReason::ExitEmpty);
    assert!(
        !handler.request_shutdown_if_pending(),
        "the held state lock forces the retry path"
    );
    handler.close_normal_and_drain_lifecycle_producers().await;
    drop(state);

    assert!(
        tokio::time::timeout(SHUTDOWN_RETRY_DELAY * 2, shutdown_rx)
            .await
            .is_err(),
        "a cancelled retry cannot request shutdown after the lane is sealed"
    );
}
