use super::Screen;
use crate::grid::GridLineFlags;
use crate::input::InputParser;
use crate::{GridRenderOptions, ScreenCaptureRange};
use rmux_proto::TerminalSize;

const SIZE: TerminalSize = TerminalSize { cols: 8, rows: 6 };

fn screen_with(bytes: &[u8]) -> Screen {
    screen_with_size(bytes, SIZE)
}

fn screen_with_size(bytes: &[u8], size: TerminalSize) -> Screen {
    let mut screen = Screen::new(size, 100);
    let mut parser = InputParser::new();
    parser.parse(bytes, &mut screen);
    screen
}

fn wrapped(screen: &Screen, row: u32) -> bool {
    screen
        .grid()
        .visible_line(row)
        .expect("visible row")
        .flags()
        .contains(GridLineFlags::WRAPPED)
}

fn transcript(screen: &Screen, join_wrapped: bool) -> Vec<u8> {
    screen.capture_transcript(
        ScreenCaptureRange {
            start_is_absolute: true,
            end_is_absolute: true,
            ..ScreenCaptureRange::default()
        },
        GridRenderOptions {
            join_wrapped,
            ..GridRenderOptions::default()
        },
    )
}

#[test]
fn partial_erase_preserves_both_soft_wrap_boundaries() {
    let screen = screen_with(b"abcdefghijklmnopqrst\x1b[2;2H\x1b[X\x1b[4;1HNEXT");

    assert!(wrapped(&screen, 0));
    assert!(wrapped(&screen, 1));
    assert!(!wrapped(&screen, 2));
    assert_eq!(
        transcript(&screen, false),
        b"abcdefgh\ni klmnop\nqrst\nNEXT\n\n\n"
    );
    assert_eq!(
        transcript(&screen, true),
        b"abcdefghi klmnopqrst\nNEXT\n\n\n"
    );
}

#[test]
fn complete_erase_breaks_both_soft_wrap_boundaries() {
    let screen = screen_with(b"abcdefghijklmnopqrst\x1b[2;1H\x1b[2K\x1b[4;1HNEXT");

    assert!(!wrapped(&screen, 0));
    assert!(!wrapped(&screen, 1));
    assert!(!wrapped(&screen, 2));
    let expected = b"abcdefgh\n\nqrst\nNEXT\n\n\n";
    assert_eq!(transcript(&screen, false), expected);
    assert_eq!(transcript(&screen, true), expected);
}

#[test]
fn erase_entry_paths_update_only_the_boundaries_they_clear() {
    for erase in [
        b"\x1b[2;1H\x1b[8X".as_slice(),
        b"\x1b[2;1H\x1b[K".as_slice(),
        b"\x1b[2;8H\x1b[1K".as_slice(),
        b"\x1b[2;4H\x1b[2K".as_slice(),
    ] {
        let mut input = b"abcdefghijklmnopqrst".to_vec();
        input.extend_from_slice(erase);
        let screen = screen_with(&input);
        assert_eq!(
            [wrapped(&screen, 0), wrapped(&screen, 1)],
            [false, false],
            "full-width erase sequence {erase:?}"
        );
    }

    let erase_to_display_end = screen_with(b"abcdefghijklmnopqrst\x1b[2;3H\x1b[J");
    assert_eq!(
        [
            wrapped(&erase_to_display_end, 0),
            wrapped(&erase_to_display_end, 1),
        ],
        [true, false]
    );

    let erase_from_display_start = screen_with(b"abcdefghijklmnopqrst\x1b[2;5H\x1b[1J");
    assert_eq!(
        [
            wrapped(&erase_from_display_start, 0),
            wrapped(&erase_from_display_start, 1),
        ],
        [false, true]
    );
}

#[test]
fn complete_erase_breaks_wrap_across_history_viewport_boundary() {
    let screen = screen_with_size(
        b"abcdefghijkl\r\n\x1b[1;1H\x1b[2K\x1b[2;1HNEXT",
        TerminalSize { cols: 8, rows: 2 },
    );

    assert_eq!(screen.history_size(), 1);
    assert!(!screen
        .grid()
        .absolute_line_wrapped(0)
        .expect("history row wrap flag"));
    let expected = b"abcdefgh\n\nNEXT\n";
    assert_eq!(transcript(&screen, false), expected);
    assert_eq!(transcript(&screen, true), expected);
}

#[test]
fn complete_erase_boundary_survives_reflow_and_resize() {
    let mut screen = screen_with(b"abcdefghijklmnopqrst\x1b[2;1H\x1b[2K\x1b[4;1HNEXT");

    let initial = b"abcdefgh\n\nqrst\nNEXT\n\n\n";
    assert_eq!(transcript(&screen, false), initial);
    assert_eq!(transcript(&screen, true), initial);

    screen.resize(TerminalSize { cols: 5, rows: 6 });
    assert_eq!(transcript(&screen, true), initial);

    screen.resize(SIZE);
    assert_eq!(transcript(&screen, false), initial);
    assert_eq!(transcript(&screen, true), initial);
}

#[test]
fn complete_erase_boundary_is_preserved_on_alternate_screen() {
    let screen = screen_with(b"MAIN\x1b[?1049h\x1b[Habcdefghijkl\x1b[2;1H\x1b[2K\x1b[3;1HNEXT");

    let expected = b"abcdefgh\n\nNEXT\n\n\n\n";
    assert!(screen.is_alternate());
    assert_eq!(transcript(&screen, false), expected);
    assert_eq!(transcript(&screen, true), expected);
    assert_eq!(
        screen
            .capture_saved_transcript(
                ScreenCaptureRange {
                    start_is_absolute: true,
                    end_is_absolute: true,
                    ..ScreenCaptureRange::default()
                },
                GridRenderOptions::default(),
            )
            .expect("saved main screen"),
        b"MAIN\n\n\n\n\n\n"
    );
}
