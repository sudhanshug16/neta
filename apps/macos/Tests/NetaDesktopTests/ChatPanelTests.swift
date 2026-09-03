import Foundation
import XCTest

@testable import NetaDesktop

/// T11.8: the panel owns one transcript plus one composer per selection —
/// `select` rebuilds both, `scrollTo` forwards, `isDetailsOpen` toggles the
/// inspector, and the panel view builds over every placement.
@MainActor
final class ChatPanelTests: XCTestCase {
	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z
	private let workspaceId = "git:github.com/acme/Halden"

	func testSelectRebuildsBothViewModels() {
		let shell = ShellState()
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: shell)
		XCTAssertEqual(model.selection, .leader)
		XCTAssertEqual(model.sessionId, "s-leader")
		let firstTranscript = model.transcript
		let firstComposer = model.composer
		model.select(.agent("ag-thane"))
		XCTAssertEqual(model.selection, .agent("ag-thane"))
		XCTAssertEqual(model.shell.selection, .agent("ag-thane"))
		XCTAssertEqual(model.sessionId, "s-ag-thane")
		XCTAssertTrue(model.transcript !== firstTranscript, "select rebuilds the transcript")
		XCTAssertTrue(model.composer !== firstComposer, "select rebuilds the composer")
		XCTAssertTrue(model.transcript.turns.isEmpty, "the rebuilt transcript starts empty")
		XCTAssertEqual(model.composer.placeholder, "Message Thane")
	}

	func testSelectMissionResolvesTheLeadSession() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.select(.mission("m304"))
		XCTAssertEqual(model.sessionId, "s-leader", "a leader-led mission opens the leader session")
		model.select(.mission("m305"))
		XCTAssertEqual(model.sessionId, "s-ag-quill", "an agent-led mission opens the lead session")
	}

	func testSelectUnknownIdFallsBackToLeaderSession() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.select(.mission("no-such-mission"))
		XCTAssertEqual(model.sessionId, "s-leader")
		model.select(.agent("no-such-agent"))
		XCTAssertEqual(model.sessionId, "s-leader")
	}

	func testScrollToForwardsLoadedTurnAndConsumes() async {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.transcript.apply(TurnChange(
			sessionId: "s-leader",
			turn: Turn(
				id: "t1", sessionId: "s-leader",
				startedAt: base, endedAt: nil, role: .agent, cancelled: nil),
			block: nil))
		await model.scrollTo(turnId: "t1")
		XCTAssertEqual(
			model.transcript.pendingScroll,
			ScrollRequest(turnId: "t1", flash: true))
		XCTAssertEqual(
			model.transcript.consumeScroll(),
			ScrollRequest(turnId: "t1", flash: true))
		XCTAssertNil(model.transcript.consumeScroll(), "consumeScroll drains the request")
	}

	func testIsDetailsOpenDefaultsClosed() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		XCTAssertFalse(model.isDetailsOpen)
		model.isDetailsOpen = true
		XCTAssertTrue(model.isDetailsOpen)
	}

	func testArchivedAgentMarksComposerReadOnly() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		model.select(.agent("ag-old"))
		XCTAssertTrue(model.composer.isArchived)
		XCTAssertEqual(model.composer.button, .none)
		XCTAssertEqual(model.composer.placeholder, "Read-only · archived")
	}

	func testOpenTurnSyncsComposerToStop() {
		let model = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		XCTAssertFalse(model.composer.hasOpenTurn)
		model.transcript.apply(TurnChange(
			sessionId: "s-leader",
			turn: Turn(
				id: "t1", sessionId: "s-leader",
				startedAt: base, endedAt: nil, role: .agent, cancelled: nil),
			block: nil))
		model.syncComposer()
		XCTAssertTrue(model.composer.hasOpenTurn)
		XCTAssertEqual(model.composer.button, .stop)
	}

	func testPanelBuildsAcrossPlacements() {
		let live = ChatPanelModel(
			client: FixtureNodeClient(), store: store(), shell: ShellState())
		_ = ChatPanel(model: live, windowWidth: 1100)
		_ = ChatPanel(model: live, windowWidth: 1600)
		live.isDetailsOpen = true
		_ = ChatPanel(model: live, windowWidth: 1100)
		_ = ChatPanel(model: live, windowWidth: 1600)
		let shell = ShellState()
		shell.select(.agent("ag-thane"))
		_ = ChatPanel(client: FixtureNodeClient(), store: store(), shell: shell)
	}

	// MARK: - Helpers

	private func store() -> Store {
		let store = Store()
		store.replace(snapshot: Snapshot(
			machine: Machine(id: "m1", name: "mac-studio", createdAt: base),
			workspaces: [Workspace(
				id: workspaceId, kind: .git, name: "repo",
				remote: "git@github.com:acme/repo.git", roots: [],
				createdAt: base)],
			leaders: [Leader(
				workspaceId: workspaceId, machineId: "m1",
				sessionId: "s-leader", provider: "Claude", model: "claude-opus-5",
				mode: .leadPlus, modeSince: base, modeActiveMs: 14 * 60_000,
				activeMissionId: "m304", state: .running)],
			missions: [
				Mission(
					id: "m304", number: 304, workspaceId: workspaceId,
					machineId: "m1", name: "Rate limiter on /search",
					objective: "Cap search QPS.", changes: [],
					lead: .leader, agentIds: ["ag-thane"],
					access: .readOnly, worktree: nil, state: .running,
					attention: nil, createdAt: base, closedAt: nil,
					disposition: nil, closeReason: nil, integration: nil,
					continuesMissionId: nil),
				Mission(
					id: "m305", number: 305, workspaceId: workspaceId,
					machineId: "m1", name: "Flag cleanup",
					objective: "Remove stale flags.", changes: [],
					lead: .agent(agentId: "ag-quill"), agentIds: ["ag-quill"],
					access: .readWrite, worktree: nil, state: .running,
					attention: nil, createdAt: base, closedAt: nil,
					disposition: nil, closeReason: nil, integration: nil,
					continuesMissionId: nil),
			],
			hasOlder: false,
			agents: [
				Agent(
					id: "ag-thane", missionId: "m304",
					workspaceId: workspaceId, name: "Thane",
					task: "Add the limiter.", access: .readOnly,
					provider: "Codex", model: "gpt-5-codex",
					skills: [], sessionId: "s-ag-thane",
					canSpawn: false, state: .running, stateBefore: nil,
					activity: nil, pendingQuestion: nil,
					startedAt: base, endedAt: nil, outcome: nil),
				Agent(
					id: "ag-quill", missionId: "m305",
					workspaceId: workspaceId, name: "Quill",
					task: "Drop the flags.", access: .readWrite,
					provider: "Codex", model: "gpt-5-codex", skills: [],
					sessionId: "s-ag-quill", canSpawn: true,
					state: .running, stateBefore: nil, activity: nil,
					pendingQuestion: nil, startedAt: base, endedAt: nil,
					outcome: nil),
				Agent(
					id: "ag-old", missionId: "m304",
					workspaceId: workspaceId, name: "Old",
					task: "Done.", access: .readOnly,
					provider: "Codex", model: "gpt-5-codex", skills: [],
					sessionId: "s-ag-old", canSpawn: false,
					state: .archived, stateBefore: nil, activity: nil,
					pendingQuestion: nil, startedAt: base, endedAt: base,
					outcome: "Landed."),
			],
			completedCounts: [:], events: [], attention: [],
			windowDays: 14, protocolVersion: 1, at: base))
		return store
	}
}
