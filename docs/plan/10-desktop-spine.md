# 10 — Desktop spine canvas

The canvas is the primary surface: a time axis (the spine), the workspace
leader fixed at Now on its right, missions anchored at their start time, lead
cards in one row above and one below, agents stacked away from the spine under
their lead, checkpoints on the axis. Code lives in
`apps/macos/Sources/NetaDesktop/Canvas/` and tests in
`apps/macos/Tests/NetaDesktopTests/`; Writes paths are relative to those two;
Contract declarations are `public`. Read first: `docs/plan/README.md`,
`docs/plan/01-domain.md`; `BRIEF.md`, `NODES.md` and `PAPER-SPINE.md` (all
three revisions) in `design/canvas-directions/`, named short below; and
`MANIFESTO.md` on Canvas, Canvas interaction and visual grammar, Agent archive,
Visual direction, Rejected desktop patterns.

09 provides these; never reimplement or edit them, except one line of
`Shell/RootView.swift` in T10.9. `Store` (`@MainActor @Observable`:
`missions`, `agentsById`, `leader`, `events`); `ShellState` (`selection`,
`select(_:)`); `Selection` (`case leader, mission(MissionId),
agent(AgentId)`); `NodeClient` and `FixtureNodeClient`; Swift mirrors of the
`01-domain.md` types with `Date` times; `Theme`, the BRIEF.md tokens plus
`agentHues`; and `MissionBarView`, which renders the Now control whose state
is owned here (T10.8).

Rules: Swift 6, macOS 26, no external Swift dependencies. **Nodes never scale**
— no `scaleEffect` on a node view; zoom changes the lens only, so text keeps
its point size. Layout is pure: no `Store`, no bare `Date()`, no SwiftUI state.
Status is never colour alone, hit targets are 26 pt or taller, and tests
`@testable import NetaDesktop`.

## Tasks

### T10.1 time lens
Goal: a Swift `TimeLens` reproducing `src/core/lens.ts` and its fixture.
Reads: this file, `src/core/lens.ts`, `test/fixtures/lens-cases.json`.
Writes: `TimeLens.swift`, `TimeLensTests.swift`.
Contract:
```swift
struct TimeLensOptions: Sendable, Equatable, Codable {  // times epoch ms
  var now, focusStart, focusEnd: Double; var width, minPxPerHour: Double
}
struct TimeTick: Sendable, Equatable { let t: Double; let label: String }
struct TimeLens: Sendable, Equatable {
  static let maxPxPerHour: Double = 4096
  init(_ options: TimeLensOptions); var options: TimeLensOptions { get }
  func x(_ t: Double) -> Double; func t(_ x: Double) -> Double
  func ticks() -> [TimeTick]
  func zoomed(factor: Double, aroundX: Double) -> TimeLens
  func fitted(earliestOpen: Double?, now: Double) -> TimeLens
}
```
Steps: 1. `width` is points and `minPxPerHour` points per hour; port `lens.ts`
line for line, not redesigning the compression curve. 2. `zoomed` divides the
focus duration by `factor` about `t(aroundX)`, holding `x(t(aroundX))` fixed,
then clamps `width / focusHours` into `[minPxPerHour, maxPxPerHour]`. 3. Fit —
`fitted` — sets `focusStart` to `earliestOpen` (or `now - 3_600_000`) and
`focusEnd` to `now`.
Tests: `TimeLensTests` — every sample in `test/fixtures/lens-cases.json` (five
levels up from `#filePath`) within 0.001 pt; `t(x(t))` within 1 ms; `x`
monotonic; `zoomed` holds the cursor time under both clamps; `fitted` puts the
earliest open mission at `x >= 0`.
Done when: `swift build` and `swift test` pass with that test file; commit.
Commit: `feat(desktop): time lens ported from core`

### T10.2 metrics and agent stacks
Goal: the per-mission stack — live first, up to eight completed, then chip.
Reads: this file, `MANIFESTO.md` Agent archive, `NODES.md`.
Writes: `SpineMetrics.swift`, `AgentStack.swift`, `AgentStackTests.swift`.
Contract: `struct SpineMetrics: Sendable, Equatable`, `static let standard`,
`var` defaults, `CGFloat` points unless noted: `leadCardWidth` 210,
`leadCardHeight` 74, `leadAttentionHeight` 104, `closedNodeWidth` 132,
`closedNodeHeight` 34, `agentRowWidth` 220, `agentRowHeight` 40,
`runningRowHeight` 52, `chipHeight` 26, `rowGap` 5, `columnGap` 16, `leadGap`
10, `spineOffset` 90, `minHitHeight` 26, `checkpointClusterGap` 24; and `Int`
`completedShown` 8, `maxLiveColumns` 60, `maxChainWalk` 512. Plus:
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
trailing gap. 2. Drop `archived`. 3. Live is anything not `completed`, sorted
by state priority `blocked, failed, running, starting, interrupted`, then
`startedAt`, then `id`. 4. Completed sorted by `endedAt` descending then `id`;
take `completedShown` unless `expanded`. 5. Stack live then completed,
`runningRowHeight` for running rows else `agentRowHeight`, `rowGap` between,
then the chip when `hiddenCompleted > 0`.
Tests: `AgentStackTests` — live agents never collapse at any count; eight
completed shown at 9, 20 and 200, `hiddenCompleted` 1, 12, 192; `expanded`
shows all with no chip; order is attention-first, stable across 100 shuffles.
Done when: `swift build` and `swift test` pass with that test file; commit.
Commit: `feat(desktop): agent stack builder`

### T10.3 spine layout
Goal: anchors on the axis, one row of lead cards each side, bent connectors.
Reads: this file, `PAPER-SPINE.md` item 9 and Revision 2, `MANIFESTO.md`.
Writes: `SpineIndex.swift`, `SpineLayout.swift`, `SpineLayoutTests.swift`.
Contract: `struct SpineIndex: Sendable` holds the missions sorted by
`createdAt` then `number`, with `init(missions: [Mission])`, `count`,
`subscript(_ i: Int) -> Mission`, `var earliestOpen: Double?`, `func
firstIndex(atOrAfter t: Double) -> Int`. Plus:
```swift
enum SpineSide: Sendable, Equatable { case above, below }
struct MissionTick: Sendable, Equatable { let x: CGFloat; let state: MissionState }
struct MissionColumn: Sendable, Equatable, Identifiable {
  let id: MissionId; let number: Int; let side: SpineSide
  let anchor: CGPoint; let slot, card: CGRect; let connector: [CGPoint]
  let stack: AgentStack; let rows: [CGRect]; let collapsed: Bool
}
```
`Placement` (`Sendable, Equatable`) is `spineY: CGFloat`, `leader: CGRect`,
`columns: [MissionColumn]`, `ticks: [MissionTick]`; `enum SpineLayout` has
`static func layout(index: SpineIndex, agents: [MissionId: [Agent]], lens:
TimeLens, viewport: CGRect, metrics: SpineMetrics = .standard, expanded:
Set<MissionId> = []) -> Placement`.
Steps: 1. `spineY = viewport.midY`; `anchor.x = lens.x(createdAt)`; the leader
card is pinned at `lens.x(options.now)`, spine-centred, never moving. 2. `side
= number.isMultiple(of: 2) ? .below : .above`; numbers are permanent, so a side
never changes, and no two missions stack vertically on one side. 3. Per side,
walk newest to oldest from the viewport's right edge to a chain break (an
anchor more than `leadCardWidth + columnGap` from its newer neighbour), at most
`maxChainWalk` steps, then sweep forward: centre each `slot` on its anchor,
then push it outward, away from Now, until its trailing edge is at most
`nextNewerSlot.minX - columnGap`. 4. `slot` is always `leadCardWidth` wide
whatever the state, so finishing a mission changes state, not place. 5. `card`
is `leadAttentionHeight` tall when `attention != nil` else `leadCardHeight`,
near edge `spineOffset` from the axis; closed, it is `closedNodeWidth ×
closedNodeHeight` centred in the slot, `collapsed`, no `rows`. 6. `connector`
is two points when `abs(card.midX - anchor.x) <= 0.5`, else four: vertical to
`spineY ± spineOffset / 2`, horizontal to `card.midX`, vertical into the card.
7. `rows` are `agentRowWidth` wide, card-aligned, growing away from the spine,
the first `leadGap` past its far edge.
Tests: `SpineLayoutTests` — over 1 000 seeded random datasets (1–200 missions
across 30 days) no two `slot` rects on one side overlap; cycling a mission
through every `MissionState` and toggling `attention` leaves every `anchor` and
`slot.minX` identical, as do three viewports at one lens; `connector` has 2
points over its anchor and 4 with the exact bend `y` otherwise.
Done when: `swift build` and `swift test` pass with that test file; commit.
Commit: `feat(desktop): spine layout`

### T10.4 virtualisation and backdrop
Goal: materialise the visible window only; draw the rest in one `Canvas`.
Reads: this file, `MANIFESTO.md` Canvas, `PAPER-SPINE.md` item 8, Revision 2.
Writes: `SpineVirtualiser.swift`, `SpineBackdrop.swift`,
`VirtualisationTests.swift`.
Contract: `struct VisibleWindow: Sendable, Equatable` is `columns:
[MissionColumn]` (materialised as views), `ticks: [MissionTick]` (1 pt per
pixel column), `leader: CGRect`, `spineY: CGFloat` and `var liveViewCount:
Int`; `enum SpineVirtualiser` has `static func window(index: SpineIndex,
agents: [MissionId: [Agent]], lens: TimeLens, viewport: CGRect, metrics:
SpineMetrics = .standard, expanded: Set<MissionId> = []) -> VisibleWindow`.
Plus:
```swift
enum SpinePainter {
  static func connectorPath(_ points: [CGPoint]) -> Path
  static func draw(into ctx: inout GraphicsContext, size: CGSize,
    window: VisibleWindow, lens: TimeLens, style: BackdropStyle,
    emphasisFor: (MissionId) -> Double)
}
```
`struct BackdropStyle: Sendable, Equatable`, `static let standard`, `var`
defaults: `edgeColor` `Theme.violet.opacity(0.32)`, `edgeWidth` 1.4,
`axisColor` `.white.opacity(0.14)`, `axisUnderlay`
`Theme.violet.opacity(0.06)`, `anchorDiameter` 8, `anchorRing` 2, `tickWidth`
1. `struct SpineBackdrop: View` wraps the painter: `init(window: VisibleWindow,
lens: TimeLens, style: BackdropStyle = .standard, emphasisFor: @escaping
(MissionId) -> Double)`.
Steps: 1. Binary-search `index` for `viewport`'s time range widened one column
each side, lay out that range only, and if it gives more than `maxLiveColumns`
keep those nearest `viewport.midX`, ticking the rest. 2. `x` is monotonic in
`createdAt`, so build ticks by walking the viewport pixel by pixel,
binary-searching the first mission at or after `lens.t(px + 1)` — one tick per
pixel column at most, carrying that bucket's strongest state, priority
`blocked, failed, readyToClose, mergedNotClosed, running, closed`. Never
iterate every mission. 3. Draw in one `Canvas`, no per-mission shape views, in
order: axis underlay, axis, `lens.ticks()` labels in 10 pt mono `Theme.textSecondary`
beneath it, mission ticks, connectors, agent trunk edges with 6 pt stubs, then
anchors. 4. Every edge is `edgeColor` at `edgeWidth`, solid, round caps — one
colour, never dashed or coloured; blocked shows in the amber anchor and the
label. 5. An anchor is `anchorDiameter` in the state colour ringed `anchorRing`
in `Theme.ground`; a `.leader`-led mission gets a 12 pt crown on its card
header, no edge to the leader.
Tests: `VirtualisationTests` — with 100 000 missions over three years and a
1600 × 1000 viewport on the last day, `window` averages under 8 ms over 20
runs, returns at most 60 `columns`, never more ticks than `viewport.width`, and
shifts at most one column per edge on a one-pixel pan; and through a recording
`GraphicsContext`, a `.leader`-led mission draws no leader edge.
Done when: `swift build` and `swift test` pass with that test file; commit.
Commit: `feat(desktop): spine virtualisation and backdrop`

### T10.5 sigils, state colour and fading
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
`Theme.textSecondary`; labels are the manifesto's Product language strings, `Merged ·
not closed` included. 3. `emphasis` is `1.0` for `blocked` and `failed` at any
age, `0.55` for `closed`, `0.70` for `readyToClose`, `mergedNotClosed` and any
mission with no `running` or `starting` agent, `1.0` otherwise. 4. `text`
composites `base` at `emphasis` over `bg`, raising alpha until `contrastRatio
>= contrastFloor` (WCAG relative luminance, computed once).
Tests: `FadingTests` — `Sigil` is stable for every name in `dataset.json`,
matches `lib.mjs` on ten of them, always has three to six bits set; the
emphasis table holds for every `MissionState`, blocked and failed at `1.0` at
30 days old; `contrastRatio` of faded `Theme.textSecondary` over `Theme.nodeFill` is
`>= 4.5` at emphasis `0.55`, `0.70` and `1.0`.
Done when: `swift build` and `swift test` pass with that test file; commit.
Commit: `feat(desktop): sigils, state colour and fading`

### T10.6 node views
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
Four `struct …: View`: `LeaderCardView(name: String, mode: LeaderMode,
selected: Bool)`; `LeadCardView(model: LeadCardModel, emphasis: Double,
selected: Bool)`; `AgentRowView(model: AgentRowModel, emphasis: Double,
selected: Bool)`; `CompletedChip(count: Int, expanded: Bool, action: @escaping
() -> Void)`.
Steps: 1. `crown` is true when the lead is the workspace leader. 2. Anatomy per
NODES.md and PAPER-SPINE.md — leader card: violet glass rim and sheen over a
violet tint, 44 pt crown avatar, name 15/600, `Workspace leader` 10/500
secondary, `LEAD`/`LEAD++` chip, 2 pt mint border when selected. 3. Lead card:
number and right-aligned age in tabular numerals, name, a 6 pt state dot with
its label, `led by <name>` or the crown, the attention note in state colour. 4.
Agent row: sigil, name, provider mark, access glyph, the full task over two or
three lines, the state row, a mono activity line when running. 5.
`CompletedChip` is a pill with a chevron expanding in place, never a circle or
separate surface. 6. Tint through `CanvasStyle.text`, never below the floor.
Tests: `NodeViewTests` — `LeadCardModel` gives number, name, state label, age
and `led by` for every mission in the 09 fixture, `crown` exactly when
`mission.lead == .leader`, `attention` verbatim, ages `25m`, `2h`, `3d`, `2w`;
`AgentRowModel` never truncates `task`, emits `activity` only for `running`,
glyphs `eye` and `pencil`; view heights meet `standard.minHitHeight`.
Done when: `swift build` and `swift test` pass with that test file; commit.
Commit: `feat(desktop): spine node views`

### T10.7 checkpoints
Goal: an icon per event kind on the axis, tooltips, coalescing, an action.
Reads: this file, `docs/plan/01-domain.md`, `MANIFESTO.md` Canvas,
`PAPER-SPINE.md` item 10 and Revision 2.
Writes: `Checkpoints.swift`, `CheckpointViews.swift`, `CheckpointTests.swift`.
Contract: `enum CheckpointIcon: String, Sendable, CaseIterable` has cases
`bolt, merge, diamond, x, document, power, check, question`; `enum
CheckpointAction: Sendable, Equatable` has `case scrollToTurn(sessionId:
SessionId, turnId: TurnId)` and `case openDecisionRecord(missionId: MissionId,
seq: Int)`. Plus:
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
`enum Checkpoints`: `icon(for kind: EventKind) -> CheckpointIcon?` and
`place(events: [Event], lens: TimeLens, now: Date, metrics: SpineMetrics =
.standard) -> (points: [Checkpoint], clusters: [CheckpointCluster])`.
`CheckpointCluster` (`Sendable, Equatable, Identifiable`) is `id: String`, `x:
CGFloat`, `members: [Checkpoint]`; `struct CheckpointLayer: View` takes
`init(points: [Checkpoint], clusters: [CheckpointCluster], spineY: CGFloat,
router: CheckpointRouter)`.
Steps: 1. Icon table: `leader.modeChanged` bolt; `mission.merged` and
`base.integrated` merge; `user.pinned` diamond; `mission.failed` x;
`charter.changed` document; `node.restarted` power; `mission.closed` check;
`mission.blocked` question; every other `EventKind` gives `nil` and is not a
checkpoint. 2. Icons are 14 pt stroke, 1.5 width, round caps, on the axis, no
permanent labels; hover shows one glass tooltip with the label, the relative
time and a 6 pt caret. 3. Events older than `lens.options.focusStart` coalesce,
grouped by x within `checkpointClusterGap`, each an `N more` chip at its mean
x. 4. `open` sets `pending` to `.scrollToTurn` when the event carries
`sessionId` and `turnId`, else `.openDecisionRecord`; it opens no surface.
Tests: `CheckpointTests` — every `EventKind.allCases` case maps to the table's
icon or explicitly to `nil`; events inside the focus window stay individual;
twelve at 2w collapse into clusters whose `members.count` sums to twelve;
`leader.modeChanged` routes to `.scrollToTurn` with a `turnId` and
`.openDecisionRecord` without; `consume()` clears `pending`.
Done when: `swift build` and `swift test` pass with that test file; commit.
Commit: `feat(desktop): axis checkpoints`

### T10.8 Now state and interaction
Goal: Now state, the off-screen leader marker, pan, zoom, Fit, select.
Reads: this file, `MANIFESTO.md` Canvas and Canvas interaction and visual
grammar, `appendix-v2-desktop.md` in this directory, `PAPER-SPINE.md` item 5.
Writes: `NowState.swift`, `SpineViewportState.swift`,
`TrackpadPanCapture.swift`, `NowStateTests.swift`.
Contract:
```swift
@MainActor @Observable final class NowState {  // label "Now", "Now · 3d back"
  private(set) var isLive, leaderOffScreen: Bool
  private(set) var label: String; private(set) var jumpRequest: TimeLens?
  func update(lens: TimeLens, viewport: CGRect, leader: CGRect, now: Date)
  func jumpToNow(lens: TimeLens, viewport: CGRect, now: Date)
  func consumeJump() -> TimeLens?
}
```
`@MainActor @Observable final class SpineViewportState`: `init(lens:
TimeLens)`, `var expanded: Set<MissionId>`, `private(set) var lens: TimeLens`,
`private(set) var scrollY: CGFloat`, `pan(by: CGSize, viewport: CGRect,
contentHeight: CGFloat)`, `zoom(factor: Double, atCursorX: CGFloat)`, `zoom(_
step: ZoomStep, viewport: CGRect)` for ⌘= and ⌘-, `fit(index: SpineIndex,
viewport: CGRect, now: Date)` for ⌘0, `toggleExpanded(_:)`. `enum ZoomStep:
Sendable { case zoomIn, zoomOut }`; `struct OffScreenLeaderMarker: View` takes
`init(state: NowState, trailingInset: CGFloat, action: @escaping () -> Void)`;
and `struct TrackpadPanCapture: NSViewRepresentable` takes `init(isEnabled:
Bool, interactionInsets: EdgeInsets, onScroll: @escaping (CGSize) -> Void)`.
Steps: 1. `isLive` when `lens.x(lens.options.now) <= viewport.maxX + 0.5`;
otherwise `label` is `Now · <n> back`, `n` the coarsest of `d`, `h`, `m`
between `lens.t(viewport.maxX)` and `now`. 2. `jumpToNow` sets `jumpRequest` to
the current lens re-anchored so the live edge sits at `viewport.maxX`, keeping
the focus duration; the 09 `MissionBar` renders the control from this state. 3.
`leaderOffScreen` is true when `leader` does not intersect `viewport`; the
marker draws inside the canvas at `viewport.maxX - trailingInset`, left of the
chat, and jumps to Now. 4. Rewrite `TrackpadPanCapture` from the v2 idea, do
not copy it: a local `NSEvent` scroll-wheel monitor filtered by window and by
`interactionInsets` so the chat and mission bar keep their own scrolling,
non-precise deltas scaled by 18, coalesced per run-loop turn, event swallowed.
5. Horizontal delta shifts the focus window in time; vertical delta changes
`scrollY`, clamped to `0...max(0, contentHeight - viewport.height)`, never the
lens. 6. `zoom` uses `TimeLens.zoomed`; `MagnifyGesture` maps magnification to
`factor`, `⌘=` and `⌘-` use `1.25` and `0.8` about `viewport.midX`. 7. `fit`
sets the focus window to all open missions via `index.earliestOpen` and resets
`scrollY`. 8. Click calls `shell.select(_:)`, `Escape` returns to `.leader`.
Tests: `NowStateTests` — lit at the live edge and at a half-pixel overshoot;
`Now · 3d back` at three days, `Now · 5h back` at five hours; `consumeJump`
clears the request; `leaderOffScreen` flips exactly when the leader rect leaves
the viewport; a 100 pt horizontal pan moves `lens.t(viewport.midX)` and leaves
`SpineMetrics.standard` untouched; a vertical pan changes `scrollY` only, and
clamps; `zoom` holds the cursor time within 1 ms; `fit` shows the earliest.
Done when: `swift build` and `swift test` pass with that test file; commit.
Commit: `feat(desktop): now control and spine interaction`

### T10.9 canvas assembly
Goal: the one view that composes the spine and hands it to the 09 shell.
Reads: this file, `docs/plan/09-desktop-shell.md`, `PAPER-SPINE.md` artboard 1.
Writes: `SpineCanvasView.swift`, `SpineCanvasTests.swift`, and the one line of
`apps/macos/Sources/NetaDesktop/Shell/RootView.swift` holding
`CanvasPlaceholder`.
Contract:
```swift
struct SpineCanvasView: View {
  init(store: Store, shell: ShellState, viewport: SpineViewportState,
       now: NowState, router: CheckpointRouter)
}
```
Steps: 1. `GeometryReader` into a `ZStack`: `SpineBackdrop` at the bottom, the
materialised `MissionColumn` views placed with `.position`, `CheckpointLayer`,
the leader card, then `OffScreenLeaderMarker`. 2. Rebuild `SpineIndex` only
when the mission set changes; recompute `SpineVirtualiser.window` when the
lens, viewport or store revision changes. 3. Call `NowState.update` on every
recomputation, applying `consumeJump()`. 4. Apply `TrackpadPanCapture` with the
shell's insets; attach `⌘=`, `⌘-`, `⌘0`, `Escape`.
Tests: `SpineCanvasTests` against `FixtureNodeClient` — the fourteen-mission
fixture yields a leader card and fourteen columns; selecting a mission then an
agent updates `shell.selection` and `Escape` returns it to `.leader`; zoomed far
out, missions become ticks but the leader card stays.
Done when: `swift build` and `swift test` pass with that test file; commit.
Commit: `feat(desktop): assemble the spine canvas`
