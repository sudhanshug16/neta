import CoreGraphics
import Foundation
import SwiftUI
import XCTest

@testable import NetaDesktop

/// T10.4 contract: the visible window materialises at most `maxLiveColumns`
/// columns laid out from a binary-searched range only, ticks stay at one per
/// pixel column with the bucket's strongest state, a one-pixel pan barely
/// moves the kept set, and no mission draws a leader edge.
final class VirtualisationTests: XCTestCase {
	private let metrics = SpineMetrics.standard
	private let viewport = CGRect(x: 0, y: 0, width: 1600, height: 1000)
	private let base = Date(timeIntervalSince1970: 1_780_315_200) // 2026-06-01T12:00:00Z
	private var baseMs: Double { base.timeIntervalSince1970 * 1000 }

	private func lens(focusHours: Double) -> TimeLens {
		TimeLens(TimeLensOptions(
			now: baseMs,
			focusStart: baseMs - focusHours * 3_600_000,
			focusEnd: baseMs,
			width: 1600,
			minPxPerHour: 8))
	}

	// MARK: - 100k-mission window

	/// 100 000 missions over three years, viewport on the last day: the
	/// window averages under 8 ms over 20 runs, caps columns at 60, and never
	/// emits more ticks than the viewport is wide.
	func testWindowOn100kMissionsIsFastCappedAndTicked() {
		let threeYears = 3 * 365.25 * 86400.0
		let states: [MissionState] =
			[.running, .blocked, .failed, .readyToClose, .mergedNotClosed, .closed]
		var missions: [Mission] = []
		missions.reserveCapacity(100_000)
		for i in 0 ..< 100_000 {
			missions.append(makeMission(
				id: "m\(i)", number: i + 1, state: states[i % states.count],
				createdAt: Date(
					timeIntervalSince1970: base.timeIntervalSince1970
						- Double(i) * threeYears / 100_000)))
		}
		let index = SpineIndex(missions: missions)
		let lens = lens(focusHours: 24)

		var window = SpineVirtualiser.window(
			index: index, agents: [:], lens: lens, viewport: viewport)
		let started = Date()
		for _ in 0 ..< 20 {
			window = SpineVirtualiser.window(
				index: index, agents: [:], lens: lens, viewport: viewport)
		}
		let average = Date().timeIntervalSince(started) / 20
		XCTAssertLessThan(average, 0.008, "average \(average * 1000) ms per window")

		// ~92 missions fall in the last day: the cap must engage exactly.
		XCTAssertEqual(window.columns.count, metrics.maxLiveColumns)
		XCTAssertEqual(window.liveViewCount, window.columns.count)
		XCTAssertLessThanOrEqual(window.ticks.count, Int(viewport.width))
		XCTAssertGreaterThan(window.ticks.count, 0)
		XCTAssertEqual(window.spineY, viewport.midY)
		XCTAssertEqual(
			window.leader.midX, CGFloat(lens.x(lens.options.now)), accuracy: 1e-9)
		XCTAssertEqual(window.leader.midY, window.spineY)
		// Kept columns keep index (oldest-to-newest) order.
		let times = Dictionary(uniqueKeysWithValues: missions.map { ($0.id, $0.createdAt) })
		let ordered = window.columns.map { times[$0.id]! }
		XCTAssertEqual(ordered, ordered.sorted(), "kept columns keep index order")
	}

	// MARK: - Pan stability

	/// A one-pixel pan shifts the kept set by at most one column per edge.
	func testOnePixelPanShiftsAtMostOneColumnPerEdge() {
		var missions: [Mission] = []
		for i in 0 ..< 400 {
			missions.append(makeMission(
				id: "m\(i)", number: i + 1,
				createdAt: base.addingTimeInterval(Double(-i) * 864)))
		}
		let index = SpineIndex(missions: missions)
		let lens = lens(focusHours: 96)
		let panned = viewport.offsetBy(dx: 1, dy: 0)
		let before = SpineVirtualiser.window(
			index: index, agents: [:], lens: lens, viewport: viewport)
		let after = SpineVirtualiser.window(
			index: index, agents: [:], lens: lens, viewport: panned)
		XCTAssertEqual(before.columns.count, metrics.maxLiveColumns)
		XCTAssertEqual(after.columns.count, metrics.maxLiveColumns)
		let oldIds = Set(before.columns.map(\.id))
		let newIds = Set(after.columns.map(\.id))
		XCTAssertLessThanOrEqual(newIds.subtracting(oldIds).count, 1, "added")
		XCTAssertLessThanOrEqual(oldIds.subtracting(newIds).count, 1, "removed")
	}

	// MARK: - Bucket ticks

	/// Missions sharing a pixel column collapse into one tick carrying the
	/// strongest state: blocked beats running.
	func testBucketTickCarriesStrongestState() {
		let at = base.addingTimeInterval(-3600)
		let missions = [
			makeMission(id: "run", number: 1, state: .running, createdAt: at),
			makeMission(id: "blocked", number: 2, state: .blocked, createdAt: at),
		]
		let window = SpineVirtualiser.window(
			index: SpineIndex(missions: missions), agents: [:],
			lens: lens(focusHours: 24), viewport: viewport)
		XCTAssertEqual(window.columns.count, 2)
		XCTAssertEqual(window.ticks.count, 1)
		XCTAssertEqual(window.ticks[0].state, .blocked)
	}

	// MARK: - Backdrop recording

	/// Through a recording graphics context: every column draws its connector
	/// and anchor, trunks grow with 6 pt stubs, lens labels render — and a
	/// `.leader`-led mission draws no leader edge.
	func testLeaderLedMissionDrawsNoLeaderEdge() {
		let missions = [
			makeMission(
				id: "led", number: 1, state: .running, lead: .leader,
				createdAt: base.addingTimeInterval(-7200)),
			makeMission(
				id: "plain", number: 2, state: .blocked,
				lead: .agent(agentId: "a0"),
				createdAt: base.addingTimeInterval(-3600)),
		]
		let agents: [MissionId: [Agent]] = [
			"led": [
				makeAgent(id: "a1", missionId: "led", state: .running),
				makeAgent(id: "a2", missionId: "led", state: .starting),
			],
		]
		let lens = lens(focusHours: 24)
		let window = SpineVirtualiser.window(
			index: SpineIndex(missions: missions), agents: agents,
			lens: lens, viewport: viewport)
		XCTAssertEqual(window.columns.count, 2)

		var recorder = RecordingGraphicsContext()
		SpinePainter.draw(
			into: &recorder, size: viewport.size, window: window, lens: lens,
			style: .standard, emphasisFor: { _ in 1 })

		XCTAssertTrue(
			recorder.strokes.allSatisfy { $0.kind != .leader },
			"leader-led mission must draw no leader edge")
		XCTAssertEqual(
			recorder.strokes.filter { $0.kind == .connector }.count,
			window.columns.count)
		XCTAssertEqual(recorder.anchors.count, window.columns.count)
		XCTAssertEqual(
			Set(recorder.anchors.map(\.id)),
			Set(window.columns.map(\.id)))
		let trunkRows = window.columns.reduce(0) { $0 + $1.rows.count }
		XCTAssertEqual(recorder.strokes.filter { $0.kind == .trunk }.count, 1)
		let stubs = recorder.strokes.filter { $0.kind == .stub }
		XCTAssertEqual(stubs.count, trunkRows)
		for stub in stubs {
			XCTAssertEqual(stub.points.count, 2)
			XCTAssertEqual(
				abs(stub.points[0].x - stub.points[1].x),
				BackdropPlan.stubLength, accuracy: 1e-9)
		}
		XCTAssertEqual(recorder.labelCount, lens.ticks().count)
		XCTAssertEqual(recorder.tickCount, window.ticks.count)
		XCTAssertEqual(recorder.drawnStyles, [.standard])
	}

	/// An empty index draws an empty backdrop without crashing.
	func testEmptyIndexYieldsEmptyWindowAndBackdrop() {
		let lens = lens(focusHours: 24)
		let window = SpineVirtualiser.window(
			index: SpineIndex(missions: []), agents: [:],
			lens: lens, viewport: viewport)
		XCTAssertEqual(window.columns, [])
		XCTAssertEqual(window.ticks, [])
		XCTAssertEqual(window.liveViewCount, 0)
		XCTAssertEqual(window.spineY, viewport.midY)
		var recorder = RecordingGraphicsContext()
		SpinePainter.draw(
			into: &recorder, size: viewport.size, window: window, lens: lens,
			style: .standard, emphasisFor: { _ in 1 })
		XCTAssertEqual(recorder.strokes, [])
		XCTAssertEqual(recorder.anchors, [])
		XCTAssertEqual(recorder.tickCount, 0)
	}

	// MARK: - Connector paths

	func testConnectorPath() {
		XCTAssertTrue(SpinePainter.connectorPath([]).isEmpty)
		XCTAssertFalse(
			SpinePainter.connectorPath([CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 8)])
				.isEmpty)
		XCTAssertFalse(
			SpinePainter.connectorPath([
				CGPoint(x: 1, y: 2), CGPoint(x: 1, y: 3),
				CGPoint(x: 4, y: 3), CGPoint(x: 4, y: 5),
			]).isEmpty)
	}

	// MARK: - Canvas smoke

	/// The backdrop view renders through a real `Canvas` without crashing.
	@MainActor
	func testBackdropRendersInCanvas() {
		let missions = [
			makeMission(
				id: "led", number: 1, state: .blocked, lead: .leader,
				createdAt: base.addingTimeInterval(-7200)),
		]
		let lens = lens(focusHours: 24)
		let window = SpineVirtualiser.window(
			index: SpineIndex(missions: missions), agents: [:],
			lens: lens, viewport: viewport)
		let renderer = ImageRenderer(content: SpineBackdrop(
			window: window, lens: lens, emphasisFor: { _ in 1 }))
		renderer.proposedSize = ProposedViewSize(width: 1600, height: 1000)
		XCTAssertNotNil(renderer.cgImage)
	}

	// MARK: - Helpers

	private func makeMission(
		id: String, number: Int, state: MissionState = .running,
		lead: MissionLead = .leader, createdAt: Date
	) -> Mission {
		Mission(
			id: id, number: number,
			workspaceId: "w1", machineId: "m1",
			name: "mission \(number)", objective: "Objective.", changes: [],
			lead: lead, agentIds: [], access: .readOnly, worktree: nil,
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
			name: "agent \(id)", task: "Task.", access: .readOnly, provider: "fake",
			model: "test-model", skills: [], sessionId: "s-\(id)",
			canSpawn: false, state: state, stateBefore: nil, activity: nil,
			pendingQuestion: nil,
			startedAt: base, endedAt: nil, outcome: nil)
	}
}
