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

	// MARK: - Helpers

	private func store() -> Store {
		let store = Store()
		store.replace(snapshot: Snapshot(
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
			windowDays: 14, protocolVersion: 1, at: base))
		return store
	}
}
