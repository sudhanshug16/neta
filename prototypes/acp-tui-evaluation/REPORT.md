# Rust ACP TUI source and execution evaluation

Evaluated 2026-09-10. No production or vendor files changed; no commits. Public repositories cloned in `/private/tmp/neta-acp-eval`.

## Decision

Adapt **selected modules from Bitrouter main**, pinned to `23cc164452fe844b04919aeb93e05a83286d775c`. Its schema-only `bitrouter-tui` crate supplies a tested retained ACP journal, markdown/tool/diff rendering, Unicode composer and pure action/effect state machines. Keep Neta's terminal/event ownership, host routing, session ownership, input encoder and OSC52 handling. Write a small Neta-owned pane adapter around the public line renderers.

Do **not** wholesale embed either application. Neither implements the missing pane-scoped mouse text selection or proves SSH clipboard behavior. These remain explicit Neta work, even though rendering and editing reuse worked in the executable experiment.

Cyril is a useful design reference for Frame/Rect widget boundaries, approval UI, and session status, but its broad Kiro-focused state and core dependency make it the weaker extraction candidate. The Bitrouter published 0.33 interface is materially different from main and should not be chosen based on current-main documentation.

## Exact source comparison

| Concern | Bitrouter v0.33.0 | Bitrouter main | Cyril main |
|---|---|---|---|
| Commit | `e213d7fa9e401ecf84f7c2a98cf58b44d4061506` | `23cc164452fe844b04919aeb93e05a83286d775c` | `ab65e7a31ae7a84054f998ad056db65e1b12ef11` |
| Version | Tag v0.33.0 | 1.0.0-alpha.30 | 0.2.0-alpha.1 |
| License | Apache-2.0 | Apache-2.0 | MIT |
| Public embedding seam | `TuiConfig`, `TuiError`, `run`; rendering/input/app modules private | Public `journal`, `editor`, `render`, `machine`, `code`, `permission`, etc. | `cyril-ui` public widgets, traits and state |
| Dependency coupling | bitrouter-core/config/providers with ACP | ACP schema1.7 only; Ratatui0.29, Crossterm0.28 | cyril-core, ACP2 conductor, Tokio/process, bundled SQLite; Ratatui0.30/Crossterm0.29 |
| Rect composition | `run` owns raw mode, alternate screen and event loop | `render::message`, Registry tools, plan/markdown return Lines; View/CodeView own terminal, private drawing | `widgets::chat::render(Frame, Rect, dyn TuiState, Theme)` directly available |
| State boundary | Own application/session manager | Journal consumes ACP SessionUpdate; reducer produces effects, no network | TuiState requires messages plus Kiro effort, memory, context, subagents, voice/hooks/code panels and more |
| Selection/copy | Explicitly disables mouse capture for terminal-native selection | Explicit Copy{text} effect, caller implements clipboard; no pane drag selection | Ctrl+M disables mouse capture for copy mode; event handler wheel only, other mouse events ignored |
| Remote ACP | Application/provider integration | Renderer transport-independent; SDK transport says stdio-only, local spawned child | Default process transport spawns agent; Kiro-focused runtime, no demonstrated Neta host attachment |
| Cancel/steer | Application behavior, not extracted | Pure Cancel effect and process-local next-turn queue; Node must enforce cancel/wait/re-prompt same session | Queue-steer paths depend on Kiro capability and private bridge commands; cannot substitute for Neta steering |
| Permissions | Application-owned | Data Prompt + ResolvePermission effect; no resolver/network in renderer | Approval queue/responder + core mediation; broad runtime coupling |
| Sessions | Own session lifecycle | Caller sets session active/reset/selectors and handles OpenSession effect | Own session/controller/workbench persistence; not Node ownership |

Source anchors:

- [0.33 public exports and terminal ownership](https://github.com/bitrouter/bitrouter/blob/e213d7fa9e401ecf84f7c2a98cf58b44d4061506/bitrouter-tui/src/lib.rs)
- [Main crate boundary: generic charter retired, schema rendering retained](https://github.com/bitrouter/bitrouter/blob/23cc164452fe844b04919aeb93e05a83286d775c/crates/bitrouter-tui/src/lib.rs)
- [Main retained journal](https://github.com/bitrouter/bitrouter/blob/23cc164452fe844b04919aeb93e05a83286d775c/crates/bitrouter-tui/src/journal.rs)
- [Main line-renderer interface](https://github.com/bitrouter/bitrouter/blob/23cc164452fe844b04919aeb93e05a83286d775c/crates/bitrouter-tui/src/render/mod.rs)
- [Main effects, composer, sessions and private drawing](https://github.com/bitrouter/bitrouter/blob/23cc164452fe844b04919aeb93e05a83286d775c/crates/bitrouter-tui/src/code.rs)
- [Cyril chat Rect widget](https://github.com/dwalleck/cyril/blob/ab65e7a31ae7a84054f998ad056db65e1b12ef11/crates/cyril-ui/src/widgets/chat.rs)
- [Cyril broad TuiState interface](https://github.com/dwalleck/cyril/blob/ab65e7a31ae7a84054f998ad056db65e1b12ef11/crates/cyril-ui/src/traits.rs)
- [Cyril input, mouse and Kiro steering dispatch](https://github.com/dwalleck/cyril/blob/ab65e7a31ae7a84054f998ad056db65e1b12ef11/crates/cyril/src/app.rs)

## Executed evidence

1. `cargo test -p bitrouter-tui --lib --locked`: **207 passed, 0 failed**. Uses exact main repository lockfile. Initial system Rust1.89 rejected the crate's Rust1.93 minimum. Existing complete Rust1.96.1 toolchain resolved the blocker. An initial attempt with the extracted compiler alone failed because its standard-library sysroot was missing; the complete installation worked. No upstream source was patched.
2. Neta's actual `test/fixtures/fake-acp-agent.mjs` was spawned over JSON-RPC stdio with no provider credentials. Initialize/new then four prompts (`STREAM`, `DIFF`, `THINK`, `EDIT`) produced **10 session updates**; edit permission was answered `cancelled`. Fixture session `s1` completed successfully. A tiny Python capture driver performed transport; this does not claim Bitrouter's own ACP client was executed.
3. A standalone Rust harness consumed those exact updates via `SessionUpdate` deserialization and `Journal::apply`, retaining **7 entries**. The public Bitrouter message/tool/plan renderers rendered into a right-hand Rect starting at x=20 at widths **1,2,7,20,40,80** in Ratatui TestBackend. Every cell (symbol and style) of the entire left 20×80 Rect matched its baseline at all widths; no panic. At width80, the rendered buffer also contained the expected streaming paragraph, tool title, and cancelled permission outcome. Unicode, markdown and a code fence were also fed into the pane.
4. Bitrouter Editor preserved a multiline paste and deleted a family emoji as one grapheme, then a CJK character on subsequent Backspaces. Both assertions passed.
5. Initial harness compiled and ran in **16.95 seconds** after dependencies were cached; final expanded assertions rebuilt in **0.27 seconds**. No real terminal/PTY visual run, SSH session, OS clipboard round-trip, cancel/re-prompt integration, long-history benchmark or Cyril compilation was performed. Unit-test success does not prove those untested paths.

Reproduce in this workspace with `sh prototypes/acp-tui-evaluation/run.sh` (public network dependencies and Rust≥1.93 required; override RUSTC if the recorded temporary toolchain is unavailable). The script pins the evaluated source and Cargo lockfile. Artifacts next to this report: `run.sh`, `Cargo.toml`, `Cargo.lock`, `main.rs`, `capture.py`, `updates.ndjson`, `render.txt` (TestBackend debug snapshot), `bitrouter-tests.log`, `harness.log`. The runnable temporary Cargo harness is `/private/tmp/neta-acp-eval/harness`; it path-depends on the pinned source checkout. Toolchain: `/private/tmp/neta-herdr-tools/install/rust/bin/rustc`; cache `/private/tmp/neta-rmux-cargo`; build output `/private/tmp/neta-acp-eval/target`. Temporary paths in this exploratory harness are deliberate, not a distributable integration.

## Concrete adaptation boundary

- First extraction: `editor`, `journal`, `render` and their narrowly required cost/wrap support, preserving Apache attribution. Alternatively pin the whole clean main renderer crate while using only these exports; no reason to import the Bitrouter application or SDK.
- Neta owns a per-selected-conversation projection and PaneWidget. Convert host-delivered conversation blocks/ACP updates once, call line renderers with pane width, draw with caller-owned Frame/Rect. Preserve selected exact Node session ID. Do not spawn another provider when opening the pane.
- Borrow the pure state-machine pattern or selected permission controls, but route Submit, Cancel, session/model/mode changes and permission outcomes into existing Neta host APIs. Neta's Node remains responsible for cancellation boundary and same-session steering; Bitrouter's local prompt queue must not become a second authoritative queue.
- Keep filesystem/terminal requests on the machine that owns the Node. Do not import Cyril/Bitrouter process or host IO mediators into the UI; a remote cwd is not a local path authorization.
- Implement pane-owned drag hit testing and selected transcript text extraction; dispatch copied text through Neta's existing clipboard/OSC52 route. Native terminal selection crossing both panes is not sufficient.
- Add bounded history/projection and visible-row caching before production. Both tested library Journal and the harness retain all supplied entries; Cyril's chat widget loops through committed messages and uses a u16-clamped Paragraph scroll. Neither proves Neta's long-history bounds.

This result supports a narrow renderer/editor reuse implementation, not a completed native ACP client migration.
