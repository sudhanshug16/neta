import Foundation
import SwiftUI
import XCTest

@testable import NetaDesktop

// MARK: - Builders

private let baseNow = Date(timeIntervalSince1970: 1_787_712_000)

private func makeMission(
	number: Int = 298,
	name: String = "mission",
	state: MissionState = .running,
	attention: String? = nil,
	createdAt: Date = baseNow,
	lead: MissionLead = .leader
) -> Mission {
	Mission(
		id: "m\(number)", number: number, workspaceId: "w", machineId: "m",
		name: name, objective: "Objective.", changes: [], lead: lead,
		agentIds: [], access: .readOnly, worktree: nil, state: state,
		attention: attention, createdAt: createdAt,
		closedAt: state == .closed ? createdAt : nil, disposition: nil,
		closeReason: nil, integration: nil, continuesMissionId: nil)
}

private func makeAgent(
	name: String = "agent",
	task: String = "Task.",
	state: AgentState = .running,
	access: Access = .readOnly,
	model: String = "test-model",
	activity: String? = nil
) -> Agent {
	Agent(
		id: "a-\(name)-\(state.rawValue)", missionId: "m1", workspaceId: "w",
		name: name, task: task, access: access, provider: "fake",
		model: model, skills: [], sessionId: "s", canSpawn: false,
		state: state, stateBefore: nil,
		activity: activity.map { AgentActivity(text: $0, at: baseNow) },
		pendingQuestion: nil, startedAt: baseNow, endedAt: nil, outcome: nil)
}

private func nodeViewsSource() throws -> String {
	var url = URL(fileURLWithPath: #filePath, isDirectory: false)
		.deletingLastPathComponent()
	url.deleteLastPathComponent()
	url.deleteLastPathComponent()
	url.appendPathComponent("Sources/NetaDesktop/Canvas/NodeViews.swift")
	return try String(contentsOf: url, encoding: .utf8)
}

/// T10.6 contract: lead/agent models over the recorded 09 fixture plus the
/// age buckets, and the four node views with their anatomy and hit targets.
/// Protocol data always comes from `test/fixtures`; nothing is hand-written.
@MainActor
final class NodeViewTests: XCTestCase {
	// MARK: - LeadCardModel over the fixture

	func testLeadCardModelCoversEveryFixtureMission() async throws {
		let snapshot = try await FixtureNodeClient().snapshot()
		XCTAssertEqual(snapshot.missions.count, 13)
		let agentsById = Dictionary(
			uniqueKeysWithValues: snapshot.agents.map { ($0.id, $0) })
		for mission in snapshot.missions {
			let lead: Agent? = {
				if case .agent(let id) = mission.lead { return agentsById[id] }
				return nil
			}()
			let model = LeadCardModel(
				mission: mission, lead: lead, leaderName: "Halden", now: snapshot.at)
			XCTAssertEqual(model.numberText, "#\(mission.number)", "number #\(mission.number)")
			XCTAssertEqual(model.name, mission.name, "name #\(mission.number)")
			XCTAssertEqual(
				model.stateLabel, CanvasStyle.label(for: mission.state),
				"state label #\(mission.number)")
			XCTAssertEqual(
				model.attention, mission.attention, "attention verbatim #\(mission.number)")
			XCTAssertEqual(
				model.crown, mission.lead == .leader, "crown #\(mission.number)")
			XCTAssertNotNil(model.ledBy, "led by #\(mission.number)")
			assertAgeFormat(model.ageText, file: #filePath, line: #line)
		}
	}

	func testLeadCardFixtureAge() async throws {
		let snapshot = try await FixtureNodeClient().snapshot()
		let mission = try XCTUnwrap(snapshot.missions.first { $0.number == 2 })
		let model = LeadCardModel(
			mission: mission, lead: nil, leaderName: "Halden", now: snapshot.at)
		XCTAssertEqual(model.ageText, "5h")
	}

	func testLeadCardCrownExactlyWhenLeaderLed() {
		let crowned = LeadCardModel(
			mission: makeMission(), lead: nil, leaderName: "Halden", now: baseNow)
		XCTAssertTrue(crowned.crown)
		XCTAssertEqual(crowned.ledBy, "led by Halden")

		let lead = makeAgent(name: "Ember")
		let agentLed = LeadCardModel(
			mission: makeMission(lead: .agent(agentId: lead.id)), lead: lead,
			leaderName: "Halden", now: baseNow)
		XCTAssertFalse(agentLed.crown)
		XCTAssertEqual(agentLed.ledBy, "led by Ember")

		let missing = LeadCardModel(
			mission: makeMission(lead: .agent(agentId: "no-such-agent")), lead: nil,
			leaderName: "Halden", now: baseNow)
		XCTAssertFalse(missing.crown)
		XCTAssertNil(missing.ledBy)
	}

	func testLeadCardAges() {
		let cases: [(TimeInterval, String)] = [
			(25 * 60, "25m"),
			(2 * 3600, "2h"),
			(3 * 86400, "3d"),
			(14 * 86400, "2w"),
		]
		for (offset, expected) in cases {
			let mission = makeMission(createdAt: baseNow.addingTimeInterval(-offset))
			let model = LeadCardModel(
				mission: mission, lead: nil, leaderName: "Halden", now: baseNow)
			XCTAssertEqual(model.ageText, expected, "age \(offset)s")
		}
	}

	func testLeadCardAttentionVerbatim() {
		let note = "Which API should the widget use?"
		let with = LeadCardModel(
			mission: makeMission(attention: note), lead: nil,
			leaderName: "Halden", now: baseNow)
		XCTAssertEqual(with.attention, note)
		let without = LeadCardModel(
			mission: makeMission(), lead: nil, leaderName: "Halden", now: baseNow)
		XCTAssertNil(without.attention)
	}

	// MARK: - AgentRowModel

	func testAgentRowModelKeepsFullTask() async throws {
		let snapshot = try await FixtureNodeClient().snapshot()
		XCTAssertFalse(snapshot.agents.isEmpty)
		for agent in snapshot.agents {
			let model = AgentRowModel(agent: agent)
			XCTAssertEqual(model.task, agent.task, "full task for \(agent.name)")
			XCTAssertEqual(model.name, agent.name)
			XCTAssertEqual(model.model, agent.model)
			XCTAssertEqual(model.stateLabel, CanvasStyle.label(for: agent.state))
			XCTAssertEqual(model.sigil, Sigil(name: agent.name))
			XCTAssertEqual(
				model.accessGlyph, agent.access == .readOnly ? "eye" : "pencil")
			if agent.state != .running {
				XCTAssertNil(model.activity, "activity only for running")
			}
		}
		let long = "Return Retry-After on throttled responses\nand document every edge."
		XCTAssertEqual(AgentRowModel(agent: makeAgent(task: long)).task, long)
	}

	func testAgentRowActivityOnlyForRunning() {
		let running = AgentRowModel(
			agent: makeAgent(state: .running, activity: "Editing limiter.ts"))
		XCTAssertEqual(running.activity, "Editing limiter.ts")
		XCTAssertNil(AgentRowModel(agent: makeAgent(state: .running)).activity)
		for state in [AgentState.blocked, .failed, .completed, .starting, .interrupted] {
			let model = AgentRowModel(
				agent: makeAgent(state: state, activity: "Editing limiter.ts"))
			XCTAssertNil(model.activity, "no activity when \(state.rawValue)")
		}
	}

	func testAgentRowAccessGlyphs() {
		XCTAssertEqual(
			AgentRowModel(agent: makeAgent(access: .readOnly)).accessGlyph, "eye")
		XCTAssertEqual(
			AgentRowModel(agent: makeAgent(access: .readWrite)).accessGlyph, "pencil")
	}

	// MARK: - View anatomy and hit targets

	func testViewsHoldExactlyTheirContract() {
		let leader = LeaderCardView(name: "Halden", mode: .leadPlus, selected: false)
		XCTAssertEqual(
			Mirror(reflecting: leader).children.compactMap(\.label).sorted(),
			["mode", "name", "selected"])
		let mission = makeMission()
		let cardModel = LeadCardModel(
			mission: mission, lead: nil, leaderName: "Halden", now: baseNow)
		let card = LeadCardView(model: cardModel, emphasis: 1, selected: false)
		XCTAssertEqual(
			Mirror(reflecting: card).children.compactMap(\.label).sorted(),
			["emphasis", "model", "selected"])
		let rowModel = AgentRowModel(agent: makeAgent())
		let row = AgentRowView(model: rowModel, emphasis: 1, selected: false)
		XCTAssertEqual(
			Mirror(reflecting: row).children.compactMap(\.label).sorted(),
			["emphasis", "model", "selected"])
		let chip = CompletedChip(count: 8, expanded: false, action: {})
		XCTAssertEqual(
			Mirror(reflecting: chip).children.compactMap(\.label).sorted(),
			["action", "count", "expanded"])
	}

	func testCompletedChipFiresInPlace() {
		var fired = false
		let chip = CompletedChip(count: 8, expanded: false, action: { fired = true })
		let action = Mirror(reflecting: chip).children
			.first { $0.label == "action" }?.value as? () -> Void
		XCTAssertNotNil(action)
		action?()
		XCTAssertTrue(fired)
	}

	func testViewHeightsMeetMinHitHeight() {
		let floor = SpineMetrics.standard.minHitHeight
		let leader = LeaderCardView(name: "Halden", mode: .leadPlus, selected: false)
		XCTAssertGreaterThanOrEqual(hostedHeight(of: leader), floor, "leader card")
		let mission = makeMission(attention: "Which API should the widget use?")
		let cardModel = LeadCardModel(
			mission: mission, lead: nil, leaderName: "Halden", now: baseNow)
		XCTAssertGreaterThanOrEqual(
			hostedHeight(of: LeadCardView(model: cardModel, emphasis: 0.7, selected: false)),
			floor, "lead card")
		let rowModel = AgentRowModel(
			agent: makeAgent(state: .running, activity: "Editing limiter.ts"))
		XCTAssertGreaterThanOrEqual(
			hostedHeight(of: AgentRowView(model: rowModel, emphasis: 1, selected: false)),
			floor, "agent row")
		XCTAssertGreaterThanOrEqual(
			hostedHeight(of: CompletedChip(count: 8, expanded: false, action: {})),
			floor, "completed chip")
	}

	func testNodeViewsNeverScaleAndTintThroughCanvasStyle() throws {
		let source = try nodeViewsSource()
		XCTAssertFalse(source.contains(".scaleEffect"), "nodes never scale")
		XCTAssertTrue(
			source.contains("CanvasStyle.text"),
			"tint routes through CanvasStyle.text")
	}

	// MARK: - Helpers

	private func hostedHeight<V: View>(of view: V, width: CGFloat = 240) -> CGFloat {
		let hosting = NSHostingView(rootView: view)
		hosting.frame = CGRect(x: 0, y: 0, width: width, height: 900)
		hosting.layoutSubtreeIfNeeded()
		return hosting.fittingSize.height
	}

	private func assertAgeFormat(
		_ age: String, file: StaticString = #filePath, line: UInt = #line
	) {
		guard let suffix = age.last, "mhdw".contains(suffix) else {
			return XCTFail("age \(age) ends in m/h/d/w", file: file, line: line)
		}
		XCTAssertTrue(
			age.dropLast().allSatisfy(\.isNumber) && age.count > 1,
			"age \(age) is digits plus a bucket", file: file, line: line)
	}
}
