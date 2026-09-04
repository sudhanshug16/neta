import Foundation
import XCTest

@testable import NetaDesktop

/// T11.7 contract: `forWidth` at 1100, 1499, 1500 and 1600; mission fields
/// carry the permanent number and every accepted change; an agent with no
/// outcome omits that field; leader fields with and without a decision
/// record.
@MainActor
final class DetailsTests: XCTestCase {
	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z
	// The workspace is NoScrubs; the leader is Halden. Nothing may
	// derive the leader's name from the workspace.
	private let workspaceId = "git:github.com/acme/NoScrubs"

	func testForWidthBreakpoint() {
		XCTAssertEqual(DetailsPlacement.forWidth(1100), .replacing)
		XCTAssertEqual(DetailsPlacement.forWidth(1499), .replacing)
		XCTAssertEqual(DetailsPlacement.forWidth(1500), .beside)
		XCTAssertEqual(DetailsPlacement.forWidth(1600), .beside)
	}

	func testMissionFieldsCarryNumberAndEveryChangeNewestFirst() {
		let store = store()
		let fields = DetailsModel.fields(
			for: .mission("m304"), store: store, decision: nil)
		let byId = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0) })
		XCTAssertEqual(byId["number"]?.value, "304")
		XCTAssertEqual(byId["name"]?.value, "Rate limiter on /search")
		XCTAssertEqual(byId["objective"]?.value, "Cap search QPS.")
		let changes = fields.filter { $0.id.hasPrefix("change-") }
		XCTAssertEqual(
			changes.map(\.value),
			["Also cover /suggest.", "Cover /search first."])
		XCTAssertEqual(byId["worktree-path"]?.value, "/work/m304")
		XCTAssertEqual(byId["worktree-branch"]?.value, "neta/m304")
		XCTAssertEqual(byId["integration"]?.value, "merged abc123 into main")
		XCTAssertEqual(byId["disposition"]?.value, "Merged")
	}

	func testMissionWithoutOptionalsOmitsThem() {
		let store = store()
		let fields = DetailsModel.fields(
			for: .mission("m305"), store: store, decision: nil)
		let ids = Set(fields.map(\.id))
		XCTAssertFalse(ids.contains("worktree-path"))
		XCTAssertFalse(ids.contains("worktree-branch"))
		XCTAssertFalse(ids.contains("disposition"))
		XCTAssertEqual(
			fields.first(where: { $0.id == "integration" })?.value,
			"not merged")
	}

	func testAgentWithoutOutcomeOmitsThatField() {
		let store = store()
		let fields = DetailsModel.fields(
			for: .agent("ag-thane"), store: store, decision: nil)
		let byId = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0) })
		XCTAssertEqual(byId["task"]?.value, "Add the limiter.")
		XCTAssertEqual(byId["access"]?.value, "read-only")
		XCTAssertEqual(byId["provider"]?.value, "Codex")
		XCTAssertEqual(byId["model"]?.value, "gpt-5-codex")
		XCTAssertEqual(byId["skills"]?.value, "search, limits")
		XCTAssertEqual(byId["activity"]?.value, "Writing tests")
		XCTAssertNil(byId["outcome"])
	}

	func testAgentWithOutcomeShowsIt() {
		let store = store()
		let fields = DetailsModel.fields(
			for: .agent("ag-quill"), store: store, decision: nil)
		XCTAssertEqual(
			fields.first(where: { $0.id == "outcome" })?.value,
			"Flags removed.")
	}

	func testLeaderFieldsWithDecision() {
		let store = store()
		let fields = DetailsModel.fields(
			for: .leader, store: store, decision: decision())
		let byId = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0) })
		XCTAssertEqual(byId["mode"]?.value, "Lead++ · 14 min active")
		XCTAssertEqual(byId["decision-objective"]?.value, "Ship the limiter.")
		XCTAssertEqual(
			byId["decision-why"]?.value, "Needs workspace writes.")
		XCTAssertEqual(byId["decision-mission"]?.value, "m304")
		XCTAssertEqual(byId["decision-worktree"]?.value, "/work/m304")
		XCTAssertEqual(byId["decision-mutation"]?.value, "code")
		XCTAssertEqual(byId["decision-files"]?.value, "7")
		XCTAssertEqual(byId["decision-validation"]?.value, "swift test")
		XCTAssertEqual(byId["decision-minutes"]?.value, "20")
		XCTAssertEqual(byId["decision-external"]?.value, "none")
		// Mode plus the nine decision-record lines.
		XCTAssertEqual(fields.count, 10)
	}

	func testLeaderFieldsWithoutDecision() {
		let store = store()
		let fields = DetailsModel.fields(
			for: .leader, store: store, decision: nil)
		XCTAssertEqual(fields.map(\.id), ["mode", "decision"])
		XCTAssertEqual(
			fields.last?.value, "No Lead++ decision recorded")
	}

	func testTitles() {
		let store = store()
		XCTAssertEqual(DetailsModel.title(for: .leader, store: store), "Halden")
		XCTAssertEqual(
			DetailsModel.title(for: .leader, store: store), store.leader?.name)
		XCTAssertNotEqual(
			DetailsModel.title(for: .leader, store: store), store.workspaces.first?.name)
		XCTAssertEqual(
			DetailsModel.title(for: .mission("m304"), store: store),
			"#304 Rate limiter on /search")
		XCTAssertEqual(
			DetailsModel.title(for: .agent("ag-thane"), store: store), "Thane")
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
				workspaceId: workspaceId, machineId: "m1",
				name: "Halden",
				sessionId: "s-leader", provider: "Claude",
				model: "claude-opus-5", mode: .leadPlus, modeSince: base,
				modeActiveMs: 14 * 60_000, activeMissionId: "m304",
				state: .running)],
			missions: [
				Mission(
					id: "m304", number: 304, workspaceId: workspaceId,
					machineId: "m1", name: "Rate limiter on /search",
					objective: "Cap search QPS.",
					changes: [
						MissionChange(
							at: base, text: "Cover /search first.",
							turnId: nil),
						MissionChange(
							at: base.addingTimeInterval(60),
							text: "Also cover /suggest.", turnId: nil),
					],
					lead: .leader, agentIds: ["ag-thane"],
					access: .readOnly,
					worktree: Worktree(
						provider: "worktrunk", path: "/work/m304",
						branch: "neta/m304", base: "main"),
					state: .running, attention: nil, createdAt: base,
					closedAt: nil, disposition: .merged, closeReason: nil,
					integration: MissionIntegration(
						mergedAt: base, commit: "abc123", base: "main"),
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
					skills: ["search", "limits"], sessionId: "s-ag-thane",
					canSpawn: false, state: .running, stateBefore: nil,
					activity: AgentActivity(text: "Writing tests", at: base),
					pendingQuestion: nil, startedAt: base, endedAt: nil,
					outcome: nil),
				Agent(
					id: "ag-quill", missionId: "m305",
					workspaceId: workspaceId, name: "Quill",
					task: "Drop the flags.", access: .readWrite,
					provider: "Codex", model: "gpt-5-codex", skills: [],
					sessionId: "s-ag-quill", canSpawn: true,
					state: .blocked, stateBefore: nil, activity: nil,
					pendingQuestion: nil, startedAt: base, endedAt: nil,
					outcome: "Flags removed."),
			],
			completedCounts: [:], events: [], attention: [],
			windowDays: 14, protocolVersion: 1, at: base))
		return store
	}

	private func decision() -> DecisionRecord {
		DecisionRecord(
			objective: "Ship the limiter.",
			whyLeadInsufficient: "Needs workspace writes.",
			missionId: "m304", worktreePath: "/work/m304",
			mutationKind: "code", estimatedFiles: 7,
			validation: "swift test", estimatedMinutes: 20,
			externalEffects: "none")
	}
}
