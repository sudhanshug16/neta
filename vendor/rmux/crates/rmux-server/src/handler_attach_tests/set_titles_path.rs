//! Issue #182, OSC 7: the working directory a client's outer terminal shows is
//! part of the same per-client identity as its title, and must track the pane.
//!
//! tmux treats an inbound OSC 7 as a redraw cause, resolves the path
//! independently of the title while redrawing the client, and writes an empty
//! path when the pane reports one. A path change that raises no refresh leaves
//! the outer terminal stale, and a path that can only ever be overwritten can
//! never be cleared.

use super::set_titles_support::{
    active_pane_id, append_global, delivered_paths, delivered_titles, set_global,
    title_capable_context,
};
use super::*;

/// A terminal family advertising both the title and OSC 7 templates.
async fn enable_osc7(handler: &RequestHandler) {
    append_global(handler, OptionName::TerminalFeatures, "xterm*:osc7").await;
}

/// Feeds bytes to a pane through the production reader path and applies the
/// alert events production built from them.
async fn feed_active_pane(
    handler: &RequestHandler,
    session: &rmux_proto::SessionName,
    bytes: &[u8],
) {
    let pane_id = active_pane_id(handler, session).await;
    let (transcript, output) = {
        let state = handler.state.lock().await;
        let target = PaneTarget::with_window(session.clone(), 0, 0);
        (
            state
                .transcript_handle(&target)
                .expect("session transcript must exist"),
            state
                .pane_output_for_target(session, 0, 0)
                .expect("pane output must exist"),
        )
    };
    let events = crate::pane_io::publish_pane_bytes_capturing_alerts(
        session,
        pane_id,
        &transcript,
        &output,
        bytes.to_vec(),
    );
    assert!(
        !events.is_empty(),
        "the production reader must report an alert for {bytes:?}"
    );
    for event in events {
        handler.handle_pane_alert_event(event).await;
    }
}

/// What the pane itself now reports, independent of any client.
async fn pane_path(handler: &RequestHandler, session: &rmux_proto::SessionName) -> String {
    let state = handler.state.lock().await;
    let pane_id = state
        .sessions
        .session(session)
        .and_then(|session| session.window_at(0))
        .and_then(|window| window.pane(0).map(rmux_core::Pane::id))
        .expect("window pane exists");
    state
        .pane_screen_state(session, pane_id)
        .map(|pane_state| pane_state.path)
        .unwrap_or_default()
}

/// The reviewer's live-path reproduction: a program in the active pane emits
/// OSC 7, and the attached client's outer terminal must follow without waiting
/// for an unrelated redraw.
#[tokio::test]
async fn a_live_pane_path_change_reaches_the_outer_terminal() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    create_quiet_session(&handler, &alpha).await;

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
    enable_osc7(&handler).await;
    set_global(&handler, OptionName::SetTitlesString, "PATHTEST").await;
    set_global(&handler, OptionName::SetTitles, "on").await;

    // Measured on tmux 3.7b: a fresh client whose pane reports no directory is
    // told so with one empty OSC 7, then told each later value.
    feed_active_pane(&handler, &alpha, b"\x1b]7;file:///review-before\x07").await;
    assert_eq!(pane_path(&handler, &alpha).await, "file:///review-before");
    assert_eq!(
        delivered_paths(&mut control_rx),
        vec![String::new(), "file:///review-before".to_owned()],
        "the first path must reach the outer terminal"
    );

    // A path-only change: no title mutation, no other redraw cause.
    feed_active_pane(&handler, &alpha, b"\x1b]7;file:///review-after\x07").await;
    assert_eq!(pane_path(&handler, &alpha).await, "file:///review-after");
    let delivered = delivered_paths(&mut control_rx);
    assert_eq!(
        delivered,
        vec!["file:///review-after".to_owned()],
        "a path-only change must refresh the client exactly once"
    );
}

/// tmux writes an OSC 7 carrying an empty payload when the pane reports one, so
/// a client that was told a directory can be told it no longer has one.
#[tokio::test]
async fn a_pane_clearing_its_path_clears_the_outer_terminal() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    create_quiet_session(&handler, &alpha).await;

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
    enable_osc7(&handler).await;
    set_global(&handler, OptionName::SetTitlesString, "PATHTEST").await;
    set_global(&handler, OptionName::SetTitles, "on").await;

    feed_active_pane(&handler, &alpha, b"\x1b]7;file:///review-set\x07").await;
    assert_eq!(
        delivered_paths(&mut control_rx),
        vec![String::new(), "file:///review-set".to_owned()],
        "the attach reports the empty pane path, then the value it is given"
    );

    feed_active_pane(&handler, &alpha, b"\x1b]7;\x07").await;
    assert_eq!(
        pane_path(&handler, &alpha).await,
        "",
        "the pane itself must record the cleared path"
    );
    assert_eq!(
        delivered_paths(&mut control_rx),
        vec![String::new()],
        "clearing the pane path must clear the outer terminal's"
    );

    // And the cleared state is remembered: repeating it stays silent.
    feed_active_pane(&handler, &alpha, b"\x1b]7;\x07x").await;
    assert!(
        delivered_paths(&mut control_rx).is_empty(),
        "an unchanged empty path must not be rewritten"
    );
}

/// `set-titles off` gates OSC 7 exactly as it gates OSC 0: a path change while
/// titles are off writes nothing and costs no redraw.
#[tokio::test]
async fn a_path_change_writes_nothing_while_set_titles_is_off() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    create_quiet_session(&handler, &alpha).await;

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
    enable_osc7(&handler).await;
    // Drain the terminal-features refresh; set-titles stays at its "off" default.
    let _ = delivered_paths(&mut control_rx);

    feed_active_pane(&handler, &alpha, b"\x1b]7;file:///never-written\x07").await;
    assert_eq!(
        pane_path(&handler, &alpha).await,
        "file:///never-written",
        "the pane still records the path"
    );
    assert!(
        delivered_paths(&mut control_rx).is_empty(),
        "set-titles off must write no OSC 7"
    );
}

/// A client whose terminal never advertised the OSC 7 template keeps its
/// working directory untouched even while `set-titles` is on.
#[tokio::test]
async fn a_client_without_the_osc7_capability_receives_no_path() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    create_quiet_session(&handler, &alpha).await;

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
    set_global(&handler, OptionName::SetTitlesString, "NOPATH").await;
    set_global(&handler, OptionName::SetTitles, "on").await;
    assert_eq!(delivered_titles(&mut control_rx), vec!["NOPATH".to_owned()]);

    feed_active_pane(&handler, &alpha, b"\x1b]7;file:///no-capability\x07").await;
    assert!(
        delivered_paths(&mut control_rx).is_empty(),
        "a client without osc7 must receive no path"
    );
}

/// A window shared by two linked sessions, one with `set-titles on` and one
/// with it off: an outer-identity change must redraw only the session that
/// would actually write to its client's terminal.
#[tokio::test]
async fn a_linked_session_with_set_titles_off_is_not_redrawn_by_a_title_change() {
    let handler = RequestHandler::new();
    let owner = session_name("titled-owner");
    let peer = session_name("untitled-peer");
    create_quiet_session(&handler, &owner).await;
    create_quiet_session(&handler, &peer).await;

    let owner_pid = u32::MAX - 182;
    let peer_pid = u32::MAX - 183;
    let (owner_tx, mut owner_rx) = mpsc::unbounded_channel();
    let (peer_tx, mut peer_rx) = mpsc::unbounded_channel();
    let _owner_id = handler
        .register_attach_with_terminal_context(
            owner_pid,
            owner.clone(),
            owner_tx,
            title_capable_context(),
        )
        .await;
    let _peer_id = handler
        .register_attach_with_terminal_context(
            peer_pid,
            peer.clone(),
            peer_tx,
            title_capable_context(),
        )
        .await;

    let linked = handler
        .handle(Request::LinkWindow(LinkWindowRequest {
            source: WindowTarget::with_window(owner.clone(), 0),
            target: WindowTarget::with_window(peer.clone(), 0),
            after: false,
            before: false,
            kill_destination: true,
            detached: false,
        }))
        .await;
    assert!(matches!(linked, Response::LinkWindow(_)), "{linked:?}");

    set_session_option(
        &handler,
        &owner,
        OptionName::SetTitlesString,
        "T:#{pane_title}",
    )
    .await;
    set_session_option(&handler, &owner, OptionName::SetTitles, "on").await;
    set_session_option(&handler, &peer, OptionName::SetTitles, "off").await;
    let _ = delivered_titles(&mut owner_rx);
    let _ = delivered_titles(&mut peer_rx);

    // The shared pane retitles itself.
    feed_active_pane(&handler, &owner, b"\x1b]2;LINKED-APP\x07").await;

    assert_eq!(
        delivered_titles(&mut owner_rx),
        vec!["T:LINKED-APP".to_owned()],
        "the session with set-titles on must be told the new title"
    );
    assert!(
        matches!(peer_rx.try_recv(), Err(TryRecvError::Empty)),
        "a linked session with set-titles off must pay no redraw for a title change"
    );
}

async fn set_session_option(
    handler: &RequestHandler,
    session: &rmux_proto::SessionName,
    option: OptionName,
    value: &str,
) {
    let set = handler
        .handle(Request::SetOption(SetOptionRequest {
            scope: ScopeSelector::Session(session.clone()),
            option,
            value: value.to_owned(),
            mode: SetOptionMode::Replace,
        }))
        .await;
    assert!(matches!(set, Response::SetOption(_)), "set {option:?}");
}
