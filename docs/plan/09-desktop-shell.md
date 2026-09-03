# 09 — Desktop shell

The macOS app's frame: Node client, store, window, floating glass surfaces, toolbar, mission bar,
navigator. The spine canvas is `10-desktop-spine.md` and the chat body `11-desktop-chat.md`; each
gets a placeholder view here.

Read first: `docs/plan/README.md`, `docs/plan/01-domain.md`, `design/canvas-directions/BRIEF.md`,
`design/canvas-directions/PAPER-SPINE.md` (all three revisions; Revision 3 supersedes earlier
surfaces), and `MANIFESTO.md` sections "Clients, cache, and offline state", "Desktop information
architecture", "The mission inbox", "Visual direction", "Rejected desktop patterns".

Depends on 04. `test/fixtures/node-snapshot.json` and `node-events.ndjson` are recorded by 04 and
are the only data the app's tests and previews use. If they are absent, stop and report; never
invent the protocol or hand-write a fixture.

## Fixed decisions

- Swift 6 language mode, macOS 26, SwiftUI, SwiftPM, no Xcode project, no external packages. Every
  type is `Sendable` or `@MainActor`; every declaration in a Contract below is `public` unless
  marked otherwise.
- The app never owns a session, never spawns an agent, and only reads `~/.neta/node.json`. On
  reconnect the cache is replaced whole, never patched. `Store` holds Node data, `ShellState` the
  person's view; views own nothing.
- Build and test from `apps/macos`; paths below are relative to it. Sources in
  `Sources/NetaDesktop/`: `Node/`, `Model/` (mirrors, store), `Shell/` (window, layout, toolbar,
  mission bar, navigator), `Canvas/` (10), `Chat/` (11), `Theme/`. Tests in
  `Tests/NetaDesktopTests/`.
- Geometry, from PAPER-SPINE Revision 3: the canvas fills the window and nothing narrows or pushes
  it; the toolbar capsule sits top centre 12 down, the chat is 410 wide on the right (16 inset, top
  48) and hidden only by the person, the mission bar is a 52-tall capsule 16 inset along the bottom,
  the navigator a 300-wide overlay 12 inset in the chat's band. Liquid Glass on every floating
  surface and control, through `Theme/`; nodes, edges and the spine never.
- Keyboard: `⌘L` navigator, `⌘K` focus composer, `⌘.` cancel turn, `⌘0` Fit, `⌘=`/`⌘-` time zoom,
  `Escape` close overlay. Nothing else is bound here.

## Tasks

### T9.1 theme tokens and the glass material
Goal: every color, font and metric in one place, plus the Liquid Glass modifier.
Reads: this file, `design/canvas-directions/BRIEF.md`, `PAPER-SPINE.md` (Rev 3).
Writes: `Sources/NetaDesktop/Theme/{Theme,Glass}.swift`, `Tests/NetaDesktopTests/ThemeTests.swift`.
Contract:
```swift
enum Theme {
  static let ground, violet, mint, blue, amber, green, red: Color
  static let agentHues: [Color]                   // six, in BRIEF order
  static let textPrimary, textSecondary: Color    // white 0.96 / 0.64
  static let nodeFill, nodeBorder, divider, subtleSurface: Color
  static func text(_ s: CGFloat, _ w: Font.Weight) -> Font  // SF Pro
  static func mono(_ s: CGFloat, _ w: Font.Weight) -> Font  // SF Mono
  static func digits(_ font: Font) -> Font                  // tabular numerals
  enum Metric {   // CGFloat, from the geometry above: panelRadius 22, barRadius 26,
    // edgeInset 16, navigatorInset 12, chatWidth 410, navigatorWidth 300,
    // surfaceTop 48, missionBarHeight 52, barGap 12, hoverEdge 6
    static func concentric(outer: CGFloat, padding: CGFloat) -> CGFloat }
}
enum GlassShape: Sendable { case panel, capsule, rounded(CGFloat) }
extension View { func netaGlass(_ s: GlassShape = .panel, tint: Color? = nil) -> some View }
```
Steps: 1. Colors are literals from BRIEF; no color is defined elsewhere in the app. 2. `digits` and
`mono` apply `.monospacedDigit()`, used on every ordinal, age and percentage. 3. `netaGlass` is the
only call site of `.glassEffect` outside `Theme/`; the leader rim takes the violet tint. 4.
`concentric` is `max(outer - padding, 6)`.
Tests: `ThemeTests.swift` — each BRIEF hex round-trips within 1/255; `agentHues.count == 6`;
`concentric(outer: 22, padding: 8) == 14`, never below 6; `digits` yields a monospaced-digit font.
Done when: `swift build` and `swift test` pass in `apps/macos`, the test passes, the commit is made.
Commit: `feat(desktop): theme tokens and glass material`

### T9.2 domain mirrors
Goal: Swift mirrors of every 01-domain type that decode the recorded fixture.
Reads: this file, `docs/plan/01-domain.md`, `test/fixtures/node-snapshot.json`.
Writes: `Sources/NetaDesktop/Model/Domain.swift`, `Tests/NetaDesktopTests/DomainDecodingTests.swift`.
Contract: identical field names, all `Codable, Hashable, Sendable`, `Identifiable` where there is
an `id`.
```swift
typealias Ulid = String
typealias MachineId = Ulid; typealias MissionId = Ulid; typealias AgentId = Ulid
typealias SessionId = Ulid; typealias TurnId = Ulid
struct Workspace, WorkspaceRoot, Machine, Leader, Mission, MissionChange, Worktree,
       Agent, Event, Block, Turn, DecisionRecord
enum WorkspaceKind, LeaderMode, Access, MissionState, Disposition, AgentState,
     Role, BlockKind: String, Codable, Sendable
enum MissionLead: Codable, Sendable { case leader, agent(agentId: Ulid) }
enum EventKind: Codable, Sendable { /* 01-domain cases */ case unknown(String) }
enum DataValue: Codable, Sendable { case string(String), number(Double), bool(Bool), null }
struct Snapshot: Codable, Sendable {          // 04's SnapshotResult, field for field
  let machine: Machine; let workspaces: [Workspace]; let leaders: [Leader]
  let missions: [Mission]; let hasOlder: Bool; let agents: [Agent]
  let completedCounts: [Ulid: Int]; let events: [Event]; let attention: [Mission]
  let windowDays: Int; let protocolVersion: Int; let at: Date }
enum NodeNotification: Sendable { case event(Event), state(StateChange),
                                       turn(TurnChange), node(NodeLifecycle) }
extension Mission { var needsPerson: Bool }  // blocked|failed|readyToClose|mergedNotClosed
enum NetaJSON { static let decoder: JSONDecoder; static let encoder: JSONEncoder }
```
Steps: 1. Transcribe the types; no renaming `CodingKeys`, no `convertFromSnakeCase`. 2. Dates are
`Date`; `NetaJSON` uses ISO 8601 with fractional seconds, UTC, both ways. 3. Unknown enum cases
decode to `.unknown(raw)` and never throw — a newer Node must not crash an older app. 4.
`StateChange`, `TurnChange`, `NodeLifecycle` mirror the `state`, `turn`, `node` payloads in
`04-node.md`.
Tests: `DomainDecodingTests.swift` — `node-snapshot.json` decodes to the fixture's mission count and
one mission's `number`, `name`, `state`, `createdAt` to the ms; every `node-events.ndjson` line
decodes; an unknown `kind` becomes `.unknown`; a `Mission` re-encoded and decoded is equal.
Done when: `swift build` and `swift test` pass in `apps/macos`, the test passes, the commit is made.
Commit: `feat(desktop): codable domain mirrors`

### T9.3 node client protocol and fixture client
Goal: the one interface the app talks to, and the fixture replay behind it.
Reads: this file, `docs/plan/01-domain.md`, `.../Model/Domain.swift`.
Writes: `Sources/NetaDesktop/Node/{NodeClient,FixtureNodeClient}.swift`,
`Tests/NetaDesktopTests/FixtureNodeClientTests.swift`.
Contract:
```swift
protocol NodeClient: Sendable {
  func connect() async throws; func snapshot() async throws -> Snapshot
  func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission]
  func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event]
  func conversationTail(sessionId: Ulid, cursor: String?, limit: Int) async throws -> ConversationPage
  func prompt(sessionId: Ulid, text: String) async throws -> Ulid   // turnId
  func cancel(sessionId: Ulid) async throws
  func setModel(sessionId: Ulid, model: String) async throws
  func listModels(provider: String) async throws -> [ModelInfo]
  func setMode(workspaceId: String, mode: LeaderMode) async throws
  func pin(missionId: Ulid, pinned: Bool) async throws
  func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws
  var notifications: AsyncStream<NodeNotification> { get } }
struct ConversationPage: Codable, Sendable {   // 04's conversation.tail result
  let turns: [Turn]; let blocks: [Block]; let nextCursor: String?; let prevCursor: String? }
struct ModelInfo: Codable, Sendable, Identifiable { let id, provider, label: String }
actor FixtureNodeClient: NodeClient {
  init(fixtureDirectory: URL = FixtureNodeClient.repoFixtures)  // test/fixtures via #filePath
  func emitNext() -> Bool                                       // push one recorded event
  func emit(_ notification: NodeNotification)                   // push a made-up one
  private(set) var calls: [(method: String, json: String)] }    // 11 asserts on these
```
Steps: 1. The fixture client loads the snapshot once and answers reads from it;
`missionsList`/`eventsList` page backwards from `before`. 2. Recorded events replay through
`notifications`, one per `emitNext()`, so tests drive time and previews can run a timer. 3. Writes
mutate the in-memory copy, emit the matching notification, and never touch disk.
Tests: `FixtureNodeClientTests.swift` — `snapshot()` returns the fixture's missions;
`missionsList(before:)` pages strictly older without repeats; `emitNext()` replays in order then
finishes the stream; `prompt` emits a `turn`.
Done when: `swift build` and `swift test` pass in `apps/macos`, the test passes, the commit is made.
Commit: `feat(desktop): node client protocol and fixture client`

### T9.4 socket client
Goal: the real transport, and starting the Node when it is not running.
Reads: this file, `docs/plan/04-node.md`, `.../Node/NodeClient.swift`.
Writes: `Sources/NetaDesktop/Node/{SocketNodeClient,LineFramer}.swift`,
`Tests/NetaDesktopTests/SocketNodeClientTests.swift`.
Contract:
```swift
actor SocketNodeClient: NodeClient {
  init(netaDirectory: URL = SocketNodeClient.defaultDirectory,   // ~/.neta
       launcher: any NodeLauncher = BundledNodeLauncher()) }
struct NodeInfo: Codable, Sendable {   // node.json
  let socket: String; let token: String; let pid: Int; let protocolVersion: Int }
protocol NodeLauncher: Sendable { func start() async throws }
struct BundledNodeLauncher: NodeLauncher {}   // bundled neta: node start --detach
enum NodeClientError: Error, Sendable { case nodeUnavailable, protocolMismatch(Int),
  rejected(String), rpc(code: Int, message: String), disconnected }
struct LineFramer: Sendable {          // NDJSON, no length prefix
  mutating func push(_ data: Data) -> [Data]
  static func frame(_ line: Data) -> Data }
```
Steps: 1. Read `node.json`; connect with `NWConnection(to: .unix(path:))`; the first message is
`hello` with the token and protocol version, a mismatch throws `protocolMismatch`. 2. Requests carry
a monotonic integer id and resume a continuation held by id; notifications (no id) are yielded on
the stream. 3. If the socket is missing or refused, call `launcher.start()` (the bundled `neta` in
`Bundle.main` Resources) and retry every 250 ms for 5 s, then throw `nodeUnavailable`. 4. On
disconnect finish the stream; the caller reconnects with a fresh snapshot.
Tests: `SocketNodeClientTests.swift` — `LineFramer` splits across arbitrary chunk boundaries and a
line split mid-UTF-8, ignores blank lines, never emits a partial line; request ids increase; an
error response maps to `.rpc`; a launcher stub that never creates the socket makes `connect()` throw
`nodeUnavailable` within 5 s. No test opens a real socket or Node.
Done when: `swift build` and `swift test` pass in `apps/macos`, the test passes, the commit is made.
Commit: `feat(desktop): socket node client`

### T9.5 store
Goal: the app's picture of the Node, replaced on reconnect, patched by notifications.
Reads: this file, `MANIFESTO.md` "Clients, cache, and offline state", `.../Domain.swift`.
Writes: `Sources/NetaDesktop/Model/Store.swift`, `Tests/NetaDesktopTests/StoreTests.swift`.
Contract:
```swift
@Observable @MainActor final class Store {
  private(set) var machine: Machine?; private(set) var workspaces: [Workspace]
  private(set) var leader: Leader?; private(set) var nodeState: NodeLifecycle?
  private(set) var missions: [Mission]            // sorted by createdAt ascending
  private(set) var missionsById: [Ulid: Mission]; private(set) var missionsByNumber: [Int: Mission]
  private(set) var agentsById: [Ulid: Agent]; private(set) var events: [Event]
  private(set) var window: ClosedRange<Date>   // what the canvas may draw
  var attention: [Mission] { get }             // derived, never stored
  func replace(snapshot: Snapshot); func apply(notification: NodeNotification)
  func extendWindow(back: Date, missions: [Mission], events: [Event])
  func blocks(for sessionId: Ulid) -> [Block]; func noteViewed(_ sessionId: Ulid)
  func cache(_ page: ConversationPage, for sessionId: Ulid)
  var cachedSessionIds: [Ulid] { get }   // most recent first
  func cachedBytes(for sessionId: Ulid) -> Int }
```
Steps: 1. `replace` swaps every collection in one assignment set and resets `window` to `[oldest
open mission's createdAt, now]`; nothing survives the previous connection. 2. `apply` handles
`event` (append, keep sorted), `state` (upsert a Mission, Agent or Leader, refresh both indexes),
`turn` (append to that session's cache), `node` (store it). 3. `attention` is computed on read:
`missions.filter(\.needsPerson)` ordered blocked, failed, readyToClose, mergedNotClosed, then by
number. 4. `extendWindow` merges older pages and moves `window.lowerBound` back, dropping nothing
loaded. 5. The block cache holds at most 1 MB per session and 100 sessions, evicting the least
recently viewed session whole; only `noteViewed` reorders recency.
Tests: `StoreTests.swift` — a second `replace` leaves no trace of the first; `apply` upserts a
mission and reindexes by number; an event for an unknown mission is kept without crashing;
`extendWindow` moves the lower bound back and keeps loaded missions; `attention` matches the order
rule; 101 cached sessions leave the 100 most recently viewed; a session over 1 MB drops its oldest
blocks.
Done when: `swift build` and `swift test` pass in `apps/macos`, the test passes, the commit is made.
Commit: `feat(desktop): observable store`

### T9.6 shell state, selection and commands
Goal: what the person is looking at, and the keyboard.
Reads: this file, `MANIFESTO.md` "Desktop information architecture", `.../Model/Store.swift`.
Writes: `Sources/NetaDesktop/Shell/{ShellState,Commands}.swift`,
`Tests/NetaDesktopTests/ShellStateTests.swift`.
Contract:
```swift
enum Selection: Hashable, Sendable { case leader, mission(Ulid), agent(Ulid) }
@Observable @MainActor final class ShellState {
  var selection: Selection = .leader
  var chatVisible = true; var navigatorVisible = false; var composerFocused = false
  var timeZoom: Double = 1.0        // 0.25 ... 4.0
  private(set) var fitRequested = 0
  func select(_ selection: Selection); func sessionId(in store: Store) -> Ulid?
  func toggleNavigator(); func dismissOverlay() -> Bool   // Escape; false if none
  func fit(); func zoomIn(); func zoomOut(); var zoomPercent: Int { get } }
struct NetaCommands: Commands {}    // ⌘L ⌘K ⌘. ⌘0 ⌘= ⌘-
```
Steps: 1. `sessionId` resolves `.leader` to the leader's session, `.mission(id)` to that mission's
lead session (the leader's when the lead is the leader), `.agent(id)` to that agent's session; an
unknown id returns nil and selection falls back to `.leader`. 2. Selecting opens that session's
chat; only the person's toggle sets `chatVisible = false`. 3. Zoom clamps to 0.25...4 in ×1.25
steps; `fit` resets to 1.0 and bumps `fitRequested`, which 10 observes. 4. `NetaCommands` binds the
six menu shortcuts; Escape calls `dismissOverlay` via `.onExitCommand` in the root view.
Tests: `ShellStateTests.swift` — each selection case resolves to the right session id against a
fixture-backed store; an unknown id falls back to `.leader`; selecting never changes `chatVisible`;
`dismissOverlay` closes the navigator and returns false when nothing is open; zoom clamps at both
ends.
Done when: `swift build` and `swift test` pass in `apps/macos`, the test passes, the commit is made.
Commit: `feat(desktop): shell state and keyboard commands`

### T9.7 window and layout
Goal: every floating surface's frame, from a pure function, so the chat can never sit on the
mission bar.
Reads: this file, `.../Shell/ShellState.swift`.
Writes: `Sources/NetaDesktop/Shell/{ShellLayout,RootView}.swift`,
`Sources/NetaDesktop/NetaDesktopApp.swift` (edit), `Tests/NetaDesktopTests/ShellLayoutTests.swift`.
Contract:
```swift
struct ShellLayout: Equatable, Sendable {
  let canvas: CGRect       // always the full window
  let chat: CGRect?        // nil when hidden
  let missionBar: CGRect
  let navigator: CGRect?   // nil when hidden
  static func compute(size: CGSize, chatVisible: Bool, navigatorVisible: Bool) -> ShellLayout }
struct RootView: View { init(store: Store, shell: ShellState, client: any NodeClient) }
struct CanvasPlaceholder: View {}   // replaced by 10
struct ChatPlaceholder: View {}     // replaced by 11
```
Steps: 1. `compute`: mission bar `x = 16`, `width = size.width - 32`, `height = 52`, `maxY =
size.height - 16`; chat `width = min(410, size.width - 360)`, `x = size.width - 16 - width`, `y =
48`, `maxY = missionBar.minY - 12`; navigator `x = 12`, `width = 300`, the same band; canvas the
full size. 2. `RootView` is a `GeometryReader` over a `ZStack` — canvas, toolbar capsule centred at
the top, navigator, chat, mission bar — each `.netaGlass(...)` and positioned from the layout, and
the canvas is told which rects are covered so no floating surface steals trackpad panning. 3.
`NetaDesktopApp` builds one `Store`, `ShellState` and `SocketNodeClient`, calls `connect()` then
`snapshot()` into `replace(snapshot:)`, feeds `notifications` into `apply(notification:)`, and
reconnects with a full snapshot; the window stays `.hiddenTitleBar`, 1600×1000 default, 1100×700
minimum.
Tests: `ShellLayoutTests.swift` — at 1100×700 and 1600×1000 the chat never overlaps the mission bar
(`chat!.maxY <= missionBar.minY`, gap 12); every rect lies inside the window; the chat is at least
320 wide and leaves 360 points of canvas uncovered on the left; hiding the chat changes neither the
bar nor the canvas.
Done when: `swift build` and `swift test` pass in `apps/macos`, the test passes, the commit is made.
Commit: `feat(desktop): window and shell layout`

### T9.8 toolbar capsule
Goal: the only global control surface — workspace, machine, Fit, time zoom.
Reads: this file, `MANIFESTO.md` "Desktop information architecture".
Writes: `Sources/NetaDesktop/Shell/ToolbarCapsule.swift`,
`Tests/NetaDesktopTests/ToolbarTests.swift`.
Contract:
```swift
struct ToolbarModel: Equatable, Sendable {
  let workspaces: [Workspace]; let selectedWorkspaceId: String
  let machines: [Machine]?    // nil when the workspace has one machine
  let selectedMachineId: Ulid?; let zoomPercent: Int
  static func make(store: Store, shell: ShellState) -> ToolbarModel }
struct ToolbarCapsule: View { init(model: ToolbarModel, shell: ShellState) }
```
Steps: 1. `machines` is non-nil only when the selected workspace has roots on more than one machine.
2. The capsule renders `workspace ▾`, the machine menu when present, `Fit`, then `−  100%  +` with
the percentage in mono tabular digits; capsule and controls are glass with concentric radii. 3.
Buttons call `shell.fit()`, `zoomIn()`, `zoomOut()`; the toolbar has no other action.
Tests: `ToolbarTests.swift` — one root gives `machines == nil`, two roots on two machines give two
entries; `zoomPercent` tracks `shell.timeZoom`; a model built from the fixture store carries no
mission, agent or mode field.
Done when: `swift build` and `swift test` pass in `apps/macos`, the test passes, the commit is made.
Commit: `feat(desktop): toolbar capsule`

### T9.9 mission bar
Goal: the inbox — leader, Now, waiting missions with marks, running ones compact.
Reads: this file, `MANIFESTO.md` "The mission inbox", `PAPER-SPINE.md` (item 5).
Writes: `Sources/NetaDesktop/Shell/MissionBar.swift`,
`Tests/NetaDesktopTests/MissionBarTests.swift`.
Contract:
```swift
enum MissionBarItem: Equatable, Identifiable, Sendable {
  case leader(name: String, mode: LeaderMode)
  case now(lit: Bool)       // lit state supplied by 10
  case divider
  case waiting(Mission)     // number, name, state label, attention mark
  case running(Mission)     // number and a mint dot only
  var id: String { get } }
enum MissionBarModel {
  static func items(missions: [Mission], leader: Leader?, nowLit: Bool) -> [MissionBarItem] }
struct MissionBarView: View {
  init(items: [MissionBarItem], selection: Selection, onSelect: @escaping (Selection) -> Void) }
```
Steps: 1. Order: leader, Now, divider, waiting missions grouped blocked, failed, readyToClose,
mergedNotClosed and by number ascending within each group, then running missions by number
ascending; closed missions never appear. 2. Every item carries a text state label and a mark; state
is never carried by color alone. 3. Selecting calls `onSelect(.mission(id))`; the shell opens that
lead's conversation and 10 pans the spine to it. 4. One glass capsule of glass chips, scrolling
horizontally on overflow: no counts, no cards, no status tiles, never the Lead/Lead++ control.
Tests: `MissionBarTests.swift` — a fixture with all four waiting states plus running missions
produces exactly that order; closed missions are absent; every `waiting` item has a non-empty state
label; `now(lit:)` follows the flag.
Done when: `swift build` and `swift test` pass in `apps/macos`, the test passes, the commit is made.
Commit: `feat(desktop): mission bar`

### T9.10 navigator overlay
Goal: the auto-hiding jump list — workspaces, machines when they matter, missions.
Reads: this file, `MANIFESTO.md` "Desktop information architecture", `PAPER-SPINE.md` (Rev 2).
Writes: `Sources/NetaDesktop/Shell/Navigator.swift`, `Tests/NetaDesktopTests/NavigatorTests.swift`.
Contract:
```swift
struct NavigatorModel: Equatable, Sendable {
  struct Row: Equatable, Identifiable, Sendable {
    let id: Ulid; let number: Int; let name: String; let stateLabel: String; let tint: Color }
  let workspaces: [Workspace]; let machines: [Machine]?   // machines nil when one
  let open: [Row]           // number descending
  let archived: [Row]       // closedAt descending
  static func make(store: Store, query: String) -> NavigatorModel }
struct NavigatorOverlay: View {
  init(model: NavigatorModel, shell: ShellState, onSelect: @escaping (Selection) -> Void) }
struct NavigatorEdgeTrigger: View { init(shell: ShellState) }   // 6pt hover strip
```
Steps: 1. `make` filters both groups by `query`: a leading `#` or digits match the number prefix,
anything else is a case-insensitive substring of the name; an empty query returns everything. 2. The
overlay is a floating glass panel holding a `Jump to…` field with a `⌘L` hint in mono, then
WORKSPACES, MACHINE when present, then MISSIONS as OPEN and ARCHIVED groups; no leader row, no
counts, no cards, no status tiles. 3. It overlays the canvas and moves nothing; the edge trigger
sets `navigatorVisible`; Escape or a canvas click clears it. 4. Selecting a row calls
`onSelect(.mission(id))` and closes the overlay.
Tests: `NavigatorTests.swift` — `open` is number descending, `archived` closedAt descending; a
closed mission never appears in `open`; `#30` matches by number prefix and `refund`
case-insensitively by name; an empty query returns every mission; one machine gives `machines ==
nil`; no leader row, no group counts.
Done when: `swift build` and `swift test` pass in `apps/macos`, the test passes, the commit is made.
Commit: `feat(desktop): navigator overlay`
