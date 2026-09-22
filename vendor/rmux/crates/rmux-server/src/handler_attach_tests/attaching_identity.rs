//! Issue #182: what an attaching client's `#{client_*}` bindings resolve to
//! when the requester pid does not identify one local process.
//!
//! `listener_attach_identity_tests` drives the whole funnel and proves the
//! frame the wire really carries. This pins the decision itself, including the
//! two outcomes that funnel cannot reach at once: an in-process dispatch, which
//! is legitimately the server owner's, and a pid whose open connections were
//! authenticated as different peers, which is nobody's.

use super::*;

use rmux_ipc::PeerIdentity;
use rmux_os::identity::UserIdentity;

use crate::server_access::AccessMode;

const FIRST_UID: u32 = 18_300;
const SECOND_UID: u32 = 18_301;

fn peer(pid: u32, uid: u32) -> PeerIdentity {
    PeerIdentity {
        pid,
        uid,
        user: UserIdentity::Uid(uid),
    }
}

fn admit(
    handler: &RequestHandler,
    peer: &PeerIdentity,
) -> crate::server_access::ServerAccessAdmission {
    handler
        .set_test_access_mode_for_uid(peer.uid, AccessMode::ReadWrite)
        .expect("the delegated peer can be granted access");
    handler
        .server_access_admission_for_peer(peer)
        .expect("the granted peer is admitted")
}

/// The blocking finding: two connections authenticated as different peers can
/// share one numeric pid after the OS recycles it. Neither may lend the other
/// its identity, and substituting the server owner is not "closed" either —
/// registration would still store the peer the listener authenticated, so the
/// first frame and `list-clients` would disagree.
#[tokio::test]
async fn conflicting_authenticated_peers_fail_closed_rather_than_becoming_the_owner() {
    let handler = RequestHandler::new();
    let shared_pid = 60_190;
    let first = peer(shared_pid, FIRST_UID);
    let second = peer(shared_pid, SECOND_UID);
    let first_admission = admit(&handler, &first);
    let second_admission = admit(&handler, &second);
    let owner = handler.server_owner_identity();
    assert!(
        owner != first.user && owner != second.user,
        "this test only means something while neither peer is the server owner"
    );

    // No connection scope at all: an in-process dispatch stays the owner's.
    let (_, user) = handler
        .attaching_client_identity(shared_pid)
        .expect("an in-process dispatch resolves");
    assert_eq!(
        user, owner,
        "an unauthenticated requester is still the owner"
    );

    let first_scope = handler.begin_authenticated_peer_access(&first, first_admission);
    let (uid, user) = handler
        .attaching_client_identity(shared_pid)
        .expect("one authenticated peer resolves");
    assert_eq!(
        (uid, user),
        (first.uid, first.user.clone()),
        "a single authenticated connection still names its own peer"
    );

    let second_scope = handler.begin_authenticated_peer_access(&second, second_admission);
    let error = handler
        .attaching_client_identity(shared_pid)
        .expect_err("two peers on one pid cannot name one attaching client");
    assert!(
        matches!(&error, RmuxError::Server(message) if message.contains("ambiguous")),
        "the refusal must say why, got {error:?}"
    );

    // Once the reused pid belongs to one peer again, that peer is named.
    drop(second_scope);
    let (uid, user) = handler
        .attaching_client_identity(shared_pid)
        .expect("the surviving peer resolves");
    assert_eq!(
        (uid, user),
        (first.uid, first.user.clone()),
        "closing the colliding connection restores the survivor's identity"
    );
    drop(first_scope);
}

/// The same rule at the scope-set level, so the distinction between "no
/// authenticated peer" and "more than one" cannot silently collapse again.
#[tokio::test]
async fn a_pid_with_one_authenticated_peer_is_never_reported_as_conflicting() {
    let handler = RequestHandler::new();
    let shared_pid = 60_191;
    let only = peer(shared_pid, FIRST_UID);
    let admission = admit(&handler, &only);

    let outer = handler.begin_authenticated_peer_access(&only, admission);
    // A hook or shell running under that connection inherits its peer rather
    // than turning the requester ambiguous.
    let inner = handler
        .begin_inherited_detached_requester_access(shared_pid)
        .await;
    let (uid, user) = handler
        .attaching_client_identity(shared_pid)
        .expect("nested scopes of one peer resolve");
    assert_eq!(
        (uid, user),
        (only.uid, only.user.clone()),
        "a nested scope must not erase the peer it inherited"
    );
    drop(inner);
    drop(outer);
}
