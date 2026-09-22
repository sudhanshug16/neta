//! Listener-level coverage for an access admission that goes stale while a
//! pane-stream open is still in flight.
//!
//! `handler_pane_stream_tests::revoked_raw_subscribe_keeps_its_identity_and_only_replaces_the_keyframe`
//! calls [`RequestHandler::revoke_inflight_pane_stream_response`] directly, so
//! it pins the substitution but never proves that the connection loop reaches
//! it: deleting the recheck in [`serve_connection`] leaves that test green.
//! The test below drives a real connection through the real listener and only
//! observes the wire, so the recheck itself is what is under test.

use std::sync::Mutex as StdMutex;

use rmux_os::identity::UserIdentity;
use rmux_proto::{
    PaneStreamEndReason, PaneStreamEvent, PaneStreamMode, PaneTargetRef,
    SubscribePaneStreamRequest, UnsubscribePaneStreamRequest, UnsubscribePaneStreamResponse,
};
use tokio::sync::Notify;

use super::connection_test_support::{
    connected_streams, finish_connection, read_test_response, spawn_connection, start_quiet_pane,
    write_test_request,
};
use super::*;
use crate::server_access::AccessMode;

/// Parks a connection loop between its dispatched pane-stream response and the
/// inflight admission recheck.
///
/// The revocation window the listener guards is exactly that gap, and nothing
/// a client can send widens it. This is the only way to make the race
/// deterministic, so it stays `#[cfg(test)]`, one-shot, and scoped to a single
/// handler.
#[derive(Debug, Default)]
pub(super) struct InflightPaneStreamPause {
    reached: Notify,
    release: Notify,
    dispatched: StdMutex<Option<Response>>,
}

impl InflightPaneStreamPause {
    /// Waits until the connection loop parks and returns the untouched
    /// response it is about to revalidate.
    async fn wait_until_reached(&self) -> Response {
        self.reached.notified().await;
        self.dispatched
            .lock()
            .expect("inflight pane-stream pause mutex must not be poisoned")
            .clone()
            .expect("a parked connection publishes its dispatched response")
    }

    fn release(&self) {
        self.release.notify_one();
    }
}

static INFLIGHT_PANE_STREAM_PAUSES: StdMutex<Vec<(usize, Arc<InflightPaneStreamPause>)>> =
    StdMutex::new(Vec::new());

fn install_inflight_pane_stream_pause(
    handler: &Arc<RequestHandler>,
) -> Arc<InflightPaneStreamPause> {
    let handler_key = std::ptr::from_ref::<RequestHandler>(handler).addr();
    let pause = Arc::new(InflightPaneStreamPause::default());
    let mut pauses = INFLIGHT_PANE_STREAM_PAUSES
        .lock()
        .expect("inflight pane-stream pause registry lock");
    let previous = pauses.iter().any(|(key, _)| *key == handler_key);
    assert!(!previous, "inflight pane-stream pause already installed");
    pauses.push((handler_key, Arc::clone(&pause)));
    pause
}

/// Called by [`serve_connection`] just before it revalidates the admission a
/// pane-stream response was dispatched under. Returns immediately unless a
/// test installed a pause for this handler.
pub(super) async fn pause_before_inflight_pane_stream_recheck(
    handler: &RequestHandler,
    response: &Response,
) {
    if !matches!(
        response,
        Response::SubscribePaneStream(_) | Response::PaneStreamCursor(_)
    ) {
        return;
    }
    let handler_key = std::ptr::from_ref(handler).addr();
    let pause = {
        let mut pauses = INFLIGHT_PANE_STREAM_PAUSES
            .lock()
            .expect("inflight pane-stream pause registry lock");
        let position = pauses.iter().position(|(key, _)| *key == handler_key);
        position.map(|position| pauses.swap_remove(position).1)
    };
    let Some(pause) = pause else {
        return;
    };
    *pause
        .dispatched
        .lock()
        .expect("inflight pane-stream pause mutex must not be poisoned") = Some(response.clone());
    pause.reached.notify_one();
    pause.release.notified().await;
}

/// Proves the listener path the direct unit test cannot reach.
///
/// The connection really subscribes, the admission it was dispatched under is
/// really rotated out while the response is still in flight, and the client
/// only ever observes the substituted opening event.
#[tokio::test]
async fn a_stale_admission_turns_an_inflight_raw_open_into_a_revoked_end() -> io::Result<()> {
    let peer_uid = revocable_peer_uid();
    let peer = PeerIdentity {
        pid: std::process::id(),
        uid: peer_uid,
        user: UserIdentity::Uid(peer_uid),
    };
    let handler = Arc::new(RequestHandler::new());
    let target = start_quiet_pane(&handler, "inflight-access-revoked").await;
    handler
        .set_test_access_mode_for_uid(peer_uid, AccessMode::ReadWrite)
        .expect("test peer starts read-write");

    let (server, mut client) = connected_streams("listener-inflight-access").await?;
    let (_shutdown_tx, connection_task) = spawn_connection(&handler, peer, server);
    let pause = install_inflight_pane_stream_pause(&handler);

    write_test_request(
        &mut client,
        Request::SubscribePaneStream(SubscribePaneStreamRequest {
            target: PaneTargetRef::slot(target.clone()),
            mode: PaneStreamMode::Raw,
            include_snapshot: false,
        }),
    )
    .await?;

    // The connection loop now holds a real opening response and has not yet
    // revalidated the admission it was dispatched under.
    let Response::SubscribePaneStream(opened) = pause.wait_until_reached().await else {
        panic!("the parked response must be the real pane-stream opening");
    };
    assert_eq!(opened.target, target);
    assert!(
        matches!(opened.event, PaneStreamEvent::RawRebase(_)),
        "a Raw open answers with a keyframe before revocation: {:?}",
        opened.event
    );
    assert!(
        handler
            .pane_output_subscription_key_for_test(opened.subscription_id)
            .is_some(),
        "the dispatched open still holds its subscription while the admission is current"
    );

    // Rotate the admission out. A mode downgrade would not do: `set_mode`
    // keeps the entry's epoch, so only removing the identity makes the
    // snapshot the connection captured fail revalidation.
    handler
        .remove_test_access_for_uid(peer_uid)
        .expect("test peer access can be revoked");
    pause.release();

    let mut revoked = opened.clone();
    revoked.event = PaneStreamEvent::End(PaneStreamEndReason::AccessRevoked);
    assert_eq!(
        read_test_response(&mut client).await?,
        Response::SubscribePaneStream(revoked),
        "the listener must replace the opening event of the real response and nothing else"
    );
    assert!(
        handler
            .pane_output_subscription_key_for_test(opened.subscription_id)
            .is_none(),
        "the subscription and its stream quota are released before the client observes the end"
    );

    // Nothing is left for the client to release. The sibling test
    // `revoked_connection_can_release_its_owned_pane_stream` answers `removed:
    // true` here because its stream survived the revocation; a revoked
    // inflight open owes the client no cursor and no unsubscribe.
    write_test_request(
        &mut client,
        Request::UnsubscribePaneStream(UnsubscribePaneStreamRequest {
            subscription_id: opened.subscription_id,
        }),
    )
    .await?;
    assert_eq!(
        read_test_response(&mut client).await?,
        Response::UnsubscribePaneStream(UnsubscribePaneStreamResponse {
            subscription_id: opened.subscription_id,
            removed: false,
        })
    );

    drop(client);
    finish_connection(connection_task).await
}

/// A uid that is neither the server owner nor a reserved superuser, so its
/// access entry can be removed while the connection is mid-request.
#[cfg(unix)]
fn revocable_peer_uid() -> u32 {
    rmux_os::identity::real_user_id().saturating_add(13_000)
}

#[cfg(windows)]
fn revocable_peer_uid() -> u32 {
    // Windows keys the access store by SID, so no uid entry can collide with
    // the server owner or with a reserved identity.
    13_000
}
