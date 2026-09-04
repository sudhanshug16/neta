import Foundation
import XCTest

@testable import NetaDesktop

/// T9.5 contract: replace swaps whole, apply patches, attention derives the
/// order rule, extendWindow moves back without dropping, and the block cache
/// holds 1 MB per session and 100 sessions with LRU-whole-session eviction.
@MainActor
final class StoreTests: XCTestCase {
	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z

	func testSecondReplaceLeavesNoTraceOfFirst() {
		let store = Store()
		store.replace(snapshot: snapshot(
			machineId: "m-A", leaderSession: "s-A",
			missions: [
				mission(id: "a1", number: 1, state: .running, hoursAfterBase: 0),
				mission(id: "a2", number: 2, state: .blocked, hoursAfterBase: 1),
			],
			agents: [agent(id: "ag-A", missionId: "a1", sessionId: "s-ag-A")],
			events: [event(seq: 1, missionId: "a1")]))
		store.cache(page(texts: ["hello"]), for: "s-x")
		store.noteViewed("s-x")
		store.apply(notification: .node(NodeLifecycle(phase: .restarting)))
		XCTAssertEqual(store.cachedSessionIds, ["s-x"])
		XCTAssertNotNil(store.nodeState)

		store.replace(snapshot: snapshot(
			machineId: "m-B", leaderSession: "s-B",
			missions: [mission(id: "b1", number: 9, state: .failed, hoursAfterBase: -2)],
			agents: [agent(id: "ag-B", missionId: "b1", sessionId: "s-ag-B")],
			events: [event(seq: 7, missionId: "b1")]))

		XCTAssertEqual(store.machine?.id, "m-B")
		XCTAssertEqual(store.leader?.sessionId, "s-B")
		XCTAssertEqual(store.missions.map(\.id), ["b1"])
		XCTAssertNil(store.missionsById["a1"])
		XCTAssertNil(store.missionsById["a2"])
		XCTAssertEqual(store.missionsById["b1"]?.number, 9)
		XCTAssertNil(store.missionsByNumber[1])
		XCTAssertNil(store.missionsByNumber[2])
		XCTAssertEqual(store.missionsByNumber[9]?.id, "b1")
		XCTAssertNil(store.agentsById["ag-A"])
		XCTAssertEqual(store.agentsById["ag-B"]?.sessionId, "s-ag-B")
		XCTAssertEqual(store.events.map(\.seq), [7])
		XCTAssertEqual(store.cachedSessionIds, [])
		XCTAssertEqual(store.blocks(for: "s-x"), [])
		XCTAssertNil(store.nodeState)
		XCTAssertEqual(store.window.lowerBound, base.addingTimeInterval(-2 * 3600))
		XCTAssertEqual(store.window.upperBound, base)
	}

	func testApplyUpsertsMissionAndReindexesByNumber() {
		let store = Store()
		store.replace(snapshot: snapshot(missions: [
			mission(id: "m1", number: 1, state: .running, hoursAfterBase: 0),
		]))
		// Renumber: the old number must not linger in the index.
		store.apply(notification: .state(StateChange(
			kind: .mission,
			record: .mission(mission(id: "m1", number: 7, state: .blocked, hoursAfterBase: 0)))))
		XCTAssertEqual(store.missions.count, 1)
		XCTAssertEqual(store.missionsById["m1"]?.number, 7)
		XCTAssertEqual(store.missionsByNumber[7]?.id, "m1")
		XCTAssertNil(store.missionsByNumber[1])
		XCTAssertEqual(store.attention.map(\.id), ["m1"])
		// Unknown id appends and stays sorted.
		store.apply(notification: .state(StateChange(
			kind: .mission,
			record: .mission(mission(id: "m2", number: 3, state: .running, hoursAfterBase: -1)))))
		XCTAssertEqual(store.missions.map(\.id), ["m2", "m1"])
		XCTAssertEqual(store.missionsByNumber[3]?.id, "m2")
	}

	func testApplyEventForUnknownMissionIsKept() {
		let store = Store()
		store.replace(snapshot: snapshot(missions: [
			mission(id: "m1", number: 1, state: .running, hoursAfterBase: 0),
		]))
		let count = store.events.count
		store.apply(notification: .event(event(seq: 99, missionId: "no-such-mission")))
		XCTAssertEqual(store.events.count, count + 1)
		XCTAssertEqual(store.events.last?.missionId, "no-such-mission")
		XCTAssertEqual(store.missions.map(\.id), ["m1"])
		XCTAssertEqual(store.events.map(\.seq), store.events.map(\.seq).sorted())
	}

	func testApplyTurnAppendsToSessionCache() {
		let store = Store()
		store.replace(snapshot: snapshot())
		let at = base.addingTimeInterval(10)
		store.apply(notification: .turn(TurnChange(
			sessionId: "s-live", turn: nil,
			block: Block(turnId: "t1", seq: 0, at: at, role: .agent, kind: .text, text: "live", data: nil))))
		XCTAssertEqual(store.blocks(for: "s-live").map(\.text), ["live"])
		XCTAssertEqual(store.cachedSessionIds, ["s-live"])
		// A turn without a block caches nothing.
		store.apply(notification: .turn(TurnChange(sessionId: "s-empty", turn: nil, block: nil)))
		XCTAssertEqual(store.blocks(for: "s-empty"), [])
		XCTAssertEqual(store.cachedSessionIds, ["s-live"])
	}

	func testExtendWindowMovesLowerBoundBackAndKeepsLoaded() {
		let store = Store()
		store.replace(snapshot: snapshot(
			missions: [mission(id: "m5", number: 5, state: .running, hoursAfterBase: 0)],
			events: [event(seq: 5, missionId: "m5")]))
		let before = store.window.lowerBound
		let older = base.addingTimeInterval(-30 * 24 * 3600)
		store.extendWindow(
			back: older,
			missions: [mission(
				id: "m1", number: 1, state: .blocked,
				createdAt: base.addingTimeInterval(-31 * 24 * 3600))],
			events: [Event(
				seq: 1, at: older, workspaceId: workspaceId, kind: .missionBlocked,
				missionId: "m1", agentId: nil, sessionId: nil, turnId: nil, data: [:])])
		XCTAssertEqual(store.window.lowerBound, older)
		XCTAssertLessThan(store.window.lowerBound, before)
		XCTAssertEqual(store.window.upperBound, base)
		XCTAssertEqual(store.missions.map(\.id), ["m1", "m5"])
		XCTAssertEqual(store.missionsByNumber[1]?.id, "m1")
		XCTAssertEqual(store.events.map(\.seq), [1, 5])
	}

	func testAttentionMatchesOrderRule() {
		let store = Store()
		store.replace(snapshot: snapshot(missions: [
			mission(id: "r4", number: 4, state: .running, hoursAfterBase: 4),
			mission(id: "c6", number: 6, state: .closed, hoursAfterBase: 6),
			mission(id: "b9", number: 9, state: .blocked, hoursAfterBase: 9),
			mission(id: "m8", number: 8, state: .mergedNotClosed, hoursAfterBase: 8),
			mission(id: "f5", number: 5, state: .failed, hoursAfterBase: 5),
			mission(id: "q1", number: 1, state: .readyToClose, hoursAfterBase: 1),
			mission(id: "b3", number: 3, state: .blocked, hoursAfterBase: 3),
			mission(id: "m2", number: 2, state: .mergedNotClosed, hoursAfterBase: 2),
		]))
		// Stored sorted by createdAt; attention reorders by the rule.
		XCTAssertEqual(store.missions.map(\.number), [1, 2, 3, 4, 5, 6, 8, 9])
		XCTAssertEqual(store.attention.map(\.number), [3, 9, 5, 1, 2, 8])
	}

	func testBlockCacheKeepsHundredMostRecentlyViewed() {
		let store = Store()
		store.replace(snapshot: snapshot())
		for i in 0 ..< 101 {
			store.cache(page(texts: ["msg \(i)"]), for: "s\(i)")
			store.noteViewed("s\(i)")
		}
		XCTAssertEqual(store.cachedSessionIds.count, 100)
		XCTAssertFalse(store.cachedSessionIds.contains("s0"))
		XCTAssertEqual(store.cachedSessionIds.first, "s100")
		XCTAssertEqual(store.cachedSessionIds.last, "s1")
		XCTAssertEqual(store.blocks(for: "s100").map(\.text), ["msg 100"])
		XCTAssertEqual(store.blocks(for: "s0"), [])
		// Only noteViewed reorders: viewing s1 brings it to the front.
		store.noteViewed("s1")
		XCTAssertEqual(store.cachedSessionIds.first, "s1")
		// Re-caching a known session keeps its place. The new block uses a
		// distinct key; re-caching identical keys is idempotent, not a dup.
		store.cache(
			ConversationPage(
				turns: [],
				blocks: [Block(
					turnId: "t-new", seq: 99, at: base.addingTimeInterval(9999),
					role: .agent, kind: .text, text: "msg 50 again", data: nil)],
				nextCursor: nil, prevCursor: nil),
			for: "s50")
		XCTAssertEqual(store.cachedSessionIds.first, "s1")
		XCTAssertTrue(store.blocks(for: "s50").map(\.text).contains("msg 50 again"))
	}

	func testSessionOverOneMBCachesNewestBlocks() {
		let store = Store()
		store.replace(snapshot: snapshot())
		let step: TimeInterval = 60
		let blocks = (0 ..< 3).map { i in
			Block(
				turnId: "t\(i)", seq: i, at: base.addingTimeInterval(Double(i) * step),
				role: .agent, kind: .text,
				text: String(repeating: ["a", "b", "c"][i], count: 400_000), data: nil)
		}
		store.cache(
			ConversationPage(turns: [], blocks: blocks, nextCursor: nil, prevCursor: nil),
			for: "s-big")
		let kept = store.blocks(for: "s-big")
		XCTAssertEqual(kept.count, 2)
		XCTAssertTrue(kept[0].text.allSatisfy { $0 == "b" })
		XCTAssertTrue(kept[1].text.allSatisfy { $0 == "c" })
		XCTAssertLessThanOrEqual(store.cachedBytes(for: "s-big"), Store.maxBytesPerSession)
		XCTAssertEqual(store.cachedBytes(for: "s-big"), 800_000)
	}

	// MARK: - Leaders per workspace (FIXPASS G2/G4)

	/// `leader` used to be `snapshot.leaders.first`, so with two workspaces
	/// open the chat and the mission bar targeted whichever the Node listed
	/// first rather than the selected workspace's.
	func testLeaderFollowsTheSelectedWorkspace() {
		let store = Store()
		store.replace(snapshot: twoWorkspaceSnapshot())
		XCTAssertEqual(store.leaders.count, 2)
		XCTAssertEqual(store.currentWorkspaceId, workspaceId)
		XCTAssertEqual(store.leader?.workspaceId, workspaceId)
		XCTAssertEqual(store.leader?.name, "Halden")

		store.setCurrentWorkspace(otherWorkspaceId)
		XCTAssertEqual(store.leader?.workspaceId, otherWorkspaceId)
		XCTAssertEqual(store.leader?.name, "Ines")
		XCTAssertEqual(store.leader?.sessionId, "s-other")
	}

	func testLeaderStateUpsertsByWorkspaceWithoutTouchingTheOther() {
		let store = Store()
		store.replace(snapshot: twoWorkspaceSnapshot())
		store.setCurrentWorkspace(otherWorkspaceId)
		let updated = leader(
			workspaceId: otherWorkspaceId, name: "Ines", sessionId: "s-other", mode: .leadPlus)
		store.apply(notification: .state(StateChange(kind: .leader, record: .leader(updated))))
		XCTAssertEqual(store.leaders.count, 2)
		XCTAssertEqual(store.leader?.mode, .leadPlus)
		XCTAssertEqual(store.leaders[workspaceId]?.mode, .lead, "the other leader is untouched")

		store.setCurrentWorkspace(workspaceId)
		XCTAssertEqual(store.leader?.name, "Halden")
	}

	/// A reconnect must not move the person: `replace(snapshot:)` used to
	/// re-derive the selection on every snapshot, so a Node restart threw
	/// whoever had picked the second workspace back to the first.
	func testSelectedWorkspaceSurvivesAReconnectSnapshot() {
		let store = Store()
		store.replace(snapshot: twoWorkspaceSnapshot())
		store.setCurrentWorkspace(otherWorkspaceId)
		XCTAssertEqual(store.leader?.name, "Ines")

		store.replace(snapshot: twoWorkspaceSnapshot())
		XCTAssertEqual(
			store.currentWorkspaceId, otherWorkspaceId,
			"a snapshot that still lists the selected workspace keeps it selected")
		XCTAssertEqual(store.leader?.name, "Ines")

		// A snapshot without it falls back to the default selection.
		store.replace(snapshot: snapshot())
		XCTAssertEqual(store.currentWorkspaceId, workspaceId)
		XCTAssertEqual(store.leader?.name, "Halden")
	}

	func testOfflineFlagIsSetOnDemandAndClearedByASnapshot() {
		let store = Store()
		XCTAssertFalse(store.nodeOffline)
		store.setNodeOffline(true)
		XCTAssertTrue(store.nodeOffline)
		store.replace(snapshot: snapshot())
		XCTAssertFalse(store.nodeOffline, "a snapshot means the Node answered")
	}

	// MARK: - Helpers

	private let workspaceId = "git:github.com/acme/widget"
	private let otherWorkspaceId = "git:github.com/acme/other"

	private func leader(
		workspaceId: WorkspaceId, name: String, sessionId: SessionId,
		mode: LeaderMode = .lead
	) -> Leader {
		Leader(
			workspaceId: workspaceId, machineId: "m1", name: name,
			sessionId: sessionId, provider: "fake", model: "test-model",
			mode: mode, modeSince: base, modeActiveMs: 0,
			activeMissionId: nil, state: .idle)
	}

	/// Two open workspaces with a leader each, the shape the Node reports the
	/// moment a `neta` command runs in a second repo.
	private func twoWorkspaceSnapshot() -> Snapshot {
		Snapshot(
			machine: Machine(id: "m1", name: "machine", createdAt: base),
			workspaces: [
				Workspace(
					id: workspaceId, kind: .git, name: "widget",
					remote: "git@github.com:acme/widget.git", roots: [], createdAt: base),
				Workspace(
					id: otherWorkspaceId, kind: .git, name: "other",
					remote: "git@github.com:acme/other.git", roots: [], createdAt: base),
			],
			// Listed with the second workspace's leader first, so a test that
			// passes by accident on `leaders.first` cannot.
			leaders: [
				leader(workspaceId: otherWorkspaceId, name: "Ines", sessionId: "s-other"),
				leader(workspaceId: workspaceId, name: "Halden", sessionId: "s-leader"),
			],
			missions: [], hasOlder: false, agents: [],
			completedCounts: [:], events: [], attention: [],
			windowDays: 14, protocolVersion: 1, at: base)
	}

	private func mission(
		id: Ulid, number: Int, state: MissionState, hoursAfterBase: Double
	) -> Mission {
		mission(id: id, number: number, state: state,
			createdAt: base.addingTimeInterval(hoursAfterBase * 3600))
	}

	private func mission(
		id: Ulid, number: Int, state: MissionState, createdAt: Date
	) -> Mission {
		Mission(
			id: id, number: number, workspaceId: workspaceId,
			machineId: "m1", name: "mission \(number)", objective: "Objective.",
			changes: [], lead: .leader, agentIds: [], access: .readOnly,
			worktree: nil, state: state, attention: nil, createdAt: createdAt,
			closedAt: state == .closed ? createdAt : nil, disposition: nil,
			closeReason: nil, integration: nil, continuesMissionId: nil)
	}

	private func agent(id: Ulid, missionId: Ulid, sessionId: Ulid) -> Agent {
		Agent(
			id: id, missionId: missionId, workspaceId: workspaceId,
			name: "agent", task: "Task.", access: .readOnly, provider: "fake",
			model: "test-model", skills: [], sessionId: sessionId,
			canSpawn: false, state: .running, stateBefore: nil, activity: nil,
			pendingQuestion: nil, startedAt: base, endedAt: nil, outcome: nil)
	}

	private func event(seq: Int, missionId: Ulid?) -> Event {
		Event(
			seq: seq, at: base, workspaceId: workspaceId, kind: .missionCreated,
			missionId: missionId, agentId: nil, sessionId: nil, turnId: nil,
			data: [:])
	}

	private func page(texts: [String]) -> ConversationPage {
		ConversationPage(
			turns: [],
			blocks: texts.enumerated().map { i, text in
				Block(
					turnId: "t\(i)", seq: i,
					at: base.addingTimeInterval(Double(i)),
					role: .agent, kind: .text, text: text, data: nil)
			},
			nextCursor: nil, prevCursor: nil)
	}

	/// The Node lists every open workspace in one snapshot, so the shell's
	/// own views read the current workspace's slice: two workspaces used to
	/// interleave on the spine and put two `#1`s in the mission bar.
	func testCurrentWorkspaceSlicesMissionsAgentsAndEvents() {
		let store = Store()
		let other = "git:github.com/acme/other"
		var snapshot = snapshot(
			missions: [mission(
				id: "m1", number: 1, state: .running, createdAt: base)],
			agents: [agent(id: "a1", missionId: "m1", sessionId: "s-a1")],
			events: [event(seq: 1, missionId: "m1")])
		snapshot = Snapshot(
			machine: snapshot.machine,
			workspaces: snapshot.workspaces + [Workspace(
				id: other, kind: .git, name: "other", remote: nil, roots: [],
				createdAt: base)],
			leaders: snapshot.leaders,
			missions: snapshot.missions + [Mission(
				id: "m2", number: 1, workspaceId: other, machineId: "m1",
				name: "theirs", objective: "Objective.", changes: [],
				lead: .leader, agentIds: [], access: .readOnly, worktree: nil,
				state: .running, attention: nil, createdAt: base,
				closedAt: nil, disposition: nil, closeReason: nil,
				integration: nil, continuesMissionId: nil)],
			hasOlder: false,
			agents: snapshot.agents + [Agent(
				id: "a2", missionId: "m2", workspaceId: other, name: "Zed",
				task: "Task.", access: .readOnly, provider: "fake",
				model: "test-model", skills: [], sessionId: "s-a2",
				canSpawn: false, state: .running, stateBefore: nil,
				activity: nil, pendingQuestion: nil, startedAt: base,
				endedAt: nil, outcome: nil)],
			completedCounts: [:],
			events: snapshot.events + [Event(
				seq: 2, at: base, workspaceId: other, kind: .missionCreated,
				missionId: "m2", agentId: nil, sessionId: nil, turnId: nil,
				data: [:])],
			attention: [], windowDays: 14, protocolVersion: 1, at: base)
		store.replace(snapshot: snapshot)

		XCTAssertEqual(store.missions.count, 2, "the cache keeps both")
		XCTAssertEqual(store.currentMissions.map(\.id), ["m1"])
		XCTAssertEqual(store.currentAgentsByMission["m1"]?.map(\.id), ["a1"])
		XCTAssertNil(store.currentAgentsByMission["m2"])
		XCTAssertEqual(store.currentEvents.map(\.seq), [1])

		store.setCurrentWorkspace(other)
		XCTAssertEqual(store.currentMissions.map(\.id), ["m2"])
		XCTAssertEqual(store.currentAgentsByMission["m2"]?.map(\.id), ["a2"])
		XCTAssertEqual(store.currentEvents.map(\.seq), [2])
	}

	// MARK: - Helpers

	private func snapshot(
		machineId: MachineId = "m1",
		leaderSession: SessionId = "s-leader",
		missions: [Mission] = [],
		agents: [Agent] = [],
		events: [Event] = []
	) -> Snapshot {
		Snapshot(
			machine: Machine(id: machineId, name: "machine", createdAt: base),
			workspaces: [Workspace(
				id: workspaceId, kind: .git, name: "widget",
				remote: "git@github.com:acme/widget.git", roots: [],
				createdAt: base)],
			leaders: [Leader(
				workspaceId: workspaceId, machineId: machineId,
				name: "Halden",
				sessionId: leaderSession, provider: "fake", model: "test-model",
				mode: .lead, modeSince: base, modeActiveMs: 0,
				activeMissionId: nil, state: .idle)],
			missions: missions, hasOlder: false, agents: agents,
			completedCounts: [:], events: events, attention: [],
			windowDays: 14, protocolVersion: 1, at: base)
	}
}
