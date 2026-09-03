import CoreGraphics
import Foundation
import XCTest

@testable import NetaDesktop

// MARK: - Builders

private let now = Date(timeIntervalSince1970: 1_787_712_000)

private var nowMs: Double { now.timeIntervalSince1970 * 1000 }

private func lens(focusHours: Double = 24) -> TimeLens {
	TimeLens(TimeLensOptions(
		now: nowMs,
		focusStart: nowMs - focusHours * 3_600_000,
		focusEnd: nowMs,
		width: 1600,
		minPxPerHour: 8))
}

private func makeEvent(
	seq: Int,
	kind: EventKind,
	at: Date,
	missionId: MissionId? = nil,
	sessionId: SessionId? = nil,
	turnId: TurnId? = nil,
	data: [String: DataValue] = [:]
) -> Event {
	Event(
		seq: seq, at: at, workspaceId: "w1", kind: kind,
		missionId: missionId, agentId: nil,
		sessionId: sessionId, turnId: turnId, data: data)
}

/// T10.7 contract: the icon table over every `EventKind`, individual points
/// inside the focus window, coalescing older than `focusStart`, and routing
/// through `CheckpointRouter`.
@MainActor
final class CheckpointTests: XCTestCase {
	// MARK: - Icon table

	func testIconTableCoversEveryEventKind() {
		let expected: [EventKind: CheckpointIcon] = [
			.leaderModeChanged: .bolt,
			.missionMerged: .merge,
			.baseIntegrated: .merge,
			.userPinned: .diamond,
			.missionFailed: .x,
			.charterChanged: .document,
			.nodeRestarted: .power,
			.missionClosed: .check,
			.missionBlocked: .question,
		]
		XCTAssertEqual(EventKind.allCases.count, 17)
		for kind in EventKind.allCases {
			XCTAssertEqual(
				Checkpoints.icon(for: kind), expected[kind] ?? nil,
				"kind \(kind.rawValue)")
		}
		XCTAssertNil(Checkpoints.icon(for: .unknown("future.kind")))
	}

	func testNonCheckpointKindsAreExcludedFromPlace() {
		let lens = lens()
		let events = [
			makeEvent(seq: 1, kind: .missionCreated, at: now.addingTimeInterval(-60)),
			makeEvent(seq: 2, kind: .agentSpawned, at: now.addingTimeInterval(-120)),
			makeEvent(seq: 3, kind: .leaderModeReminder, at: now.addingTimeInterval(-180)),
			makeEvent(seq: 4, kind: .unknown("future.kind"), at: now.addingTimeInterval(-240)),
		]
		let result = Checkpoints.place(events: events, lens: lens, now: now)
		XCTAssertTrue(result.points.isEmpty)
		XCTAssertTrue(result.clusters.isEmpty)
	}

	// MARK: - Focus window stays individual

	func testFocusWindowEventsStayIndividual() {
		let lens = lens()
		let events = [
			makeEvent(
				seq: 1, kind: .leaderModeChanged,
				at: now.addingTimeInterval(-14 * 60),
				missionId: "m308", sessionId: "s1", turnId: "t1",
				data: ["number": .number(308)]),
			makeEvent(seq: 2, kind: .missionMerged, at: now.addingTimeInterval(-2 * 3600)),
			makeEvent(seq: 3, kind: .userPinned, at: now.addingTimeInterval(-3 * 3600)),
			makeEvent(seq: 4, kind: .missionFailed, at: now.addingTimeInterval(-19 * 3600)),
			makeEvent(
				seq: 5, kind: .missionCreated,
				at: now.addingTimeInterval(-3600)),
		]
		let result = Checkpoints.place(events: events, lens: lens, now: now)
		XCTAssertEqual(result.points.map(\.seq), [1, 2, 3, 4])
		XCTAssertTrue(result.clusters.isEmpty)
		for checkpoint in result.points {
			XCTAssertEqual(checkpoint.id, String(checkpoint.seq))
			XCTAssertEqual(
				checkpoint.x,
				CGFloat(lens.x(checkpoint.at.timeIntervalSince1970 * 1000)),
				accuracy: 1e-9)
		}
		XCTAssertEqual(result.points[0].label, "Lead++ · #308")
		XCTAssertEqual(result.points[0].relative, "14m ago")
		XCTAssertEqual(result.points[1].icon, .merge)
		XCTAssertEqual(result.points[3].icon, .x)
	}

	// MARK: - Coalescing

	func testTwelveAtTwoWeeksCollapseIntoClustersSummingToTwelve() {
		let lens = lens()
		let kinds: [EventKind] = [
			.missionClosed, .missionMerged, .baseIntegrated,
			.charterChanged, .nodeRestarted, .userPinned,
		]
		var events: [Event] = []
		for i in 0 ..< 12 {
			events.append(makeEvent(
				seq: 100 + i, kind: kinds[i % kinds.count],
				at: now.addingTimeInterval(-14 * 86400 + Double(i) * 60)))
		}
		let result = Checkpoints.place(events: events, lens: lens, now: now)
		XCTAssertTrue(result.points.isEmpty)
		XCTAssertFalse(result.clusters.isEmpty)
		XCTAssertEqual(result.clusters.flatMap(\.members).count, 12)
		XCTAssertEqual(
			Set(result.clusters.flatMap { $0.members.map(\.seq) }).count, 12,
			"every event lands in exactly one cluster")
		for cluster in result.clusters {
			let mean = cluster.members.reduce(CGFloat(0)) { $0 + $1.x }
				/ CGFloat(cluster.members.count)
			XCTAssertEqual(cluster.x, mean, accuracy: 1e-6)
		}
	}

	func testSpreadOldEventsFormOneClusterPerRun() {
		let lens = lens()
		var events: [Event] = []
		for i in 0 ..< 6 {
			events.append(makeEvent(
				seq: 200 + i, kind: .missionClosed,
				at: now.addingTimeInterval(-14 * 86400 + Double(i) * 60)))
		}
		for i in 0 ..< 6 {
			events.append(makeEvent(
				seq: 300 + i, kind: .missionClosed,
				at: now.addingTimeInterval(-28 * 86400 + Double(i) * 60)))
		}
		let result = Checkpoints.place(events: events, lens: lens, now: now)
		XCTAssertTrue(result.points.isEmpty)
		XCTAssertEqual(result.clusters.count, 2)
		XCTAssertEqual(result.clusters.map { $0.members.count }.sorted(), [6, 6])
	}

	// MARK: - Routing

	func testModeChangedWithTurnRoutesToScrollToTurn() {
		let lens = lens()
		let event = makeEvent(
			seq: 7, kind: .leaderModeChanged,
			at: now.addingTimeInterval(-840),
			missionId: "m1", sessionId: "s1", turnId: "t1")
		let result = Checkpoints.place(events: [event], lens: lens, now: now)
		XCTAssertEqual(result.points.count, 1)
		let router = CheckpointRouter()
		XCTAssertNil(router.pending)
		router.open(result.points[0])
		XCTAssertEqual(router.pending, .scrollToTurn(sessionId: "s1", turnId: "t1"))
		XCTAssertEqual(router.consume(), .scrollToTurn(sessionId: "s1", turnId: "t1"))
		XCTAssertNil(router.pending)
	}

	func testModeChangedWithoutTurnRoutesToDecisionRecord() {
		let lens = lens()
		let event = makeEvent(
			seq: 8, kind: .leaderModeChanged,
			at: now.addingTimeInterval(-840), missionId: "m9")
		let result = Checkpoints.place(events: [event], lens: lens, now: now)
		XCTAssertEqual(result.points.count, 1)
		let router = CheckpointRouter()
		router.open(result.points[0])
		XCTAssertEqual(router.pending, .openDecisionRecord(missionId: "m9", seq: 8))
	}

	func testOpenWithoutMissionIdStillRoutesToDecisionRecord() {
		let lens = lens()
		let event = makeEvent(
			seq: 9, kind: .missionBlocked,
			at: now.addingTimeInterval(-3600))
		let result = Checkpoints.place(events: [event], lens: lens, now: now)
		XCTAssertEqual(result.points.count, 1)
		let router = CheckpointRouter()
		router.open(result.points[0])
		XCTAssertEqual(router.pending, .openDecisionRecord(missionId: "", seq: 9))
	}

	func testConsumeClearsPending() {
		let lens = lens()
		let event = makeEvent(
			seq: 10, kind: .userPinned,
			at: now.addingTimeInterval(-60),
			missionId: "m2", sessionId: "s2", turnId: "t2")
		let result = Checkpoints.place(events: [event], lens: lens, now: now)
		let router = CheckpointRouter()
		XCTAssertNil(router.consume())
		router.open(result.points[0])
		XCTAssertNotNil(router.pending)
		XCTAssertNotNil(router.consume())
		XCTAssertNil(router.pending)
		XCTAssertNil(router.consume())
	}
}
