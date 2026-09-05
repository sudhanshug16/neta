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
	// The workspace is NoScrubs; the leader is Halden. Nothing may
	// derive the leader's name from the workspace.
	private let workspaceId = "git:github.com/acme/NoScrubs"

	func testLeaderPathIsOneSegmentWithTag() {
		let store = store()
		let segments = ChatPath.segments(for: .leader, store: store)
		XCTAssertEqual(segments, [ChatPathSegment(
			id: "leader", label: "Halden", selection: .leader, isLast: true)])
		XCTAssertTrue(ChatPath.showsLeaderTag(for: .leader))
		// The label is the leader's own name, not the workspace's.
		XCTAssertEqual(segments[0].label, store.leader?.name)
		XCTAssertNotEqual(segments[0].label, store.workspaces.first?.name)
	}

	func testLeaderLabelFallsBackWithoutALeader() {
		let empty = Store()
		let segments = ChatPath.segments(for: .leader, store: empty)
		XCTAssertEqual(segments.map(\.label), ["Leader"])
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

	func testOpenTurnUsesRespondingInsteadOfDurableLeaderState() {
		let store = store()
		XCTAssertEqual(
			ChatPath.subtitle(for: .leader, store: store, isResponding: true),
			"Claude · claude-opus-5 · Responding")
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

	/// The header prints one name line. It used to print the leader twice —
	/// once as the path, once as an identity row — so count the occurrences.
	func testHeaderPrintsTheNameExactlyOnce() {
		let store = store()
		for selection in [Selection.leader, .mission("m304"), .agent("ag-thane")] {
			let model = ChatHeaderModel.make(selection: selection, store: store)
			let name = model.name
			XCTAssertFalse(name.isEmpty)
			XCTAssertEqual(
				model.labels.filter { $0 == name }.count, 1,
				"\(selection) prints \(name) once")
		}
	}

	/// The model above cannot see a second name line: `labels` is built as
	/// segments + tag + subtitle + Details, so it prints the name once by
	/// construction. The deviation was in the view — the leader printed once
	/// as the path and once as an identity row under it — so pin the view's
	/// structure as well: one primary-weight name Text, one avatar, no row
	/// that prints the identity again.
	func testHeaderViewDrawsOneNameLineAndNoIdentityRow() throws {
		let source = try chatHeaderViewSource()
		XCTAssertEqual(
			occurrences(of: "Theme.text(14, .semibold)", in: source), 1,
			"exactly one primary-weight name Text")
		XCTAssertEqual(
			occurrences(of: "nameLine(", in: source), 2,
			"the name line is declared once and drawn once")
		for identityRow in ["Text(model.name)", "model.name)", "SigilView", "monogram"] {
			XCTAssertFalse(
				source.contains(identityRow),
				"no identity row: the path's last segment is the name")
		}
		XCTAssertEqual(
			occurrences(of: "Circle()", in: source), 1,
			"one avatar circle, no second monogram")
		XCTAssertEqual(occurrences(of: "crown.fill", in: source), 1)
	}

	/// The leader header, line by line: avatar, name, tag, subtitle, Details.
	func testLeaderHeaderLabels() {
		let model = ChatHeaderModel.make(selection: .leader, store: store())
		XCTAssertEqual(model.labels, [
			"Halden", "WORKSPACE LEADER",
			"Claude · claude-opus-5 · Running", "Details",
		])
		XCTAssertEqual(model.name, "Halden")
		XCTAssertTrue(model.showsAvatar, "the leader gets the violet crown avatar")
	}

	/// An agent header: the path is the name line, no tag, no avatar.
	func testAgentHeaderLabels() {
		let model = ChatHeaderModel.make(selection: .agent("ag-thane"), store: store())
		XCTAssertEqual(model.labels, [
			"Halden", "#304 Rate limiter on /search", "Thane",
			"Codex · gpt-5-codex · read-only · Running", "Details",
		])
		XCTAssertFalse(model.showsLeaderTag)
		XCTAssertFalse(model.showsAvatar)
	}

	/// Revision 2 removed Stop and the mode control from this header.
	func testHeaderHasNoStopOrModeControl() throws {
		let source = try chatHeaderViewSource()
		XCTAssertFalse(source.contains("\"Stop\""), "Stop lives on the composer")
		XCTAssertFalse(source.contains("Lead++"), "the mode control lives on the composer")
		XCTAssertTrue(source.contains("crown.fill"), "the leader avatar carries a crown")
		XCTAssertTrue(source.contains("Theme.Metric.headerAvatar"), "28 pt avatar")
		// Details is a control on the chat panel, so it names the control
		// weight: a bare capsule silhouette would float (Glass.swift).
		XCTAssertTrue(
			source.contains("netaControlGlass(.capsule"), "Details is a glass capsule")
		XCTAssertFalse(source.contains("netaFloatingGlass"), "Details sits on the panel")
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

	private func occurrences(of token: String, in contents: String) -> Int {
		contents.components(separatedBy: token).count - 1
	}

	/// Revision 3 surface 2 gives the strip violet glass at 0.18. The tone is
	/// a token, not a literal restated in the view.
	func testLeadPlusStripTakesItsToneFromGlass() throws {
		let source = try chatSource(named: "LeadPlusStrip.swift")
		XCTAssertTrue(
			source.contains("tint: Theme.Glass.leadPlusStrip"),
			"the strip takes the 0.18 violet from Theme.Glass")
		XCTAssertFalse(source.contains("opacity(0.18)"), "no restated literal")
		// Nested inside the chat panel, so no outer shadow.
		XCTAssertFalse(source.contains("netaFloatingGlass"), "the strip sits on the chat panel")
	}

	private func chatSource(named name: String) throws -> String {
		var url = URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()
		url.deleteLastPathComponent()
		url.deleteLastPathComponent()
		url.appendPathComponent("Sources/NetaDesktop/Chat/\(name)")
		return try String(contentsOf: url, encoding: .utf8)
	}

	private func chatHeaderViewSource() throws -> String {
		var url = URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()
		url.deleteLastPathComponent()
		url.deleteLastPathComponent()
		url.appendPathComponent("Sources/NetaDesktop/Chat/ChatHeaderView.swift")
		return try String(contentsOf: url, encoding: .utf8)
	}

	private func store() -> Store {
		let store = Store()
		store.replace(snapshot: Snapshot(
			machine: Machine(id: "m1", name: "mac-studio", createdAt: base),
			workspaces: [Workspace(
				id: workspaceId, kind: .git, name: "NoScrubs",
				remote: "git@github.com:acme/NoScrubs.git", roots: [],
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
			name: "Halden",
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
