use std::collections::BTreeSet;

use crate::input::InputParser;
use crate::{GridRenderOptions, ScreenCaptureRange};
use rmux_proto::TerminalSize;

use super::Screen;

#[derive(Clone, Copy)]
struct OracleCase {
    case_id: &'static str,
    operation: &'static str,
    position: &'static str,
    count: &'static str,
    wrap: &'static str,
    location: &'static str,
    lines: u8,
    glyphs: &'static str,
    screen: &'static str,
    repetition: u8,
    payload_hex: &'static str,
    expected_hex: &'static str,
}

const ORACLE_CASES: &[OracleCase] = &[
    OracleCase {
        case_id: "m00038",
        operation: "DCH",
        position: "first",
        count: "one",
        wrap: "exact",
        location: "history",
        lines: 1,
        glyphs: "ascii",
        screen: "alternate",
        repetition: 1,
        payload_hex: "1b631b5b334a1b5b324a1b5b721b5b3f37681b5b313b31481b5b3f31303439681b5b313b31484142434445464748494a4b4c0d0a4e58540d0a454e441b5b721b5b313b31481b5b31501b5b721b5b383b31480d0a48300d0a48310d0a48320d0a48330d0a48340d0a48350d0a48360d0a48370d0a48380d0a48390d0a48300d0a48311b5d323b6d303030333807",
        expected_hex: "48340a48350a48360a48370a48380a48390a48300a48310a",
    },
    OracleCase {
        case_id: "m00308",
        operation: "DCH",
        position: "first",
        count: "large",
        wrap: "exact",
        location: "viewport",
        lines: 2,
        glyphs: "combining",
        screen: "main",
        repetition: 1,
        payload_hex: "1b631b5b334a1b5b324a1b5b721b5b3f37681b5b313b314865cc81416fcc816265cc81416fcc816265cc81416fcc816265cc81416fcc816265cc81416fcc816265cc81416fcc81620d0a4e58540d0a454e441b5b721b5b313b31481b5b3939501b5d323b6d303033303807",
        expected_hex: "0a65cc81416fcc816265cc81416fcc816265cc81416fcc81620a4e58540a454e440a0a0a0a0a",
    },
    OracleCase {
        case_id: "m00384",
        operation: "DCH",
        position: "first",
        count: "large",
        wrap: "partial",
        location: "viewport",
        lines: 3,
        glyphs: "ascii",
        screen: "main",
        repetition: 1,
        payload_hex: "1b631b5b334a1b5b324a1b5b721b5b3f37681b5b313b31484142434445464748494a4b4c6d6e6f7071727374757677783031323334353637380d0a4e58540d0a454e441b5b721b5b323b31481b5b3939501b5d323b6d303033383407",
        expected_hex: "4142434445464748494a4b4c0a0a3031323334353637380a4e58540a454e440a0a0a0a",
    },
    OracleCase {
        case_id: "m03120",
        operation: "DL",
        position: "middle",
        count: "one",
        wrap: "partial",
        location: "viewport",
        lines: 3,
        glyphs: "ascii",
        screen: "main",
        repetition: 1,
        payload_hex: "1b631b5b334a1b5b324a1b5b721b5b3f37681b5b313b31484142434445464748494a4b4c6d6e6f7071727374757677783031323334353637380d0a4e58540d0a454e441b5b721b5b323b36481b5b314d1b5d323b6d303331323007",
        expected_hex: "4142434445464748494a4b4c0a3031323334353637380a4e58540a454e440a0a0a0a0a",
    },
    OracleCase {
        case_id: "m04416",
        operation: "IL",
        position: "middle",
        count: "one",
        wrap: "partial",
        location: "viewport",
        lines: 3,
        glyphs: "ascii",
        screen: "main",
        repetition: 1,
        payload_hex: "1b631b5b334a1b5b324a1b5b721b5b3f37681b5b313b31484142434445464748494a4b4c6d6e6f7071727374757677783031323334353637380d0a4e58540d0a454e441b5b721b5b323b36481b5b314c1b5d323b6d303434313607",
        expected_hex: "4142434445464748494a4b4c0a0a6d6e6f7071727374757677780a3031323334353637380a4e58540a454e440a0a0a",
    },
    OracleCase {
        case_id: "m04489",
        operation: "IL",
        position: "middle",
        count: "two",
        wrap: "exact",
        location: "viewport",
        lines: 3,
        glyphs: "ascii",
        screen: "main",
        repetition: 2,
        payload_hex: "1b631b5b334a1b5b324a1b5b721b5b3f37681b5b313b31484142434445464748494a4b4c6d6e6f7071727374757677783031323334353637383941420d0a4e58540d0a454e441b5b721b5b323b36481b5b324c1b5b324c1b5d323b6d303434383907",
        expected_hex: "4142434445464748494a4b4c0a0a0a0a0a6d6e6f7071727374757677780a3031323334353637383941420a4e58540a",
    },
    OracleCase {
        case_id: "m05712",
        operation: "RI",
        position: "middle",
        count: "one",
        wrap: "partial",
        location: "viewport",
        lines: 3,
        glyphs: "ascii",
        screen: "main",
        repetition: 1,
        payload_hex: "1b631b5b334a1b5b324a1b5b721b5b3f37681b5b313b31484142434445464748494a4b4c6d6e6f7071727374757677783031323334353637380d0a4e58540d0a454e441b5b323b38721b5b323b36481b4d1b5d323b6d303537313207",
        expected_hex: "4142434445464748494a4b4c0a0a6d6e6f7071727374757677780a3031323334353637380a4e58540a454e440a0a0a",
    },
    OracleCase {
        case_id: "m06211",
        operation: "RI",
        position: "last",
        count: "two",
        wrap: "exact",
        location: "viewport",
        lines: 2,
        glyphs: "wide",
        screen: "alternate",
        repetition: 2,
        payload_hex: "1b631b5b334a1b5b324a1b5b721b5b3f37681b5b313b31481b5b3f31303439681b5b313b3148e7958c41e5a5bd62e7958c41e5a5bd62e7958c41e5a5bd62e7958c41e5a5bd620d0a4e58540d0a454e441b5b313b38721b5b313b3132481b4d1b4d1b4d1b4d1b5d323b6d303632313107",
        expected_hex: "0a0a0a0ae7958c41e5a5bd62e7958c41e5a5bd620ae7958c41e5a5bd62e7958c41e5a5bd620a4e58540a454e440a",
    },
    OracleCase {
        case_id: "m07008",
        operation: "SD",
        position: "middle",
        count: "one",
        wrap: "partial",
        location: "viewport",
        lines: 3,
        glyphs: "ascii",
        screen: "main",
        repetition: 1,
        payload_hex: "1b631b5b334a1b5b324a1b5b721b5b3f37681b5b313b31484142434445464748494a4b4c6d6e6f7071727374757677783031323334353637380d0a4e58540d0a454e441b5b323b38721b5b323b36481b5b31541b5d323b6d303730303807",
        expected_hex: "4142434445464748494a4b4c0a0a6d6e6f7071727374757677780a3031323334353637380a4e58540a454e440a0a0a",
    },
];

fn decode_hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0, "hex input must contain byte pairs");
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = char::from(pair[0]).to_digit(16).expect("hex high nibble");
            let low = char::from(pair[1]).to_digit(16).expect("hex low nibble");
            u8::try_from((high << 4) | low).expect("decoded hex byte")
        })
        .collect()
}

fn capture_range(case: OracleCase) -> ScreenCaptureRange {
    if case.location == "history" {
        ScreenCaptureRange {
            start_is_absolute: true,
            end_is_absolute: true,
            ..ScreenCaptureRange::default()
        }
    } else {
        ScreenCaptureRange::default()
    }
}

fn joined_options() -> GridRenderOptions {
    GridRenderOptions {
        join_wrapped: true,
        include_empty_cells: false,
        trim_spaces: false,
        ..GridRenderOptions::default()
    }
}

fn parsed_screen(case: OracleCase) -> Screen {
    let mut screen = Screen::new(TerminalSize { cols: 12, rows: 8 }, 2_000);
    let mut parser = InputParser::new();
    parser.parse(&decode_hex(case.payload_hex), &mut screen);
    screen
}

fn axis_values<'a>(
    cases: impl Iterator<Item = &'a OracleCase>,
    value: impl Fn(&'a OracleCase) -> &'static str,
) -> BTreeSet<&'static str> {
    cases.map(value).collect()
}

#[test]
fn wrapped_mutation_matrix_matches_tmux_3_7b() {
    assert_eq!(
        axis_values(ORACLE_CASES.iter(), |case| case.operation),
        BTreeSet::from(["DCH", "DL", "IL", "RI", "SD"])
    );
    assert_eq!(
        axis_values(ORACLE_CASES.iter(), |case| case.position),
        BTreeSet::from(["first", "last", "middle"])
    );
    assert_eq!(
        axis_values(ORACLE_CASES.iter(), |case| case.count),
        BTreeSet::from(["large", "one", "two"])
    );
    assert_eq!(
        axis_values(ORACLE_CASES.iter(), |case| case.wrap),
        BTreeSet::from(["exact", "partial"])
    );
    assert_eq!(
        axis_values(ORACLE_CASES.iter(), |case| case.location),
        BTreeSet::from(["history", "viewport"])
    );
    assert_eq!(
        ORACLE_CASES
            .iter()
            .map(|case| case.lines)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([1, 2, 3])
    );
    assert_eq!(
        axis_values(ORACLE_CASES.iter(), |case| case.glyphs),
        BTreeSet::from(["ascii", "combining", "wide"])
    );
    assert_eq!(
        axis_values(ORACLE_CASES.iter(), |case| case.screen),
        BTreeSet::from(["alternate", "main"])
    );
    assert_eq!(
        ORACLE_CASES
            .iter()
            .map(|case| case.repetition)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([1, 2])
    );

    for &case in ORACLE_CASES {
        let screen = parsed_screen(case);
        let range = capture_range(case);
        let expected = decode_hex(case.expected_hex);
        let raw = screen.capture_transcript(range, GridRenderOptions::default());
        let joined = screen.capture_transcript(range, joined_options());

        assert_eq!(raw, expected, "{}: raw capture", case.case_id);
        assert_eq!(joined, expected, "{}: joined capture", case.case_id);
    }
}

#[test]
fn il_bulk_insert_preserves_existing_tmux_3_7b_wrap_m04044() {
    let payload = decode_hex(
        "1b631b5b334a1b5b324a1b5b721b5b3f37681b5b313b31484142434445464748\
         494a4b4c6d6e6f7071727374757677780d0a4e58540d0a454e441b5b721b5b31\
         3b31481b5b324c1b5d323b6d303430343407",
    );
    let expected_raw = decode_hex(
        "0a0a4142434445464748494a4b4c0a6d6e6f7071727374757677780a4e58540a\
         454e440a0a0a",
    );
    let expected_joined = decode_hex(
        "0a0a4142434445464748494a4b4c6d6e6f7071727374757677780a4e58540a45\
         4e440a0a0a",
    );
    let mut screen = Screen::new(TerminalSize { cols: 12, rows: 8 }, 2_000);
    let mut parser = InputParser::new();
    parser.parse(&payload, &mut screen);

    assert_eq!(
        screen.capture_transcript(ScreenCaptureRange::default(), GridRenderOptions::default()),
        expected_raw,
        "m04044: raw capture"
    );
    let joined = screen.capture_transcript(ScreenCaptureRange::default(), joined_options());
    assert_eq!(joined, expected_joined, "m04044: joined capture");
    assert_eq!(
        awk_like_nonempty_fields(&joined),
        "3:ABCDEFGHIJKLmnopqrstuvwx|NXT|END",
        "m04044: copy-buffer consumer fields"
    );
}

fn awk_like_nonempty_fields(capture: &[u8]) -> String {
    let fields = capture
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| String::from_utf8(line.to_vec()).expect("capture field must be UTF-8"))
        .collect::<Vec<_>>();
    format!("{}:{}", fields.len(), fields.join("|"))
}

#[test]
fn wrapped_mutation_consumer_keeps_tmux_3_7b_fields() {
    let expected = [
        ("m00384", "4:ABCDEFGHIJKL|012345678|NXT|END"),
        ("m03120", "4:ABCDEFGHIJKL|012345678|NXT|END"),
        ("m04416", "5:ABCDEFGHIJKL|mnopqrstuvwx|012345678|NXT|END"),
        ("m04489", "4:ABCDEFGHIJKL|mnopqrstuvwx|0123456789AB|NXT"),
        ("m05712", "5:ABCDEFGHIJKL|mnopqrstuvwx|012345678|NXT|END"),
        ("m07008", "5:ABCDEFGHIJKL|mnopqrstuvwx|012345678|NXT|END"),
    ];

    for (case_id, expected_fields) in expected {
        let case = ORACLE_CASES
            .iter()
            .copied()
            .find(|case| case.case_id == case_id)
            .expect("consumer case must be in the oracle matrix");
        let capture = parsed_screen(case).capture_transcript(capture_range(case), joined_options());
        assert_eq!(
            awk_like_nonempty_fields(&capture),
            expected_fields,
            "{case_id}: copy-buffer consumer fields"
        );
    }
}
