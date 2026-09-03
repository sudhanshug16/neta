# 11 — Desktop chat

The chat surface: the selected session's ACP conversation, header, composer
and Details inspector. Paths in tasks are relative to `apps/macos/`, with
`Chat/…` short for `Sources/NetaDesktop/Chat/…`. Chat is primary; Details is
one action, never a tab bar; 09's `Theme` owns colours, radii and glass.
Code blocks below omit `public`; every declaration in them is public.

Read first: `docs/plan/README.md`, `docs/plan/01-domain.md` (Turn, Block,
Leader, DecisionRecord), `docs/plan/09-desktop-shell.md`,
`design/canvas-directions/BRIEF.md` (chat section, tokens),
`design/canvas-directions/PAPER-SPINE.md` (Artboard 2, Revision 2 chat and
composer items, Revision 3 chat glass), `MANIFESTO.md` sections "Lead and
Lead++", "ACP, steering, and recovery", "Desktop information architecture".

## What 09 provides

Imported, never redefined here; if 09 ships a different name, 09 wins.

- `NodeClient`: `conversationTail(sessionId:cursor:limit:)`,
  `prompt(sessionId:text:)`, `cancel(sessionId:)`, `setModel(sessionId:model:)`,
  `listModels(provider:)`, `setMode(workspaceId:mode:)`, with `ConversationPage`
  (`turns`, `blocks`, `nextCursor`, `prevCursor`) and `ModelInfo` (`id`,
  `provider`, `label`);
  and `notifications: AsyncStream<NodeNotification>`.
- `TurnChange { sessionId: SessionId; turn: Turn?; block: Block? }` — the
  `turn` notification: a turn opening or closing, or a block appended.
- `Selection { case leader; case mission(MissionId); case agent(AgentId) }`.
- `Store` (`@MainActor @Observable`): `leader`, `missionsById`, `agentsById`,
  `blocks(for:)`; and `ShellState`: `selection`, `sessionId(in:)`.
- `FixtureNodeClient(fixtureDirectory:)` with `emitNext()`,
  `emit(_: NodeNotification)` and
  `private(set) var calls: [(method: String, json: String)]`.
- `Theme`, `NodeNotification`, and Swift mirrors of the 01 types (`Turn`,
  `Block`, `BlockKind`, `Role`, `Mission`, `Agent`, `Leader`, `LeaderMode`,
  `Access`, `DecisionRecord`, the id typealiases).

## Tasks

### T11.1 turn model and streaming
Goal: the chat view model holds turns and applies streaming deltas.
Reads: this file, `docs/plan/01-domain.md`, `docs/plan/09-desktop-shell.md`.
Writes: `Chat/ChatTurn.swift`, `Chat/ChatViewModel.swift`,
`Tests/NetaDesktopTests/ChatViewModelTests.swift`.
Contract:
```swift
struct ChatTurn: Identifiable, Equatable, Sendable {
  let id: TurnId; let role: Role; let startedAt: Date
  var endedAt: Date?; var cancelled: Bool; var blocks: [Block]
  var isOpen: Bool { endedAt == nil && !cancelled }
}
struct ScrollRequest: Equatable, Sendable {
  let turnId: TurnId; let flash: Bool
}
@MainActor @Observable final class ChatViewModel {
  init(client: any NodeClient, sessionId: SessionId)
  private(set) var turns: [ChatTurn]; var atBottom: Bool
  private(set) var openTurnId: TurnId?
  private(set) var pendingScroll: ScrollRequest?
  var autoScrollTarget: TurnId? { get }
  func start() async; func apply(_ payload: TurnChange)
  func consumeScroll() -> ScrollRequest?
}
```
Steps: 1. `start()` tails the newest page (`conversation.tail`), then passes
every `.turn` notification to `apply`, which drops other sessions. 2. A
`turn` inserts or updates by id, `turns` sorted by `startedAt`; `endedAt` or
`cancelled` closes it and clears a matching `openTurnId`. 3. A `block`
inserts into `block.turnId` by `seq` — out-of-order deltas land right, a
repeat replaces, an unknown `turnId` opens a synthetic turn from its role and
time. 4. `autoScrollTarget` is the newest turn id while `atBottom`, else nil.
Tests: three streamed blocks append to the open turn in order; an
out-of-order `seq` sorts in and a repeat replaces; an unknown turn id opens a
turn; another session is ignored; `autoScrollTarget` nil unless `atBottom`.
Done when: `swift build` and `swift test` pass in `apps/macos`.
Commit: `feat(desktop): chat turn model and streaming`

### T11.2 paging and scroll to turn
Goal: `scrollTo(turnId:)`, called by 10's checkpoints, reaches any turn by
paging older blocks inside the 1 MB per-session cache.
Reads: this file, `Chat/ChatViewModel.swift`, `MANIFESTO.md` section
"Clients, cache, and offline state".
Writes: `Chat/ChatPaging.swift`,
`Tests/NetaDesktopTests/ChatPagingTests.swift`.
Contract:
```swift
// pages are 09's `ConversationPage`: turns, blocks, nextCursor, prevCursor
enum ChatCache { static let limitBytes = 1_048_576 }
extension ChatViewModel {
  func scrollTo(turnId: TurnId) async
  @discardableResult func loadOlder() async -> Bool
  func jumpToLatest() async; func trim(around a: TurnId)
  var cacheBytes: Int { get }
  var hasOlder: Bool { get }; var hasNewer: Bool { get }
}
```
Steps: 1. `scrollTo` sets `pendingScroll` with `flash: true` when the turn
is loaded; else it anchors on it with `conversation.tail`'s `turnId` (04) and
calls `loadOlder` until the turn arrives, `prevCursor` is nil, or 32 pages are
fetched, leaving `pendingScroll` nil if it never appears. 2. `loadOlder` calls
`conversation.tail` with `direction: "backward"` from the oldest page's
`prevCursor` (04); each page prepends its turns and blocks and adds their
encoded size to `cacheBytes`, and `hasOlder` is `prevCursor != nil`.
3. `trim(around:)` keeps a contiguous window around the anchor while
`cacheBytes` exceeds `ChatCache.limitBytes`, dropping the turns furthest from
it and setting `hasOlder`/`hasNewer`. 4. While `hasNewer`, `apply` drops
payloads outside the window; `jumpToLatest` re-tails and returns to bottom.
Tests: a loaded turn sets the flashing request; an unloaded one pages three
times and stops at the target; a target never returned stops at a nil cursor
with no pending scroll; trim holds `cacheBytes` under 1 MB; `jumpToLatest`
restores the tail.
Done when: `swift build` and `swift test` pass in `apps/macos`.
Commit: `feat(desktop): conversation paging and scroll to turn`

### T11.3 Markdown-lite
Goal: the Markdown subset the transcript renders, as a pure parser.
Reads: this file.
Writes: `Chat/MarkdownLite.swift`,
`Tests/NetaDesktopTests/MarkdownLiteTests.swift`.
Contract:
```swift
enum MarkdownSpan: Equatable, Sendable { case text(String); case code(String) }
enum MarkdownBlock: Equatable, Sendable {
  case paragraph([MarkdownSpan]); case code(language: String?, text: String)
  case list(ordered: Bool, items: [[MarkdownSpan]])
}
enum MarkdownLite { static func parse(_ text: String) -> [MarkdownBlock] }
```
Steps: 1. Normalise CRLF, split on blank lines. 2. A fence (three backticks,
optionally a language word) runs to its closing fence or the end of input.
3. A block whose every line starts `- `, `* ` or `<digits>. ` is a list.
4. In a paragraph or list item a matched backtick pair makes a `code` span;
an unmatched backtick stays literal. 5. No images, emphasis, headings or
links: `![alt](url)` and everything else stay literal text.
Tests: two paragraphs from one blank line; inline code with and without a
closing backtick; a fence with a language, one without, one never closed;
bullet and ordered lists; image syntax stays literal; CRLF equals LF.
Done when: `swift build` and `swift test` pass in `apps/macos`.
Commit: `feat(desktop): markdown-lite for the transcript`

### T11.4 block and turn rendering
Goal: every block kind renders and the testable parts stay pure.
Reads: this file, `Chat/MarkdownLite.swift`,
`design/canvas-directions/BRIEF.md`.
Writes: `Chat/BlockView.swift`, `Chat/TurnView.swift`,
`Tests/NetaDesktopTests/BlockRenderTests.swift`.
Contract:
```swift
struct BlockStyle: Equatable, Sendable {
  let size: CGFloat; let weight: Font.Weight; let mono: Bool
  let secondary: Bool; let alignment: HorizontalAlignment
  static func of(kind: BlockKind, role: Role) -> BlockStyle
}
struct DiffLine: Equatable, Sendable {
  enum Kind: Sendable { case added, removed, context, meta }
  let kind: Kind; let text: String
}
enum BlockText {
  static func thoughtSummary(_ t: String, limit: Int = 120) -> String
  static func toolTitle(_ b: Block) -> String
  static func toolDetail(_ b: Block) -> String?
  static func diffLines(_ text: String) -> [DiffLine]
}
struct BlockView: View {
  init(block: Block, expanded: Bool, onToggle: @escaping () -> Void)
}
struct TurnView: View { init(turn: ChatTurn, flashing: Bool) }
```
Steps: 1. `text` renders `MarkdownLite.parse`. 2. `thought` renders
`thoughtSummary` dimmed on one line, expanding to the full text. 3. `tool`
renders `toolTitle` with a chevron disclosing `toolDetail` (the block's
`data` as sorted `key: value` lines), absent when there is none. 4. `diff`
renders `diffLines` in mono with added and removed tinting; `status` is
centred at 10/500 secondary. 5. `TurnView` puts user turns in a violet glass
bubble and agent turns on the subtle surface, timestamp beneath in 10 px
mono, flashing once when `flashing` becomes true.
Tests: `BlockStyle.of` over all five kinds and both roles, including the
centred secondary status line; `thoughtSummary` truncates on a word boundary;
`toolDetail` nil for empty `data`, sorted otherwise; `diffLines` classifies
`+`, `-`, `@@`, context, and `+++`/`---` as meta.
Done when: `swift build` and `swift test` pass in `apps/macos`.
Commit: `feat(desktop): transcript block rendering`

### T11.5 header and Lead++ strip
Goal: the path header, leader tag, subtitle, Details button, Lead++ strip.
Reads: this file, `design/canvas-directions/PAPER-SPINE.md` (Artboard 2,
Revision 2), `MANIFESTO.md` section "Lead and Lead++".
Writes: `Chat/ChatPath.swift`, `Chat/ChatHeaderView.swift`,
`Chat/LeadPlusStrip.swift`, `Tests/NetaDesktopTests/ChatHeaderTests.swift`.
Contract:
```swift
struct ChatPathSegment: Identifiable, Equatable, Sendable {
  let id: String; let label: String
  let selection: Selection; let isLast: Bool
}
enum ChatPath {
  static func segments(for s: Selection, store: Store) -> [ChatPathSegment]
  static func subtitle(for s: Selection, store: Store) -> String
  static func showsLeaderTag(for s: Selection) -> Bool
}
enum LeadPlusStripModel {
  static func isVisible(_ leader: Leader?, _ s: Selection) -> Bool
  static func text(minutes: Int, mission: Mission?) -> String
}
struct ChatHeaderView: View {
  init(selection: Selection, store: Store, onDetails: @escaping () -> Void,
       onSelect: @escaping (Selection) -> Void)
}
struct LeadPlusStrip: View { init(minutes: Int, mission: Mission?) }
```
Steps: 1. Segments start at the leader, add `#<number> <name>` for a mission
and the agent's name for an agent — `Halden › #304 Rate limiter on /search ›
Thane`, or `Halden` alone for the leader; a mission led by the leader ends at
the mission. Only the last segment is primary 14/600; earlier ones are
secondary links calling `onSelect`. 2. Subtitle is `provider · model ·
State`, with `read-only`/`read-write` before the state for agents;
`WORKSPACE LEADER` shows only for `.leader`; the `Details` capsule trails the
header; no Stop or mode control here. 3. The strip shows for a leader in
`leadPlus`, violet glass at 18% with a clock icon, minutes
`modeActiveMs / 60_000` floored, text `Lead++ active <n> min · #<number>
<name>` without the mission clause when there is none.
Tests: the leader path is one segment with the tag, an agent path three with
selections on the first two, a leader-led mission two; subtitles for a
leader and a read-only agent; the strip is hidden for an agent and for a
leader in `lead`, and its text drops the missing mission clause.
Done when: `swift build` and `swift test` pass in `apps/macos`.
Commit: `feat(desktop): chat header path and Lead++ strip`

### T11.6 composer
Goal: the controls row, growing field, Stop/send button, archived form.
Reads: this file, `docs/plan/README.md` (protocol summary),
`design/canvas-directions/PAPER-SPINE.md` (Revision 2 composer).
Writes: `Chat/ComposerModel.swift`, `Chat/ComposerView.swift`,
`Tests/NetaDesktopTests/ComposerTests.swift`.
Contract:
```swift
enum ComposerButton: Equatable, Sendable {
  case stop, send, sendDisabled, none
}
@MainActor @Observable final class ComposerModel {
  init(client: any NodeClient, store: Store, sessionId: SessionId,
       selection: Selection)
  var draft: String; var hasOpenTurn: Bool; var isArchived: Bool
  private(set) var models: [ModelInfo]                     // 09's type
  private(set) var selectedModel: String
  var button: ComposerButton { get }; var lineCount: Int { get }
  var modelPickerEnabled: Bool { get }; var showsModeControl: Bool { get }
  var placeholder: String { get }
  func loadModels() async; func send() async; func stop() async
  func setModel(_ id: String) async; func setMode(_ mode: LeaderMode) async
}
struct ComposerView: View { init(model: ComposerModel) }
```
Steps: 1. `button` is `.none` when archived, `.stop` with an open turn,
`.send` when the trimmed draft is non-empty, else `.sendDisabled`; Stop is a
square glyph, send the mint arrow. 2. `modelPickerEnabled` is false while a
turn is open or the session is archived; `loadModels` calls `models.list`,
`setModel` calls `conversation.setModel`. 3. `showsModeControl` is true only
for `.leader` and a mission lead (`canSpawn`); the compact `Lead | Lead++`
control's help text says "build access"; `setMode` calls `leader.setMode`
even during an open turn, and the Node does the cancel-and-re-prompt.
4. `send` prompts with the trimmed draft and clears it; `stop` cancels.
5. `lineCount` clamps to `1...6`; `Enter` sends, `Shift-Enter` newlines, `⌘.`
stops; archived renders `Read-only · archived` and no controls.
Tests: the button matrix over open turn × empty/typed, plus archived;
`modelPickerEnabled` false during a turn; `showsModeControl` false for an
ordinary agent, true for a leader and a mission lead; `send` prompts once,
`stop` cancels, `setMode` works during a turn.
Done when: `swift build` and `swift test` pass in `apps/macos`.
Commit: `feat(desktop): chat composer and controls row`

### T11.7 Details inspector
Goal: the Details action's content and its adaptive placement.
Reads: this file, `docs/plan/01-domain.md` (Mission, Agent, Leader,
DecisionRecord), `MANIFESTO.md` section "Desktop information architecture".
Writes: `Chat/DetailsModel.swift`, `Chat/DetailsView.swift`,
`Tests/NetaDesktopTests/DetailsTests.swift`.
Contract:
```swift
enum DetailsPlacement: Equatable, Sendable {
  case beside, replacing
  static func forWidth(_ width: CGFloat) -> DetailsPlacement
}
struct DetailsField: Identifiable, Equatable, Sendable {
  let id: String; let label: String; let value: String; let mono: Bool
}
enum DetailsModel {
  static func title(for s: Selection, store: Store) -> String
  static func fields(for s: Selection, store: Store,
                     decision: DecisionRecord?) -> [DetailsField]
}
struct DetailsView: View {
  init(selection: Selection, store: Store, decision: DecisionRecord?,
       placement: DetailsPlacement, onBack: @escaping () -> Void)
}
```
Steps: 1. `forWidth` is `.beside` at 1500 and above, `.replacing` below.
2. A mission lead's fields: number, name, objective, one field per accepted
change newest first, worktree path, branch, integration (`merged <commit>
into <base>` or `not merged`), disposition. 3. An agent's fields: task,
access, provider, model, skills comma separated, activity, outcome. 4. The
leader's fields: mode with active minutes, then the nine decision-record
lines, or `No Lead++ decision recorded` when `decision` is nil. 5. Absent
optionals are omitted, never blank; `.replacing` fills the panel with a back
control, `.beside` sits beside the transcript. No tab bar here.
Tests: `forWidth` at 1100, 1499, 1500 and 1600; mission fields carry the
permanent number and every accepted change; an agent with no outcome omits
that field; leader fields with and without a decision record.
Done when: `swift build` and `swift test` pass in `apps/macos`.
Commit: `feat(desktop): details inspector`

### T11.8 chat panel assembly
Goal: one panel wiring the pieces and exposing `scrollTo(turnId:)` to 10.
Reads: this file, every other file in `Chat/`.
Writes: `Chat/ChatPanel.swift`, `Chat/ChatPanelModel.swift`,
`Tests/NetaDesktopTests/ChatPanelTests.swift`, and the one line of
`Sources/NetaDesktop/Shell/RootView.swift` holding `ChatPlaceholder`.
Contract:
```swift
@MainActor @Observable final class ChatPanelModel {
  init(client: any NodeClient, store: Store)
  private(set) var chat: ChatViewModel
  private(set) var composer: ComposerModel; var isDetailsOpen: Bool
  func select(_ selection: Selection) async
  func scrollTo(turnId: TurnId) async
}
struct ChatPanel: View { init(model: ChatPanelModel, width: CGFloat) }
```
Steps: 1. `select` cancels the running stream task, builds a new
`ChatViewModel` and `ComposerModel` for that session and starts them; the
same session again is a no-op. 2. `scrollTo` forwards to
`ChatViewModel.scrollTo`. 3. `isDetailsOpen` is one boolean, set by the
header's Details button and cleared by the back control;
`DetailsPlacement.forWidth(width)` picks the layout. 4. The panel composes
header, Lead++ strip when visible, a `LazyVStack` transcript scrolled by
`autoScrollTarget` and `consumeScroll`, then the composer.
Tests: selecting an agent rebuilds both view models on that session id and
stops the previous stream; the same session again is a no-op; `scrollTo`
forwards; Details replaces the transcript at 1100 and sits beside it at 1600.
Done when: `swift build` and `swift test` pass in `apps/macos`.
Commit: `feat(desktop): chat panel assembly`
