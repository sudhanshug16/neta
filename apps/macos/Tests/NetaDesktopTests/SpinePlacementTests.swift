import CoreGraphics
import Foundation
import XCTest

@testable import NetaDesktop

/// T10.3 contract: the merged mission/checkpoint index and straight
/// anchor-under-card placement.
final class SpinePlacementTests: XCTestCase {
	private let metrics = SpineMetrics.standard
	private let base = Date(timeIntervalSince1970: 1_780_315_200)
	private let viewport = CGRect(x: 0, y: 0, width: 1600, height: 1000)

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

	private func makeEvent(
		seq: Int, kind: EventKind, at: Date
	) -> Event {
		Event(
			seq: seq, at: at, workspaceId: "w1", kind: kind,
			missionId: nil, agentId: nil, sessionId: nil, turnId: nil,
			data: [:])
	}

	private func index(
		missions: [Mission], events: [Event] = [],
		pxPerHour: Double = 48, maxPitch: CGFloat = 320
	) -> SpineIndex {
		SpineIndex(
			missions: missions, events: events,
			pxPerHour: pxPerHour, maxPitch: maxPitch)
	}

	// MARK: - Index merge

	func testCheckpointsMergeIntoTheSequence() {
		let m1 = makeMission(
			id: "m1", number: 1,
			createdAt: base.addingTimeInterval(-7200))
		let m2 = makeMission(
			id: "m2", number: 2, createdAt: base)
		let pin = makeEvent(
			seq: 4, kind: .userPinned,
			at: base.addingTimeInterval(-3600))
		let chat = makeEvent(
			seq: 5, kind: .leaderModeReminder,
			at: base.addingTimeInterval(-1800))
		let idx = index(missions: [m2, m1], events: [chat, pin])
		XCTAssertEqual(idx.count, 3)
		XCTAssertEqual(idx[0].isCheckpoint, false)
		XCTAssertEqual(idx[1], .checkpoint(eventSeq: 4, at: pin.at.timeIntervalSince1970 * 1000))
		XCTAssertEqual(idx[2].isCheckpoint, false)
		XCTAssertEqual(idx.mission(1), nil)
		XCTAssertEqual(idx.mission(0)?.id, "m1")
		XCTAssertEqual(idx.mission(2)?.id, "m2")
	}

	func testFirstIndexSearchesCumulativeX() {
		let idx = index(missions: [
			makeMission(
				id: "a", number: 1,
				createdAt: base.addingTimeInterval(-7200)),
			makeMission(id: "b", number: 2, createdAt: base),
		])
		XCTAssertEqual(idx.firstIndex(atOrAfter: -1), 0)
		XCTAssertEqual(idx.firstIndex(atOrAfter: 0), 0)
		XCTAssertEqual(idx.firstIndex(atOrAfter: 0.5), 1)
		XCTAssertEqual(
			idx.firstIndex(atOrAfter: idx.x(1)), 1)
		XCTAssertEqual(
			idx.firstIndex(atOrAfter: idx.x(1) + 1), 2)
		XCTAssertEqual(
			SpineIndex(missions: [], pxPerHour: 48, maxPitch: 320)
				.firstIndex(atOrAfter: 0),
			0)
	}

	func testEarliestOpenIsAnIndex() {
		let closed = makeMission(
			id: "c", number: 1, state: .closed,
			createdAt: base.addingTimeInterval(-7200))
		let open = makeMission(
			id: "o", number: 2, state: .running,
			createdAt: base.addingTimeInterval(-3600))
		let idx = index(missions: [open, closed])
		XCTAssertEqual(idx.earliestOpen, 1)
		XCTAssertNil(index(missions: [closed]).earliestOpen)
		XCTAssertNil(index(missions: []).earliestOpen)
	}

	// MARK: - Side rule

	func testSideFollowsNumberParity() {
		XCTAssertEqual(SpinePlacement.side(for: 1), .above)
		XCTAssertEqual(SpinePlacement.side(for: 2), .below)
		XCTAssertEqual(SpinePlacement.side(for: 3), .above)
		XCTAssertEqual(SpinePlacement.side(for: 100), .below)
	}

	// MARK: - Placement shape

	func testAnchorUnderCardWithStraightConnector() {
		let odd = makeMission(
			id: "odd", number: 1, createdAt: base.addingTimeInterval(-3600))
		let even = makeMission(
			id: "even", number: 2, createdAt: base)
		let placed = SpinePlacement.place(
			index: index(missions: [odd, even]), agents: [:],
			range: 0 ..< 2, scrollX: 0, viewport: viewport)
		XCTAssertEqual(placed.spineY, 500)
		XCTAssertEqual(placed.columns.count, 2)
		XCTAssertEqual(placed.columns[0].side, .above)
		XCTAssertEqual(placed.columns[1].side, .below)
		for column in placed.columns {
			XCTAssertEqual(column.card.midX, column.anchor.x, accuracy: 1e-9)
			XCTAssertEqual(column.connector.count, 2)
			XCTAssertEqual(column.connector[0], column.anchor)
			XCTAssertEqual(column.connector[1].x, column.anchor.x)
		}
		let above = placed.columns[0]
		XCTAssertEqual(above.card.maxY, 500 - metrics.spineOffset)
		XCTAssertEqual(above.card.width, metrics.leadCardWidth)
		let below = placed.columns[1]
		XCTAssertEqual(below.card.minY, 500 + metrics.spineOffset)
	}

	func testClosedNodeCentredWithNoRows() {
		let closed = makeMission(
			id: "c", number: 2, state: .closed,
			createdAt: base)
		let placed = SpinePlacement.place(
			index: index(missions: [closed]), agents: [:],
			range: 0 ..< 1, scrollX: 0, viewport: viewport)
		let column = placed.columns[0]
		XCTAssertTrue(column.collapsed)
		XCTAssertTrue(column.rows.isEmpty)
		XCTAssertEqual(column.card.width, 180)
		XCTAssertEqual(column.card.height, metrics.closedNodeHeight)
		XCTAssertEqual(column.card.midX, column.anchor.x, accuracy: 1e-9)
		XCTAssertEqual(column.card.minY, 500 + metrics.spineOffset)
	}

	func testAttentionCardIsTallerButCentred() {
		let plain = makeMission(
			id: "p", number: 1, createdAt: base.addingTimeInterval(-100))
		let noted = makeMission(
			id: "n", number: 3, attention: "Waiting on you",
			createdAt: base)
		var anchors: [CGPoint] = []
		for state in
			[MissionState.running, .blocked, .failed, .readyToClose, .mergedNotClosed]
		{
			let changed = makeMission(
				id: "p", number: 1, state: state,
				createdAt: base.addingTimeInterval(-100))
			let placed = SpinePlacement.place(
				index: index(missions: [changed, noted]), agents: [:],
				range: 0 ..< 2, scrollX: 0, viewport: viewport)
			anchors.append(placed.columns[0].anchor)
			XCTAssertEqual(
				placed.columns[0].card.height, metrics.leadCardHeight)
		}
		for anchor in anchors.dropFirst() {
			XCTAssertEqual(anchor, anchors[0])
		}
		let placed = SpinePlacement.place(
			index: index(missions: [plain, noted]), agents: [:],
			range: 0 ..< 2, scrollX: 0, viewport: viewport)
		XCTAssertEqual(
			placed.columns[1].card.height, metrics.leadAttentionHeight)
		XCTAssertEqual(
			placed.columns[1].card.midX, placed.columns[1].anchor.x,
			accuracy: 1e-9)
	}

	// MARK: - Stability

	func testStateAndAttentionNeverMoveAnchorOrCard() {
		let at = base.addingTimeInterval(-3600)
		let states: [MissionState] =
			[.running, .blocked, .failed, .readyToClose, .mergedNotClosed, .closed]
		var anchors: [CGPoint] = []
		var midXs: [CGFloat] = []
		for state in states {
			for attention in [nil, "note"] as [String?] {
				let placed = SpinePlacement.place(
					index: index(missions: [
						makeMission(
							id: "m", number: 1, state: state,
							attention: attention, createdAt: at),
					]),
					agents: [:], range: 0 ..< 1, scrollX: 0,
					viewport: viewport)
				anchors.append(placed.columns[0].anchor)
				midXs.append(placed.columns[0].card.midX)
			}
		}
		for anchor in anchors.dropFirst() {
			XCTAssertEqual(anchor, anchors[0])
		}
		for midX in midXs.dropFirst() {
			XCTAssertEqual(midX, midXs[0], accuracy: 1e-9)
		}
	}

	func testThreeViewportsAtOneScrollXAgree() {
		let missions = [
			makeMission(
				id: "a", number: 1,
				createdAt: base.addingTimeInterval(-3600)),
			makeMission(id: "b", number: 2, createdAt: base),
		]
		let idx = index(missions: missions)
		let viewports = [
			CGRect(x: 0, y: 0, width: 1600, height: 1000),
			CGRect(x: 0, y: 0, width: 800, height: 600),
			CGRect(x: 0, y: 100, width: 1600, height: 800),
		]
		let first = SpinePlacement.place(
			index: idx, agents: [:], range: 0 ..< 2, scrollX: 50,
			viewport: viewports[0])
		for viewport in viewports.dropFirst() {
			let placed = SpinePlacement.place(
				index: idx, agents: [:], range: 0 ..< 2,
				scrollX: 50, viewport: viewport)
			XCTAssertEqual(
				placed.columns.map(\.anchor.x),
				first.columns.map(\.anchor.x))
			XCTAssertEqual(
				placed.columns.map(\.card.midX),
				first.columns.map(\.card.midX))
		}
	}

	func testAppendingMovesNoExistingAnchor() {
		let old = [
			makeMission(
				id: "a", number: 1,
				createdAt: base.addingTimeInterval(-7200)),
			makeMission(
				id: "b", number: 2,
				createdAt: base.addingTimeInterval(-3600)),
		]
		let before = SpinePlacement.place(
			index: index(missions: old), agents: [:],
			range: 0 ..< 2, scrollX: 0, viewport: viewport)
		let grown = old + [
			makeMission(id: "c", number: 3, createdAt: base),
		]
		let after = SpinePlacement.place(
			index: index(missions: grown), agents: [:],
			range: 0 ..< 3, scrollX: 0, viewport: viewport)
		XCTAssertEqual(
			Array(after.columns.prefix(2).map(\.anchor.x)),
			before.columns.map(\.anchor.x))
	}

	// MARK: - No overlap over random datasets

	/// Mission numbers are permanent and grow with creation, so the test
	/// numbers missions in time order: neighbours alternate sides, hence
	/// same-side pairs sit two floored gaps apart (at least `2 * minPitch`
	/// = 240 px) and 210 px cards never overlap.
	func testRandomDatasetsNeverOverlapOnOneSide() {
		for seed in 0 ..< 1000 {
			let (missions, agents) = randomDataset(seed: seed)
			let idx = index(missions: missions)
			let placed = SpinePlacement.place(
				index: idx, agents: agents, range: 0 ..< idx.count,
				scrollX: 0, viewport: viewport)
			for side in [SpineSide.above, SpineSide.below] {
				let cards = placed.columns
					.filter { $0.side == side }
					.map(\.card)
					.sorted { $0.minX < $1.minX }
				// Pairs, not indices: a one-mission dataset leaves one side
				// empty, and `1 ..< 0` would trap.
				for (prev, card) in zip(cards, cards.dropFirst()) {
					XCTAssertGreaterThanOrEqual(
						card.minX, prev.maxX,
						"seed \(seed) overlaps on \(side)")
				}
				for (prev, card) in zip(cards, cards.dropFirst()) {
					// Epsilon: cumulative `CGFloat` sums and the
					// `CGRect.midX` round-trip shave ~1 ulp off the exact
					// `2 * minPitch` floor; a true violation is ~120 pt.
					XCTAssertGreaterThanOrEqual(
						card.midX - prev.midX,
						2 * 120 - 1e-6,
						"seed \(seed): same-side pair under 2 * minPitch")
				}
			}
		}
	}

	// MARK: - Builders

	private func next(_ rng: inout UInt64, _ upper: UInt64) -> UInt64 {
		rng = rng &* 0xBF58_476D_1CE4_E5B9 &+ 0x9E37_79B9_7F4A_7C15
		if rng == 0 { rng = 0x1234_5678_9ABC_DEF1 }
		var x = rng >> 17
		x ^= x >> 29
		x &*= 0xCB24_D0BA_5C37_8B89
		x ^= x >> 27
		return x % upper
	}

	private func randomDataset(seed: Int) -> (
		missions: [Mission], agents: [MissionId: [Agent]]
	) {
		var rng: UInt64 =
			0x9E37_79B9_7F4A_7C15 &+ UInt64(seed + 1) &* 0xBF58_476D_1CE4_E5B9
		if rng == 0 { rng = 0x1234_5678_9ABC_DEF1 }
		let count = 1 + Int(next(&rng, 200))
		let states: [MissionState] =
			[.running, .blocked, .failed, .readyToClose, .mergedNotClosed, .closed]
		let agentStates: [AgentState] =
			[.running, .starting, .blocked, .failed, .interrupted,
			 .completed, .completed, .archived]
		let numberBase = 200 + Int(next(&rng, 500))
		var missions: [Mission] = []
		var agents: [MissionId: [Agent]] = [:]
		// Times spread over 30 days; numbers grow with creation time.
		var offsets: [Double] = []
		for _ in 0 ..< count {
			offsets.append(Double(next(&rng, 30 * 24 * 3600)))
		}
		offsets.sort()
		// Distinct seconds: equal timestamps tie-break by number ascending,
		// which can place two same-parity missions adjacently. Production
		// numbers grow with creation time, so time order is number order
		// and neighbours strictly alternate sides.
		for k in 1 ..< offsets.count {
			offsets[k] = max(offsets[k], offsets[k - 1] + 1)
		}
		for (k, offset) in offsets.enumerated() {
			let number = numberBase + k
			let state = states[Int(next(&rng, UInt64(states.count)))]
			let withAttention =
				state == .blocked && next(&rng, 2) == 0
			let mission = makeMission(
				id: "m\(seed)-\(k)", number: number, state: state,
				attention: withAttention ? "Waiting on you" : nil,
				createdAt: base.addingTimeInterval(-offset))
			missions.append(mission)
			let agentCount = Int(next(&rng, 4))
			var list: [Agent] = []
			for a in 0 ..< agentCount {
				let agentState =
					agentStates[Int(next(&rng, UInt64(agentStates.count)))]
				list.append(Agent(
					id: "a\(seed)-\(k)-\(a)", missionId: mission.id,
					workspaceId: "w1", name: "agent \(a)", task: "Task.",
					access: .readOnly, provider: "fake", model: "test-model",
					skills: [], sessionId: "s", canSpawn: false,
					state: agentState, stateBefore: nil, activity: nil,
					pendingQuestion: nil,
					startedAt: base.addingTimeInterval(-offset),
					endedAt: nil, outcome: nil))
			}
			agents[mission.id] = list
		}
		return (missions, agents)
	}
}
