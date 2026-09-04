import CoreGraphics
import Foundation
import XCTest

@testable import NetaDesktop

private func makeMission(
	id: String, number: Int, state: MissionState = .running,
	createdAt: Date
) -> Mission {
	Mission(
		id: id, number: number,
		workspaceId: "w1", machineId: "m1",
		name: "mission \(number)", objective: "Objective.", changes: [],
		lead: .leader, agentIds: [], access: .readOnly, worktree: nil,
		state: state, attention: nil,
		createdAt: createdAt,
		closedAt: nil, disposition: nil, closeReason: nil,
		integration: nil, continuesMissionId: nil)
}

private func makeAgent(
	id: String, missionId: String, state: AgentState
) -> Agent {
	Agent(
		id: id, missionId: missionId, workspaceId: "w1",
		name: "agent \(id)", task: "Task.", access: .readOnly,
		provider: "fake", model: "test-model", skills: [],
		sessionId: "s-\(id)", canSpawn: false, state: state,
		stateBefore: nil, activity: nil, pendingQuestion: nil,
		startedAt: Date(timeIntervalSince1970: 1_780_315_200),
		endedAt: nil, outcome: nil)
}

/// T10.5 contract: index-based windowing at scale and the one-`Canvas`
/// paint plan.
final class VirtualisationTests: XCTestCase {
	private let viewport = CGRect(x: 0, y: 0, width: 1600, height: 1000)
	private let base = Date(timeIntervalSince1970: 1_780_315_200)

	/// 100 000 missions over three years, viewport parked at the newest end.
	private func hugeIndex() -> SpineIndex {
		var missions: [Mission] = []
		missions.reserveCapacity(100_000)
		let span = 3 * 365 * 86400.0
		for i in 0 ..< 100_000 {
			missions.append(makeMission(
				id: "m\(i)", number: i + 1, state: .running,
				createdAt: base.addingTimeInterval(
					-span + span * Double(i) / 100_000)))
		}
		return SpineIndex(
			missions: missions, pxPerHour: 48, maxPitch: 320)
	}

	// MARK: - Scale

	func testHugeIndexWindowsFastWithBoundedViews() {
		let index = hugeIndex()
		let scrollX = max(0, index.contentWidth - viewport.width)
		var total: TimeInterval = 0
		var window = SpineVirtualiser.window(
			index: index, agents: [:], scrollX: scrollX,
			viewport: viewport, now: base.timeIntervalSince1970 * 1000)
		for _ in 0 ..< 20 {
			let start = Date()
			window = SpineVirtualiser.window(
				index: index, agents: [:], scrollX: scrollX,
				viewport: viewport,
				now: base.timeIntervalSince1970 * 1000)
			total += Date().timeIntervalSince(start)
		}
		XCTAssertLessThan(total / 20, 0.008, "window averages under 8 ms")
		XCTAssertLessThanOrEqual(
			window.columns.count, SpineMetrics.standard.maxLiveColumns)
		XCTAssertLessThanOrEqual(window.ticks.count, Int(viewport.width))
		XCTAssertEqual(
			window.liveViewCount, window.columns.count)
	}

	func testOnePixelPanShiftsAtMostOneColumnPerEdge() {
		let index = hugeIndex()
		let scrollX = max(0, index.contentWidth - viewport.width)
		let nowMs = base.timeIntervalSince1970 * 1000
		let before = SpineVirtualiser.window(
			index: index, agents: [:], scrollX: scrollX,
			viewport: viewport, now: nowMs)
		let after = SpineVirtualiser.window(
			index: index, agents: [:], scrollX: scrollX + 1,
			viewport: viewport, now: nowMs)
		XCTAssertLessThanOrEqual(
			abs(after.range.lowerBound - before.range.lowerBound), 1)
		XCTAssertLessThanOrEqual(
			abs(after.range.upperBound - before.range.upperBound), 1)
	}

	func testOverflowKeepsNearestColumnsAsViews() {
		var missions: [Mission] = []
		for i in 0 ..< 200 {
			missions.append(makeMission(
				id: "m\(i)", number: i + 1, state: .running,
				createdAt: base.addingTimeInterval(-Double(200 - i) * 60)))
		}
		let index = SpineIndex(
			missions: missions, pxPerHour: 48, maxPitch: 320)
		// Wide enough to hold past `maxLiveColumns` floored columns: at
		// the 120 pt minimum a 1600 pt window can never engage the cap.
		let wide = CGRect(x: 0, y: 0, width: 61 * 120 + 2 * 210, height: 1000)
		let window = SpineVirtualiser.window(
			index: index, agents: [:], scrollX: 0, viewport: wide,
			now: base.timeIntervalSince1970 * 1000)
		XCTAssertEqual(
			window.columns.count, SpineMetrics.standard.maxLiveColumns)
		XCTAssertGreaterThan(window.ticks.count, 0)
	}

	// MARK: - Paint plan

	/// A `.leader`-led mission draws no leader edge, and a four-row stack
	/// draws four centred links of `edgeWidth` — no trunk.
	func testLeaderLedMissionDrawsLinksButNoLeaderEdge() {
		// Even number: the card sits below the spine, so links run down
		// from the card's far (bottom) edge.
		let mission = makeMission(
			id: "m1", number: 2, state: .running, createdAt: base)
		XCTAssertEqual(mission.lead, .leader)
		let agents = Dictionary(
			grouping: (0 ..< 4).map {
				makeAgent(id: "a\($0)", missionId: "m1", state: .running)
			},
			by: \.missionId)
		let index = SpineIndex(
			missions: [mission], pxPerHour: 48, maxPitch: 320)
		let window = SpineVirtualiser.window(
			index: index, agents: agents, scrollX: 0, viewport: viewport,
			now: base.timeIntervalSince1970 * 1000)
		XCTAssertEqual(window.columns.count, 1)
		let column = window.columns[0]
		XCTAssertEqual(column.rows.count, 4)
		var recorder = RecordingGraphicsContext()
		SpinePainter.draw(
			into: &recorder, size: viewport.size, window: window,
			style: .standard, emphasisFor: { _ in 1 })
		XCTAssertTrue(
			recorder.strokes.allSatisfy { $0.kind != .leader },
			"no leader edge, even leader-led")
		let links = recorder.strokes.filter { $0.kind == .link }
		XCTAssertEqual(links.count, 4)
		XCTAssertEqual(recorder.drawnStyles.first?.edgeWidth, 1.4)
		for (i, link) in links.enumerated() {
			XCTAssertEqual(link.points.count, 2)
			XCTAssertEqual(link.points[0].x, link.points[1].x)
			XCTAssertEqual(
				link.points[0].x, column.card.midX, accuracy: 1e-9,
				"link \(i) horizontally centred on the stack")
		}
		// Each link spans exactly its gap: card to first row, row to row.
		let first = links[0]
		XCTAssertEqual(first.points[0].y, column.card.maxY, accuracy: 1e-9)
		XCTAssertEqual(
			first.points[1].y, column.rows[0].minY, accuracy: 1e-9)
	}
}
