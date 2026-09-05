# 10 — Desktop spine canvas

The canvas is the primary surface: a symbolic spine, the workspace leader fixed at
Now on its right, missions and checkpoints in one sequence in time order along it,
each lead card directly above or below its own anchor, agents stacked away from the
spine under their lead. It is not to scale — the card is the anchor and the gap
carries the elapsed time. Code lives in `apps/macos/Sources/NetaDesktop/Canvas/`,
tests in `apps/macos/Tests/NetaDesktopTests/`; Writes paths are relative to those
two, Contract declarations `public`. Read first: `docs/plan/README.md`,
`docs/plan/01-domain.md`; `BRIEF.md`, `NODES.md`, `PAPER-SPINE.md` (all revisions;
4 and 4b rule layout) in `design/canvas-directions/`; `MANIFESTO.md` on Canvas,
Canvas interaction and visual grammar, Agent archive, Visual direction, Rejected
desktop patterns.

09 provides these; never reimplement or edit them, except one line of
`Shell/RootView.swift` in T10.10. `Store` (`@MainActor @Observable`: `missions`,
`agentsById`, `leader`, `events`); `ShellState` (`selection`, `select(_:)`);
`Selection` (`case leader, mission(MissionId), agent(AgentId)`); `NodeClient` and
`FixtureNodeClient`; Swift mirrors of the `01-domain.md` types with `Date` times;
`Theme`, the BRIEF.md tokens plus `agentHues`; and `MissionBarView`, which renders
the Now control whose state is owned here (T10.9).

Rules: Swift 6, macOS 26, no external Swift dependencies. **Nodes never scale** —
no `scaleEffect` on a node view; zoom changes spacing only, so text keeps its point
size. Nothing bends and nothing stacks: connectors are straight vertical lines,
there is no overlap resolver, and an item's x depends only on the items before it,
so appending never moves existing items and a state change never moves anything.
Layout is pure: no `Store`, no bare `Date()`, no SwiftUI state. Status is never
colour alone, hit targets are 26 pt or taller, tests `@testable import NetaDesktop`.

## Tasks

Done when, for every task: `swift build` and `swift test` pass, the test file it
names exists and passes, and its commit is made.

### T10.1 sequence spacing
Goal: the pure gap rule that turns one time-ordered sequence into x positions.
Reads: this file, `PAPER-SPINE.md` Revision 4, `MANIFESTO.md` Canvas.
Writes: `SequenceSpacing.swift`, `SequenceSpacingTests.swift`.
Contract: `enum SpineItem: Sendable, Equatable` has `case mission(id: MissionId,
at: Double, number: Int)` and `case checkpoint(eventSeq: Int, at: Double)` — times
epoch ms — plus `var at: Double` and `var isCheckpoint: Bool`; `enum
SequenceSpacing` has `static let defaultSameSidePitch: CGFloat` (230, the widest
node plus the gutter) and `static func spacing(items: [SpineItem], pxPerHour:
Double, minPitch: CGFloat = 120, maxPitch: CGFloat = 320, checkpointPitch: CGFloat
= 28, sameSidePitch: CGFloat = defaultSameSidePitch) -> [CGFloat]`.
Steps: 1. Sort by `at`, ties checkpoint before mission then `eventSeq` or `number`;
the order is total, so the result is deterministic. 2. `x[0] = 0`. 3. Each
neighbouring gap is `elapsedHours * pxPerHour` clamped into `floor...maxPitch`,
`floor` being `checkpointPitch` when either item is a checkpoint, `sameSidePitch`
when both are missions whose numbers share a parity (they sit on the same side of
the spine, so the 120 pt column Rev 4 rests on alternation would draw their 210 pt
cards and 220 pt stacks through each other — which happens whenever the permanent
numbers do not run in time order), else `minPitch`. 4. Then widen: for neighbouring
missions holding `k` checkpoints, if their summed distance is under `max(their
mission floor, checkpointPitch * (k + 1))`, spread the shortfall evenly over those
`k + 1` gaps. 5. Return
cumulative x per item in sorted order; nothing after an item may move it.
Tests: `SequenceSpacingTests` — x strictly increasing; two missions a minute apart
sit exactly `minPitch` apart, three weeks apart exactly `maxPitch`, mid-range
exactly `elapsedHours * pxPerHour`; a gap holding four checkpoints is at least
`checkpointPitch * 5` wide with neighbours at least `checkpointPitch` apart;
neighbouring missions always at least `minPitch` apart, and same-side neighbours at
least `sameSidePitch`; 100 shuffles agree.
Commit: `feat(desktop): spine sequence spacing`

### T10.2 metrics and agent stacks
Goal: the per-mission stack — live first, up to eight completed, then chip.
Reads: this file, `MANIFESTO.md` Agent archive, `NODES.md`.
Writes: `SpineMetrics.swift`, `AgentStack.swift`, `AgentStackTests.swift`.
Contract: `struct SpineMetrics: Sendable, Equatable`, `static let standard`, `var`
defaults, `CGFloat` points unless noted: `leadCardWidth` 210, `leadCardHeight` 112,
`leadAttentionHeight` 148, `leaderCardHeight` 74, `closedNodeWidth` 180,
`closedNodeHeight` 34, `agentRowWidth` 220, `agentRowHeight` 68,
`runningRowHeight` 84, `chipHeight` 26, `rowGap` 10, `leadGap` 10, `spineOffset`
90, `minHitHeight` 26; `Int` `completedShown` 8, `maxLiveColumns` 60; plus
`func rowHeight(running: Bool) -> CGFloat` and `func cardHeight(attention: Bool) ->
CGFloat`, the one height rule the placement and the node views both read. The node
heights are the views' rendered heights for the worst content each can draw,
measured with `NSHostingView.fittingSize` and asserted in `NodeViewTests`: a rect
smaller than its view is not a smaller node, because `.position` centres, so the
view simply paints over its neighbours. Plus:
```swift
struct StackItem: Sendable, Equatable, Identifiable {
  enum Content: Sendable, Equatable { case agent(AgentId), moreCompleted(Int) }
  let id: String; let content: Content; let offset, height: CGFloat
}
struct AgentStack: Sendable, Equatable {
  static let empty: AgentStack; let items: [StackItem]; let height: CGFloat
  let liveCount, hiddenCompleted: Int
  static func build(agents: [Agent], expanded: Bool,
                    metrics: SpineMetrics) -> AgentStack
}
```
Steps: 1. `offset` runs from the lead card's far edge and `height` excludes the
trailing gap. 2. Drop `archived`. 3. Live is anything not `completed`, sorted by
state priority `blocked, failed, running, starting, interrupted`, then
`startedAt`, then `id`. 4. Completed sorted by `endedAt` descending then `id`;
take `completedShown` unless `expanded`. 5. Stack live then completed,
`runningRowHeight` for running rows else `agentRowHeight`, `rowGap` between, then
the chip when `hiddenCompleted > 0`; the gap is 10 pt so the stack link is visible.
Tests: `AgentStackTests` — live agents never collapse at any count; eight completed
shown at 9, 20 and 200, `hiddenCompleted` 1, 12, 192; `expanded` shows all with no
chip; order is attention-first, stable across 100 shuffles.
Commit: `feat(desktop): agent stack builder`

### T10.3 spine placement
Goal: each anchor on the spine under or over its own card, straight connectors.
Reads: this file, `PAPER-SPINE.md` Revision 4, `MANIFESTO.md` Canvas.
Writes: `SpineIndex.swift`, `SpinePlacement.swift`, `SpinePlacementTests.swift`.
Contract: `struct SpineIndex: Sendable` merges missions and checkpoint events
into one `SpineItem` sequence with its cumulative x from T10.1 —
`init(missions: [Mission], events: [Event], pxPerHour: Double, maxPitch:
CGFloat)`, `count`, `subscript(_ i: Int) -> SpineItem`, `x(_ i: Int) -> CGFloat`,
`mission(_ i: Int) -> Mission?`, `contentWidth`, `earliestOpen: Int?` and
`firstIndex(atOrAfter x: CGFloat) -> Int`, a binary search. Plus:
```swift
enum SpineSide: Sendable, Equatable { case above, below }
struct MissionTick: Sendable, Equatable { let x: CGFloat; let state: MissionState }
struct MissionColumn: Sendable, Equatable, Identifiable {
  let id: MissionId; let number: Int; let side: SpineSide
  let anchor: CGPoint; let card: CGRect; let connector: [CGPoint]
  let stack: AgentStack; let rows: [CGRect]; let collapsed: Bool
}
```
`Placement` (`Sendable, Equatable`) is `spineY: CGFloat`, `leader: CGRect`,
`columns: [MissionColumn]`, `ticks: [MissionTick]`; `enum SpinePlacement` has
`static func place(index: SpineIndex, agents: [MissionId: [Agent]], range:
Range<Int>, scrollX: CGFloat, viewport: CGRect, metrics: SpineMetrics = .standard,
expanded: Set<MissionId> = []) -> Placement`.
Steps: 1. `spineY = viewport.midY`; `anchor` is `(index.x(i) - scrollX +
viewport.minX, spineY)`, no offsetting and no resolver; the leader card is pinned
past the newest item, spine-centred. 2. `side = number.isMultiple(of: 2) ? .below
: .above`; numbers are permanent, so a side never changes and neighbours always
alternate. 3. `card` is `leadCardWidth` wide, `leadAttentionHeight` tall when
`attention != nil` else `leadCardHeight`, centred on `anchor.x`, near edge
`spineOffset` from the spine; closed, it is `closedNodeWidth × closedNodeHeight`
centred the same way, `collapsed`, no `rows`. 4. `connector` is exactly two points,
`anchor` and the card's near edge, both at `anchor.x`. 5. `rows` are
`agentRowWidth` wide, card-aligned, away from the spine, the first `leadGap` past
the card's far edge, `rowGap` apart.
Tests: `SpinePlacementTests` — over 1 000 seeded random datasets (1–200 missions
across 30 days) no two `card` rects on one side overlap, and the same runs assert
the reason, that every same-side pair is at least `2 * minPitch` apart; cycling a
mission through every `MissionState` and toggling `attention` leaves `anchor` and
`card.midX` identical, as do three viewports at one `scrollX`; appending a newer
mission moves no existing `anchor.x`; `connector` has two points at `anchor.x`.
Commit: `feat(desktop): spine placement`

### T10.4 tick labels
Goal: the age labels, placed proportionally inside the gap each age falls in.
Reads: this file, `PAPER-SPINE.md` Revision 4, `MANIFESTO.md` Canvas.
Writes: `SpineTicks.swift`, `SpineTicksTests.swift`.
Contract: `struct SpineTick: Sendable, Equatable, Identifiable` is `id: String`,
`label: String`, `at: Double`, `x: CGFloat`; `enum SpineTicks` has `static let
labels = ["2w", "1w", "3d", "1d", "12h", "3h", "1h", "now"]` and `static func
place(index: SpineIndex, now: Double, minLabelGap: CGFloat = 24) -> [SpineTick]`.
Steps: 1. Every label but `now` is an age before `now`; `now` is `now` itself. 2.
Binary-search the neighbouring item pair whose times bracket the age and place it
at `x(i) + (t - at(i)) / (at(i + 1) - at(i)) * (x(i + 1) - x(i))` — proportional
by time inside that one gap, never across gaps. 3. An age older than the first
item pins to `x(0)`; `now` pins to the last item's x, the leader's. 4. Drop a
label within `minLabelGap` of the last kept one, oldest to newest. 5. Labels
annotate only: nothing in the placement depends on them.
Tests: `SpineTicksTests` — over items spread across a month every label lands
inside the gap bracketing its age, in order, x strictly increasing; a label whose
age falls on an item sits exactly on that item's x; with three items inside one
hour only `1h` and `now` survive `minLabelGap`; 100 shuffles agree.
Commit: `feat(desktop): spine tick labels`

### T10.5 virtualisation and backdrop
Goal: materialise the visible index range only; draw the rest in one `Canvas`.
Reads: this file, `MANIFESTO.md` Canvas, `PAPER-SPINE.md` item 8, Revision 4.
Writes: `SpineVirtualiser.swift`, `SpineBackdrop.swift`, `VirtualisationTests.swift`.
Contract: `struct VisibleWindow: Sendable, Equatable` is `range: Range<Int>`,
`columns: [MissionColumn]` (materialised as views), `ticks: [MissionTick]` (1 pt
per pixel column), `labels: [SpineTick]`, `leader: CGRect`, `spineY: CGFloat` and
`var liveViewCount: Int`; `enum SpineVirtualiser` has `static func window(index:
SpineIndex, agents: [MissionId: [Agent]], scrollX: CGFloat, viewport: CGRect,
now: Double, metrics: SpineMetrics = .standard, expanded: Set<MissionId> = []) ->
VisibleWindow`. Plus `enum SpinePainter` with `static func connectorPath(_ points:
[CGPoint]) -> Path` and `static func draw(into ctx: inout GraphicsContext, size:
CGSize, window: VisibleWindow, style: BackdropStyle, emphasisFor: (MissionId) ->
Double)`.
`struct BackdropStyle: Sendable, Equatable`, `static let standard`, `var`
defaults: `edgeColor` `Theme.violet.opacity(0.32)`, `edgeWidth` 1.4, `axisColor`
`.white.opacity(0.14)`, `axisUnderlay` `Theme.violet.opacity(0.06)`,
`anchorDiameter` 8, `anchorRing` 2, `tickWidth` 1. `struct SpineBackdrop: View`
wraps the painter: `init(window: VisibleWindow, style: BackdropStyle = .standard,
emphasisFor: @escaping (MissionId) -> Double)`.
Steps: 1. Virtualisation is index-based: binary-search cumulative x for the range
covering `scrollX - leadCardWidth` through `scrollX + viewport.width +
leadCardWidth`, place that range only, and if it yields more than `maxLiveColumns`
columns keep those nearest `viewport.midX` and tick the rest. 2. `x` is monotonic
in the index, so build ticks by walking the viewport pixel by pixel,
binary-searching the first mission at or after each pixel's content x — one tick
per pixel column at most, carrying that bucket's strongest state, priority
`blocked, failed, readyToClose, mergedNotClosed, running, closed`. Never iterate
every mission. 3. Draw in one `Canvas`, no per-mission shape views, in
order: axis underlay, axis, `labels` in 10 pt mono `Theme.textSecondary`, mission
ticks, connectors, stack links, then anchors. 4. An agent stack has no trunk line
and no stubs: a short vertical segment, horizontally centred on the stack, joins
the lead card to the first row, each row to the next, and the last row to the `+N
completed` chip. 5. Every edge and link is `edgeColor` at `edgeWidth`, solid,
straight, round caps — one colour, never bent, dashed or coloured; blocked shows in
the amber anchor and the label. 6. An anchor is `anchorDiameter` in the state
colour ringed `anchorRing` in `Theme.ground`; a `.leader`-led mission draws no
leader edge, its crown belonging to the card header in T10.7.
Tests: `VirtualisationTests` — with 100 000 missions over three years and a
1600 × 1000 viewport at the newest end, `window` averages under 8 ms over 20 runs,
returns at most 60 `columns`, never more ticks than `viewport.width`, and shifts at
most one column per edge on a one-pixel pan; through a recording `GraphicsContext`
a `.leader`-led mission draws no leader edge and a four-row stack draws four
centred links of `edgeWidth`, no trunk.
Commit: `feat(desktop): spine virtualisation and backdrop`

### T10.6 sigils, state colour and fading
Goal: the agent mark, the colour and label tables, the fade rule, the floor.
Reads: this file, `BRIEF.md`, `lib.mjs`, `PAPER-SPINE.md` Revision 1 item 4.
Writes: `Sigil.swift`, `CanvasStyle.swift`, `FadingTests.swift`.
Contract:
```swift
struct Sigil: Sendable, Equatable {           // hueIndex 0...5
  init(name: String); let bits: UInt8; let hueIndex: Int
  func isOn(row: Int, column: Int) -> Bool
  static func hash(_ name: String) -> UInt32  // FNV-1a, 32-bit
}
struct SigilView: View { init(name: String, size: CGFloat = 12) }
```
`enum CanvasStyle`: `static let contrastFloor: Double = 4.5`; `color(for:)` and
`label(for:)`, each overloaded on `MissionState` and `AgentState`, returning
`Color` and `String`; `emphasis(mission: Mission, agents: [Agent]) -> Double`;
`text(_ base: Color, emphasis: Double, over bg: Color) -> Color`; and
`contrastRatio(_ fg: Color, over bg: Color) -> Double`.
Steps: 1. `hash` is `lib.mjs`'s FNV-1a; `bits = UInt8((h ^ (h >> 11)) & 0xff)`,
then `|= 0x93` under three set bits and `&= 0x6f` over six; `isOn(row:column:)`
reads bit `row * 2 + min(column, 3 - column)`; `hueIndex = Int(hash(name) % 6)`
indexes `Theme.agentHues`. 2. Colours: running mint, blocked amber, failed red,
completed green, readyToClose and mergedNotClosed blue, closed and archived
`Theme.textSecondary`; labels are the manifesto's Product language strings,
`Merged · not closed` included. 3. `emphasis` is `1.0` for `blocked` and `failed`
at any age, `0.55` for `closed`, `0.70` for `readyToClose`, `mergedNotClosed` and
any mission with no `running` or `starting` agent, `1.0` otherwise. 4. `text`
composites `base` at `emphasis` over `bg`, raising alpha until `contrastRatio >=
contrastFloor` (WCAG relative luminance, computed once).
Tests: `FadingTests` — `Sigil` is stable for every name in `dataset.json`, matches
`lib.mjs` on ten of them, always has three to six bits set; the emphasis table
holds for every `MissionState`, blocked and failed at `1.0` at 30 days old;
`contrastRatio` of faded `Theme.textSecondary` over `Theme.nodeFill` is `>= 4.5`
at emphasis `0.55`, `0.70` and `1.0`.
Commit: `feat(desktop): sigils, state colour and fading`

### T10.7 node views
Goal: leader card, lead card, agent row, `+N completed` chip, and their models.
Reads: this file, `NODES.md`, `PAPER-SPINE.md` items 9, 11 and Revision 2.
Writes: `NodeModels.swift`, `NodeViews.swift`, `NodeViewTests.swift`.
Contract:
```swift
struct LeadCardModel: Sendable, Equatable {   // "#298", "25m", "led by Ember"
  init(mission: Mission, lead: Agent?, leaderName: String, now: Date)
  let numberText, name, stateLabel, ageText: String
  let stateColor: Color; let ledBy, attention: String?; let crown: Bool
}
struct AgentRowModel: Sendable, Equatable {   // accessGlyph "eye" | "pencil"
  init(agent: Agent); let sigil: Sigil; let stateColor: Color
  let name, task, stateLabel, model, accessGlyph: String
  let activity: String?                       // running only, mono line
}
```
Four `struct …: View`: `LeaderCardView(name: String, mode: LeaderMode, selected:
Bool)`; `LeadCardView(model: LeadCardModel, emphasis: Double, selected: Bool)`;
`AgentRowView(model: AgentRowModel, emphasis: Double, selected: Bool)`;
`CompletedChip(count: Int, expanded: Bool, action: @escaping () -> Void)`.
Steps: 1. `crown` is true when the lead is the workspace leader. 2. Anatomy per
NODES.md and PAPER-SPINE.md — leader card: violet glass rim and sheen over a
violet tint, 44 pt crown avatar, name 15/600, `Workspace leader` 10/500
secondary, `LEAD`/`LEAD++` chip, 2 pt mint border when selected. 3. Lead card:
number and right-aligned age in tabular numerals, name, a 6 pt state dot with its
label, `led by <name>` or the crown, the attention note in state colour. 4. Agent
row: sigil, name, access glyph, the full task over two or three
lines, the state row, a mono activity line when running. PAPER-SPINE item 9's
row anatomy is `sigil · name · task · state · access glyph`: no provider mark,
which rendered as a bare unexplained initial next to the state label. The model
is named in full in the chat header instead. 5. `CompletedChip` is a
pill with a chevron expanding in place, never a circle or separate surface. 6.
Tint through `CanvasStyle.text`, never below the floor.
Tests: `NodeViewTests` — `LeadCardModel` gives number, name, state label, age and
`led by` for every mission in the 09 fixture, `crown` exactly when `mission.lead
== .leader`, `attention` verbatim, ages `25m`, `2h`, `3d`, `2w`; `AgentRowModel`
never truncates `task`, emits `activity` only for `running`, glyphs `eye` and
`pencil`; view heights meet `standard.minHitHeight`.
Commit: `feat(desktop): spine node views`

### T10.8 checkpoints
Goal: an icon per event kind on the spine, tooltips, an action.
Reads: this file, `docs/plan/01-domain.md`, `MANIFESTO.md` Canvas, `PAPER-SPINE.md`
item 10 and Revision 4.
Writes: `Checkpoints.swift`, `CheckpointViews.swift`, `CheckpointTests.swift`.
Contract: `enum CheckpointIcon: String, Sendable, CaseIterable` has cases `bolt,
merge, diamond, x, document, power, check, question`; `enum CheckpointAction:
Sendable, Equatable` has `case scrollToTurn(sessionId: SessionId, turnId: TurnId)`
and `case openDecisionRecord(missionId: MissionId, seq: Int)`. Plus:
```swift
struct Checkpoint: Sendable, Equatable, Identifiable {  // id = String(seq)
  let id: String; let seq: Int; let at: Date; let kind: EventKind
  let icon: CheckpointIcon; let label, relative: String  // "Lead++ · #308"
  let x: CGFloat; let missionId: MissionId?
  let sessionId: SessionId?; let turnId: TurnId?
}
@MainActor @Observable final class CheckpointRouter {   // 11 consumes this
  private(set) var pending: CheckpointAction?
  func open(_ checkpoint: Checkpoint); func consume() -> CheckpointAction?
}
```
`enum Checkpoints`: `icon(for kind: EventKind) -> CheckpointIcon?` and `place(index:
SpineIndex, events: [Event], range: Range<Int>, scrollX: CGFloat, viewport: CGRect,
now: Date) -> [Checkpoint]`; `struct CheckpointLayer: View` takes `init(points:
[Checkpoint], spineY: CGFloat, router: CheckpointRouter)`.
Steps: 1. Icon table: `leader.modeChanged` bolt; `mission.merged` and
`base.integrated` merge; `user.pinned` diamond; `mission.failed` x;
`charter.changed` document; `node.restarted` power; `mission.closed` check;
`mission.blocked` question; every other kind gives `nil` and is not a checkpoint.
2. A checkpoint is an item in the sequence, so its x comes from
`index.x`, never from a separate scale; the spacing rule keeps neighbours
`checkpointPitch` apart, so checkpoints never pile up. 3. Icons are 14 pt stroke,
1.5 width, round caps, on the spine, no permanent labels; hover shows one glass
tooltip with the label, the relative time and a 6 pt caret. 4. `open` sets
`pending` to `.scrollToTurn` when the event carries `sessionId` and `turnId`,
else `.openDecisionRecord`; it opens no surface.
Tests: `CheckpointTests` — every `EventKind.allCases` case maps to the table's
icon or explicitly to `nil`; over twelve events spread across a month each `x`
equals `index.x` of its item and no two are closer than `checkpointPitch`;
`leader.modeChanged` routes to `.scrollToTurn` with a `turnId` and
`.openDecisionRecord` without; `consume()` clears `pending`.
Commit: `feat(desktop): spine checkpoints`

### T10.9 Now state, zoom and interaction
Goal: Now state, the off-screen leader marker, pan, zoom, Fit, select.
Reads: this file, `MANIFESTO.md` Canvas and Canvas interaction and visual grammar,
`appendix-v2-desktop.md` in this directory, `PAPER-SPINE.md` item 5, Revision 4.
Writes: `NowState.swift`, `SpineViewportState.swift`, `TrackpadPanCapture.swift`,
`NowStateTests.swift`.
Contract:
```swift
@MainActor @Observable final class NowState {  // label "Now", "Now · 3d back"
  private(set) var isLive, leaderOffScreen: Bool
  private(set) var label: String; private(set) var jumpRequest: CGFloat?
  func update(index: SpineIndex, scrollX: CGFloat, viewport: CGRect,
              leader: CGRect, now: Date, trailingInset: CGFloat = 0)
  func jumpToNow(index: SpineIndex, viewport: CGRect, trailingInset: CGFloat = 0)
  func consumeJump() -> CGFloat?
}
enum ZoomStep: Sendable { case zoomIn, zoomOut }
```
`@MainActor @Observable final class SpineViewportState`: `init(pxPerHour: Double)`,
`var expanded: Set<MissionId>`, `private(set)` `pxPerHour: Double`, `maxPitch:
CGFloat`, `scrollX, scrollY: CGFloat`; `pan(by: CGSize, index: SpineIndex,
viewport: CGRect, contentHeight: CGFloat, trailingInset: CGFloat = 0)`,
`zoom(factor: Double, atCursorX: CGFloat, index: SpineIndex, viewport: CGRect =
.zero, trailingInset: CGFloat = 0)`, `zoom(_ step: ZoomStep, index: SpineIndex,
viewport: CGRect, trailingInset: CGFloat = 0)` for ⌘= and ⌘-, `fit(index:
SpineIndex, viewport: CGRect, trailingInset: CGFloat = 0)` for ⌘0, `jump(to:
CGFloat)`, `toggleExpanded(_:)`. The `trailingInset` is the canvas's usable right
edge (the chat's leading edge less `SpinePlacement.chatGap`): every one of these
resolves the scroll against it, so the leader card stays at Now just left of the
chat. `struct OffScreenLeaderMarker: View` takes `init(state:
NowState, trailingInset: CGFloat, action: @escaping () -> Void)`; `struct
TrackpadPanCapture: NSViewRepresentable` takes `init(isEnabled: Bool,
excludedRects: [CGRect], onScroll: @escaping (CGSize) -> Void)` — the rects the
shell's floating surfaces actually cover (`ShellLayout.covered`), not edge insets:
the navigator only occupies the band between the surface top and the mission bar,
and carving its full-height leading column out of the capture stopped the canvas
above and below it panning too.
Steps: 1. `isLive` when the newest item's x is at or inside `scrollX +
viewport.width + 0.5`; else `label` is `Now · <n> back`, `n` the coarsest of `d`,
`h`, `m` back to `now`. 2. `jumpToNow` sets `jumpRequest` to the `scrollX` putting
the live edge at the canvas's usable right edge; 09's `MissionBar` renders the
control from this state but does not ask through it — the ask is
`ShellState.jumpToNow()`, which bumps `nowRequested`, and the canvas answers it in
T10.10, so anything outside the canvas (the bar, the debug driver) can reach Now. 3. `leaderOffScreen` is true when `leader` does not intersect `viewport`; the
marker draws at `viewport.maxX - trailingInset`, left of the chat, and jumps to
Now. 4. Rewrite `TrackpadPanCapture` from the v2 idea, never by copying it: a
local `NSEvent` scroll-wheel monitor filtered by window and `excludedRects` so
chat, navigator and mission bar keep their own scrolling, non-precise deltas scaled by 18,
coalesced per run-loop turn, event swallowed. 5. Horizontal delta changes
`scrollX`, clamped by `SpinePlacement.clampScrollX`: back no further than the
oldest item at the left edge, forward no further than the live edge
(`SpinePlacement.liveScrollX`, which puts the leader card's far edge on the usable
right edge and is negative when the whole sequence is narrower than the usable
width — the leader still sits at Now and the spine runs off to its left). Nothing
exists right of Now, so the live edge is always the forward limit; the far-left
`0...max(0, index.contentWidth - viewport.width)` rule this replaces put the
leader behind the navigator on an empty workspace. Vertical changes `scrollY`,
clamped to `0...max(0, contentHeight - viewport.height)`; neither touches the
spacing. 6. Zoom changes `pxPerHour` and `maxPitch` only —
`minPitch` and `checkpointPitch` are constant, so zooming out collapses toward a
uniform sequence; `MagnifyGesture` maps magnification to `factor`, `⌘=` and `⌘-`
use `1.25` and `0.8` about `viewport.midX`, and `scrollX` is re-solved after the
rebuild to hold the content under the cursor. A pinch moves `ShellState.timeZoom`
by the same ratio (T10.10 `applyPinch`), so the toolbar's readout can never report a
zoom the spacing does not have. 7. `fit` finds the largest
`pxPerHour` at which every open mission from `index.earliestOpen` to the newest
fits in `viewport.width`, else keeps the minimum and pans to the newest; reset
`scrollY`. 8. Click calls `shell.select(_:)`, `Escape` returns to `.leader`.
Tests: `NowStateTests` — lit at the live edge and at a half-pixel overshoot; `Now ·
3d back` and `Now · 5h back`; `consumeJump` clears the request; `leaderOffScreen`
flips exactly when the leader rect leaves the viewport; a 100 pt horizontal pan
moves `scrollX` by 100 and leaves `pxPerHour` and `SpineMetrics.standard`
untouched; a vertical pan changes `scrollY` only, and clamps; `zoom` holds the
content under the cursor within 1 pt, never changes the minimum pitch, and at the
floor gives a uniform sequence; `fit` shows every open mission when they fit, the
newest when not.
Commit: `feat(desktop): now control, zoom and spine interaction`

### T10.10 canvas assembly
Goal: the one view that composes the spine and hands it to the 09 shell.
Reads: this file, `docs/plan/09-desktop-shell.md`, `PAPER-SPINE.md` artboard 1.
Writes: `SpineCanvasView.swift`, `SpineCanvasTests.swift`, and the one line of
`apps/macos/Sources/NetaDesktop/Shell/RootView.swift` holding `CanvasPlaceholder`.
Contract: `struct SpineCanvasView: View` with `init(store: Store, shell: ShellState,
viewport: SpineViewportState, now: NowState, router: CheckpointRouter)`, plus
`resolve(size:date:)`, `applyShellZoom(size:)`, `applyShellFit(size:)`,
`applyShellNow(size:)`, `applyPinch(factor:atX:size:)` and `revealSelection(size:)`
— the ends of the shell's wires, exposed so the tests drive the same paths the body
does. `SpineCanvasPipeline` carries `static func trailingInset(size:shell:)` and
`static func interactionRects(size:shell:)`.
Steps: 1. `GeometryReader` into a `ZStack`: `SpineBackdrop` at the bottom, the
materialised `MissionColumn` views placed with `.position`, `CheckpointLayer`, the
leader card, then `OffScreenLeaderMarker`. Every placed view is framed to its
placement rect first (`.frame(width:height:)`), because `.position` centres a view
on a point: an unframed view paints over its neighbours instead of drawing smaller.
2. The canvas draws `Store.currentMissions`, `currentEvents` and
`currentAgentsByMission` — the current workspace only, since the Node lists every
open workspace in one snapshot and two of them interleave into two sequences
through each other. 3. Rebuild `SpineIndex` only when the mission set, the
checkpoint set or the spacing inputs change; recompute `SpineVirtualiser.window`
when `scrollX`, the viewport or the store revision changes. 4. Call
`NowState.update` on every recomputation, applying `consumeJump()`. The first
layout, and any later change of the usable or content width while the view is
live, re-anchors on the live edge; the same change while the view is scrolled back
re-clamps `scrollX` with `SpinePlacement.clampScrollX`, so widening the band never
leaves the leader short of the usable right edge. 5. Apply `TrackpadPanCapture`
with `interactionRects`; attach `⌘=`, `⌘-`, `⌘0`, `Escape`, and observe
`shell.timeZoom`, `shell.fitRequested` and `shell.nowRequested`.
Tests: `SpineCanvasTests` against `FixtureNodeClient` — the fourteen-mission
fixture yields a leader card and fourteen columns; selecting a mission then an
agent updates `shell.selection` and `Escape` returns it to `.leader`; zoomed far
out, missions become ticks but the leader card stays; a mission in another
workspace never enters the window; `shell.jumpToNow()` returns the view to the live
edge; a pinch moves `shell.timeZoom` in step and is applied once.
Commit: `feat(desktop): assemble the spine canvas`
