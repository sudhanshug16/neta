use std::path::Path;

use rmux_proto::{SessionName, TerminalSize};

use super::{
    DeferredInitialPaneInput, DeferredInitialPaneInputDrain, DeferredInitialPaneSpawn,
    HandlerState, InitialPaneSpawnOptions, PasteDelimiters,
};

fn session_name(value: &str) -> SessionName {
    SessionName::new(value).expect("valid session name")
}

fn prepare_deferred_session(
    state: &mut HandlerState,
    session_name: &SessionName,
) -> DeferredInitialPaneSpawn {
    state
        .sessions
        .create_session(session_name.clone(), TerminalSize { cols: 80, rows: 24 })
        .expect("session creation succeeds");
    state
        .prepare_deferred_initial_session_terminal(
            session_name,
            InitialPaneSpawnOptions {
                socket_path: Path::new(r"\\.\pipe\rmux-deferred-identity-test"),
                spawn_environment: None,
                raw_spawn_environment: None,
                environment_overrides: None,
                command: None,
                pane_alert_callback: None,
                pane_exit_callback: None,
            },
        )
        .expect("deferred initial pane preparation succeeds")
}

#[test]
fn deferred_input_finisher_follows_runtime_session_rename() {
    let mut state = HandlerState::default();
    let original = session_name("deferred-original");
    let renamed = session_name("deferred-renamed");
    let job = prepare_deferred_session(&mut state, &original);

    state
        .rename_session(&original, &renamed)
        .expect("session rename succeeds");

    let drain = state
        .take_deferred_initial_pane_input_or_finish(&original, job.identity)
        .expect("finisher resolves the renamed runtime");
    assert!(matches!(
        drain,
        DeferredInitialPaneInputDrain::Finished {
            runtime_session_name
        } if runtime_session_name == renamed
    ));
    assert!(
        !state.active_pane_is_starting(&renamed),
        "the renamed pane must leave Starting state"
    );
    state.shutdown_terminals_for_test();
}

#[test]
fn deferred_identity_ignores_reused_name_and_stale_generation() {
    let mut state = HandlerState::default();
    let original = session_name("deferred-reused");
    let renamed = session_name("deferred-owner");
    let original_job = prepare_deferred_session(&mut state, &original);
    state
        .rename_session(&original, &renamed)
        .expect("session rename succeeds");
    let replacement_job = prepare_deferred_session(&mut state, &original);

    let resolved = state
        .starting_runtime_session_for_identity(&original, original_job.identity)
        .expect("old pane identity remains resolvable");
    assert_eq!(
        resolved, renamed,
        "a reused name must not capture the old job"
    );

    let drain = state
        .take_deferred_initial_pane_input_or_finish(&original, original_job.identity)
        .expect("old finisher resolves by stable identity");
    assert!(matches!(
        drain,
        DeferredInitialPaneInputDrain::Finished {
            runtime_session_name
        } if runtime_session_name == renamed
    ));
    assert!(
        state.active_pane_is_starting(&original),
        "finishing the old job must preserve the replacement pane"
    );

    let replacement_runtime = replacement_job.runtime_session_name.clone();
    let replacement_pane_id = replacement_job.identity.pane_id();
    let replacement = state
        .starting_panes
        .get_mut(&replacement_runtime)
        .and_then(|panes| panes.get_mut(&replacement_pane_id))
        .expect("replacement starting pane exists");
    replacement.generation = replacement.generation.saturating_add(1);

    state.finish_deferred_initial_pane_input_after_error(
        &replacement_runtime,
        replacement_job.identity,
    );
    assert!(
        state.active_pane_is_starting(&original),
        "a stale generation must not remove a newer pane incarnation"
    );
    state.shutdown_terminals_for_test();
}

#[test]
fn starting_pane_keeps_bracketed_paste_distinct_from_plain_bytes() {
    let mut state = HandlerState::default();
    let session = session_name("deferred-bracketed-paste");
    let job = prepare_deferred_session(&mut state, &session);
    let payload = b"\x1b[200~alpha\nbeta\x1b[201~";

    assert!(state
        .queue_starting_pane_paste_input(&session, 0, 0, payload, PasteDelimiters::Wrapped)
        .expect("bracketed paste queues while the pane starts"));

    let starting = state
        .starting_panes
        .get(&job.runtime_session_name)
        .and_then(|panes| panes.get(&job.identity.pane_id()))
        .expect("starting pane remains registered");
    assert_eq!(
        starting.queued_input.front(),
        Some(&DeferredInitialPaneInput::Paste {
            bytes: payload.to_vec(),
            delimiters: PasteDelimiters::Wrapped,
        })
    );
    assert_eq!(starting.queued_input_bytes, payload.len());
    state.shutdown_terminals_for_test();
}

/// A body queued for a destination that never announced `?2004h` is still a
/// paste, so it must reach the flush as one. Queuing it as plain bytes is what
/// sent it through the raw ConPTY pipe, where a legacy input state machine
/// parses and consumes the control sequences inside the pasted content.
#[test]
fn a_bare_paste_body_is_queued_as_a_paste_and_keeps_its_disposition() {
    let mut state = HandlerState::default();
    let session = session_name("deferred-bare-paste");
    let job = prepare_deferred_session(&mut state, &session);
    let payload = "alpha\r\n\u{1b}[9;2u omega".as_bytes();

    assert!(state
        .queue_starting_pane_paste_input(&session, 0, 0, payload, PasteDelimiters::Bare)
        .expect("a bare paste body queues while the pane starts"));

    let starting = state
        .starting_panes
        .get(&job.runtime_session_name)
        .and_then(|panes| panes.get(&job.identity.pane_id()))
        .expect("starting pane remains registered");
    assert_eq!(
        starting.queued_input.front(),
        Some(&DeferredInitialPaneInput::Paste {
            bytes: payload.to_vec(),
            delimiters: PasteDelimiters::Bare,
        }),
        "a bare body must not be demoted to plain queued bytes"
    );
    assert_eq!(starting.queued_input_bytes, payload.len());
    state.shutdown_terminals_for_test();
}

/// The typed bracketed-paste entry must be accounted for exactly like plain
/// bytes, otherwise the starting-pane queue silently stops enforcing the
/// 64-KiB bound that protects a pane that never finishes starting.
#[test]
fn queued_bracketed_paste_is_charged_against_the_starting_input_limit() {
    let mut state = HandlerState::default();
    let session = session_name("deferred-bracketed-capacity");
    let job = prepare_deferred_session(&mut state, &session);
    let limit = super::STARTING_PANE_INPUT_MAX_BYTES;
    let chunk = vec![b'p'; 4096];

    let mut queued = 0;
    while queued + chunk.len() <= limit {
        assert!(
            state
                .queue_starting_pane_paste_input(&session, 0, 0, &chunk, PasteDelimiters::Wrapped)
                .expect("a bracketed paste below the limit queues"),
            "the pane is still starting, so the paste must be queued"
        );
        queued += chunk.len();
    }
    assert_eq!(
        queued, limit,
        "the chunk size must divide the limit exactly"
    );

    let overflow = state
        .queue_starting_pane_paste_input(&session, 0, 0, b"x", PasteDelimiters::Wrapped)
        .expect_err("one byte past the limit must be rejected");
    assert!(
        overflow.to_string().contains("input queue is full"),
        "unexpected overflow error: {overflow}"
    );

    let starting = state
        .starting_panes
        .get(&job.runtime_session_name)
        .and_then(|panes| panes.get(&job.identity.pane_id()))
        .expect("starting pane remains registered");
    assert_eq!(
        starting.queued_input_bytes, limit,
        "every queued bracketed paste must contribute its own byte length"
    );
    assert_eq!(
        starting.queued_input.len(),
        limit / chunk.len(),
        "the rejected byte must not have been appended"
    );
    state.shutdown_terminals_for_test();
}
