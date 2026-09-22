use super::*;

fn token(value: &str) -> String {
    value.to_owned()
}

fn fixture() -> (SessionStore, TargetFindContext) {
    let session_name = rmux_proto::SessionName::new("alpha").expect("valid session name");
    let mut sessions = SessionStore::new();
    sessions
        .create_session(session_name.clone(), TerminalSize { cols: 80, rows: 24 })
        .expect("session creation succeeds");
    let find_context = TargetFindContext::from_target(rmux_proto::Target::Window(
        WindowTarget::with_window(session_name, 0),
    ));
    (sessions, find_context)
}

fn parse(arguments: &[&str]) -> Result<ParsedSelectLayout, RmuxError> {
    let (sessions, find_context) = fixture();
    parse_select_layout(
        CommandTokens::new(arguments.iter().map(|argument| token(argument)).collect()),
        &sessions,
        &find_context,
    )
}

#[test]
fn select_layout_rejects_unknown_option_shapes_before_layout() {
    for (arguments, expected) in [
        (&["-x"][..], "command select-layout: unknown flag -x"),
        (&["--bogus"][..], "command select-layout: invalid flag --"),
        (&["-nx"][..], "command select-layout: unknown flag -x"),
        (&["-value"][..], "command select-layout: unknown flag -v"),
    ] {
        assert_eq!(
            parse(arguments).expect_err("unknown option must fail before layout parsing"),
            RmuxError::Server(expected.to_owned())
        );
    }
}

#[test]
fn select_layout_preserves_legitimate_flags_and_separator() {
    for arguments in [
        &["-E", "-t", "alpha:0"][..],
        &["-n", "-t", "alpha:0"][..],
        &["-o", "-t", "alpha:0"][..],
        &["-p", "-t", "alpha:0"][..],
        &["-t", "alpha:0", "tiled"][..],
        &["-ntalpha:0"][..],
        &["--", "tiled"][..],
    ] {
        parse(arguments).unwrap_or_else(|error| {
            panic!("select-layout rejected legitimate arguments {arguments:?}: {error}")
        });
    }
}

#[test]
fn select_layout_mode_clusters_use_tmux_priority_independent_of_spelling() {
    for arguments in [
        &["-En", "-t", "alpha:0"][..],
        &["-nE", "-t", "alpha:0"][..],
        &["-E", "-n", "-t", "alpha:0"][..],
        &["-Enop", "-t", "alpha:0"][..],
    ] {
        assert!(
            matches!(
                parse(arguments),
                Ok(ParsedSelectLayout::Request(Request::NextLayout(_)))
            ),
            "-n must govern {arguments:?}"
        );
    }

    for arguments in [&["-Ep", "-t", "alpha:0"][..], &["-op", "-t", "alpha:0"][..]] {
        assert!(
            matches!(
                parse(arguments),
                Ok(ParsedSelectLayout::Request(Request::PreviousLayout(_)))
            ),
            "-p must govern {arguments:?}"
        );
    }

    assert!(matches!(
        parse(&["-Eo", "-t", "alpha:0"]),
        Ok(ParsedSelectLayout::Request(Request::SpreadLayout(_)))
    ));
    assert!(matches!(
        parse(&["-o", "-t", "alpha:0"]),
        Ok(ParsedSelectLayout::Request(Request::SelectOldLayout(_)))
    ));
}

#[test]
fn select_layout_mode_operand_semantics_match_tmux() {
    for arguments in [
        &["-n", "-t", "alpha:0", "tiled"][..],
        &["-p", "-t", "alpha:0", "tiled"][..],
        &["-E", "-t", "alpha:0", "tiled"][..],
    ] {
        parse(arguments).unwrap_or_else(|error| {
            panic!("governing navigation/spread mode must ignore one operand: {error}")
        });
    }

    let ParsedSelectLayout::Request(Request::SelectCustomLayout(request)) =
        parse(&["-o", "-t", "alpha:0", "tiled"]).expect("-o accepts one custom-layout operand")
    else {
        panic!("-o with an operand must use strict custom-layout parsing at runtime");
    };
    assert_eq!(request.layout, "tiled");

    assert!(
        parse(&["-En", "-t", "alpha:0", "tiled", "extra"]).is_err(),
        "a governing mode must still reject a second operand"
    );
}

#[test]
fn select_layout_preserves_missing_target_error() {
    assert_eq!(
        parse(&["-t"]).expect_err("-t without a target must fail"),
        RmuxError::Server("missing -t target".to_owned())
    );
}
