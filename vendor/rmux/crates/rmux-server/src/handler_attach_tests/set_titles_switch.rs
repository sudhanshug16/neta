//! Issue #182, switch-time bindings: the frame an attached `switch-client`
//! delivers expands `set-titles-string` against the client it is written to,
//! so its `#{client_session}` must already be the session that switch commits
//! to rather than the one being left.
//!
//! The switch renders before it moves the client and the linked-family refresh
//! that follows deliberately excludes the switched client, so nothing corrects
//! a stale binding. These run with `status-interval 0` for exactly that reason:
//! the periodic tick that happened to repair it in the field is off.
//!
//! Oracle: tmux 3.7b, measured on this host with `status-interval 0` and
//! `set-titles-string 'TARGET=#S|CLIENT=#{client_session}'`. A client on
//! `alpha` is told `TARGET=alpha|CLIENT=alpha`, and after switching to `beta`
//! its next OSC 0 is `TARGET=beta|CLIENT=beta`.

use super::set_titles_support::{
    delivered_titles, new_detached_session, remembered_title, set_global, title_capable_context,
};
use super::*;

const SWITCH_TITLE_FORMAT: &str = "TARGET=#S|CLIENT=#{client_session}|N=#{client_name}";

/// Creates both sessions, arms the title format and silences the periodic
/// status tick, all before any client attaches.
async fn arm_two_sessions(
    handler: &RequestHandler,
    alpha: &rmux_proto::SessionName,
    beta: &rmux_proto::SessionName,
) {
    new_detached_session(handler, alpha).await;
    new_detached_session(handler, beta).await;
    // The reviewer's reproduction: no periodic redraw may repair the frame.
    set_global(handler, OptionName::StatusInterval, "0").await;
    set_global(handler, OptionName::SetTitlesString, SWITCH_TITLE_FORMAT).await;
}

async fn attach_title_capable_client(
    handler: &RequestHandler,
    session: &rmux_proto::SessionName,
    attach_pid: u32,
) -> mpsc::UnboundedReceiver<AttachControl> {
    let (control_tx, control_rx) = mpsc::unbounded_channel();
    let _attach_id = handler
        .register_attach_with_terminal_context(
            attach_pid,
            session.clone(),
            control_tx,
            title_capable_context(),
        )
        .await;
    control_rx
}

fn expected_title(session: &str, attach_pid: u32) -> String {
    let client_name = crate::client_names::attached_client_name(attach_pid);
    format!("TARGET={session}|CLIENT={session}|N={client_name}")
}

async fn switch_client_to(
    handler: &RequestHandler,
    attach_pid: u32,
    session: &rmux_proto::SessionName,
) {
    let switched = handler
        .dispatch(
            attach_pid,
            Request::SwitchClient(SwitchClientRequest {
                target: session.clone(),
            }),
        )
        .await
        .response;
    assert_eq!(
        switched,
        Response::SwitchClient(rmux_proto::SwitchClientResponse {
            session_name: session.clone(),
        })
    );
}

/// The blocking finding, at the layer it failed: the delivered switch frame
/// must agree with `#S`, with `list-clients` and with the tmux oracle.
#[tokio::test]
async fn the_switch_frame_expands_the_destination_session_for_the_switched_client() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    let beta = session_name("beta");
    let attach_pid = std::process::id();
    arm_two_sessions(&handler, &alpha, &beta).await;
    let mut control_rx = attach_title_capable_client(&handler, &alpha, attach_pid).await;

    set_global(&handler, OptionName::SetTitles, "on").await;
    assert_eq!(
        delivered_titles(&mut control_rx),
        vec![expected_title("alpha", attach_pid)],
        "the client opens on alpha and is told so once"
    );

    switch_client_to(&handler, attach_pid, &beta).await;

    let expected = expected_title("beta", attach_pid);
    assert_eq!(
        delivered_titles(&mut control_rx),
        vec![expected.clone()],
        "the switch frame itself must carry the destination session, with no \
         later redraw to correct it"
    );
    assert_eq!(
        remembered_title(&handler, attach_pid).await,
        Some(expected),
        "the per-client memory must record what the switch frame really wrote"
    );
}

/// The switched client's own record is what moves, not the render: a client
/// that stays behind keeps its own session in its own title.
#[tokio::test]
async fn a_client_that_stays_behind_keeps_its_own_session_in_its_title() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    let beta = session_name("beta");
    let switching_pid = std::process::id();
    let staying_pid = switching_pid.wrapping_add(18_201);
    arm_two_sessions(&handler, &alpha, &beta).await;
    let mut switching_rx = attach_title_capable_client(&handler, &alpha, switching_pid).await;
    let mut staying_rx = attach_title_capable_client(&handler, &alpha, staying_pid).await;

    set_global(&handler, OptionName::SetTitles, "on").await;
    let staying_title = expected_title("alpha", staying_pid);
    assert_eq!(
        delivered_titles(&mut switching_rx),
        vec![expected_title("alpha", switching_pid)],
        "both clients open on alpha under their own names"
    );
    assert_eq!(
        delivered_titles(&mut staying_rx),
        vec![staying_title.clone()]
    );

    switch_client_to(&handler, switching_pid, &beta).await;

    assert_eq!(
        delivered_titles(&mut switching_rx),
        vec![expected_title("beta", switching_pid)],
        "only the switching client moves to beta"
    );
    assert!(
        delivered_titles(&mut staying_rx)
            .iter()
            .all(|title| title == &staying_title),
        "the client left on alpha is never told another client's session"
    );
    assert_eq!(
        remembered_title(&handler, staying_pid).await,
        Some(staying_title),
        "the staying client's remembered title still names alpha"
    );
}

/// `list-clients` is the independent oracle for the same bindings. After the
/// switch, it and the delivered frame must report one session, not two.
#[tokio::test]
async fn the_switch_frame_and_list_clients_agree_on_the_client_session() {
    let handler = RequestHandler::new();
    let alpha = session_name("alpha");
    let beta = session_name("beta");
    let attach_pid = std::process::id();
    arm_two_sessions(&handler, &alpha, &beta).await;
    let mut control_rx = attach_title_capable_client(&handler, &alpha, attach_pid).await;

    set_global(&handler, OptionName::SetTitles, "on").await;
    let _opening = delivered_titles(&mut control_rx);
    switch_client_to(&handler, attach_pid, &beta).await;
    let delivered = delivered_titles(&mut control_rx);

    let listed = handler
        .handle(Request::ListClients(Box::new(
            rmux_proto::ListClientsRequest {
                target_session: None,
                // `#S` has no client scope in `list-clients`; the session this
                // client reports is the one under test on both sides.
                format: Some(SWITCH_TITLE_FORMAT.replace("#S", "#{client_session}")),
                filter: None,
                sort_order: None,
                reversed: false,
            },
        )))
        .await;
    let Response::ListClients(list) = listed else {
        panic!("list-clients must answer, got {listed:?}");
    };
    let listed = String::from_utf8_lossy(list.output.stdout())
        .lines()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    assert_eq!(
        delivered, listed,
        "the switch frame must expand the same client bindings list-clients reports"
    );
}
