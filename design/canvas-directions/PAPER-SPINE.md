# Paper build spec — Neta desktop, Spine canvas (selected direction)

Build this in Paper Desktop as new artboards in the file the user has open.
Read BRIEF.md in this directory for the exact color and type tokens and the
hard MUST/NEVER rules (they still apply). Read MANIFESTO.md sections "Canvas",
"Desktop information architecture", and "The mission inbox" for the product
decisions this screen must show. Use dataset.json for every mission, agent,
name, task, state and activity line. Do not invent agents.

## Artboard 1 — "Neta · Spine" — 1600 × 1000, background #0E0F13

What is different from the earlier Spine mockup (Main.dc.html):

1. **No navigator.** It is an auto-hiding overlay and is hidden here. The
   canvas runs from the left window edge. Draw the three traffic lights at
   (20,18) in muted grey.
2. **Permanent mission numbers.** Replace ordinals 01–14 with `#298`–`#311`
   in the same order (01 → #298, 14 → #311). No oldest/newest legend.
3. **Closed missions stay on the spine.** Add three closed missions to the
   far left, older than #298, shown as a faded lead node only (55% opacity),
   no agents: `#291 Password reset rate limits · Merged · closed 12d`,
   `#294 Docs site build cache · Abandoned · closed 11d`,
   `#296 Slack digest bot · Merged · closed 10d`.
4. **Fading.** Ready-to-close missions (#301, #305) render at 70% opacity.
   Blocked (#299, #309) and Failed (#306) stay at full emphasis regardless of
   position. Running missions full emphasis.
5. **Mission bar** along the bottom: a 56px reserved strip, full width,
   background rgba(24,26,32,0.92), 1px top border rgba(255,255,255,0.10).
   Left to right: the leader button (28px violet avatar with crown, `Halden`,
   `LEAD++` chip), then the **Now** control in its lit state (mint dot + `Now`
   in a subtle pill), a 1px divider, then mission chips. Waiting missions
   first, each with sigil, number, short name, and an attention mark:
   `#299 Stripe webhook retries · Blocked` (amber), `#309 Refund flow edge
   cases · Blocked` (amber), `#306 Audit log export · Failed` (red), `#301
   Onboarding email copy · Ready to close` (blue), `#305 Remove legacy feature
   flags · Ready to close` (blue), `#298 Payments regression · Merged, not
   closed` (blue). Then the running missions compact: sigil + number only
   (`#300`, `#302`, `#303`, `#304`, `#307`, `#308`, `#310`, `#311`) with a
   mint dot. No counts, no cards, no status tiles. The bar never hosts the
   Lead/Lead++ control.
6. **Toolbar** (top-center capsule, backdrop blur): `NoScrubs ▾` ·
   `mac-studio ▾` · `Fit` · `−  100%  +`. Zoom is time zoom; nothing else in
   the toolbar. No Now here (it lives in the bar). No New mission.
7. **Chat** floats on the right: 410 wide, top 48, bottom 72 (clear of the
   mission bar), 16 from the right edge. Leader selected. Header: avatar,
   `Halden` with `WORKSPACE LEADER` tag, subtitle `Claude · claude-opus-5 ·
   Running`, compact `Lead | Lead++` segmented control (Lead++ selected),
   `Details` text button, round Stop button. Under it the persistent strip
   `Lead++ active 14 min · #308 Search index rebuild`. Then the six messages
   from dataset.json `leaderTranscript`, then the composer "Message the
   workspace leader" with a mint send button.
8. **Spine** at y = 520, from x = 40 to the leader at x ≈ 1000–1150 (leader
   card sits just left of the chat panel, vertically centred on the spine).
   1px line rgba(255,255,255,0.14) with a 2px violet line at 6% beneath.
   Tick labels under the spine in 10px mono secondary: `now`, `1h`, `3h`,
   `12h`, `1d`, `3d`, `1w`, `2w`. Lens scale: the last day gets about half
   the width; a week is compressed; the three closed missions sit in the
   last 200px on the left.
9. **Missions** anchor to the spine at their start time with an 8px dot in
   the state color. Lead cards alternate above/below the spine (~90px away),
   connected to the anchor by a short vertical edge (amber dashed for
   Blocked). Agents stack away from the spine beneath their lead as row nodes
   (sigil · name · task · state · access glyph, running rows add the mono
   activity line), joined by a thin trunk edge with 6px stubs. Live agents
   first, then up to 8 completed, then the `+N completed` chip (pill with
   chevron, never a circle). Stacks may run off the top or bottom edge. Lead
   cards must not overlap each other. #308 is led by Halden: header
   `#308 · led by Halden`, violet edge to the leader card.
10. **Checkpoints on the spine**, each a 14px stroke icon sitting on the
    axis, distinct per type, with a 10px label beneath for the two most
    recent and a coalesced count chip for older ones:
    - 14m ago: Lead++ change (bolt icon, violet) label `Lead++ · #308`
    - 2h ago: merge into main (merge icon, blue) label `Merged #298 → main`
    - 3h ago: pinned message (diamond, primary text color), no label
    - 19h ago: failure (x icon, red), no label
    - 2d ago: charter change (document icon, secondary), no label
    - 5d ago: Node restart (power icon, secondary), no label
    - at 2w: a chip `4 more` in secondary
11. **Leader card** at Now: violet border 60%, 44px violet avatar with crown,
    `Halden` 15/600, `Workspace leader` 10/500 secondary, `LEAD++` chip.
    Selected: 2px mint border.

Density: with the navigator hidden the visible band is x 40–1174, so more
missions fit than in the earlier mockup. Aim for all 14 open missions with
their lead cards fully readable and at least the live agents of each in view.

## Artboard 2 — "Chat header · agent selected" — 410 × 132, background rgba(24,26,32,1)

The chat header when an agent is selected instead of the leader, to show the
path: first line `Halden › #304 Rate limiter on /search › Thane` where
`Halden` and `#304 Rate limiter on /search` are secondary-colored links and
`Thane` is primary 14/600; second line `Codex · gpt-5-codex · read-only ·
Running` 10/500 secondary; trailing `Details` text button and round Stop
button. No Lead/Lead++ control (agents have none). Beneath, one agent
message from Thane: `k6 at 400 rps: p95 212 ms, no 429s yet. Raising to 600.`
at 12.5px.

## Quality bar

Native, calm, tasteful dark macOS. System font family if Paper offers SF Pro
or similar; otherwise the closest neutral sans Paper lists, and a mono for
activity lines and tick labels. Tabular numerals on every digit. No emoji,
no gradients on fills, no glow, no bubbles around missions, no cards
containing lists, no role words. Status never by color alone.

## Revision 2 (operator feedback, 2026-09-03)

### Edit "Neta · Spine"
- Connectors: ONE color for every edge, rgba(153,133,245,0.32), solid, 1.4px.
  Remove the amber dashed variant and remove the violet leader→#308 line.
  Blocked is carried only by the amber anchor dot and the card's label.
  #308's card header reads `#308 · led by Halden` with a 12px violet crown
  mark; no edge to the leader card.
- No vertical stacking of missions. Each side of the spine is ONE row of lead
  cards sorted by start time; one mission per column; a mission's agent stack
  grows away from the spine beneath its own lead card only. Connectors from
  anchor to card may bend (vertical from the anchor, then horizontal, then
  vertical into the card) when the card cannot sit directly over its anchor.
  Missions that do not fit continue past the left edge; that is expected.
  The three closed missions may fall off-screen here.
- Checkpoints: remove the permanent labels. Show exactly one tooltip, on the
  Lead++ checkpoint, styled as a hover tooltip (small panel, 1px border,
  `Lead++ · #308 · 14 min ago · by Halden`, with a 6px caret to the icon).
- Chat header: remove the Lead/Lead++ control and the Stop button. Keep
  avatar, name, WORKSPACE LEADER tag, subtitle, and Details.
- Composer: above the text field add a controls row: model picker
  `claude-opus-5 ▾` (10/500 secondary in a subtle pill) and the compact
  `Lead | Lead++` segmented control (Lead++ selected). The trailing round
  button is **Stop** (square glyph, 30px, subtle surface) because the leader
  is Running; when a person types, it becomes the mint send arrow.
- Keep everything else as built.

### New artboard "Neta · Typical day" — 1600 × 1000
The most probable morning, not the worst case. Same shell (no navigator,
toolbar, chat right, mission bar). Spine content:
- Open missions: `#311 Checkout A/B rollout · Running · 25m · led by Ember`
  with agents Bram (Running) and Petra (Running); `#310 Terraform drift on
  staging · Running · 2h · led by Tamsin` with Ash (Running), Orrin
  (Completed), Jules (Completed); `#309 Refund flow edge cases · Blocked · 3h
  · led by Quill` with Zed (Blocked) and Nell (Completed), attention note
  from dataset; `#305 Remove legacy feature flags · Ready to close · 1d · led
  by Pico`, no live agents, `+7 completed` chip. That is all: four open.
- Closed, faded (55%), lead node only, spread across the past two weeks:
  #308 Search index rebuild · Merged · closed 5h; #307 Sentry noise reduction
  · Merged · closed 9h; #306 Audit log export · Abandoned · closed 18h; #304
  Rate limiter on /search · Merged · closed 1d; #303 Invoice PDF rendering ·
  Merged · closed 2d; #302 Flaky auth tests · Merged · closed 3d; #300
  Postgres 16 upgrade · Merged · closed 5d; #298 Payments regression · Merged
  · closed 6d; #296 Slack digest bot · Merged · closed 10d; #294 Docs site
  build cache · Abandoned · closed 11d.
- Checkpoints: merge of #308 (5h), merge of #307 (9h), a Lead++ change (1d),
  a pinned message (3d), a `3 more` chip at 2w. No labels.
- Mission bar: Halden (LEAD chip, not Lead++), Now lit, `#309 Refunds ·
  Blocked` (amber), `#305 Flags · Ready` (blue), then `#310`, `#311` compact.
- Chat: leader subtitle `Claude · claude-opus-5 · Idle`, no Lead++ strip,
  composer controls row shows `Lead` selected, the text field holds a typed
  draft `Close #305 once the checks pass.` and the trailing button is the
  mint send arrow. Transcript: three messages: user `Morning. Where are we?`
  09:12; Halden `#309 is waiting on you: Quill asked whether to refund partial
  captures or void the charge. #310 and #311 are running clean. #305 is ready
  to close.` 09:12; user `Void them. Merge #305 when green.` 09:14.

### New artboard "Neta · Navigator open" — 1600 × 1000
Duplicate "Neta · Typical day", then add the navigator overlay on top of the
canvas at the left: 300px wide, full height between the traffic lights and
the mission bar, background rgba(24,26,32,0.96), 1px right border
rgba(255,255,255,0.10), shadow 0 12px 28px rgba(0,0,0,0.28). It overlays;
nothing underneath moves. Contents, top to bottom, 16px padding:
- a search field `Jump to…` with a trailing `⌘L` hint in mono;
- WORKSPACES: NoScrubs (selected), neta, fx-ledger, each with a monogram
  square;
- MACHINE: mac-studio · Online (dot), build-box · Offline;
- MISSIONS as a jump list: OPEN group with the four open missions (number,
  name, state label in state color), then ARCHIVED group with the ten closed
  ones (number, name, `Merged`/`Abandoned` in secondary), most recent first.
No leader row. No counts except none. No cards.

### Edit "Chat header · agent selected"
Remove the Stop button; keep Details.

## Revision 3 — Liquid Glass (operator direction, 2026-09-03)

Apply Apple's Liquid Glass material (macOS Tahoe) to every floating surface on
all four artboards. Glass is the navigation and control layer; canvas nodes,
edges and the spine are content and stay as they are.

### Glass material, dark mode
- Fill `rgba(28,30,38,0.55)` over `backdrop-filter: blur(28px) saturate(1.4)`.
  If Paper rejects backdrop-filter, use fill `rgba(28,30,38,0.82)` and say so.
- Rim: 1px border `rgba(255,255,255,0.14)`; specular top edge as inset
  shadow `inset 0 1px 0 rgba(255,255,255,0.22)`; faint bottom inner edge
  `inset 0 -1px 0 rgba(255,255,255,0.04)`; outer shadow
  `0 18px 40px rgba(0,0,0,0.38)`.
- Specular sheen: an absolutely positioned overlay inside each panel,
  `linear-gradient(135deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0)
  38%)`, pointer-events none, same radius, clipped to the panel.
- Radii: panels 22px; capsules 999px; nested controls concentric (outer radius
  minus padding). No hard 4px corners on glass.
- Text on glass: primary `rgba(255,255,255,0.96)`, secondary
  `rgba(255,255,255,0.64)` (raised for vibrancy legibility).
- Controls on glass (Now, Lead | Lead++, model picker, Details, Stop / send,
  search field, `+N completed` chips, tooltip): capsule glass with the same
  rim. Selected segment = brighter glass lozenge `rgba(255,255,255,0.14)`;
  Lead++ selected = violet glass `rgba(153,133,245,0.30)` with violet text so
  the state stays recognizable. Send arrow stays a solid mint capsule.

### Surfaces to convert, on every board where present
1. Toolbar capsule.
2. Chat panel: fill at `0.66` for reading comfort; user bubbles violet glass
   `rgba(153,133,245,0.35)` with rim; agent bubbles `rgba(255,255,255,0.06)`;
   composer field inset glass `rgba(0,0,0,0.22)` with rim; the Lead++ strip
   violet glass at 0.18.
3. Mission bar: no longer a flush full-width strip. A floating glass capsule
   along the bottom, 16px inset from the left, right and bottom edges, 52px
   tall, radius 26, same contents and order. The chat panel keeps clearing it.
4. Navigator overlay (Navigator board): floating glass panel inset 12px from
   the top, left and bottom, radius 22, not a flush sheet.
5. The Lead++ tooltip (Spine board).
6. Leader card at Now: content card, but give it the glass rim and specular
   sheen with a violet tint `rgba(153,133,245,0.16)` so the focal node reads
   as lifted; selection stays the 2px mint border.
7. Ground: keep `#0E0F13`, add one soft radial tint behind the leader and chat
   area, `radial-gradient(600px 400px at 78% 52%, rgba(153,133,245,0.07),
   transparent 70%)`, so the glass has something to refract. Nothing else on
   the ground.

Everything else, including node cards, spine, edges, anchors, checkpoint
icons and the mission content, stays unchanged. Export all four boards again
to the same PNG paths when done.
