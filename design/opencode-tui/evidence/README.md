# Reviewed terminal captures

Captured 2026-09-18 from the production TUI in the staged darwin-arm64 executable, using a local fake model. Mission navigation and saved archive records come from the visual RPC fixture. These are terminal-cell renders preserving 24-bit foreground/background colors, bold and reverse video; they are not Ghostty screenshots. Menlo supplies the image glyphs.

- [Mission spine](mission.png): 170 × 45, populated navigation, native chat.
- [Archive](archive.png): recorded dates, disposition, selected saved actor, no composer.
- [Workspace picker](workspaces.png): paths, activity counts, selection and machine context.
- [Reset](reset.png): both choices with complete descriptions.
- [Native command palette](commands.png) and [Neta search](commands-neta.png).
- [Compact terminal](live-narrow.png): 80 × 32, usable chat and commands.

Each image has a same-named `.ansi` source. Regenerate with `python3 scripts/render-tui-capture.py design/opencode-tui/evidence/*.ansi` (Pillow required).

Validation: the alignment pass completed 312 conformance tests, zero failures or skips, including source integration, staged native integration, and packed cold-start/reopen without Bun or the sibling checkout. Both Neta and TUI typechecks passed. After removing the header wordmark, the local bundle and pinned fork overlay were rebuilt and the staged native E2E passed again (85 assertions); these captures reflect that follow-up. E2E checks include emitted RGB values, brackets, fixed columns, archive metadata, resize behavior and command navigation.

Font metrics and native transcript/control layout remain terminal/OpenCode adaptations described in [the parity checklist](../PARITY.md).
