use super::apply_layout;
use crate::{Pane, PaneGeometry};
use rmux_proto::{LayoutName, TerminalSize};

fn pane(index: u32) -> Pane {
    Pane::new(index, PaneGeometry::new(0, 0, 0, 0))
}

fn assert_tiled_layout(
    pane_count: u32,
    requested_main_width: Option<u16>,
    expected: Vec<PaneGeometry>,
) {
    let mut panes = (0..pane_count).map(pane).collect::<Vec<_>>();

    apply_layout(
        &mut panes,
        LayoutName::Tiled,
        TerminalSize { cols: 80, rows: 24 },
        requested_main_width,
    );

    assert_eq!(
        panes.iter().map(|pane| pane.geometry()).collect::<Vec<_>>(),
        expected
    );
}

#[test]
fn tiled_geometry_for_one_to_six_panes_matches_tmux_grid() {
    for (pane_count, expected) in [
        (1, vec![PaneGeometry::new(0, 0, 80, 24)]),
        (
            2,
            vec![
                PaneGeometry::new(0, 0, 80, 11),
                PaneGeometry::new(0, 12, 80, 12),
            ],
        ),
        (
            3,
            vec![
                PaneGeometry::new(0, 0, 39, 11),
                PaneGeometry::new(40, 0, 40, 11),
                PaneGeometry::new(0, 12, 80, 12),
            ],
        ),
        (
            4,
            vec![
                PaneGeometry::new(0, 0, 39, 11),
                PaneGeometry::new(40, 0, 40, 11),
                PaneGeometry::new(0, 12, 39, 12),
                PaneGeometry::new(40, 12, 40, 12),
            ],
        ),
        (
            5,
            vec![
                PaneGeometry::new(0, 0, 39, 7),
                PaneGeometry::new(40, 0, 40, 7),
                PaneGeometry::new(0, 8, 39, 7),
                PaneGeometry::new(40, 8, 40, 7),
                PaneGeometry::new(0, 16, 80, 8),
            ],
        ),
        (
            6,
            vec![
                PaneGeometry::new(0, 0, 39, 7),
                PaneGeometry::new(40, 0, 40, 7),
                PaneGeometry::new(0, 8, 39, 7),
                PaneGeometry::new(40, 8, 40, 7),
                PaneGeometry::new(0, 16, 39, 8),
                PaneGeometry::new(40, 16, 40, 8),
            ],
        ),
    ] {
        assert_tiled_layout(pane_count, None, expected);
    }
}

#[test]
fn tiled_ignores_requested_main_width() {
    assert_tiled_layout(
        4,
        Some(79),
        vec![
            PaneGeometry::new(0, 0, 39, 11),
            PaneGeometry::new(40, 0, 40, 11),
            PaneGeometry::new(0, 12, 39, 12),
            PaneGeometry::new(40, 12, 40, 12),
        ],
    );
}

#[test]
fn tiled_partial_final_row_absorbs_remaining_width_in_the_last_pane() {
    assert_tiled_layout(
        8,
        None,
        vec![
            PaneGeometry::new(0, 0, 26, 7),
            PaneGeometry::new(27, 0, 26, 7),
            PaneGeometry::new(54, 0, 26, 7),
            PaneGeometry::new(0, 8, 26, 7),
            PaneGeometry::new(27, 8, 26, 7),
            PaneGeometry::new(54, 8, 26, 7),
            PaneGeometry::new(0, 16, 26, 8),
            PaneGeometry::new(27, 16, 53, 8),
        ],
    );
}

#[test]
fn tiled_five_and_six_pane_minimum_avoids_tmux_hang_product_divergence() {
    for (pane_count, size, expected) in [
        (
            5,
            TerminalSize { cols: 9, rows: 1 },
            vec![
                PaneGeometry::new(0, 0, 4, 1),
                PaneGeometry::new(5, 0, 4, 1),
                PaneGeometry::new(0, 2, 4, 1),
                PaneGeometry::new(5, 2, 4, 1),
                PaneGeometry::new(0, 4, 9, 1),
            ],
        ),
        (
            6,
            TerminalSize { cols: 11, rows: 1 },
            vec![
                PaneGeometry::new(0, 0, 5, 1),
                PaneGeometry::new(6, 0, 5, 1),
                PaneGeometry::new(0, 2, 5, 1),
                PaneGeometry::new(6, 2, 5, 1),
                PaneGeometry::new(0, 4, 5, 1),
                PaneGeometry::new(6, 4, 5, 1),
            ],
        ),
    ] {
        let mut panes = (0..pane_count).map(pane).collect::<Vec<_>>();
        let tree = apply_layout(&mut panes, LayoutName::Tiled, size, None);

        assert_eq!(
            tree.size(),
            TerminalSize {
                cols: size.cols,
                rows: 5,
            }
        );
        assert_eq!(
            panes.iter().map(|pane| pane.geometry()).collect::<Vec<_>>(),
            expected
        );
    }
}

#[test]
fn tiled_width_deficient_rows_converge_on_first_application_product_divergence() {
    for (pane_count, size, expected) in [
        (
            3,
            TerminalSize { cols: 1, rows: 5 },
            vec![
                PaneGeometry::new(0, 0, 1, 2),
                PaneGeometry::new(2, 0, 1, 2),
                PaneGeometry::new(0, 3, 3, 2),
            ],
        ),
        (
            4,
            TerminalSize { cols: 1, rows: 7 },
            vec![
                PaneGeometry::new(0, 0, 1, 3),
                PaneGeometry::new(2, 0, 1, 3),
                PaneGeometry::new(0, 4, 1, 3),
                PaneGeometry::new(2, 4, 1, 3),
            ],
        ),
        (
            5,
            TerminalSize { cols: 1, rows: 9 },
            vec![
                PaneGeometry::new(0, 0, 1, 2),
                PaneGeometry::new(2, 0, 1, 2),
                PaneGeometry::new(0, 3, 1, 2),
                PaneGeometry::new(2, 3, 1, 2),
                PaneGeometry::new(0, 6, 3, 3),
            ],
        ),
        (
            6,
            TerminalSize { cols: 1, rows: 11 },
            vec![
                PaneGeometry::new(0, 0, 1, 3),
                PaneGeometry::new(2, 0, 1, 3),
                PaneGeometry::new(0, 4, 1, 3),
                PaneGeometry::new(2, 4, 1, 3),
                PaneGeometry::new(0, 8, 1, 3),
                PaneGeometry::new(2, 8, 1, 3),
            ],
        ),
    ] {
        let mut panes = (0..pane_count).map(pane).collect::<Vec<_>>();
        let tree = apply_layout(&mut panes, LayoutName::Tiled, size, None);

        assert_eq!(
            tree.size(),
            TerminalSize {
                cols: 3,
                rows: size.rows,
            }
        );
        assert_eq!(
            panes.iter().map(|pane| pane.geometry()).collect::<Vec<_>>(),
            expected
        );
        assert!(
            tree.root.check(),
            "width-deficient tiled rows must remain structurally coherent"
        );
    }
}
