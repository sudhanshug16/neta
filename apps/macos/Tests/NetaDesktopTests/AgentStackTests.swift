import CoreGraphics
import Foundation
import XCTest

@testable import NetaDesktop

/// T10.2 contract: live agents never collapse, up to `completedShown`
/// completed agents show directly with the rest behind a chip, expanded
/// shows all with no chip, and ordering is attention-first and stable.
final class AgentStackTests: XCTestCase {
	private let metrics = SpineMetrics.standard
	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z

	// MARK: - Metrics

	func testStandardMetricValues() {
		XCTAssertEqual(metrics.leadCardWidth, 210)
		XCTAssertEqual(metrics.leadCardHeight, 74)
		XCTAssertEqual(metrics.leadAttentionHeight, 104)
		XCTAssertEqual(metrics.closedNodeWidth, 180)
		XCTAssertEqual(metrics.closedNodeHeight, 34)
		XCTAssertEqual(metrics.agentRowWidth, 220)
		XCTAssertEqual(metrics.agentRowHeight, 40)
		XCTAssertEqual(metrics.runningRowHeight, 52)
		XCTAssertEqual(metrics.chipHeight, 26)
		XCTAssertEqual(metrics.rowGap, 10)
		XCTAssertEqual(metrics.leadGap, 10)
		XCTAssertEqual(metrics.spineOffset, 90)
		XCTAssertEqual(metrics.minHitHeight, 26)
		XCTAssertEqual(metrics.completedShown, 8)
		XCTAssertEqual(metrics.maxLiveColumns, 60)
	}

	// MARK: - Live never collapses

	func testLiveAgentsNeverCollapseAtAnyCount() {
		for count in [1, 8, 9, 20, 60, 200] {
			let agents = (0 ..< count).map { i in
				makeAgent(id: "live-\(i)", state: .running, startedHours: Double(i))
			}
			let stack = AgentStack.build(agents: agents, expanded: false, metrics: metrics)
			XCTAssertEqual(stack.liveCount, count, "count \(count)")
			XCTAssertEqual(stack.hiddenCompleted, 0, "count \(count)")
			XCTAssertEqual(stack.items.count, count, "count \(count)")
			XCTAssertFalse(
				stack.items.contains {
					if case .moreCompleted = $0.content { return true }
					return false
				}, "live must never produce a chip (count \(count))")
		}
	}

	func testMixedLiveStatesNeverCollapse() {
		let states: [AgentState] = [.blocked, .failed, .running, .starting, .interrupted]
		var agents: [Agent] = []
		for i in 0 ..< 50 {
			agents.append(makeAgent(
				id: "mix-\(i)", state: states[i % states.count], startedHours: Double(i)))
		}
		let stack = AgentStack.build(agents: agents, expanded: false, metrics: metrics)
		XCTAssertEqual(stack.liveCount, 50)
		XCTAssertEqual(stack.items.count, 50)
		XCTAssertEqual(stack.hiddenCompleted, 0)
	}

	// MARK: - Completed paging

	func testEightCompletedShownWithRemainderBehindChip() {
		for (total, hidden) in [(9, 1), (20, 12), (200, 192)] {
			let agents = (0 ..< total).map { i in
				makeAgent(
					id: "done-\(i)", state: .completed, startedHours: 0,
					endedHours: Double(i))
			}
			let stack = AgentStack.build(agents: agents, expanded: false, metrics: metrics)
			XCTAssertEqual(stack.liveCount, 0, "total \(total)")
			XCTAssertEqual(stack.hiddenCompleted, hidden, "total \(total)")
			XCTAssertEqual(stack.items.count, 8 + 1, "total \(total)")
			let shown = stack.items.prefix(8)
			XCTAssertTrue(shown.allSatisfy {
				if case .agent = $0.content { return true }
				return false
			})
			if case .moreCompleted(let n) = stack.items.last?.content {
				XCTAssertEqual(n, hidden, "total \(total)")
			} else {
				XCTFail("last item must be the chip (total \(total))")
			}
			XCTAssertEqual(stack.items.last?.height, metrics.chipHeight)
		}
	}

	func testCompletedAtOrUnderLimitHasNoChip() {
		for total in [0, 1, 7, 8] {
			let agents = (0 ..< total).map { i in
				makeAgent(
					id: "done-\(i)", state: .completed, startedHours: 0,
					endedHours: Double(i))
			}
			let stack = AgentStack.build(agents: agents, expanded: false, metrics: metrics)
			XCTAssertEqual(stack.items.count, total, "total \(total)")
			XCTAssertEqual(stack.hiddenCompleted, 0, "total \(total)")
		}
	}

	func testExpandedShowsAllCompletedWithNoChip() {
		for total in [9, 20, 200] {
			let agents = (0 ..< total).map { i in
				makeAgent(
					id: "done-\(i)", state: .completed, startedHours: 0,
					endedHours: Double(i))
			}
			let stack = AgentStack.build(agents: agents, expanded: true, metrics: metrics)
			XCTAssertEqual(stack.items.count, total, "total \(total)")
			XCTAssertEqual(stack.hiddenCompleted, 0, "total \(total)")
			XCTAssertFalse(stack.items.contains {
				if case .moreCompleted = $0.content { return true }
				return false
			})
		}
	}

	// MARK: - Ordering

	func testLiveOrderIsAttentionFirstThenStartedAtThenId() {
		let agents = [
			makeAgent(id: "run-early", state: .running, startedHours: 0),
			makeAgent(id: "blocked-late", state: .blocked, startedHours: 9),
			makeAgent(id: "fail-mid", state: .failed, startedHours: 5),
			makeAgent(id: "start-early", state: .starting, startedHours: 0),
			makeAgent(id: "interrupt-early", state: .interrupted, startedHours: 0),
			makeAgent(id: "blocked-early", state: .blocked, startedHours: 1),
			makeAgent(id: "run-b", state: .running, startedHours: 2),
			makeAgent(id: "run-a", state: .running, startedHours: 2),
		]
		let stack = AgentStack.build(agents: agents, expanded: false, metrics: metrics)
		XCTAssertEqual(
			stack.items.map(\.id),
			[
				"blocked-early", "blocked-late", "fail-mid", "run-early",
				"run-a", "run-b", "start-early", "interrupt-early",
			])
	}

	func testCompletedOrderIsNewestFirstThenId() {
		let agents = [
			makeAgent(id: "c-b", state: .completed, startedHours: 0, endedHours: 2),
			makeAgent(id: "c-a", state: .completed, startedHours: 0, endedHours: 2),
			makeAgent(id: "c-new", state: .completed, startedHours: 0, endedHours: 5),
			makeAgent(id: "c-old", state: .completed, startedHours: 0, endedHours: 1),
		]
		let stack = AgentStack.build(agents: agents, expanded: true, metrics: metrics)
		XCTAssertEqual(stack.items.map(\.id), ["c-new", "c-a", "c-b", "c-old"])
	}

	func testLiveStacksBeforeCompleted() {
		let agents = [
			makeAgent(id: "c-1", state: .completed, startedHours: 0, endedHours: 9),
			makeAgent(id: "run-1", state: .running, startedHours: 0),
			makeAgent(id: "start-1", state: .starting, startedHours: 0),
		]
		let stack = AgentStack.build(agents: agents, expanded: true, metrics: metrics)
		XCTAssertEqual(stack.items.map(\.id), ["run-1", "start-1", "c-1"])
		XCTAssertEqual(stack.liveCount, 2)
	}

	func testOrderStableAcrossOneHundredShuffles() {
		var agents: [Agent] = []
		let states: [AgentState] =
			[.blocked, .failed, .running, .starting, .interrupted, .completed]
		for i in 0 ..< 30 {
			agents.append(makeAgent(
				id: "agent-\(i)", state: states[i % states.count],
				startedHours: Double(i % 7), endedHours: Double(i)))
		}
		let reference = AgentStack.build(agents: agents, expanded: false, metrics: metrics)
		var rng: UInt64 = 0x1234_5678_9ABC_DEF1
		for _ in 0 ..< 100 {
			shuffle(&agents, rng: &rng)
			let stack = AgentStack.build(agents: agents, expanded: false, metrics: metrics)
			XCTAssertEqual(stack, reference)
		}
	}

	// MARK: - Archive and geometry

	func testArchivedAgentsAreDropped() {
		let agents = [
			makeAgent(id: "run-1", state: .running, startedHours: 0),
			makeAgent(id: "arch-1", state: .archived, startedHours: 0),
			makeAgent(id: "arch-2", state: .archived, startedHours: 1),
			makeAgent(id: "done-1", state: .completed, startedHours: 0, endedHours: 1),
		]
		let stack = AgentStack.build(agents: agents, expanded: true, metrics: metrics)
		XCTAssertEqual(stack.items.map(\.id), ["run-1", "done-1"])
		XCTAssertEqual(stack.liveCount, 1)
		XCTAssertEqual(stack.hiddenCompleted, 0)
	}

	func testOffsetsRunFromLeadEdgeAndHeightExcludesTrailingGap() {
		let agents = [
			makeAgent(id: "run-1", state: .running, startedHours: 0),
			makeAgent(id: "start-1", state: .starting, startedHours: 1),
		]
		let stack = AgentStack.build(agents: agents, expanded: true, metrics: metrics)
		XCTAssertEqual(stack.items.count, 2)
		XCTAssertEqual(stack.items[0].offset, 0)
		XCTAssertEqual(stack.items[0].height, metrics.runningRowHeight)
		XCTAssertEqual(
			stack.items[1].offset, metrics.runningRowHeight + metrics.rowGap)
		XCTAssertEqual(stack.items[1].height, metrics.agentRowHeight)
		XCTAssertEqual(
			stack.height,
			metrics.runningRowHeight + metrics.rowGap + metrics.agentRowHeight)
	}

	func testChipOffsetAndHeight() {
		let agents = (0 ..< 9).map { i in
			makeAgent(id: "done-\(i)", state: .completed, startedHours: 0, endedHours: Double(i))
		}
		let stack = AgentStack.build(agents: agents, expanded: false, metrics: metrics)
		let chip = stack.items.last!
		XCTAssertEqual(chip.height, metrics.chipHeight)
		XCTAssertEqual(chip.offset, 8 * (metrics.agentRowHeight + metrics.rowGap))
		XCTAssertEqual(
			stack.height,
			8 * metrics.agentRowHeight + 7 * metrics.rowGap
				+ metrics.rowGap + metrics.chipHeight)
	}

	func testEmptyStack() {
		XCTAssertEqual(
			AgentStack.build(agents: [], expanded: false, metrics: metrics), .empty)
		XCTAssertEqual(AgentStack.empty.items, [])
		XCTAssertEqual(AgentStack.empty.height, 0)
		XCTAssertEqual(AgentStack.empty.liveCount, 0)
		XCTAssertEqual(AgentStack.empty.hiddenCompleted, 0)
	}

	// MARK: - Helpers

	private func makeAgent(
		id: String, state: AgentState, startedHours: Double, endedHours: Double? = nil
	) -> Agent {
		Agent(
			id: id, missionId: "m1", workspaceId: "w1",
			name: "agent \(id)", task: "Task.", access: .readOnly, provider: "fake",
			model: "test-model", skills: [], sessionId: "s-\(id)",
			canSpawn: false, state: state, stateBefore: nil, activity: nil,
			pendingQuestion: nil, startedAt: base.addingTimeInterval(startedHours * 3600),
			endedAt: endedHours.map { base.addingTimeInterval($0 * 3600) }, outcome: nil)
	}

	/// Deterministic Fisher-Yates shuffle (xorshift64*).
	private func shuffle(_ agents: inout [Agent], rng: inout UInt64) {
		guard agents.count > 1 else { return }
		for i in stride(from: agents.count - 1, through: 1, by: -1) {
			rng ^= rng >> 12
			rng ^= rng << 25
			rng ^= rng >> 27
			let j = Int((rng &* 0x2545_F491_4F6C_DD1D >> 32) % UInt64(i + 1))
			agents.swapAt(i, j)
		}
	}
}
