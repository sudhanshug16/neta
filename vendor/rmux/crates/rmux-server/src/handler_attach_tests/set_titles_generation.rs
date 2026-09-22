//! Issue #182, redraw generation binding: a `#{client_*}` frame belongs to the
//! exact attach generation it was captured from.
//!
//! A generic redraw snapshots one client under the attach lock, renders under
//! the state lock, then reacquires the attach lock to deliver. Registration
//! deliberately allows a replacement to take the same pid, so between those two
//! lock holds `by_pid[pid]` can already be a different client. Keying delivery
//! on the pid alone hands generation A's rendered geometry to its replacement B
//! and records A's title in B's memory, after which deduplication claims B was
//! shown something it never received.
//!
//! `refresh_identity.rs` already revalidates the captured attach id and session
//! id before it commits; these prove the two generic paths do the same,
//! including `refresh_attached_client`, whose `expected_attach_id` is `None`.

use super::set_titles_support::{
    delivered_titles, new_detached_session, remembered_title, set_global, title_capable_context,
};
use super::*;

/// Distinguishes the two generations by something only the client owns, so a
/// frame delivered to the wrong one is visible rather than merely suspected.
const GEOMETRY_TITLE_FORMAT: &str = "GEN=#{client_width}x#{client_height}";

const FIRST_SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };
const REPLACEMENT_SIZE: TerminalSize = TerminalSize {
    cols: 132,
    rows: 43,
};

fn title_for(size: TerminalSize) -> String {
    format!("GEN={}x{}", size.cols, size.rows)
}

/// Registers one client exactly as `listener.rs` publishes a fresh attach.
async fn attach_sized_client(
    handler: &RequestHandler,
    session: &rmux_proto::SessionName,
    attach_pid: u32,
    client_size: TerminalSize,
) -> mpsc::UnboundedReceiver<AttachControl> {
    let (control_tx, control_rx) = mpsc::unbounded_channel();
    let uid = current_owner_uid();
    handler
        .register_attach_with_access(
            attach_pid,
            session.clone(),
            None,
            AttachRegistration {
                control_tx,
                control_backlog: Arc::new(AtomicUsize::new(0)),
                closing: Arc::new(AtomicBool::new(false)),
                persistent_overlay_epoch: Arc::new(AtomicU64::new(0)),
                terminal_context: title_capable_context(),
                client_title: None,
                flags: crate::handler::attach_support::ClientFlags::default(),
                render_stream: false,
                uid,
                user: rmux_os::identity::UserIdentity::Uid(uid),
                can_write: true,
                client_size: Some(client_size),
            },
        )
        .await
        .expect("attach registration succeeds");
    control_rx
}

/// Arms a session whose title reports each client's own geometry, attaches the
/// first generation and drains whatever its registration already produced.
async fn armed_session(
    label: &str,
    attach_pid: u32,
) -> (
    RequestHandler,
    rmux_proto::SessionName,
    mpsc::UnboundedReceiver<AttachControl>,
) {
    let handler = RequestHandler::new();
    let session = session_name(label);
    new_detached_session(&handler, &session).await;
    set_global(&handler, OptionName::SetTitlesString, GEOMETRY_TITLE_FORMAT).await;
    set_global(&handler, OptionName::SetTitles, "on").await;

    // The registration carries no remembered title, so the redraw under test
    // really resolves and commits this generation's own geometry rather than
    // deduplicating against something it was already shown.
    let control_rx = attach_sized_client(&handler, &session, attach_pid, FIRST_SIZE).await;
    (handler, session, control_rx)
}

/// Replaces the paused generation with a differently sized client under the
/// same pid and session, and returns the replacement's own control queue.
async fn replace_with_second_generation(
    handler: &RequestHandler,
    session: &rmux_proto::SessionName,
    attach_pid: u32,
) -> mpsc::UnboundedReceiver<AttachControl> {
    let replacement_rx = attach_sized_client(handler, session, attach_pid, REPLACEMENT_SIZE).await;
    assert_eq!(
        remembered_title(handler, attach_pid).await,
        None,
        "a fresh registration starts with no remembered title of its own"
    );
    replacement_rx
}

/// Neither the frame nor the memory of the replaced generation may survive.
async fn assert_replacement_untouched_by(
    handler: &RequestHandler,
    attach_pid: u32,
    replacement_rx: &mut mpsc::UnboundedReceiver<AttachControl>,
    context: &str,
) {
    let stale_title = title_for(FIRST_SIZE);
    let delivered = delivered_titles(replacement_rx);
    assert!(
        !delivered.contains(&stale_title),
        "{context}: the replacement must not be shown the replaced generation's \
         title, got {delivered:?}"
    );
    assert_ne!(
        remembered_title(handler, attach_pid).await,
        Some(stale_title),
        "{context}: the replacement must not remember a title it was never sent"
    );
}

/// The session-wide generic redraw: `refresh_attached_session` captures every
/// eligible client, renders, then delivers by pid and session name only.
#[tokio::test]
async fn a_session_redraw_never_delivers_a_replaced_generation_s_frame() {
    let attach_pid = 60_182;
    let (handler, session, _first_rx) =
        armed_session("redraw-generation-session", attach_pid).await;

    let pause = crate::handler::attach_support::install_generic_render_delivery_pause(attach_pid);
    let refresh_handler = handler.clone();
    let refresh_session = session.clone();
    let refresh = tokio::spawn(async move {
        refresh_handler
            .refresh_attached_session(&refresh_session)
            .await;
    });

    tokio::time::timeout(ATTACH_LIFECYCLE_TIMEOUT, pause.reached.notified())
        .await
        .expect("the session redraw reaches its delivery boundary");
    let mut replacement_rx = replace_with_second_generation(&handler, &session, attach_pid).await;
    pause.release.notify_one();
    refresh.await.expect("session refresh task");

    assert_replacement_untouched_by(
        &handler,
        attach_pid,
        &mut replacement_rx,
        "refresh_attached_session",
    )
    .await;
}

/// The single-client generic redraw. `refresh_attached_client` passes
/// `expected_attach_id = None`, so both its capture filter and its delivery
/// guard accept any same-pid, same-session replacement.
#[tokio::test]
async fn a_client_redraw_with_no_expected_identity_still_binds_its_generation() {
    let attach_pid = 60_183;
    let (handler, session, _first_rx) = armed_session("redraw-generation-client", attach_pid).await;

    let pause = crate::handler::attach_support::install_generic_render_delivery_pause(attach_pid);
    let refresh_handler = handler.clone();
    let refresh_session = session.clone();
    let refresh = tokio::spawn(async move {
        refresh_handler
            .refresh_attached_client(attach_pid, &refresh_session)
            .await;
    });

    tokio::time::timeout(ATTACH_LIFECYCLE_TIMEOUT, pause.reached.notified())
        .await
        .expect("the client redraw reaches its delivery boundary");
    let mut replacement_rx = replace_with_second_generation(&handler, &session, attach_pid).await;
    pause.release.notify_one();
    refresh.await.expect("client refresh task");

    assert_replacement_untouched_by(
        &handler,
        attach_pid,
        &mut replacement_rx,
        "refresh_attached_client",
    )
    .await;
}

/// The binding must not cost the ordinary case anything: with no replacement in
/// flight, both generic paths still redraw the client that is actually there.
#[tokio::test]
async fn an_undisturbed_generic_redraw_still_reaches_its_own_client() {
    let attach_pid = 60_184;
    let (handler, session, mut control_rx) =
        armed_session("redraw-generation-undisturbed", attach_pid).await;

    handler.refresh_attached_client(attach_pid, &session).await;
    assert_eq!(
        delivered_titles(&mut control_rx),
        vec![title_for(FIRST_SIZE)],
        "the client still receives its own geometry"
    );
    assert_eq!(
        remembered_title(&handler, attach_pid).await,
        Some(title_for(FIRST_SIZE)),
        "and the server remembers what it just showed that client"
    );

    handler.refresh_attached_client(attach_pid, &session).await;
    let delivered = delivered_titles(&mut control_rx);
    assert!(
        delivered.is_empty(),
        "an unchanged title is still deduplicated, got {delivered:?}"
    );

    // A real change must still arrive through the session-wide path.
    set_global(
        &handler,
        OptionName::SetTitlesString,
        "CHANGED-#{client_width}",
    )
    .await;
    let delivered = delivered_titles(&mut control_rx);
    assert_eq!(
        delivered.last().map(String::as_str),
        Some("CHANGED-80"),
        "the live client still receives its own changed title, got {delivered:?}"
    );
}
