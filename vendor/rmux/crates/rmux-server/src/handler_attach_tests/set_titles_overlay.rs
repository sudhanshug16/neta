//! Issue #182, overlay acceptance: a title a client was told it already shows
//! must be one the wire really carried.
//!
//! A refresh made while a mode-tree overlay is open stamps its switch with that
//! overlay's state. Dismissing the overlay advances the state and the attach
//! loop discards every older-state switch, frame and all. The title memory is
//! recorded server-side, so a title stranded that way would be deduplicated out
//! of every successor render and the outer terminal would keep the old one
//! until an unrelated title mutation or a reattach.

use super::set_titles_support::{
    delivered_titles, new_detached_session, remembered_title, set_global, title_capable_context,
};
use super::*;

/// Opens a real mode-tree overlay through the command funnel, so subsequent
/// refreshes for this client are stamped with its persistent-overlay state.
async fn open_mode_tree(handler: &RequestHandler, attach_pid: u32) {
    let commands = handler
        .parse_control_commands("choose-tree -Zs")
        .await
        .expect("choose-tree parses");
    handler
        .execute_parsed_commands_for_test(attach_pid, commands)
        .await
        .expect("choose-tree activates");
    assert!(
        handler.mode_tree_active(attach_pid).await,
        "the fixture needs an active mode-tree overlay"
    );
}

async fn dismiss_mode_tree_and_refresh(handler: &RequestHandler, attach_pid: u32) {
    let refreshed = handler
        .dismiss_mode_tree(attach_pid)
        .await
        .expect("mode tree dismissal succeeds");
    for session_name in refreshed {
        handler.refresh_attached_session(&session_name).await;
    }
}

/// The blocking sequence from the independent review: a title-bearing
/// `Switch(N)` is queued, a barrier at `N + 1` then discards it, and the
/// successor refresh must still put that title on the wire exactly once.
#[tokio::test]
async fn a_title_discarded_by_an_overlay_barrier_reaches_the_successor_refresh() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    new_detached_session(&handler, &alpha).await;

    let attach_pid = std::process::id();
    let (control_tx, mut control_rx) = mpsc::unbounded_channel();
    let _attach_id = handler
        .register_attach_with_terminal_context(
            attach_pid,
            alpha.clone(),
            control_tx,
            title_capable_context(),
        )
        .await;

    set_global(&handler, OptionName::SetTitlesString, "BEFORE").await;
    set_global(&handler, OptionName::SetTitles, "on").await;
    assert_eq!(
        delivered_titles(&mut control_rx),
        vec!["BEFORE".to_owned()],
        "the client starts from a known delivered title"
    );

    open_mode_tree(&handler, attach_pid).await;
    // The overlay itself re-renders; drain so only the contested frames remain.
    let _ = delivered_titles(&mut control_rx);

    // Queue the title-bearing Switch(N) while the overlay state is N.
    set_global(&handler, OptionName::SetTitlesString, "AFTER").await;

    // Dismiss the overlay: this queues AdvancePersistentOverlayState(N + 1),
    // which discards every already-queued switch stamped with N.
    dismiss_mode_tree_and_refresh(&handler, attach_pid).await;

    assert_eq!(
        delivered_titles(&mut control_rx),
        vec!["AFTER".to_owned()],
        "the discarded title must be re-emitted by the successor refresh exactly once"
    );
    assert_eq!(
        remembered_title(&handler, attach_pid).await.as_deref(),
        Some("AFTER"),
        "remembered state must equal what the wire actually carried"
    );
}

/// The same barrier must not make the client forget a title it *did* deliver.
/// A switch stamped with the barrier's own state survives it, so its title
/// stays remembered and no successor repeats it.
#[tokio::test]
async fn a_title_surviving_its_overlay_barrier_is_not_re_emitted() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    new_detached_session(&handler, &alpha).await;

    let attach_pid = std::process::id();
    let (control_tx, mut control_rx) = mpsc::unbounded_channel();
    let _attach_id = handler
        .register_attach_with_terminal_context(
            attach_pid,
            alpha.clone(),
            control_tx,
            title_capable_context(),
        )
        .await;

    set_global(&handler, OptionName::SetTitlesString, "STABLE").await;
    set_global(&handler, OptionName::SetTitles, "on").await;
    assert_eq!(delivered_titles(&mut control_rx), vec!["STABLE".to_owned()]);

    open_mode_tree(&handler, attach_pid).await;
    let _ = delivered_titles(&mut control_rx);

    // A title change while the overlay is open, then an unrelated redraw at the
    // same overlay state: no barrier, so both frames are drawn.
    set_global(&handler, OptionName::SetTitlesString, "CHANGED").await;
    set_global(&handler, OptionName::StatusInterval, "13").await;

    assert_eq!(
        delivered_titles(&mut control_rx),
        vec!["CHANGED".to_owned()],
        "an undiscarded title reaches the wire exactly once"
    );
    assert_eq!(
        remembered_title(&handler, attach_pid).await.as_deref(),
        Some("CHANGED"),
    );

    // Dismissing now carries no pending title, so the successor stays silent.
    dismiss_mode_tree_and_refresh(&handler, attach_pid).await;
    assert!(
        delivered_titles(&mut control_rx).is_empty(),
        "a title the terminal already shows must not be rewritten after a barrier"
    );
}

/// A client with no overlay open stamps no state on its switches, so no barrier
/// can discard its frames and its remembered title must be left alone.
#[tokio::test]
async fn an_unstamped_title_is_never_reverted_by_a_barrier() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    new_detached_session(&handler, &alpha).await;

    let attach_pid = std::process::id();
    let (control_tx, mut control_rx) = mpsc::unbounded_channel();
    let _attach_id = handler
        .register_attach_with_terminal_context(
            attach_pid,
            alpha.clone(),
            control_tx,
            title_capable_context(),
        )
        .await;

    set_global(&handler, OptionName::SetTitlesString, "PLAIN").await;
    set_global(&handler, OptionName::SetTitles, "on").await;
    assert_eq!(delivered_titles(&mut control_rx), vec!["PLAIN".to_owned()]);

    // A dismissal with no mode tree open is a no-op that queues no barrier.
    let refreshed = handler
        .dismiss_mode_tree(attach_pid)
        .await
        .expect("dismissing nothing succeeds");
    assert!(refreshed.is_empty());
    set_global(&handler, OptionName::StatusInterval, "17").await;

    assert!(
        delivered_titles(&mut control_rx).is_empty(),
        "an unchanged title must stay deduplicated across an unrelated redraw"
    );
    assert_eq!(
        remembered_title(&handler, attach_pid).await.as_deref(),
        Some("PLAIN"),
    );
}
