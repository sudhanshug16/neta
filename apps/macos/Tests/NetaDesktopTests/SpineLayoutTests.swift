import CoreGraphics
import Foundation
import XCTest

@testable import NetaDesktop

/// T10.3 contract: side by number parity, chain-break sweep with a fixed slot
/// width, attention/closed card heights, collapsed closed nodes, and 2/4-point
/// connectors with the exact bend.
final class SpineLayoutTests: XCTestCase {
	private let metrics = SpineMetrics.standard
	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z
	private var baseMs: Double { base.timeIntervalSince1970 * 1000 }

	private let viewport = CGRect(x: 0, y: 0, width: 1600, height: 1000)

	private func lens(focusHours: Double) -> TimeLens {
		TimeLens(TimeLensOptions(
			now: baseMs,
			focusStart: baseMs - focusHours * 3_600_000,
			focusEnd: baseMs,
			width: 1600,
			minPxPerHour: 8))
	}

	// MARK: - SpineIndex

	func testIndexSortsByCreatedAtThenNumber() {
		let m1 = makeMission(id: "m1", number: 3, createdAt: base)
		let m2 = makeMission(id: "m2", number: 1, createdAt: base.addingTimeInterval(-100))
		let m3 = makeMission(id: "m3", number: 2, createdAt: base)
		let m4 = makeMission(id: "m4", number: 1, createdAt: base)
		let index = SpineIndex(missions: [m1, m2, m3, m4])
		XCTAssertEqual(index.count, 4)
		XCTAssertEqual((0 ..< 4).map { index[$0].id }, ["m2", "m4", "m3", "m1"])
	}

	func testEarliestOpenSkipsClosed() {
		let open = makeMission(
			id: "open", number: 2, state: .running,
			createdAt: base.addingTimeInterval(-3600))
		let olderClosed = makeMission(
			id: "older-closed", number: 1, state: .closed,
			createdAt: base.addingTimeInterval(-7200))
		let index = SpineIndex(missions: [olderClosed, open])
		XCTAssertEqual(index.earliestOpen, open.createdAt.timeIntervalSince1970 * 1000)
		XCTAssertNil(SpineIndex(missions: [olderClosed]).earliestOpen)
		XCTAssertNil(SpineIndex(missions: []).earliestOpen)
	}

	func testFirstIndexAtOrAfter() {
		let t0 = base.addingTimeInterval(-300).timeIntervalSince1970 * 1000
		let t1 = base.addingTimeInterval(-200).timeIntervalSince1970 * 1000
		let t2 = base.addingTimeInterval(-100).timeIntervalSince1970 * 1000
		let index = SpineIndex(missions: [
			makeMission(id: "a", number: 1, createdAt: base.addingTimeInterval(-300)),
			makeMission(id: "b", number: 2, createdAt: base.addingTimeInterval(-100)),
			makeMission(id: "c", number: 3, createdAt: base.addingTimeInterval(-100)),
		])
		XCTAssertEqual(index.firstIndex(atOrAfter: t0 - 1), 0)
		XCTAssertEqual(index.firstIndex(atOrAfter: t0), 0)
		XCTAssertEqual(index.firstIndex(atOrAfter: t1), 1)
		XCTAssertEqual(index.firstIndex(atOrAfter: t2), 1)
		XCTAssertEqual(index.firstIndex(atOrAfter: t2 + 1), 3)
		XCTAssertEqual(SpineIndex(missions: []).firstIndex(atOrAfter: t0), 0)
	}

	// MARK: - Side rule

	func testSideFollowsNumberParity() {
		XCTAssertEqual(SpineLayout.side(for: 1), .above)
		XCTAssertEqual(SpineLayout.side(for: 2), .below)
		XCTAssertEqual(SpineLayout.side(for: 3), .above)
		XCTAssertEqual(SpineLayout.side(for: 100), .below)
	}

	func testColumnsHonorSideParity() {
		let missions = (1 ... 6).map { n in
			makeMission(id: "m\(n)", number: n, createdAt: base.addingTimeInterval(Double(-n * 60)))
		}
		let placement = SpineLayout.layout(
			index: SpineIndex(missions: missions), agents: [:],
			lens: lens(focusHours: 72), viewport: viewport)
		for column in placement.columns {
			XCTAssertEqual(
				column.side, column.number.isMultiple(of: 2) ? .below : .above,
				"mission #\(column.number)")
		}
	}

	// MARK: - 1000 seeded datasets

	func testNoSlotOverlapAcrossOneThousandDatasets() {
		let focusHours = [6.0, 72.0, 720.0]
		for seed in 0 ..< 1000 {
			let lens = lens(focusHours: focusHours[seed % focusHours.count])
			let (missions, agents) = randomDataset(seed: seed)
			let index = SpineIndex(missions: missions)
			let placement = SpineLayout.layout(
				index: index, agents: agents, lens: lens, viewport: viewport)
			XCTAssertEqual(placement.columns.count, missions.count, "seed \(seed)")
			XCTAssertEqual(placement.ticks.count, missions.count, "seed \(seed)")
			for (i, column) in placement.columns.enumerated() {
				let mission = index[i]
				XCTAssertEqual(column.id, mission.id, "seed \(seed)")
				let expectedX = CGFloat(lens.x(
					mission.createdAt.timeIntervalSince1970 * 1000))
				XCTAssertEqual(column.anchor.x, expectedX, accuracy: 1e-9, "seed \(seed)")
				XCTAssertEqual(column.anchor.y, placement.spineY, "seed \(seed)")
				XCTAssertEqual(column.slot.width, metrics.leadCardWidth, "seed \(seed)")
				XCTAssertEqual(placement.ticks[i].x, column.anchor.x, "seed \(seed)")
				XCTAssertEqual(placement.ticks[i].state, mission.state, "seed \(seed)")
				assertConnectorShape(column, spineY: placement.spineY, context: "seed \(seed)")
			}
			for side in [SpineSide.above, SpineSide.below] {
				let slots = placement.columns.filter { $0.side == side }.map(\.slot)
				for i in 0 ..< slots.count {
					for j in (i + 1) ..< slots.count {
						XCTAssertFalse(
							slots[i].intersects(slots[j]),
							"seed \(seed) side \(side): slot \(i) \(slots[i]) vs slot \(j) \(slots[j])")
					}
				}
			}
		}
	}

	// MARK: - State, attention and viewport stability

	func testStateAndAttentionCyclingLeavesAnchorsAndSlotsStill() {
		let lens = lens(focusHours: 72)
		let (missions, agents) = randomDataset(seed: 42)
		let baseline = SpineLayout.layout(
			index: SpineIndex(missions: missions), agents: agents,
			lens: lens, viewport: viewport)
		let states: [MissionState] =
			[.running, .blocked, .failed, .readyToClose, .mergedNotClosed, .closed]
		var cycled = missions
		for state in states {
			for attention in [nil, "Waiting on owner input"] {
				cycled[7] = makeMission(
					id: cycled[7].id, number: cycled[7].number, state: state,
					attention: attention, createdAt: cycled[7].createdAt)
				let placement = SpineLayout.layout(
					index: SpineIndex(missions: cycled), agents: agents,
					lens: lens, viewport: viewport)
				XCTAssertEqual(placement.columns.count, baseline.columns.count)
				for (a, b) in zip(placement.columns, baseline.columns) {
					XCTAssertEqual(a.anchor, b.anchor, "state \(state) attention \(attention ?? "nil")")
					XCTAssertEqual(a.slot.minX, b.slot.minX, "state \(state) attention \(attention ?? "nil")")
					XCTAssertEqual(a.slot.width, b.slot.width, "state \(state) attention \(attention ?? "nil")")
				}
				XCTAssertEqual(placement.leader, baseline.leader)
			}
		}
	}

	func testThreeViewportsAtOneLensLeaveAnchorsAndSlotsStill() {
		let lens = lens(focusHours: 72)
		let (missions, agents) = randomDataset(seed: 7)
		let viewports = [
			CGRect(x: 0, y: 0, width: 1600, height: 1000),
			CGRect(x: -400, y: 50, width: 2000, height: 800),
			CGRect(x: 200, y: -100, width: 1200, height: 1400),
		]
		let placements = viewports.map { viewport in
			SpineLayout.layout(
				index: SpineIndex(missions: missions), agents: agents,
				lens: lens, viewport: viewport)
		}
		for placement in placements.dropFirst() {
			for (a, b) in zip(placement.columns, placements[0].columns) {
				XCTAssertEqual(a.anchor.x, b.anchor.x)
				XCTAssertEqual(a.slot.minX, b.slot.minX)
			}
		}
	}

	// MARK: - Chain breaks and the walk cap

	func testChainBreakLeavesBothSlotsCentred() {
		let lens = lens(focusHours: 720) // linear: 10 days is far past the break gap
		let missions = [
			makeMission(id: "new", number: 1, createdAt: base),
			makeMission(id: "old", number: 3, createdAt: base.addingTimeInterval(-10 * 86400)),
		]
		let placement = SpineLayout.layout(
			index: SpineIndex(missions: missions), agents: [:],
			lens: lens, viewport: viewport)
		XCTAssertEqual(placement.columns.count, 2)
		for column in placement.columns {
			XCTAssertEqual(
				column.slot.minX, column.anchor.x - metrics.leadCardWidth / 2,
				accuracy: 1e-6)
		}
	}

	func testCrowdedNeighbourPushesSlotOutward() {
		let lens = lens(focusHours: 72)
		// Same anchor: index order breaks the tie by number, so #3 places
		// first (centred) and #1 is pushed outward.
		let missions = [
			makeMission(id: "older", number: 1, createdAt: base),
			makeMission(id: "newer", number: 3, createdAt: base),
		]
		let placement = SpineLayout.layout(
			index: SpineIndex(missions: missions), agents: [:],
			lens: lens, viewport: viewport)
		let newest = placement.columns.first(where: { $0.id == "newer" })!
		let older = placement.columns.first(where: { $0.id == "older" })!
		XCTAssertEqual(
			newest.slot.minX, newest.anchor.x - metrics.leadCardWidth / 2,
			accuracy: 1e-6)
		XCTAssertEqual(
			older.slot.maxX, newest.slot.minX - metrics.columnGap, accuracy: 1e-6)
	}

	func testMaxChainWalkStillPlacesEveryMissionWithoutOverlap() {
		var shortWalk = SpineMetrics.standard
		shortWalk.maxChainWalk = 8
		var missions: [Mission] = []
		for n in 1 ... 30 {
			missions.append(makeMission(
				id: "m\(n)", number: 2 * n - 1, createdAt: base))
		}
		let placement = SpineLayout.layout(
			index: SpineIndex(missions: missions), agents: [:],
			lens: lens(focusHours: 72), viewport: viewport, metrics: shortWalk)
		XCTAssertEqual(placement.columns.count, 30)
		let slots = placement.columns.map(\.slot)
		for i in 0 ..< slots.count {
			for j in (i + 1) ..< slots.count {
				XCTAssertFalse(slots[i].intersects(slots[j]))
			}
		}
	}

	// MARK: - Cards, rows, connectors, leader

	func testOpenCardFillsSlotAtSpineOffset() {
		let lens = lens(focusHours: 72)
		let missions = [
			makeMission(id: "above", number: 1, createdAt: base),
			makeMission(
				id: "below-attn", number: 2, attention: "Waiting on owner input",
				createdAt: base.addingTimeInterval(-60)),
		]
		let placement = SpineLayout.layout(
			index: SpineIndex(missions: missions), agents: [:],
			lens: lens, viewport: viewport)
		let above = placement.columns.first(where: { $0.id == "above" })!
		XCTAssertFalse(above.collapsed)
		XCTAssertEqual(above.card, above.slot)
		XCTAssertEqual(above.card.height, metrics.leadCardHeight)
		XCTAssertEqual(above.card.maxY, placement.spineY - metrics.spineOffset, accuracy: 1e-9)
		let below = placement.columns.first(where: { $0.id == "below-attn" })!
		XCTAssertEqual(below.card, below.slot)
		XCTAssertEqual(below.card.height, metrics.leadAttentionHeight)
		XCTAssertEqual(below.card.minY, placement.spineY + metrics.spineOffset, accuracy: 1e-9)
	}

	func testClosedMissionCollapsesToCentredNodeWithNoRows() {
		let lens = lens(focusHours: 72)
		let mission = makeMission(
			id: "shut", number: 1, state: .closed,
			attention: "Waiting on owner input", createdAt: base)
		let agents = [
			makeAgent(id: "a1", missionId: "shut", state: .completed),
			makeAgent(id: "a2", missionId: "shut", state: .running),
		]
		let placement = SpineLayout.layout(
			index: SpineIndex(missions: [mission]),
			agents: ["shut": agents],
			lens: lens, viewport: viewport)
		let column = placement.columns[0]
		XCTAssertTrue(column.collapsed)
		XCTAssertEqual(column.rows, [])
		XCTAssertEqual(column.stack, .empty)
		XCTAssertEqual(column.slot.width, metrics.leadCardWidth)
		XCTAssertEqual(column.card.width, metrics.closedNodeWidth)
		XCTAssertEqual(column.card.height, metrics.closedNodeHeight)
		XCTAssertEqual(column.card.midX, column.slot.midX, accuracy: 1e-6)
		XCTAssertEqual(column.card.midY, column.slot.midY, accuracy: 1e-6)
	}

	func testRowsGrowAwayFromSpinePastLeadGap() {
		let lens = lens(focusHours: 72)
		let above = makeMission(id: "above", number: 1, createdAt: base)
		let below = makeMission(
			id: "below", number: 2, createdAt: base.addingTimeInterval(-60))
		let agents = [
			makeAgent(id: "run", missionId: "x", state: .running, startedHours: 0),
			makeAgent(id: "start", missionId: "x", state: .starting, startedHours: 1),
		]
		let placement = SpineLayout.layout(
			index: SpineIndex(missions: [above, below]),
			agents: [
				"above": agents.map { reassign($0, missionId: "above") },
				"below": agents.map { reassign($0, missionId: "below") },
			],
			lens: lens, viewport: viewport)
		for column in placement.columns {
			XCTAssertEqual(column.rows.count, column.stack.items.count)
			for row in column.rows {
				XCTAssertEqual(row.width, metrics.agentRowWidth)
				XCTAssertEqual(row.midX, column.card.midX, accuracy: 1e-9)
			}
			if column.side == .above {
				XCTAssertEqual(
					column.rows[0].maxY, column.card.minY - metrics.leadGap,
					accuracy: 1e-9)
				for (row, item) in zip(column.rows, column.stack.items) {
					XCTAssertEqual(
						row.maxY, column.card.minY - metrics.leadGap - item.offset,
						accuracy: 1e-9)
				}
			} else {
				XCTAssertEqual(
					column.rows[0].minY, column.card.maxY + metrics.leadGap,
					accuracy: 1e-9)
				for (row, item) in zip(column.rows, column.stack.items) {
					XCTAssertEqual(
						row.minY, column.card.maxY + metrics.leadGap + item.offset,
						accuracy: 1e-9)
				}
			}
		}
	}

	func testConnectorTwoPointsOverAnchor() {
		let lens = lens(focusHours: 72)
		let placement = SpineLayout.layout(
			index: SpineIndex(missions: [
				makeMission(id: "solo", number: 1, createdAt: base),
			]),
			agents: [:], lens: lens, viewport: viewport)
		let column = placement.columns[0]
		XCTAssertLessThanOrEqual(abs(column.card.midX - column.anchor.x), 0.5)
		XCTAssertEqual(column.connector.count, 2)
		XCTAssertEqual(column.connector[0], column.anchor)
		XCTAssertEqual(
			column.connector[1],
			CGPoint(x: column.anchor.x, y: column.card.maxY))
	}

	func testConnectorFourPointsWithExactBendWhenOffset() {
		let lens = lens(focusHours: 72)
		var missions: [Mission] = []
		for n in 1 ... 20 {
			missions.append(makeMission(
				id: "m\(n)", number: n, createdAt: base))
		}
		let placement = SpineLayout.layout(
			index: SpineIndex(missions: missions), agents: [:],
			lens: lens, viewport: viewport)
		var sawAbove = false
		var sawBelow = false
		for column in placement.columns {
			guard abs(column.card.midX - column.anchor.x) > 0.5 else { continue }
			XCTAssertEqual(column.connector.count, 4)
			let bendY =
				column.side == .above
				? placement.spineY - metrics.spineOffset / 2
				: placement.spineY + metrics.spineOffset / 2
			let cardEdgeY =
				column.side == .above ? column.card.maxY : column.card.minY
			XCTAssertEqual(column.connector[0], column.anchor)
			XCTAssertEqual(column.connector[1], CGPoint(x: column.anchor.x, y: bendY))
			XCTAssertEqual(column.connector[2], CGPoint(x: column.card.midX, y: bendY))
			XCTAssertEqual(column.connector[3], CGPoint(x: column.card.midX, y: cardEdgeY))
			if column.side == .above { sawAbove = true } else { sawBelow = true }
		}
		XCTAssertTrue(sawAbove && sawBelow, "expected bent connectors on both sides")
	}

	func testLeaderPinnedAtNowSpineCentred() {
		let lens = lens(focusHours: 72)
		let placement = SpineLayout.layout(
			index: SpineIndex(missions: [
				makeMission(id: "m1", number: 1, createdAt: base),
			]),
			agents: [:], lens: lens, viewport: viewport)
		XCTAssertEqual(placement.spineY, viewport.midY)
		XCTAssertEqual(
			placement.leader.midX, CGFloat(lens.x(lens.options.now)), accuracy: 1e-9)
		XCTAssertEqual(placement.leader.midY, placement.spineY)
		XCTAssertEqual(placement.leader.width, metrics.leadCardWidth)
		XCTAssertEqual(placement.leader.height, metrics.leadCardHeight)
	}

	func testTicksCarryAnchorXAndState() {
		let lens = lens(focusHours: 72)
		let missions = [
			makeMission(
				id: "a", number: 2, state: .blocked,
				createdAt: base.addingTimeInterval(-200)),
			makeMission(
				id: "b", number: 1, state: .closed, createdAt: base.addingTimeInterval(-100)),
		]
		let placement = SpineLayout.layout(
			index: SpineIndex(missions: missions), agents: [:],
			lens: lens, viewport: viewport)
		XCTAssertEqual(placement.ticks.count, 2)
		for (tick, column) in zip(placement.ticks, placement.columns) {
			XCTAssertEqual(tick.x, column.anchor.x)
			XCTAssertEqual(tick.state, column.id == "a" ? .blocked : .closed)
		}
	}

	// MARK: - Connector structural invariant

	private func assertConnectorShape(
		_ column: MissionColumn, spineY: CGFloat, context: String
	) {
		let cardEdgeY =
			column.side == .above ? column.card.maxY : column.card.minY
		if abs(column.card.midX - column.anchor.x) <= 0.5 {
			XCTAssertEqual(column.connector.count, 2, context)
			XCTAssertEqual(column.connector[0], column.anchor, context)
			XCTAssertEqual(
				column.connector[1], CGPoint(x: column.anchor.x, y: cardEdgeY),
				context)
		} else {
			let bendY =
				column.side == .above
				? spineY - metrics.spineOffset / 2
				: spineY + metrics.spineOffset / 2
			XCTAssertEqual(column.connector.count, 4, context)
			XCTAssertEqual(column.connector[0], column.anchor, context)
			XCTAssertEqual(
				column.connector[1], CGPoint(x: column.anchor.x, y: bendY),
				context)
			XCTAssertEqual(
				column.connector[2], CGPoint(x: column.card.midX, y: bendY),
				context)
			XCTAssertEqual(
				column.connector[3], CGPoint(x: column.card.midX, y: cardEdgeY),
				context)
		}
	}

	// MARK: - Helpers

	private func makeMission(
		id: String, number: Int, state: MissionState = .running,
		attention: String? = nil, createdAt: Date
	) -> Mission {
		Mission(
			id: id, number: number,
			workspaceId: "w1", machineId: "m1",
			name: "mission \(number)", objective: "Objective.", changes: [],
			lead: .leader, agentIds: [], access: .readOnly, worktree: nil,
			state: state, attention: attention,
			createdAt: createdAt,
			closedAt: nil, disposition: nil, closeReason: nil,
			integration: nil, continuesMissionId: nil)
	}

	private func makeAgent(
		id: String, missionId: String, state: AgentState,
		startedHours: Double = 0, endedHours: Double? = nil
	) -> Agent {
		Agent(
			id: id, missionId: missionId, workspaceId: "w1",
			name: "agent \(id)", task: "Task.", access: .readOnly, provider: "fake",
			model: "test-model", skills: [], sessionId: "s-\(id)",
			canSpawn: false, state: state, stateBefore: nil, activity: nil,
			pendingQuestion: nil,
			startedAt: base.addingTimeInterval(startedHours * 3600),
			endedAt: endedHours.map { base.addingTimeInterval($0 * 3600) },
			outcome: nil)
	}

	private func reassign(_ agent: Agent, missionId: MissionId) -> Agent {
		Agent(
			id: agent.id, missionId: missionId, workspaceId: agent.workspaceId,
			name: agent.name, task: agent.task, access: agent.access,
			provider: agent.provider, model: agent.model, skills: agent.skills,
			sessionId: agent.sessionId, canSpawn: agent.canSpawn,
			state: agent.state, stateBefore: agent.stateBefore,
			activity: agent.activity, pendingQuestion: agent.pendingQuestion,
			startedAt: agent.startedAt, endedAt: agent.endedAt,
			outcome: agent.outcome)
	}

	private func randomDataset(seed: Int) -> (
		missions: [Mission], agents: [MissionId: [Agent]]
	) {
		var rng: UInt64 =
			0x9E37_79B9_7F4A_7C15 &+ UInt64(seed + 1) &* 0xBF58_476D_1CE4_E5B9
		if rng == 0 { rng = 0x1234_5678_9ABC_DEF1 }
		let count = 1 + Int(next(&rng, 200))
		var numbers = Array(1 ... count)
		for i in stride(from: numbers.count - 1, through: 1, by: -1) {
			numbers.swapAt(i, Int(next(&rng, UInt64(i + 1))))
		}
		let states: [MissionState] =
			[.running, .blocked, .failed, .readyToClose, .mergedNotClosed, .closed]
		let agentStates: [AgentState] =
			[.running, .starting, .blocked, .failed, .interrupted,
			 .completed, .completed, .archived]
		var missions: [Mission] = []
		var agents: [MissionId: [Agent]] = [:]
		for i in 0 ..< count {
			let ageSeconds =
				Double(next(&rng, 30 * 24 * 60)) * 60 + Double(next(&rng, 60))
			let mission = makeMission(
				id: "m\(seed)-\(i)", number: numbers[i],
				state: states[Int(next(&rng, UInt64(states.count)))],
				attention: next(&rng, 3) == 0 ? "Waiting on owner input \(i)" : nil,
				createdAt: base.addingTimeInterval(-ageSeconds))
			missions.append(mission)
			let agentCount = Int(next(&rng, 6))
			var list: [Agent] = []
			for a in 0 ..< agentCount {
				let state = agentStates[Int(next(&rng, UInt64(agentStates.count)))]
				list.append(makeAgent(
					id: "m\(seed)-\(i)-a\(a)", missionId: mission.id, state: state,
					startedHours: Double(next(&rng, 700)),
					endedHours: state == .completed
						? Double(next(&rng, 700)) : nil))
			}
			if !list.isEmpty { agents[mission.id] = list }
		}
		return (missions, agents)
	}

	/// xorshift64* draw in `0 ..< bound`.
	private func next(_ rng: inout UInt64, _ bound: UInt64) -> UInt64 {
		precondition(bound > 0)
		rng ^= rng >> 12
		rng ^= rng << 25
		rng ^= rng >> 27
		return (rng &* 0x2545_F491_4F6C_DD1D >> 32) % bound
	}
}
