use rmux_proto::{
    PaneOutputCursorRequest, PaneOutputSubscriptionStart, PaneStreamCursorRequest, PaneStreamMode,
    Response, RmuxError, SubscribePaneOutputRequest, UnsubscribePaneOutputRequest,
    UnsubscribePaneStreamRequest,
};

use super::{subscribe, test_pane, RequestHandler, CONNECTION_ID};

const WRONG_LEGACY_KIND: &str = "subscription is not a pane-output subscription";
const WRONG_STREAM_KIND: &str = "subscription is not a pane stream";

fn assert_server_error(response: Response, message: &str) {
    let Response::Error(error) = response else {
        panic!("expected server error, got {response:?}");
    };
    assert_eq!(error.error, RmuxError::Server(message.to_owned()));
}

fn subscription_record(
    handler: &RequestHandler,
    subscription_id: rmux_proto::PaneOutputSubscriptionId,
) -> rmux_core::events::OutputSubscriptionRecord {
    handler
        .subscriptions
        .lock()
        .expect("subscription registry mutex")
        .registry
        .get(subscription_id)
        .expect("subscription must remain registered")
        .clone()
}

async fn assert_stream_is_readable(
    handler: &RequestHandler,
    subscription_id: rmux_proto::PaneOutputSubscriptionId,
) {
    let response = handler
        .handle_pane_stream_cursor(
            CONNECTION_ID,
            PaneStreamCursorRequest {
                subscription_id,
                max_events: Some(8),
            },
        )
        .await;
    assert!(
        matches!(response, Response::PaneStreamCursor(_)),
        "the correct stream endpoint must remain readable, got {response:?}"
    );
}

async fn close_stream(
    handler: &RequestHandler,
    subscription_id: rmux_proto::PaneOutputSubscriptionId,
) {
    let response = handler
        .handle_unsubscribe_pane_stream(
            CONNECTION_ID,
            UnsubscribePaneStreamRequest { subscription_id },
        )
        .await;
    assert!(
        matches!(response, Response::UnsubscribePaneStream(response) if response.removed),
        "the correct stream endpoint must still remove the subscription, got {response:?}"
    );
}

#[tokio::test]
async fn legacy_cursor_rejects_every_pane_stream_mode_without_mutation() {
    let handler = RequestHandler::new();
    let (target, _, _) = test_pane(&handler).await;

    for mode in [PaneStreamMode::Raw, PaneStreamMode::Surface] {
        let subscribed = subscribe(&handler, &target, mode).await;
        let before = subscription_record(&handler, subscribed.subscription_id);
        let response = handler
            .handle_pane_output_cursor(
                CONNECTION_ID,
                PaneOutputCursorRequest {
                    subscription_id: subscribed.subscription_id,
                    max_events: Some(8),
                },
            )
            .await;

        assert_server_error(response, WRONG_LEGACY_KIND);
        assert_eq!(
            subscription_record(&handler, subscribed.subscription_id),
            before,
            "the wrong cursor endpoint must not even touch the stream record"
        );
        assert_stream_is_readable(&handler, subscribed.subscription_id).await;
        close_stream(&handler, subscribed.subscription_id).await;
    }
}

#[tokio::test]
async fn legacy_unsubscribe_rejects_every_pane_stream_mode_without_mutation() {
    let handler = RequestHandler::new();
    let (target, _, _) = test_pane(&handler).await;

    for mode in [PaneStreamMode::Raw, PaneStreamMode::Surface] {
        let subscribed = subscribe(&handler, &target, mode).await;
        let before = subscription_record(&handler, subscribed.subscription_id);
        let response = handler
            .handle_unsubscribe_pane_output(
                CONNECTION_ID,
                UnsubscribePaneOutputRequest {
                    subscription_id: subscribed.subscription_id,
                },
            )
            .await;

        assert_server_error(response, WRONG_LEGACY_KIND);
        assert_eq!(
            subscription_record(&handler, subscribed.subscription_id),
            before,
            "the wrong unsubscribe endpoint must not mutate the stream record"
        );
        assert_stream_is_readable(&handler, subscribed.subscription_id).await;
        close_stream(&handler, subscribed.subscription_id).await;
    }
}

#[tokio::test]
async fn pane_stream_endpoints_reject_legacy_subscription_without_mutation() {
    let handler = RequestHandler::new();
    let (target, output, _) = test_pane(&handler).await;
    let response = handler
        .handle_subscribe_pane_output(
            CONNECTION_ID,
            SubscribePaneOutputRequest {
                target,
                start: PaneOutputSubscriptionStart::Now,
            },
        )
        .await;
    let Response::SubscribePaneOutput(subscribed) = response else {
        panic!("expected legacy subscription, got {response:?}");
    };
    output.send(b"still-readable".to_vec());

    let before = subscription_record(&handler, subscribed.subscription_id);
    let response = handler
        .handle_pane_stream_cursor(
            CONNECTION_ID,
            PaneStreamCursorRequest {
                subscription_id: subscribed.subscription_id,
                max_events: Some(8),
            },
        )
        .await;
    assert_server_error(response, WRONG_STREAM_KIND);
    assert_eq!(
        subscription_record(&handler, subscribed.subscription_id),
        before,
        "the wrong stream cursor must not touch the legacy record"
    );

    let response = handler
        .handle_unsubscribe_pane_stream(
            CONNECTION_ID,
            UnsubscribePaneStreamRequest {
                subscription_id: subscribed.subscription_id,
            },
        )
        .await;
    assert_server_error(response, WRONG_STREAM_KIND);
    assert_eq!(
        subscription_record(&handler, subscribed.subscription_id),
        before,
        "the wrong stream unsubscribe must not mutate the legacy record"
    );

    let response = handler
        .handle_pane_output_cursor(
            CONNECTION_ID,
            PaneOutputCursorRequest {
                subscription_id: subscribed.subscription_id,
                max_events: Some(8),
            },
        )
        .await;
    let Response::PaneOutputCursor(cursor) = response else {
        panic!("the correct legacy endpoint must remain readable, got {response:?}");
    };
    assert_eq!(cursor.events.len(), 1);
    assert_eq!(cursor.events[0].bytes, b"still-readable");
}

#[tokio::test]
async fn revoked_cleanup_rejects_pane_stream_id_at_legacy_unsubscribe() {
    let handler = RequestHandler::new();
    let (target, _, _) = test_pane(&handler).await;
    let subscribed = subscribe(&handler, &target, PaneStreamMode::Raw).await;
    let before = subscription_record(&handler, subscribed.subscription_id);

    let response = handler
        .handle_revoked_cleanup_request(
            CONNECTION_ID,
            rmux_proto::Request::UnsubscribePaneOutput(UnsubscribePaneOutputRequest {
                subscription_id: subscribed.subscription_id,
            }),
        )
        .await
        .expect("unsubscribe is accepted as a revoked cleanup request");

    assert_server_error(response, WRONG_LEGACY_KIND);
    assert_eq!(
        subscription_record(&handler, subscribed.subscription_id),
        before,
        "revoked cleanup must not mutate a stream through the legacy endpoint"
    );
    assert_stream_is_readable(&handler, subscribed.subscription_id).await;
}
