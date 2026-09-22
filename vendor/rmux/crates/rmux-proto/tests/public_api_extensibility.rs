use std::path::Path;

#[test]
fn public_extensibility_requires_downstream_fallbacks() {
    compile_fail::assert_compile_fail_cases(
        "rmux-proto",
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &[
            compile_fail::CompileFailCase::enum_match(
                "request_envelope",
                exhaustive_envelope_match("Request", include_str!("../src/request.rs")),
            ),
            compile_fail::CompileFailCase::enum_match(
                "response_envelope",
                exhaustive_envelope_match("Response", include_str!("../src/response.rs")),
            ),
            compile_fail::CompileFailCase::enum_match(
                "pane_stream_mode",
                r#"
use rmux_proto::PaneStreamMode;

fn exhaustive(value: PaneStreamMode) {
    match value {
        PaneStreamMode::Raw | PaneStreamMode::Surface => {}
    }
}

fn main() {}
"#,
            ),
            compile_fail::CompileFailCase::enum_match(
                "pane_raw_rebase_reason",
                r#"
use rmux_proto::PaneRawRebaseReason;

fn exhaustive(value: PaneRawRebaseReason) {
    match value {
        PaneRawRebaseReason::Initial
        | PaneRawRebaseReason::Lag
        | PaneRawRebaseReason::Resize
        | PaneRawRebaseReason::ClearHistory
        | PaneRawRebaseReason::ParserStateExpired
        | PaneRawRebaseReason::TerminalReset
        | PaneRawRebaseReason::TranscriptMutation
        | PaneRawRebaseReason::GenerationChanged => {}
    }
}

fn main() {}
"#,
            ),
            compile_fail::CompileFailCase::enum_match(
                "pane_stream_lifecycle_event",
                r#"
use rmux_proto::PaneStreamLifecycleEvent;

fn exhaustive(value: PaneStreamLifecycleEvent) {
    match value {
        PaneStreamLifecycleEvent::ProcessExited { .. } => {}
    }
}

fn main() {}
"#,
            ),
            compile_fail::CompileFailCase::enum_match(
                "pane_stream_end_reason",
                r#"
use rmux_proto::PaneStreamEndReason;

fn exhaustive(value: PaneStreamEndReason) {
    match value {
        PaneStreamEndReason::PaneRemoved
        | PaneStreamEndReason::AccessRevoked
        | PaneStreamEndReason::SlowConsumer
        | PaneStreamEndReason::SubscriptionExpired
        | PaneStreamEndReason::TransportLost
        | PaneStreamEndReason::ProjectionFailed => {}
    }
}

fn main() {}
"#,
            ),
            compile_fail::CompileFailCase::enum_match(
                "pane_stream_event",
                r#"
use rmux_proto::PaneStreamEvent;

fn exhaustive(value: PaneStreamEvent) {
    match value {
        PaneStreamEvent::RawRebase(_)
        | PaneStreamEvent::RawBytes(_)
        | PaneStreamEvent::SurfaceReset(_)
        | PaneStreamEvent::SurfacePatch(_)
        | PaneStreamEvent::Lifecycle(_)
        | PaneStreamEvent::End(_) => {}
    }
}

fn main() {}
"#,
            ),
        ],
    );
}

fn exhaustive_envelope_match(type_name: &str, source: &str) -> String {
    let marker = format!("pub enum {type_name} {{");
    let body = source
        .split_once(&marker)
        .unwrap_or_else(|| panic!("missing `{marker}`"))
        .1
        .split_once("\n}")
        .unwrap_or_else(|| panic!("unterminated `{marker}`"))
        .0;
    let patterns = body
        .lines()
        .filter_map(tuple_variant_pattern)
        .map(|pattern| format!("        {type_name}::{pattern} => {{}},\n"))
        .collect::<String>();
    assert!(
        !patterns.is_empty(),
        "`{type_name}` must expose at least one tuple variant"
    );
    format!(
        "use rmux_proto::{type_name};\n\n\
         fn exhaustive(value: {type_name}) {{\n\
             match value {{\n\
         {patterns}\
             }}\n\
         }}\n\n\
         fn main() {{}}\n"
    )
}

fn tuple_variant_pattern(line: &str) -> Option<String> {
    let declaration = line.strip_prefix("    ")?;
    if declaration.starts_with(' ') {
        return None;
    }
    let open = declaration.find('(')?;
    let name = &declaration[..open];
    let mut characters = name.chars();
    if !characters.next().is_some_and(char::is_uppercase)
        || !characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return None;
    }
    Some(format!("{name}(..)"))
}

#[path = "../../../tests/support/public_api_compile_fail.rs"]
mod compile_fail;
