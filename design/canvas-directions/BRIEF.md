# Neta desktop canvas — design brief for artboard authors

Everything in this directory is a design working file. Nothing here ships as
app code. Read this whole brief before writing anything.

## What we are making

Neta is a macOS app that runs persistent agent teams inside a workspace (a Git
repo). The desktop window has ONE primary surface, the canvas, and two floating
surfaces above it: a workspace navigator (left) and the selected agent's chat
(right). The user talks to the **workspace leader**; the leader creates
**missions** (one bounded objective each, each in its own worktree); each
mission has a **mission lead** and ordinary **agents**.

The current SwiftUI canvas was rejected as "too sterile, too sparse, too
diagram-like". We are producing meaningfully different visual directions for
the canvas so the operator can pick one before any SwiftUI changes. Each
direction is one static, high-fidelity mockup of the full desktop window at a
realistic working state (NoScrubs workspace, 14 open missions, ~110 agents).

Audience: one operator choosing a direction. Tone: native, calm, long-running
macOS workspace with enough personality that agents feel present. Tasteful.
Not an admin dashboard, not a network diagram, not a novelty visualization.

## Hard rules (from the product manifesto — violating these gets the artboard rejected)

MUST
- The workspace leader is a stable, immediately recognizable focal node.
- Every open mission is on the canvas. Missions may continue beyond the
  viewport edge (the canvas pans), but none are hidden or summarized away.
- Every mission shows: a two-digit ordinal (01 = oldest open mission), its
  name, its state label, and a relative age ("2h", "3d"). The ordering must be
  understandable without opening anything: the spatial composition itself must
  make the flow of work feel temporal. A legend alone is not enough.
- Running, blocked and failed agents are always individually visible and
  clickable. Only surplus COMPLETED agents collapse: up to 8 recent completed
  agents are shown directly per mission; more go behind an explicit expander
  chip reading `+N completed`. The chip is a pill with a chevron, never a
  bubble/circle node.
- Nodes are large enough to click comfortably and show their FULL task name.
  Do not trade clickability for a decorative overview.
- A mission lead and its agents connect with simple edges that terminate at
  node anchors and stay visually subordinate to labels and status.
- Status and access never rely on color alone: always a short text label, plus
  an icon where helpful, plus the semantic color.
- The Lead / Lead++ control is compact and local to the selected leader (in the
  chat header). Describe Lead++ as "build access" in any helper text.
- The Lead++ warning after 10 active minutes is a persistent, compact strip.
- Blocked questions and merged-but-unclosed missions demand attention without
  turning the canvas into a status dashboard.

NEVER
- No global "New mission" button anywhere.
- No large permanent Lead/Lead++ mode chooser, footer, or panel.
- No Chat/Details tab bar. Details is a single action in the chat header.
- No decorative progress bars.
- No mission cards containing miniature agent lists.
- No amorphous bubbles/blobs/halos around mission clusters.
- No one-direction org-chart tree; no single line of agents.
- No perfectly symmetric radial graph.
- No job titles or roles as identity (no scout/worker/reviewer/apprentice/
  journeyman/expert/architect). An agent is described by name, task, model,
  access, and activity only.
- No emoji anywhere. Icons are inline stroke SVG.
- No counts-and-status-cards dashboard in the navigator.
- No progress-like decoration unless it measures real progress.

## Exact tokens (lifted from apps/macos/Sources/NetaDesktop/Theme.swift)

Colors
- canvas ground        #0E0F13
- panel fill           rgba(24,26,32,0.92)   (#181A20 at 92%)
- panel border         rgba(255,255,255,0.10)
- panel shadow         0 12px 28px rgba(0,0,0,0.28)
- panel radius         18px
- node card fill       rgba(20,23,25,0.96)
- node border          rgba(255,255,255,0.10); selected: 2px mint
- dot grid dots        rgba(255,255,255,0.115), 1.3px, 28px spacing
- primary text         rgba(255,255,255,0.94)
- secondary text       rgba(255,255,255,0.56)
- divider              rgba(255,255,255,0.06)
- subtle surface       rgba(255,255,255,0.045) / hover 0.07 / selected 0.075
- violet (leader)      #9985F5
- mint (running)       #73D1B8
- blue (ready / info)  #8AB3FF
- amber (blocked)      #F5AD47
- green (completed)    #7DD98C
- red (failed)         #FF6161
- agent identity hues  #52B3F2  #F28775  #C7A34F  #70CC99  #E39BC7  #7FC8D9
  (first four exist today; last two are additions in the same family)

Semantic mapping for this design (some of these states do not exist in the
Swift enum yet; that is fine, the design leads):
- Running → mint, Blocked → amber, Failed → red, Completed → green,
  Ready to close → blue, Merged · not closed → blue with a distinct label,
  Archived / Offline → secondary text grey.

Typography: the system stack only. `font-family: -apple-system,
BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`; mono:
`ui-monospace, "SF Mono", Menlo, monospace`. Existing sizes to keep: node
label 13/600, sublabel 10/500 secondary, section header 9/700 uppercase with
letter-spacing 0.08em, chat body 12.5/400, panel title 14/600, toolbar 12/600,
zoom readout 10/600 mono. Use `font-variant-numeric: tabular-nums` on ordinals,
ages, and any digits that line up.

Shell geometry: navigator 248px wide, padding 16; chat panel 410px wide; both
floating with 16px inset from the window edge; toolbar is a capsule pinned top
center with `backdrop-filter: blur(18px)`. Window is 1600×1000 with a hidden
title bar; draw three 12px traffic-light circles at (20,18) in muted
#5C5F66/#5C5F66/#5C5F66 with 1px darker ring — no red/yellow/green.

## Artboard format (Design Component)

Each artboard is one self-contained `.dc.html`:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
    body { margin: 0; background: #0E0F13; }
    a { color: #8AB3FF; } a:hover { color: #B9CFFF; }
    /* shared classes go here */
  </style>
</helmet>
<div style="position: relative; width: 1600px; height: 1000px; overflow: hidden; background: #0E0F13; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif; color: rgba(255,255,255,0.94);">
  ...
</div>
</x-dc>
</body>
</html>
```

- Keep the `<script src="./support.js"></script>` line exactly. No other
  scripts. Static artboards need NO `data-dc-script` block; do not add one.
- Canonical HTML: close every element, double-quote every attribute.
- Position, size and per-node colors go in inline `style=""` so the editor's
  property panel can edit them. Shared visual style (node anatomy, chips) may
  live in `<helmet><style>` classes.
- Icons: inline SVG, stroke-based, 12/14/16px, `stroke-width: 1.5`,
  `stroke-linecap: round`. One consistent style. Never emoji.
- Real content only. Use `dataset.json` verbatim: same missions, same agents,
  same names, same states, same activity lines in every direction.
- The root is exactly 1600×1000 with the background painted. Nothing may
  overflow the root.
- Layout siblings with flex/grid and `gap`, not margins.
- Respect `prefers-reduced-motion`; static mockups need no animation at all.

Generate the file with a small Node script (`gen-<name>.mjs`) that reads
`dataset.json` and `shell.partial.html`, computes positions, and writes the
`.dc.html`. Hand-tune afterwards if needed. Commit nothing.

## What the shell must show (identical in every direction)

Toolbar (top center capsule): `NoScrubs` workspace menu · `mac-studio` machine
menu (NoScrubs exists on two machines, so the machine selector is shown) ·
Fit · − 100% + · a chronology control specific to the direction (e.g.
"Time scale: Log" or "Oldest ← → Newest"). Nothing else. No New mission.

Navigator (left floating panel):
- Header: wordmark "Neta", subtitle "Workspaces".
- Workspaces: NoScrubs (selected), neta, fx-ledger. Small monogram squares.
- Machine: mac-studio (live dot), build-box (Offline).
- "Workspace leader" row with the leader name.
- "Mission inbox", grouped, rows read `07  Payments regression` with a trailing
  state label. Groups: Needs you (blocked questions, failed,
  merged-not-closed), Ready to close, Running. Counts are small trailing
  numbers on group headers only. All 14 open missions listed.
- "Archive" row with a trailing count (23).

Chat (right floating panel), selected = the workspace leader:
- Header: leader avatar (violet, crown glyph), name, "Workspace leader" tag,
  subtitle `Claude · claude-opus-5 · Running`, then a compact segmented
  control `Lead | Lead++` (Lead++ selected, described as build access in the
  tooltip text), a `Details` text button, and a circular Stop button.
- A persistent compact warning strip under the header:
  `Lead++ active 14 min · mission 11 Search index rebuild`.
- Transcript with 5–7 messages from `dataset.json` → `leaderTranscript`.
  User bubbles violet at 55%; agent messages on subtle surface; system lines
  10/500 centered secondary.
- Composer with the placeholder "Message the workspace leader" and a mint send
  button.
- Details is an ACTION, not a tab. Do not show an inspector open in the main
  artboards.

Density target for the canvas area: at the mockup's zoom, 7–10 missions
should be readable in the viewport with their agents, and the remaining
missions must be clearly present (continuing past the edge, receding, or in
compressed bands), never absent.
