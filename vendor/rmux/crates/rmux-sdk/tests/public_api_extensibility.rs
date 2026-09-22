use std::path::Path;

#[test]
fn public_projection_records_reject_downstream_struct_literals() {
    compile_fail::assert_compile_fail_cases(
        "rmux-sdk",
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &[
            compile_fail::CompileFailCase::struct_literal(
                "pane_recovery_coverage",
                r#"
use rmux_sdk::events::PaneRecoveryCoverage;

fn construct() -> PaneRecoveryCoverage {
    PaneRecoveryCoverage {
        history_rows_total: 0,
        history_rows_included: 0,
        metadata_complete: true,
    }
}

fn main() {}
"#,
            ),
            compile_fail::CompileFailCase::struct_literal(
                "pane_recovery_rebase",
                r#"
use rmux_sdk::events::PaneRecoveryCoverage;
use rmux_sdk::{PaneRecoveryRebase, PaneRecoveryRebaseReason, PaneSnapshot};

fn construct(
    coverage: PaneRecoveryCoverage,
    snapshot: Option<PaneSnapshot>,
    reason: PaneRecoveryRebaseReason,
) -> PaneRecoveryRebase {
    PaneRecoveryRebase {
        epoch: 1,
        generation: 1,
        invalidation_revision: 1,
        next_sequence: 1,
        cols: 80,
        rows: 24,
        keyframe: Vec::new(),
        alternate: false,
        coverage,
        snapshot,
        reason,
    }
}

fn main() {}
"#,
            ),
            compile_fail::CompileFailCase::struct_literal(
                "pane_surface_snapshot",
                r#"
use rmux_sdk::{PaneSnapshot, PaneSurfaceDynamicColors, PaneSurfaceSnapshot};

fn construct(
    grid: PaneSnapshot,
    dynamic_colors: PaneSurfaceDynamicColors,
) -> PaneSurfaceSnapshot {
    PaneSurfaceSnapshot {
        grid,
        cell_hyperlink_ids: Vec::new(),
        title: String::new(),
        path: String::new(),
        hyperlinks: Default::default(),
        dynamic_colors,
        metadata_complete: true,
        mode_bits: 0,
        alternate: false,
        scroll_top: 0,
        scroll_bottom: 0,
        history_size: 0,
        history_bytes: 0,
    }
}

fn main() {}
"#,
            ),
            compile_fail::CompileFailCase::struct_literal(
                "pane_surface_dynamic_colors",
                r#"
use rmux_sdk::PaneSurfaceDynamicColors;

fn construct() -> PaneSurfaceDynamicColors {
    PaneSurfaceDynamicColors {
        foreground: None,
        background: None,
        cursor: None,
    }
}

fn main() {}
"#,
            ),
            compile_fail::CompileFailCase::struct_literal(
                "pane_surface_frame",
                r#"
use rmux_sdk::{PaneSurfaceFrame, PaneSurfaceSnapshot};

fn construct(snapshot: PaneSurfaceSnapshot) -> PaneSurfaceFrame {
    PaneSurfaceFrame {
        epoch: 1,
        revision: 1,
        next_output_sequence: 1,
        snapshot,
    }
}

fn main() {}
"#,
            ),
        ],
    );
}

#[path = "../../../tests/support/public_api_compile_fail.rs"]
mod compile_fail;
