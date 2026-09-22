# OpenCode TUI alignment

Updated 2026-09-18. [Paper reference](https://app.paper.design/file/01M1K20ESBBP7B72D2G9FGVBB6/2-0).

The five screens cover the mission spine, workspace switching, archived conversations, command discovery, and reset scope. Neta owns navigation and orchestration; OpenCode owns the live transcript, composer, model/provider controls, command palette, and dialogs.

## Implemented contract

- A shared workspace header, machine spine, selected agent tabs, mission breadcrumb, and command hints surround native OpenCode chat.
- Mission timestamps and tree branches occupy fixed columns. Mission rows expand to reveal agents; selected actors have both a named state and a selection highlight.
- Running counts include the workspace leader. Attention counts deduplicate agents and delivery failures within a mission.
- The spine uses 24% of terminal width, bounded to 30–42 columns, and hides below 95 columns. `/tabs`, `/workspace`, `/machines`, and `/archive` remain available in compact terminals.
- Native chat measures its allocated pane rather than the whole terminal; global dialogs retain the full terminal viewport.
- `/archive` exposes closed missions. Opening saved output does not attach, resume, or start a provider. History is read from Neta's stored blocks, with older pages loaded on request and no composer.
- `/reset` retains the existing explicit chat-only and workspace reset choices. Workspace reset archives missions and stops workers; chat reset preserves them.

## Terminal adaptations reflected in Paper

- Native OpenCode pickers and slash completion provide the commands; the design is not a second custom command implementation.
- Neta defaults to its own Paper-derived theme: exact graphite surfaces, amber selection, muted text and dividers. An explicitly selected custom theme remains an override. Terminal cells and the terminal's font determine type metrics; Paper pixels are translated into cell spacing.
- Saved history is a transcript of recorded blocks, not a complete replay of interactive provider tools. Archive reopen/export actions are omitted.
- Machine context describes the selected connection, not live health checks for every saved host.
- Compact terminals use pickers instead of squeezing a full spine beside chat.

## Validation

Focused tests cover activity counts, column breakpoints, nested viewport sizing, shared resize-listener cleanup, and archive reads without provider operations. The native fake-provider integration test exercises commands, reset, workspace switching, and resizing between 140×44 and 80×32. Required conformance repeats native integration against the staged binary and a packed installation without the sibling checkout or Bun on PATH.

## Visual verification, corrected

The earlier monochrome capture was not visual parity evidence. The current E2E captures ANSI with truecolor enabled, exercises a populated mission spine through a fixture RPC proxy, and renders the production TUI (including real native OpenCode chat against a local fake model).

The fixture covers a selected mission lead, a queued worker, a blocked mission, running work, merged work awaiting closeout, archived history, reset, workspace switching, and narrow terminals. No fixture actor sends a real provider request. The proxy substitutes navigation records only; it does not reproduce the UI in test code.

`NETA_REQUIRED_CONFORMANCE=1 NETA_TUI_SMOKE=1 NETA_TUI_CAPTURE_DIR=/tmp/neta-parity bun test test/opencode-v2-native.test.ts` produces ANSI captures. `python3 scripts/render-tui-capture.py /tmp/neta-parity/*.ansi` (Pillow required) preserves foreground, background, bold and reverse-video into PNG and cell JSON. This is a rendering of captured terminal cells, not a Ghostty screenshot; the terminal user's font can differ.

E2E assertions check brackets, RGB values, row-column alignment, sibling connectors, archive selection, native prompt behavior, and absence of the previously leaked project-plugin failure. Focused theme tests check dialog colors separately from chat colors. Required conformance runs the populated captures against both source and the bundled executable.

See [PARITY.md](PARITY.md) for the element checklist and deliberate native-control adaptations.
