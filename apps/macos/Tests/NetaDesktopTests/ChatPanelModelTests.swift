import Foundation
import XCTest

@testable import NetaDesktop

/// T11.8, FIXPASS: the composer has to follow the transcript's open turn the
/// moment it changes. It used to be re-derived only after a tail, a select or
/// a scroll, so once a turn closed on a streamed notification the button
/// stayed on Stop.
@MainActor
final class ChatPanelModelTests: XCTestCase {
	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z
	private let workspaceId = "git:github.com/acme/NoScrubs"

	private func turn(_ id: TurnId, endedAt: Date? = nil, cancelled: Bool? = nil) -> Turn {
		Turn(
			id: id, sessionId: "s-leader", startedAt: base,
			endedAt: endedAt, role: .agent, cancelled: cancelled)
	}

	func testComposerFollowsTheOpenTurnWithoutASyncCall() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		XCTAssertEqual(model.composer.button, .sendDisabled)

		model.transcript.apply(TurnChange(sessionId: "s-leader", turn: turn("t1"), block: nil))
		XCTAssertEqual(model.composer.button, .stop, "an open turn shows Stop at once")

		model.transcript.apply(TurnChange(
			sessionId: "s-leader",
			turn: turn("t1", endedAt: base.addingTimeInterval(4)), block: nil))
		XCTAssertEqual(
			model.composer.button, .sendDisabled,
			"the closed turn returns the button without another syncComposer")
	}

	func testCancelledTurnAlsoReleasesTheComposer() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.transcript.apply(TurnChange(sessionId: "s-leader", turn: turn("t1"), block: nil))
		model.composer.draft = "next"
		XCTAssertEqual(model.composer.button, .stop)
		model.transcript.apply(TurnChange(
			sessionId: "s-leader",
			turn: turn("t1", endedAt: base.addingTimeInterval(1), cancelled: true), block: nil))
		XCTAssertEqual(model.composer.button, .send)
	}

	/// The Node emits the person's prompt as a `user` turn with a `user`
	/// block; the transcript shows it with no local echo.
	func testUserBlockFromTheNodeShowsInTheTranscript() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		let userTurn = Turn(
			id: "t-user", sessionId: "s-leader", startedAt: base,
			endedAt: base, role: .user, cancelled: nil)
		model.transcript.apply(TurnChange(sessionId: "s-leader", turn: userTurn, block: nil))
		model.transcript.apply(TurnChange(
			sessionId: "s-leader", turn: nil,
			block: Block(
				turnId: "t-user", seq: 0, at: base, role: .user, kind: .text,
				text: "ship the limiter", data: nil)))
		XCTAssertEqual(model.transcript.turns.map(\.id), ["t-user"])
		XCTAssertEqual(model.transcript.turns[0].role, .user)
		XCTAssertEqual(model.transcript.turns[0].blocks.map(\.text), ["ship the limiter"])
		XCTAssertEqual(
			model.composer.button, .sendDisabled,
			"a closed user turn does not hold the composer on Stop")
	}

	func testSelectRewiresTheOpenTurnFollow() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.select(.agent("ag-thane"))
		model.transcript.apply(TurnChange(
			sessionId: "s-ag-thane",
			turn: Turn(
				id: "t2", sessionId: "s-ag-thane", startedAt: base,
				endedAt: nil, role: .agent, cancelled: nil),
			block: nil))
		XCTAssertEqual(model.composer.button, .stop, "the rebuilt transcript is followed too")
	}

	// MARK: - Survival across live updates (FIXPASS blocker)

	/// The panel model is owned by `RootView` in `@State` and outlives every
	/// body pass, so it has to re-resolve itself instead of being rebuilt.
	/// The leader — and with it the session id — arrives with the first
	/// snapshot, long after the panel is built, and the selection is
	/// `.leader` throughout: keyed on the selection alone the panel keeps a
	/// transcript for session "" for the life of the window.
	func testTheSessionArrivingWithTheSnapshotRebuildsTheTranscript() {
		let empty = Store()
		let shell = ShellState()
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: empty, shell: shell)
		XCTAssertEqual(model.sessionId, "", "no leader yet, no session")
		let before = ObjectIdentifier(model.transcript)

		empty.replace(snapshot: snapshot())
		XCTAssertEqual(model.currentSessionId, "s-leader")
		model.sync()

		XCTAssertEqual(model.sessionId, "s-leader")
		XCTAssertNotEqual(ObjectIdentifier(model.transcript), before)
		XCTAssertEqual(model.selection, .leader, "the selection never moved")
	}

	/// A click on the canvas or a chip in the mission bar moves
	/// `shell.selection` without going through `model.select`.
	func testAnExternalSelectionChangeReachesThePanel() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.shell.select(.agent("ag-thane"))
		model.sync()
		XCTAssertEqual(model.selection, .agent("ag-thane"))
		XCTAssertEqual(model.sessionId, "s-ag-thane")
	}

	/// And a store update that moves neither the selection nor its session
	/// leaves everything alone: the draft, the open inspector and the
	/// transcript all survive, which is exactly what a rebuilt-in-`body`
	/// model threw away on the first live notification.
	func testAStoreUpdateKeepsTheDraftAndTheInspector() {
		let store = store()
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store, shell: ShellState())
		model.composer.draft = "Close #305 once the checks pass."
		model.isDetailsOpen = true
		let transcript = ObjectIdentifier(model.transcript)

		store.apply(notification: .state(StateChange(
			kind: .mission,
			record: .mission(Mission(
				id: "m1", number: 1, workspaceId: workspaceId, machineId: "m1",
				name: "socket reconnect", objective: "Objective.", changes: [],
				lead: .leader, agentIds: [], access: .readOnly, worktree: nil,
				state: .running, attention: nil, createdAt: base, closedAt: nil,
				disposition: nil, closeReason: nil, integration: nil,
				continuesMissionId: nil)))))
		model.sync()

		XCTAssertEqual(model.composer.draft, "Close #305 once the checks pass.")
		XCTAssertTrue(model.isDetailsOpen)
		XCTAssertEqual(ObjectIdentifier(model.transcript), transcript)
	}

	/// `send` shows the person's own message at once. The Node opens the
	/// user turn with no blocks at all, so the prompt was invisible until
	/// the agent answered.
	func testSendingEchoesThePersonsOwnMessage() async {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.composer.draft = "  Void them. Merge #305 when green.  "
		await model.composer.send()
		XCTAssertEqual(
			model.transcript.turns.map { $0.blocks.map(\.text) },
			[["Void them. Merge #305 when green."]])
		XCTAssertEqual(model.transcript.turns[0].role, .user)
		XCTAssertEqual(model.composer.draft, "")

		// And when the Node delivers the same text itself, it is shown once.
		model.transcript.apply(TurnChange(
			sessionId: "s-leader",
			turn: Turn(
				id: "t-user", sessionId: "s-leader", startedAt: base,
				endedAt: base, role: .user, cancelled: nil),
			block: Block(
				turnId: "t-user", seq: 0, at: base, role: .user, kind: .text,
				text: "Void them. Merge #305 when green.", data: nil)))
		XCTAssertEqual(
			model.transcript.turns.map { $0.blocks.map(\.text) },
			[["Void them. Merge #305 when green."]])
	}

	// MARK: - Checkpoint routing (10 fills the router, 11 consumes it)

	func testACheckpointOnATurnScrollsTheTranscriptToIt() async {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.transcript.apply(TurnChange(
			sessionId: "s-leader",
			turn: Turn(
				id: "t-pinned", sessionId: "s-leader", startedAt: base,
				endedAt: base, role: .agent, cancelled: nil),
			block: Block(
				turnId: "t-pinned", seq: 0, at: base, role: .agent, kind: .text,
				text: "pinned", data: nil)))

		let router = CheckpointRouter()
		router.open(Checkpoint(
			id: "9", seq: 9, at: base, kind: .userPinned, icon: .diamond,
			label: "Pinned message", relative: "3h ago", x: 100,
			missionId: nil, sessionId: "s-leader", turnId: "t-pinned"))
		guard let action = router.consume() else {
			return XCTFail("the router staged nothing")
		}
		await model.handle(action)

		XCTAssertEqual(model.transcript.consumeScroll()?.turnId, "t-pinned")
	}

	func testACheckpointWithNoTurnOpensTheDecisionRecord() async {
		let store = store()
		store.apply(notification: .state(StateChange(
			kind: .mission,
			record: .mission(Mission(
				id: "m1", number: 1, workspaceId: workspaceId, machineId: "m1",
				name: "socket reconnect", objective: "Objective.", changes: [],
				lead: .leader, agentIds: [], access: .readOnly, worktree: nil,
				state: .running, attention: nil, createdAt: base, closedAt: nil,
				disposition: nil, closeReason: nil, integration: nil,
				continuesMissionId: nil)))))
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store, shell: ShellState())
		let router = CheckpointRouter()
		router.open(Checkpoint(
			id: "4", seq: 4, at: base, kind: .leaderModeChanged, icon: .bolt,
			label: "Lead++ · #1", relative: "14m ago", x: 100,
			missionId: "m1", sessionId: nil, turnId: nil))
		guard let action = router.consume() else {
			return XCTFail("the router staged nothing")
		}
		await model.handle(action)

		XCTAssertTrue(model.isDetailsOpen, "Details opens on the decision record")
		XCTAssertEqual(model.selection, .mission("m1"))
	}

	// MARK: - Helpers

	private func store() -> Store {
		let store = Store()
		store.replace(snapshot: snapshot())
		return store
	}

	private func snapshot() -> Snapshot {
		Snapshot(
			machine: Machine(id: "m1", name: "mac-studio", createdAt: base),
			workspaces: [Workspace(
				id: workspaceId, kind: .git, name: "NoScrubs",
				remote: "git@github.com:acme/NoScrubs.git", roots: [],
				createdAt: base)],
			leaders: [Leader(
				workspaceId: workspaceId, machineId: "m1", name: "Halden",
				sessionId: "s-leader", provider: "Claude", model: "claude-opus-5",
				mode: .lead, modeSince: base, modeActiveMs: 0,
				activeMissionId: nil, state: .idle)],
			missions: [],
			hasOlder: false,
			agents: [Agent(
				id: "ag-thane", missionId: "m304", workspaceId: workspaceId,
				name: "Thane", task: "Add the limiter.", access: .readOnly,
				provider: "Codex", model: "gpt-5-codex", skills: [],
				sessionId: "s-ag-thane", canSpawn: false, state: .running,
				stateBefore: nil, activity: nil, pendingQuestion: nil,
				startedAt: base, endedAt: nil, outcome: nil)],
			completedCounts: [:], events: [], attention: [],
			windowDays: 14, protocolVersion: 1, at: base)
	}
}
