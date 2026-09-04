import Foundation
import XCTest

@testable import NetaDesktop

/// T9.6 contract: selection resolves to the right session id against a
/// fixture-backed store, unknown ids fall back to `.leader`, selecting never
/// moves `chatVisible`, `dismissOverlay` closes the navigator (false when
/// nothing is open), zoom clamps in x1.25 steps, `fit` resets and bumps
/// `fitRequested`.
@MainActor
final class ShellStateTests: XCTestCase {
	/// The shell starts where the design says it starts: the workspace leader
	/// selected, the chat shown, the navigator hidden. (Folded in from
	/// `SmokeTests`, which was left with nothing else after `ContentView` and
	/// its `RootViewModel` stub were deleted.)
	func testShellStartsOnTheLeaderWithTheNavigatorHidden() {
		let shell = ShellState()
		XCTAssertEqual(shell.selection, .leader)
		XCTAssertTrue(shell.chatVisible)
		XCTAssertFalse(shell.navigatorVisible)
	}

	func testLeaderSelectionResolvesToLeaderSession() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		XCTAssertEqual(shell.selection, .leader)
		let sessionId = shell.sessionId(in: store)
		XCTAssertNotNil(store.leader)
		XCTAssertEqual(sessionId, store.leader?.sessionId)
	}

	func testMissionSelectionResolvesToLeadSession() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		// Every recorded mission is leader-led: it resolves to the leader.
		let mission = try XCTUnwrap(store.missions.first)
		shell.select(.mission(mission.id))
		XCTAssertEqual(shell.sessionId(in: store), store.leader?.sessionId)
		// An agent-led mission resolves to its lead agent's session.
		let agent = try XCTUnwrap(store.agentsById.values.first)
		store.apply(notification: .state(StateChange(
			kind: .mission,
			record: .mission(relead(mission, to: agent.id)))))
		shell.select(.mission(mission.id))
		XCTAssertEqual(shell.sessionId(in: store), agent.sessionId)
	}

	func testAgentSelectionResolvesToAgentSession() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		let agent = try XCTUnwrap(store.agentsById.values.first)
		shell.select(.agent(agent.id))
		XCTAssertEqual(shell.sessionId(in: store), agent.sessionId)
	}

	func testUnknownIdFallsBackToLeader() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		shell.select(.mission("no-such-mission"))
		XCTAssertNil(shell.sessionId(in: store))
		XCTAssertEqual(shell.selection, .leader)
		shell.select(.agent("no-such-agent"))
		XCTAssertNil(shell.sessionId(in: store))
		XCTAssertEqual(shell.selection, .leader)
		// After the fallback the leader still resolves.
		XCTAssertEqual(shell.sessionId(in: store), store.leader?.sessionId)
	}

	func testSelectingNeverChangesChatVisible() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		let mission = try XCTUnwrap(store.missions.first)
		let agent = try XCTUnwrap(store.agentsById.values.first)
		for visible in [true, false] {
			shell.chatVisible = visible
			shell.select(.leader)
			XCTAssertEqual(shell.chatVisible, visible)
			shell.select(.mission(mission.id))
			XCTAssertEqual(shell.chatVisible, visible)
			shell.select(.agent(agent.id))
			XCTAssertEqual(shell.chatVisible, visible)
		}
	}

	// MARK: - The auto-hide navigator overlay

	func testHoveringTheEdgeShowsTheOverlay() {
		let shell = ShellState()
		XCTAssertFalse(shell.navigatorVisible)
		shell.showNavigator()
		XCTAssertTrue(shell.navigatorVisible)
		// ⌘L is the same door, and it closes what it opened.
		shell.toggleNavigator()
		XCTAssertFalse(shell.navigatorVisible)
		shell.toggleNavigator()
		XCTAssertTrue(shell.navigatorVisible)
	}

	func testPointerExitHidesTheOverlayAfterTheDelay() async {
		let shell = ShellState()
		shell.navigatorHideDelay = .zero
		shell.showNavigator()
		shell.navigatorPointerExited(.panel)
		XCTAssertTrue(shell.navigatorVisible, "the hide is scheduled, not immediate")
		await shell.pendingNavigatorHide()
		XCTAssertFalse(shell.navigatorVisible)
	}

	func testPointerReturningCancelsThePendingHide() async {
		let shell = ShellState()
		shell.navigatorHideDelay = .zero
		shell.navigatorPointerEntered(.edge)
		shell.showNavigator()
		shell.navigatorPointerExited(.edge)
		// Crossing the gap between the 6 pt edge strip and the panel must
		// not close what the crossing opened.
		shell.navigatorPointerEntered(.panel)
		await shell.pendingNavigatorHide()
		XCTAssertTrue(shell.navigatorVisible)
	}

	/// AppKit does not order hover events across sibling views: a fast move
	/// can deliver the panel's enter before the strip's exit. The late exit
	/// must not schedule a hide under a pointer that is resting on the panel
	/// — nothing would re-show it, because `.onHover` only fires on
	/// transitions.
	func testStripExitArrivingAfterPanelEnterDoesNotHide() async {
		let shell = ShellState()
		shell.navigatorHideDelay = .zero
		shell.navigatorPointerEntered(.edge)
		shell.showNavigator()
		shell.navigatorPointerEntered(.panel)
		shell.navigatorPointerExited(.edge)
		await shell.pendingNavigatorHide()
		XCTAssertTrue(shell.navigatorVisible)
		// Leaving the panel itself still hides it.
		shell.navigatorPointerExited(.panel)
		await shell.pendingNavigatorHide()
		XCTAssertFalse(shell.navigatorVisible)
	}

	/// Using a row hides the panel out from under the pointer, so its hover
	/// exit may never arrive. The next hover-out of the edge strip must still
	/// be able to schedule a hide.
	func testHidingUnderThePointerDoesNotStrandTheAutoHide() async {
		let shell = ShellState()
		shell.navigatorHideDelay = .zero
		shell.navigatorPointerEntered(.edge)
		shell.showNavigator()
		shell.navigatorPointerEntered(.panel)
		// A row was used: the panel goes, and no `.panel` exit ever fires.
		shell.hideNavigator()
		shell.navigatorPointerEntered(.edge)
		shell.showNavigator()
		shell.navigatorPointerExited(.edge)
		await shell.pendingNavigatorHide()
		XCTAssertFalse(shell.navigatorVisible)
	}

	func testPointerExitDoesNothingWhenTheOverlayIsClosed() async {
		let shell = ShellState()
		shell.navigatorHideDelay = .zero
		shell.navigatorPointerExited(.panel)
		await shell.pendingNavigatorHide()
		XCTAssertFalse(shell.navigatorVisible)
	}

	func testEscapeHidesTheOverlayAtOnce() {
		let shell = ShellState()
		shell.showNavigator()
		XCTAssertTrue(shell.dismissOverlay())
		XCTAssertFalse(shell.navigatorVisible)
	}

	func testCanvasClickDismissesTheOverlay() {
		let shell = ShellState()
		// A canvas click with nothing open is the canvas's own click.
		XCTAssertFalse(shell.canvasClicked())
		shell.showNavigator()
		XCTAssertTrue(shell.canvasClicked())
		XCTAssertFalse(shell.navigatorVisible)
	}

	/// End to end, on the canvas's own call site: `SpineCanvasView`'s backdrop
	/// tap runs `handleBackgroundTap`, which is the only thing that reaches
	/// `canvasClicked` in the app. MANIFESTO.md "Desktop information
	/// architecture": the navigator "closes when dismissed".
	///
	/// Known limit: this reaches the handler, not the gesture. That the
	/// backdrop's `.onTapGesture` is attached below the nodes is not
	/// assertable without view introspection; only a running window or a
	/// snapshot check covers the wire itself.
	func testCanvasBackgroundTapHidesTheOverlay() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		let canvas = SpineCanvasView(store: store, shell: shell)
		let mission = try XCTUnwrap(store.missions.first)
		shell.select(.mission(mission.id))
		shell.showNavigator()
		canvas.handleBackgroundTap()
		XCTAssertFalse(shell.navigatorVisible)
		// The click that dismissed the overlay is not also a selection change.
		XCTAssertEqual(shell.selection, .mission(mission.id))
		// With nothing open the same tap is the canvas's own click.
		canvas.handleBackgroundTap()
		XCTAssertFalse(shell.navigatorVisible)
		XCTAssertEqual(shell.selection, .mission(mission.id))
	}

	func testCanvasClickBeatsAPendingHide() async {
		let shell = ShellState()
		shell.navigatorHideDelay = .seconds(60)
		shell.showNavigator()
		shell.navigatorPointerExited(.panel)
		shell.canvasClicked()
		XCTAssertFalse(shell.navigatorVisible)
		// The cancelled hide never fires, so a later show stays shown.
		await shell.pendingNavigatorHide()
		shell.showNavigator()
		XCTAssertTrue(shell.navigatorVisible)
	}

	func testSelectingARowSelectsTheMissionAndHidesTheOverlay() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		shell.showNavigator()
		let overlay = NavigatorOverlay(
			model: NavigatorModel.make(store: store, query: ""),
			shell: shell,
			onSelect: { shell.select($0) })
		let row = try XCTUnwrap(NavigatorModel.make(store: store, query: "").open.first)
		overlay.select(row)
		XCTAssertEqual(shell.selection, .mission(row.id))
		XCTAssertFalse(shell.navigatorVisible)
	}

	// MARK: - The View menu

	/// The `⌘L` item says what it will do. With the panel up, an item reading
	/// "Show Navigator" that hides it is a lying label.
	func testNavigatorMenuTitleFlipsWithTheOverlay() {
		let shell = ShellState()
		XCTAssertFalse(shell.navigatorVisible)
		XCTAssertEqual(NetaCommands.navigatorTitle(visible: shell.navigatorVisible), "Show Navigator")
		shell.toggleNavigator()
		XCTAssertTrue(shell.navigatorVisible)
		XCTAssertEqual(NetaCommands.navigatorTitle(visible: shell.navigatorVisible), "Hide Navigator")
		shell.toggleNavigator()
		XCTAssertEqual(NetaCommands.navigatorTitle(visible: shell.navigatorVisible), "Show Navigator")
	}

	// MARK: - File > Open Workspace…

	func testOpenWorkspaceOpensAndRefreshesTheSnapshot() async throws {
		let client = FixtureNodeClient()
		let store = Store()
		store.replace(snapshot: try await client.snapshot())
		let before = store.workspaces.count
		let opened = await NetaCommands.openWorkspace(
			path: "/tmp/neta-open-panel", client: client, store: store)
		XCTAssertTrue(opened)
		XCTAssertEqual(store.workspaces.count, before + 1)
		XCTAssertEqual(store.currentWorkspaceId, "folder:/tmp/neta-open-panel")
		XCTAssertTrue(store.workspaces.contains { $0.id == "folder:/tmp/neta-open-panel" })
	}

	func testOpenWorkspaceLeavesTheStoreAloneWhenTheNodeRefuses() async throws {
		let client = RefusingNodeClient()
		let store = Store()
		store.replace(snapshot: try await FixtureNodeClient().snapshot())
		let before = store.workspaces
		// The refusal is reported, not swallowed: the caller learns nothing
		// changed and the reason goes to the shell log.
		let opened = await NetaCommands.openWorkspace(path: "/tmp/nope", client: client, store: store)
		XCTAssertFalse(opened)
		XCTAssertEqual(store.workspaces, before)
	}

	func testDismissOverlayClosesNavigator() {
		let shell = ShellState()
		shell.navigatorVisible = true
		XCTAssertTrue(shell.dismissOverlay())
		XCTAssertFalse(shell.navigatorVisible)
		XCTAssertFalse(shell.dismissOverlay())
	}

	func testDismissOverlayReleasesComposerFocus() {
		let shell = ShellState()
		shell.composerFocused = true
		XCTAssertTrue(shell.dismissOverlay())
		XCTAssertFalse(shell.composerFocused)
		XCTAssertFalse(shell.dismissOverlay())
	}

	func testZoomMovesInQuarterStepsAndClamps() {
		let shell = ShellState()
		XCTAssertEqual(shell.zoomPercent, 100)
		shell.zoomIn()
		XCTAssertEqual(shell.timeZoom, 1.25, accuracy: 1e-9)
		XCTAssertEqual(shell.zoomPercent, 125)
		shell.zoomOut()
		XCTAssertEqual(shell.timeZoom, 1.0, accuracy: 1e-9)
		for _ in 0 ..< 20 { shell.zoomIn() }
		XCTAssertEqual(shell.timeZoom, ShellState.maxZoom)
		XCTAssertTrue(shell.zoomWithinBounds)
		for _ in 0 ..< 40 { shell.zoomOut() }
		XCTAssertEqual(shell.timeZoom, ShellState.minZoom)
	}

	/// The Now ask lives on the shell, not on the canvas's own `NowState`:
	/// the mission bar's Now pill and the debug driver are both outside the
	/// canvas, and the canvas is the only thing that knows where the live
	/// edge is.
	func testJumpToNowBumpsNowRequested() {
		let shell = ShellState()
		XCTAssertEqual(shell.nowRequested, 0)
		shell.jumpToNow()
		XCTAssertEqual(shell.nowRequested, 1)
		shell.jumpToNow()
		XCTAssertEqual(shell.nowRequested, 2)
		XCTAssertEqual(shell.timeZoom, 1.0, "asking for Now is not a zoom")
		XCTAssertEqual(shell.fitRequested, 0, "and it is not a Fit")
	}

	func testFitResetsZoomAndBumpsFitRequested() {
		let shell = ShellState()
		XCTAssertEqual(shell.fitRequested, 0)
		shell.zoomIn()
		shell.fit()
		XCTAssertEqual(shell.timeZoom, 1.0)
		XCTAssertEqual(shell.fitRequested, 1)
		XCTAssertEqual(shell.zoomPercent, 100)
		shell.fit()
		XCTAssertEqual(shell.fitRequested, 2)
	}

	// MARK: - Helpers

	/// The recorded fixture snapshot in a store: the only data tests use.
	private func fixtureStore() async throws -> Store {
		let client = FixtureNodeClient()
		let snapshot = try await client.snapshot()
		let store = Store()
		store.replace(snapshot: snapshot)
		return store
	}

	/// A copy of `mission` led by `agentId` instead of the leader.
	private func relead(_ mission: Mission, to agentId: Ulid) -> Mission {
		Mission(
			id: mission.id, number: mission.number,
			workspaceId: mission.workspaceId, machineId: mission.machineId,
			name: mission.name, objective: mission.objective,
			changes: mission.changes, lead: .agent(agentId: agentId),
			agentIds: mission.agentIds + [agentId], access: mission.access,
			worktree: mission.worktree, state: mission.state,
			attention: mission.attention, createdAt: mission.createdAt,
			closedAt: mission.closedAt, disposition: mission.disposition,
			closeReason: mission.closeReason, integration: mission.integration,
			continuesMissionId: mission.continuesMissionId)
	}
}

/// A Node that answers nothing: it takes the protocol's default
/// `openWorkspace`, which reports the method as unavailable. Used to prove
/// the menu leaves the store untouched when the Node refuses.
private struct RefusingNodeClient: NodeClient {
	private let refusal = NodeClientError.rpc(code: -32601, message: "unavailable")

	func connect() async throws { throw refusal }
	func snapshot() async throws -> Snapshot { throw refusal }
	func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission] {
		throw refusal
	}
	func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event] {
		throw refusal
	}
	func conversationTail(
		sessionId: Ulid, cursor: String?, limit: Int, direction: String?, turnId: TurnId?
	) async throws -> ConversationPage {
		throw refusal
	}
	func prompt(sessionId: Ulid, text: String) async throws -> Ulid { throw refusal }
	func cancel(sessionId: Ulid) async throws { throw refusal }
	func setModel(sessionId: Ulid, model: String) async throws { throw refusal }
	func listModels(provider: String) async throws -> [ModelInfo] { throw refusal }
	func setMode(workspaceId: String, mode: LeaderMode) async throws { throw refusal }
	func pin(missionId: Ulid, pinned: Bool) async throws { throw refusal }
	func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws { throw refusal }
	var notifications: AsyncStream<NodeNotification> { AsyncStream { $0.finish() } }
}

private extension ShellState {
	/// The clamp holds at both ends after repeated stepping.
	var zoomWithinBounds: Bool {
		timeZoom <= ShellState.maxZoom && timeZoom >= ShellState.minZoom
	}
}
