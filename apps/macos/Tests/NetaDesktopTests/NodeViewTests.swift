import AppKit
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
	lead: MissionLead = .leader,
	closedAt: Date? = nil,
	disposition: Disposition? = nil
) -> Mission {
	Mission(
		id: "m\(number)", number: number, workspaceId: "w", machineId: "m",
		name: name, objective: "Objective.", changes: [], lead: lead,
		agentIds: [], access: .readOnly, worktree: nil, state: state,
		attention: attention, createdAt: createdAt,
		closedAt: state == .closed ? (closedAt ?? createdAt) : nil,
		disposition: state == .closed ? disposition : nil,
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
			if mission.state == .closed {
				let closed = try XCTUnwrap(model.closedText)
				XCTAssertTrue(
					closed.hasPrefix(CanvasStyle.label(for: mission.disposition)),
					"disposition word #\(mission.number): \(closed)")
				XCTAssertTrue(
					closed.contains(" · closed "),
					"closing age #\(mission.number): \(closed)")
				XCTAssertFalse(
					closed.contains("Closed ·"), "never the state label")
			} else {
				XCTAssertNil(
					model.closedText,
					"an open mission carries no closing line #\(mission.number)")
			}
		}
	}

	/// PAPER-SPINE artboard 1 item 3 (kept by Revision 2): a closed mission
	/// reads `#296 Slack digest bot · Merged · closed 10d`. The word is the
	/// recorded disposition, never the state label `Closed`, and the age is
	/// measured from `closedAt`, not from when the mission started.
	func testClosedMissionCarriesItsDispositionAndClosingAge() {
		let opened = baseNow.addingTimeInterval(-40 * 86400)
		let merged = makeMission(
			number: 296, name: "Slack digest bot", state: .closed,
			createdAt: opened,
			closedAt: baseNow.addingTimeInterval(-10 * 86400),
			disposition: .merged)
		let model = LeadCardModel(
			mission: merged, lead: nil, leaderName: "Halden", now: baseNow)
		XCTAssertEqual(model.numberText, "#296")
		XCTAssertEqual(model.name, "Slack digest bot")
		XCTAssertEqual(model.closedText, "Merged · closed 10d")
		XCTAssertEqual(model.ageText, "5w", "the card age is still the mission's own")

		let abandoned = makeMission(
			number: 294, name: "Docs site build cache", state: .closed,
			createdAt: opened,
			closedAt: baseNow.addingTimeInterval(-11 * 86400),
			disposition: .abandoned)
		let second = LeadCardModel(
			mission: abandoned, lead: nil, leaderName: "Halden", now: baseNow)
		XCTAssertEqual(second.closedText, "Abandoned · closed 11d")

		// Closed with nothing recorded: the navigator's archive rows and the
		// closed node say the same word.
		let bare = LeadCardModel(
			mission: makeMission(number: 291, state: .closed),
			lead: nil, leaderName: "Halden", now: baseNow)
		XCTAssertEqual(bare.closedText, "Archived · closed 0m")
	}

	/// The drawn node reads the model's closing line, not the state label:
	/// `#296 Slack digest bot · Merged · closed 10d`.
	func testTheClosedNodeDrawsTheClosingLineNotTheStateLabel() throws {
		let source = try nodeViewsSource()
		let start = try XCTUnwrap(source.range(of: "private var collapsedBody"))
		let end = try XCTUnwrap(
			source.range(of: "private var fullBody", range: start.upperBound ..< source.endIndex))
		let body = String(source[start.lowerBound ..< end.lowerBound])
		XCTAssertTrue(
			body.contains("model.closedText ?? model.stateLabel"),
			"the closed node prints the closing line")
		XCTAssertFalse(
			body.contains("Text(model.stateLabel)"),
			"and never the bare state label, which reads `Closed`")
		XCTAssertTrue(
			body.contains("Text(model.numberText)") && body.contains("Text(model.name)"),
			"beside the number and the name")
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
			["collapsed", "emphasis", "model", "selected"])
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

	/// The `+N completed` chip is a glass capsule with a chevron, never a
	/// circle or a bubble (BRIEF MUST). Revision 3 lists it under "Controls
	/// on glass": "capsule glass with the same rim" — the rim, not the
	/// `0 18 40` outer shadow. Its silhouette is a capsule, which would
	/// otherwise float, so the control weight is named (see the elevation
	/// rule in Glass.swift).
	func testCompletedChipIsAGlassCapsuleWithAChevron() throws {
		let source = try nodeViewsSource()
		let chip = try XCTUnwrap(source.range(of: "public struct CompletedChip"))
		let body = String(source[chip.lowerBound...])
		XCTAssertTrue(
			body.contains("netaControlGlass(.capsule"), "the chip is a glass capsule")
		XCTAssertFalse(
			body.contains("netaFloatingGlass"), "a small pill between agent rows casts no 40 pt shadow")
		XCTAssertTrue(body.contains("chevron.right"), "collapsed chevron")
		XCTAssertTrue(body.contains("chevron.down"), "expanded chevron")
		XCTAssertFalse(body.contains("Circle()"), "never a circle")
	}

	/// The leader card keeps the Revision 3 rim and sheen, and takes them
	/// from Glass rather than restating the gradient.
	func testLeaderCardBorrowsTheGlassSpecular() throws {
		let source = try nodeViewsSource()
		XCTAssertTrue(source.contains("netaSpecular(.rounded("), "sheen comes from Glass")
		XCTAssertTrue(source.contains("Theme.Glass.leaderTint"), "violet tint token")
		XCTAssertFalse(source.contains("LinearGradient"), "no second copy of the sheen")
		XCTAssertTrue(
			source.contains("Theme.Glass.leaderBorder"),
			"the violet rim stays, as a token (PAPER-SPINE item 11)")
	}

	/// Item 1 of the fix pass: no colour or font literal in the node views.
	/// Every size goes through `Theme.text` / `Theme.mono` and every colour
	/// through `Theme`, so the design numbers have exactly one home.
	func testNodeViewsCarryNoColourOrFontLiterals() throws {
		let source = try nodeViewsSource()
		XCTAssertEqual(
			occurrences(of: ".system(size:", in: source), 0,
			"fonts route through Theme.text and Theme.mono")
		XCTAssertEqual(
			occurrences(of: "Color.white", in: source), 0,
			"the crown takes Theme.textPrimary")
		XCTAssertEqual(
			occurrences(of: "Color(", in: source), 0,
			"no colour is constructed here")
		XCTAssertEqual(
			occurrences(of: ".opacity(", in: source), 0,
			"an opacity belongs to the token, not the view")
	}

	func testNodeViewsNeverScaleAndTintThroughCanvasStyle() throws {
		let source = try nodeViewsSource()
		XCTAssertFalse(source.contains(".scaleEffect"), "nodes never scale")
		XCTAssertTrue(
			source.contains("CanvasStyle.text"),
			"tint routes through CanvasStyle.text")
	}

	// MARK: - Helpers

	private func occurrences(of token: String, in contents: String) -> Int {
		contents.components(separatedBy: token).count - 1
	}

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

// MARK: - Framing

/// Every materialised node view is exactly the size of the rect the layout
/// reserved for it.
///
/// `.position` centres a view on a point, so a view left to its intrinsic
/// size does not become a smaller node — it paints over its neighbours. The
/// render for the 2026-09-04 fix pass showed an agent row across its own lead
/// card, hiding the mission number line: the rows were placed on 40 pt rects
/// and drew 85 pt tall, and the leader card was positioned with no frame at
/// all. Sizes are measured the way AppKit measures them,
/// `NSHostingView.fittingSize`, against the same `SpineMetrics` the placement
/// uses, and the worst content each view can draw (a two-line mission name, a
/// two-line attention note, a two-line task, an activity line) is included so
/// the rect holds the biggest node, not the smallest.
@MainActor
final class NodeFramingTests: XCTestCase {
	private let metrics = SpineMetrics.standard

	private func measure(_ view: some View) -> CGSize {
		NSHostingView(rootView: view.fixedSize()).fittingSize
	}

	func testLeaderCardIsTheSizeOfItsPlacementRect() {
		let index = SpineIndex(
			missions: [], pxPerHour: 48, maxPitch: 320)
		let rect = SpinePlacement.leaderRect(
			index: index, scrollX: 0,
			viewport: CGRect(x: 0, y: 0, width: 1600, height: 1000),
			spineY: 500)
		for name in ["Ada", "Hollis", "Bartholomew Winterbourne"] {
			for mode in [LeaderMode.lead, .leadPlus] {
				XCTAssertEqual(
					measure(LeaderCardView(name: name, mode: mode, selected: false)),
					rect.size,
					"the leader card at Now is its rect, whatever the name")
			}
		}
	}

	func testLeadCardsAreTheSizeOfTheirPlacementRects() {
		let cases: [(String, MissionState, String?)] = [
			("Payments regression", .running, nil),
			("Remove every legacy feature flag from the checkout", .running, nil),
			("settings migration", .blocked, "Which API should the widget use?"),
			(
				"Remove every legacy feature flag from the checkout", .blocked,
				"Which API should the widget use for partial captures, refunds or voids?"
			),
		]
		for (name, state, attention) in cases {
			let mission = makeMission(
				number: 311, name: name, state: state, attention: attention)
			let model = LeadCardModel(
				mission: mission, lead: makeAgent(name: "Tamsin"),
				leaderName: "Hollis", now: baseNow)
			let size = measure(LeadCardView(
				model: model, emphasis: 1, selected: false))
			XCTAssertEqual(size.width, metrics.leadCardWidth)
			XCTAssertEqual(
				size.height, metrics.cardHeight(attention: attention != nil),
				"\(name) must fit the rect its column reserved")
		}
	}

	func testClosedMissionsDrawTheCollapsedNodeAtItsRect() {
		let mission = makeMission(
			number: 296, name: "Slack digest bot", state: .closed)
		let model = LeadCardModel(
			mission: mission, lead: nil, leaderName: "Hollis", now: baseNow)
		XCTAssertEqual(
			measure(LeadCardView(
				model: model, emphasis: 0.55, selected: false, collapsed: true)),
			CGSize(
				width: metrics.closedNodeWidth,
				height: metrics.closedNodeHeight))
	}

	func testAgentRowsAreTheSizeOfTheirStackRects() {
		let cases: [(String, AgentState, String?)] = [
			("Task.", .completed, nil),
			("Rework the socket reconnect backoff and every one of its tests", .completed, nil),
			("Seeded task 1.", .running, "k6 at 400 rps: p95 212 ms"),
			(
				"Rework the socket reconnect backoff and every one of its tests",
				.running,
				"k6 at 400 rps: p95 212 ms, no 429s yet. Raising to 600."
			),
		]
		for (task, state, activity) in cases {
			let agent = makeAgent(
				name: "Bartholomew", task: task, state: state,
				activity: activity)
			let stack = AgentStack.build(agents: [agent], expanded: false, metrics: metrics)
			let item = try? XCTUnwrap(stack.items.first)
			let size = measure(AgentRowView(
				model: AgentRowModel(agent: agent), emphasis: 1,
				selected: false))
			XCTAssertEqual(size.width, metrics.agentRowWidth)
			XCTAssertEqual(size.height, item?.height)
			XCTAssertEqual(
				size.height, metrics.rowHeight(running: state == .running))
		}
	}

	func testTheCompletedChipIsTheSizeOfItsStackRect() {
		let size = measure(CompletedChip(count: 7, expanded: false, action: {}))
		XCTAssertEqual(size.height, metrics.chipHeight)
	}

	/// No two columns paint through each other, whatever order the permanent
	/// numbers arrive in. The side is a pure function of the number, so a
	/// sequence whose numbers do not run in time order puts two neighbours
	/// on the same side; the spacing rule gives those the wider column.
	func testNeighbouringColumnsNeverOverlap() throws {
		let base = baseNow
		// Numbers deliberately out of time order: #3 then #1 are neighbours
		// and both sit above the spine.
		let numbers = [5, 4, 3, 1, 2]
		let missions = numbers.enumerated().map { i, number in
			makeMission(
				number: number, name: "mission \(number)",
				createdAt: base.addingTimeInterval(Double(i) * 600))
		}
		let agents = Dictionary(uniqueKeysWithValues: missions.map { mission in
			(mission.id, [
				makeAgent(name: "a\(mission.number)", task: "Task.", state: .running),
			])
		})
		// Every zoom, not only the default one: `maxPitch` shrinks with zoom
		// and floors at the 120 pt minimum column, so a cap under the 230 pt
		// same-side pitch used to squash two same-side columns into each
		// other (⌘- ⌘- from 100% reaches maxPitch 204.8).
		let zooms: [Double] = [
			SpineViewportState.defaultPxPerHour,
			SpineViewportState.defaultPxPerHour * 0.8 * 0.8,
			SpineViewportState.defaultPxPerHour * 0.8 * 0.8 * 0.8 * 0.8,
			SpineViewportState.minPxPerHour,
		]
		for pxPerHour in zooms {
			let index = SpineIndex(
				missions: missions, pxPerHour: pxPerHour,
				maxPitch: SpineViewportState.maxPitch(for: pxPerHour))
			let placed = SpinePlacement.place(
				index: index, agents: agents, range: 0 ..< index.count,
				scrollX: 0,
				viewport: CGRect(x: 0, y: 0, width: 4000, height: 1000))
			var painted: [(Int, CGRect)] = []
			for column in placed.columns {
				painted.append((column.number, column.card))
				for row in column.rows { painted.append((column.number, row)) }
			}
			for (i, a) in painted.enumerated() {
				for b in painted[(i + 1)...] where a.0 != b.0 {
					XCTAssertFalse(
						a.1.intersects(b.1),
						"#\(a.0) and #\(b.0) paint through each other "
							+ "at \(pxPerHour) px/h")
				}
			}
		}
	}

	/// The stack starts `leadGap` past the card's far edge and never
	/// overlaps it, on both sides of the spine.
	func testTheStackClearsItsLeadCard() {
		let agents = (0 ..< 3).map { i in
			makeAgent(
				name: "a\(i)", task: "Task \(i).",
				state: i == 0 ? .running : .completed)
		}
		let missions = [
			makeMission(number: 310, name: "even", state: .running),
			makeMission(number: 311, name: "odd", state: .running),
		]
		let index = SpineIndex(
			missions: missions, pxPerHour: 48, maxPitch: 320)
		let placed = SpinePlacement.place(
			index: index,
			agents: [missions[0].id: agents, missions[1].id: agents],
			range: 0 ..< index.count, scrollX: 0,
			viewport: CGRect(x: 0, y: 0, width: 1600, height: 1000))
		for column in placed.columns {
			for row in column.rows {
				XCTAssertFalse(
					row.intersects(column.card),
					"#\(column.number)'s stack must clear its own card")
			}
			guard let nearest = column.rows.first else { continue }
			let gap = column.side == .above
				? column.card.minY - nearest.maxY
				: nearest.minY - column.card.maxY
			XCTAssertEqual(gap, SpineMetrics.standard.leadGap)
		}
	}
}
