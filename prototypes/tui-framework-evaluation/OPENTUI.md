# OpenTUI evaluation

Verdict: strong toolkit candidate for a new local chat pane; not a ready ACP chat client. It supplies text editing, selection, clipboard dispatch, streamed Markdown and scrolling primitives. Neta still implements its conversation/block mapping, permissions, reconnect/history loading, pane policy and bounded transcript materialization. This evaluation does not endorse replacing the current surface yet.

Evaluated published `@opentui/core@0.5.11` with its prebuilt Darwin native library on Bun 1.4.2. Inspected upstream commit `ac753b48d386707a931dcf881d0741905b64b4f9`. No Zig compilation, provider traffic, production dependency changes or commits.

## Executed evidence

Isolated test: `/private/tmp/neta-opentui-eval/smoke.test.ts`; portable copy and exact package/lock are in `opentui/` beside this report. Run `bun install --frozen-lockfile` then `bun test smoke.test.ts` in an isolated copy of that directory. Result: **1 pass, 9 assertions**, approximately 226 ms overall on this machine. Native render/test utilities actually executed.

- Mouse drag selects `Hello`; `renderer.getSelection()?.getSelectedText()` returns it.
- Default selection is **not pane bounded**. Actual mock mouse drag from chat into a selectable spine produces `E PRIVATEHello `. The selection container expands to its ancestor on exit. Setting spine text's public `selectable=false` then dragging across panes excludes `PRIVATE` (asserted). This prevents sidebar text contamination but does not establish a hard geometric drag boundary or fully test wrapped, nested, long-history selection.
- Textarea Backspace at the beginning of line two joins `abc\ndef` into `abcdef`; bracketed multiline paste then produces `abcX\nYdef`.
- Markdown receives incomplete `**stream`, then completed bold/list text, with `streaming=true`, then `false`; rendered frame contains completed text. Code fence highlighting, tables and complex deltas were not tested here.
- ScrollBox's actual API is `stickyScroll:true, stickyStart:'bottom'` (not `stickToBottom`). Thirty rows in a five-line viewport start at offset 25. Manually setting offset 2, then appending a row, leaves offset 2. Source separately handles reengaging when the user returns to the sticky edge. Wheel/trackpad inertia and resume-at-bottom are not independently asserted here.
- All 31 row children remain mounted. Viewport culling avoids rendering invisible children; it is **not transcript virtualization** or bounded history hydration. Neta must page/window data and manage selection/history behavior across that window.
- `copyToClipboardOSC52` returns `true` under the headless renderer. This proves local native dispatch accepts the call, **not** clipboard contents, real terminal acceptance or SSH end-to-end behavior. The current clipboard API also exposes host operations and explicit terminal-only/host-only/best-available destinations.

## Runtime and packaging

The current version is no longer Bun-only: package engines declare Bun >=1.3.0 and Node >=26.4.0, and source has a `node:ffi` backend. Importing on this machine's Node 22.16.0 succeeds, but creating the test renderer fails: `OpenTUI native FFI is not available for this runtime yet`.

Neta currently declares Node >=22 and publishes a `bun build --target=node` CLI bundle. OpenTUI therefore is **not a drop-in dependency for the current supported runtime**. A separate Bun executable/runtime, or a raised Node floor plus native library/parser asset packaging, requires a deliberate shipping decision. The package ships optional native binaries for Darwin/Linux/Windows architectures (including Linux musl); this evaluation only ran Darwin. Node 26.4 support is source/package evidence, not locally executed validation. No single-file production packaging experiment was performed.

## Framework versus application

OpenTUI core is a rendering framework; the tested API does not provide an ACP connection, session lifecycle or agent chat semantics. OpenCode's use of OpenTUI is evidence of an application built on it, not evidence that core includes OpenCode's chat. Reusing OpenCode's application/server engine is a separate integration decision and was not tested in this bounded evaluation.

## Primary source pointers

All links pin the inspected source revision:

- [Package exports, engines and native packages](https://github.com/anomalyco/opentui/blob/ac753b48d386707a931dcf881d0741905b64b4f9/packages/core/package.json)
- [Renderer selection container expansion and clipboard facade](https://github.com/anomalyco/opentui/blob/ac753b48d386707a931dcf881d0741905b64b4f9/packages/core/src/renderer.ts#L4948)
- [Selection extraction](https://github.com/anomalyco/opentui/blob/ac753b48d386707a931dcf881d0741905b64b4f9/packages/core/src/lib/selection.ts)
- [Clipboard destinations and dispatch semantics](https://github.com/anomalyco/opentui/blob/ac753b48d386707a931dcf881d0741905b64b4f9/packages/core/src/lib/clipboard.ts)
- [Textarea default keybindings](https://github.com/anomalyco/opentui/blob/ac753b48d386707a931dcf881d0741905b64b4f9/packages/core/src/renderables/Textarea.ts#L89)
- [Markdown streaming contract](https://github.com/anomalyco/opentui/blob/ac753b48d386707a931dcf881d0741905b64b4f9/packages/core/src/renderables/Markdown.ts#L98)
- [ScrollBox culling, sticky behavior and manual scrolling](https://github.com/anomalyco/opentui/blob/ac753b48d386707a931dcf881d0741905b64b4f9/packages/core/src/renderables/ScrollBox.ts)
- [Headless renderer/input/frame utilities](https://github.com/anomalyco/opentui/blob/ac753b48d386707a931dcf881d0741905b64b4f9/packages/core/src/testing/test-renderer.ts)
- [Bun/Node FFI runtime](https://github.com/anomalyco/opentui/blob/ac753b48d386707a931dcf881d0741905b64b4f9/packages/core/src/platform/ffi.ts)
