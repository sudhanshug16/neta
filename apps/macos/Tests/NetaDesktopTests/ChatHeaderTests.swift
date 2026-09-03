import Foundation
import XCTest

@testable import NetaDesktop

/// T11.5 contract: the leader path is one segment with the tag, an agent
/// path three with selections on the first two, a leader-led mission two;
/// subtitles for a leader and a read-only agent; the strip hidden for an
/// agent and for a leader in `lead`, with the missing mission clause dropped.
@MainActor
final class ChatHeaderTests: XCTestCase {
	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z
	private let workspaceId = "git:github.com/acme/Halden"

	func testLeaderPathIsOneSegmentWithTag() {
		let store = store()
		let segments = ChatPath.segments(for: .leader, store: store)
		XCTAssertEqual(segments, [ChatPathSegment(
			id: "leader", label: "Halden", selection: .leader, isLast: true)])
		XCTAssertTrue(ChatPath.showsLeaderTag(for: .leader))
	}

	func testAgentPathHasThreeSegmentsWithSelectionsOnFirstTwo() {
		let store = store()
		let segments = ChatPath.segments(for: .agent("ag-thane"), store: store)
		XCTAssertEqual(segments.map(\.label), [
			"Halden", "#304 Rate limiter on /search", "Thane",
		])
		XCTAssertEqual(segments.map(\.isLast), [false, false, true])
		XCTAssertEqual(segments[0].selection, .leader)
		XCTAssertEqual(segments[1].selection, .mission("m304"))
		XCTAssertEqual(segments[2].selection, .agent("ag-thane"))
		XCTAssertFalse(ChatPath.showsLeaderTag(for: .agent("ag-thane")))
	}

	func testLeaderLedMissionEndsAtMission() {
		let store = store()
		let segments = ChatPath.segments(for: .mission("m304"), store: store)
		XCTAssertEqual(segments.map(\.label), ["Halden", "#304 Rate limiter on /search"])
		XCTAssertEqual(segments.map(\.isLast), [false, true])
		XCTAssertEqual(segments[1].selection, .mission("m304"))
		XCTAssertFalse(ChatPath.showsLeaderTag(for: .mission("m304")))
	}

	func testAgentLedMissionAppendsLeadAgent() {
		let store = store()
		let segments = ChatPath.segments(for: .mission("m305"), store: store)
		XCTAssertEqual(segments.map(\.label), ["Halden", "#305 Flag cleanup", "Quill"])
		XCTAssertEqual(segments.map(\.isLast), [false, false, true])
	}

	func testLeaderSubtitle() {
		let store = store()
		XCTAssertEqual(
			ChatPath.subtitle(for: .leader, store: store),
			"Claude · claude-opus-5 · Running")
	}

	func testReadOnlyAgentSubtitle() {
		let store = store()
		XCTAssertEqual(
			ChatPath.subtitle(for: .agent("ag-thane"), store: store),
			"Codex · gpt-5-codex · read-only · Running")
	}

	func testReadWriteAgentSubtitle() {
		let store = store()
		XCTAssertEqual(
			ChatPath.subtitle(for: .agent("ag-quill"), store: store),
			"Codex · gpt-5-codex · read-write · Blocked")
	}

	func testMissionSubtitleResolvesToLead() {
		let store = store()
		XCTAssertEqual(
			ChatPath.subtitle(for: .mission("m304"), store: store),
			"Claude · claude-opus-5 · Running")
		XCTAssertEqual(
			ChatPath.subtitle(for: .mission("m305"), store: store),
			"Codex · gpt-5-codex · read-write · Blocked")
	}

	func testStripVisibleOnlyForLeaderInLeadPlus() {
		let lead = leader(mode: .lead)
		let leadPlus = leader(mode: .leadPlus)
		XCTAssertTrue(LeadPlusStripModel.isVisible(leadPlus, .leader))
		XCTAssertFalse(LeadPlusStripModel.isVisible(leadPlus, .agent("ag-thane")))
		XCTAssertFalse(LeadPlusStripModel.isVisible(leadPlus, .mission("m304")))
		XCTAssertFalse(LeadPlusStripModel.isVisible(lead, .leader))
		XCTAssertFalse(LeadPlusStripModel.isVisible(nil, .leader))
	}

	func testStripTextWithMission() {
		let store = store()
		let mission = store.missionsById["m304"]
		XCTAssertEqual(
			LeadPlusStripModel.text(minutes: 14, mission: mission),
			"Lead++ active 14 min · #304 Rate limiter on /search")
	}

	func testStripTextDropsMissingMissionClause() {
		XCTAssertEqual(
			LeadPlusStripModel.text(minutes: 3, mission: nil),
			"Lead++ active 3 min")
	}

	func testStripMinutesFloorModeActiveMs() {
		// 14 minutes and change floors to 14.
		let ms = 14 * 60_000 + 30_000
		XCTAssertEqual(
			LeadPlusStripModel.text(minutes: ms / 60_000, mission: nil),
			"Lead++ active 14 min")
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
			leaders: [leader(mode: .leadPlus)],
			missions: [
				mission(id: "m304", number: 304, name: "Rate limiter on /search", lead: .leader),
				mission(
					id: "m305", number: 305, name: "Flag cleanup",
					lead: .agent(agentId: "ag-quill")),
			],
			hasOlder: false,
			agents: [
				agent(
					id: "ag-thane", missionId: "m304", name: "Thane",
					access: .readOnly, state: .running),
				agent(
					id: "ag-quill", missionId: "m305", name: "Quill",
					access: .readWrite, state: .blocked),
			],
			completedCounts: [:], events: [], attention: [],
			windowDays: 14, protocolVersion: 1, at: base))
		return store
	}

	private func leader(mode: LeaderMode) -> Leader {
		Leader(
			workspaceId: workspaceId, machineId: "m1",
			sessionId: "s-leader", provider: "Claude", model: "claude-opus-5",
			mode: mode, modeSince: base, modeActiveMs: 14 * 60_000,
			activeMissionId: "m304", state: .running)
	}

	private func mission(
		id: Ulid, number: Int, name: String, lead: MissionLead
	) -> Mission {
		Mission(
			id: id, number: number, workspaceId: workspaceId,
			machineId: "m1", name: name, objective: "Objective.",
			changes: [], lead: lead, agentIds: [], access: .readOnly,
			worktree: nil, state: .running, attention: nil, createdAt: base,
			closedAt: nil, disposition: nil, closeReason: nil,
			integration: nil, continuesMissionId: nil)
	}

	private func agent(
		id: Ulid, missionId: Ulid, name: String, access: Access, state: AgentState
	) -> Agent {
		Agent(
			id: id, missionId: missionId, workspaceId: workspaceId,
			name: name, task: "Task.", access: access, provider: "Codex",
			model: "gpt-5-codex", skills: [], sessionId: "s-\(id)",
			canSpawn: false, state: state, stateBefore: nil, activity: nil,
			pendingQuestion: nil, startedAt: base, endedAt: nil, outcome: nil)
	}
}
