use std::collections::BTreeMap;

use super::{session_name, Session};
use crate::{PaneId, SessionId, WindowId, WINLINK_ACTIVITY, WINLINK_BELL};
use rmux_proto::TerminalSize;

fn grouped_sessions() -> (Session, Session) {
    let size = TerminalSize { cols: 80, rows: 24 };
    let mut source = Session::new(session_name("owner"), size);
    source.create_window(size).expect("second window");
    let peer = source.clone_as_group_member(
        session_name("peer"),
        session_name("owner"),
        SessionId::new(2),
    );
    (source, peer)
}

#[test]
fn grouped_clone_removal_preserves_owner_and_peer_local_fallbacks() {
    let size = TerminalSize { cols: 80, rows: 24 };
    let mut owner = Session::new_with_initial_window(
        session_name("owner-local-selection"),
        size,
        2,
        PaneId::new(0),
        WindowId::new(0),
    );
    owner
        .insert_window_with_initial_pane(0, size)
        .expect("window 0 insert succeeds");
    owner
        .insert_window_with_initial_pane(1, size)
        .expect("window 1 insert succeeds");
    let mut peer = owner.clone_as_group_member(
        session_name("peer-local-selection"),
        session_name("selection-group"),
        SessionId::new(1),
    );
    let owner_expected_id = owner.window_at(1).expect("owner predecessor exists").id();
    let peer_expected_id = peer.window_at(0).expect("peer initial winlink exists").id();

    owner
        .remove_window(2)
        .expect("owner target removal succeeds");
    peer.remove_window(2)
        .expect("group peer target removal succeeds");

    assert_eq!(owner.window().id(), owner_expected_id);
    assert_eq!(owner.active_window_index(), 1);
    assert_eq!(owner.last_window_index(), None);
    assert_eq!(peer.window().id(), peer_expected_id);
    assert_eq!(peer.active_window_index(), 0);
    assert_eq!(peer.last_window_index(), None);
}

#[test]
fn group_sync_preserves_peer_local_winlink_alert_flags() {
    let (mut source, mut peer) = grouped_sessions();
    assert!(source.add_winlink_alert_flags(0, WINLINK_BELL));
    assert!(peer.add_winlink_alert_flags(1, WINLINK_ACTIVITY));

    peer.synchronize_group_from(&source);

    assert_eq!(peer.winlink_alert_flags(0), crate::AlertFlags::empty());
    assert_eq!(peer.winlink_alert_flags(1), WINLINK_ACTIVITY);
}

#[test]
fn group_sync_rekeys_peer_alert_flags_with_explicit_window_map() {
    let (mut source, mut peer) = grouped_sessions();
    assert!(peer.add_winlink_alert_flags(1, WINLINK_ACTIVITY));
    let index_map = source
        .reindex_windows_from(1)
        .expect("source window reindex succeeds");

    peer.synchronize_group_from_with_window_selection_map(&source, &index_map);

    assert_eq!(peer.winlink_alert_flags(1), crate::AlertFlags::empty());
    assert_eq!(peer.winlink_alert_flags(2), WINLINK_ACTIVITY);
}

#[test]
fn group_sync_duplicate_alias_removal_preserves_surviving_slot_flags() {
    let size = TerminalSize { cols: 80, rows: 24 };
    let mut source = Session::new(session_name("owner-duplicate"), size);
    let duplicate = source.window_at(0).expect("source window").clone();
    source
        .link_window(1, duplicate, false, false)
        .expect("duplicate alias insert succeeds");
    let mut peer = source.clone_as_group_member(
        session_name("peer-duplicate"),
        session_name("owner-duplicate"),
        SessionId::new(3),
    );
    assert!(peer.add_winlink_alert_flags(0, WINLINK_BELL));
    assert!(peer.add_winlink_alert_flags(1, WINLINK_ACTIVITY));
    source
        .remove_window(0)
        .expect("source duplicate alias removal succeeds");

    peer.synchronize_group_from(&source);

    assert_eq!(peer.winlink_alert_flags(1), WINLINK_ACTIVITY);
}

#[test]
fn group_sync_uses_tmux_cyclic_previous_identity_after_active_removal() {
    let size = TerminalSize { cols: 80, rows: 24 };
    let mut source = Session::new(session_name("owner-fallback"), size);
    source
        .insert_window_with_initial_pane(1, size)
        .expect("window 1 insert succeeds");
    source
        .insert_window_with_initial_pane(2, size)
        .expect("window 2 insert succeeds");
    let expected_window_id = source
        .window_at(2)
        .expect("oracle fallback exists before removal")
        .id();
    let mut peer = source.clone_as_group_member(
        session_name("peer-fallback"),
        session_name("owner-fallback"),
        SessionId::new(5),
    );

    source
        .remove_window(0)
        .expect("active source window removal succeeds");
    peer.synchronize_group_from(&source);

    assert_eq!(source.window().id(), expected_window_id);
    assert_eq!(peer.window().id(), expected_window_id);
    assert_eq!(peer.active_window_index(), 2);
}

#[test]
fn group_sync_separates_peer_selection_from_duplicate_alias_alert_permutation() {
    let size = TerminalSize { cols: 80, rows: 24 };
    let mut source = Session::new(session_name("owner-swap-duplicate"), size);
    let duplicate = source.window_at(0).expect("source window").clone();
    source
        .link_window(1, duplicate, false, false)
        .expect("duplicate alias insert succeeds");
    let mut peer = source.clone_as_group_member(
        session_name("peer-swap-duplicate"),
        session_name("owner-swap-duplicate"),
        SessionId::new(4),
    );
    peer.select_window(1)
        .expect("peer selects the second winlink");
    assert!(peer.add_winlink_alert_flags(0, WINLINK_ACTIVITY));

    source.swap_windows(0, 1).expect("source aliases swap");
    peer.synchronize_group_from_with_window_selection_and_winlink_alert_maps(
        &source,
        &BTreeMap::new(),
        &BTreeMap::from([(0, 1), (1, 0)]),
    );

    assert_eq!(peer.active_window_index(), 1);
    assert_eq!(peer.last_window_index(), Some(0));
    assert_eq!(peer.winlink_alert_flags(0), crate::AlertFlags::empty());
    assert_eq!(peer.winlink_alert_flags(1), WINLINK_ACTIVITY);
}
