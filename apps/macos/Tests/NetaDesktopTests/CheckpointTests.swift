import CoreGraphics
import Foundation
import XCTest

@testable import NetaDesktop

// MARK: - Builders

private let now = Date(timeIntervalSince1970: 1_787_712_000)

private var nowMs: Double { now.timeIntervalSince1970 * 1000 }

private func makeMission(
	id: String, number: Int, at: Date
) -> Mission {
	Mission(
		id: id, number: number,
		workspaceId: "w1", machineId: "m1",
		name: "mission \(number)", objective: "Objective.", changes: [],
		lead: .leader, agentIds: [], access: .readOnly, worktree: nil,
		state: .running, attention: nil,
		createdAt: at,
		closedAt: nil, disposition: nil, closeReason: nil,
		integration: nil, continuesMissionId: nil)
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

/// T10.8 contract: the icon table over every `EventKind`, index-based
/// positions with checkpoint pitch, and routing through `CheckpointRouter`.
@MainActor
final class CheckpointTests: XCTestCase {
	private let viewport = CGRect(x: 0, y: 0, width: 1600, height: 1000)

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
		let events = [
			makeEvent(seq: 1, kind: .missionCreated, at: now.addingTimeInterval(-60)),
			makeEvent(seq: 2, kind: .agentSpawned, at: now.addingTimeInterval(-120)),
			makeEvent(seq: 3, kind: .leaderModeReminder, at: now.addingTimeInterval(-180)),
			makeEvent(seq: 4, kind: .unknown("future.kind"), at: now.addingTimeInterval(-240)),
		]
		let index = SpineIndex(
			missions: [], events: events, pxPerHour: 48, maxPitch: 320)
		XCTAssertEqual(index.count, 0)
		XCTAssertTrue(Checkpoints.place(
			index: index, events: events, range: 0 ..< 0, scrollX: 0,
			viewport: viewport, now: now).isEmpty)
	}

	// MARK: - Index positions

	/// Twelve events across a month: each x equals `index.x` of its item
	/// and no two are closer than `checkpointPitch`.
	func testTwelveEventsAcrossAMonthSitOnTheirItems() throws {
		let kinds: [EventKind] = [
			.leaderModeChanged, .missionMerged, .userPinned, .missionFailed,
			.charterChanged, .nodeRestarted, .missionClosed, .missionBlocked,
			.baseIntegrated, .missionMerged, .userPinned, .missionClosed,
		]
		var events: [Event] = []
		for i in 0 ..< 12 {
			events.append(makeEvent(
				seq: i + 1, kind: kinds[i],
				at: now.addingTimeInterval(-30 * 86400 + Double(i) * 2.5 * 86400)))
		}
		let missions = [
			makeMission(
				id: "m1", number: 1,
				at: now.addingTimeInterval(-31 * 86400)),
			makeMission(id: "m2", number: 2, at: now),
		]
		let index = SpineIndex(
			missions: missions, events: events, pxPerHour: 48,
			maxPitch: 320)
		let points = Checkpoints.place(
			index: index, events: events, range: 0 ..< index.count,
			scrollX: 0, viewport: viewport, now: now)
		XCTAssertEqual(points.map(\.seq), Array(1...12))
		var itemXBySeq: [Int: CGFloat] = [:]
		for i in 0 ..< index.count {
			if case .checkpoint(let seq, _) = index[i] {
				itemXBySeq[seq] = index.x(i)
			}
		}
		for point in points {
			XCTAssertEqual(
				point.x, try XCTUnwrap(itemXBySeq[point.seq]),
				accuracy: 1e-9)
			XCTAssertEqual(point.id, String(point.seq))
		}
		let sorted = points.map(\.x).sorted()
		for i in 1 ..< sorted.count {
			XCTAssertGreaterThanOrEqual(sorted[i] - sorted[i - 1], 28)
		}
		XCTAssertEqual(points[0].label, "Lead++")
	}

	func testLeadPlusLabelCarriesMissionNumberAndAge() {
		let events = [
			makeEvent(
				seq: 1, kind: .leaderModeChanged,
				at: now.addingTimeInterval(-14 * 60),
				missionId: "m308", sessionId: "s1", turnId: "t1",
				data: ["number": .number(308)]),
		]
		let index = SpineIndex(
			missions: [], events: events, pxPerHour: 48, maxPitch: 320)
		let points = Checkpoints.place(
			index: index, events: events, range: 0 ..< index.count,
			scrollX: 0, viewport: viewport, now: now)
		XCTAssertEqual(points.count, 1)
		XCTAssertEqual(points[0].label, "Lead++ · #308")
		XCTAssertEqual(points[0].relative, "14m ago")
		XCTAssertEqual(points[0].icon, .bolt)
	}

	// MARK: - Routing

	func testModeChangedWithTurnRoutesToScrollToTurn() {
		let event = makeEvent(
			seq: 7, kind: .leaderModeChanged,
			at: now.addingTimeInterval(-840),
			missionId: "m1", sessionId: "s1", turnId: "t1")
		let index = SpineIndex(
			missions: [], events: [event], pxPerHour: 48, maxPitch: 320)
		let points = Checkpoints.place(
			index: index, events: [event], range: 0 ..< index.count,
			scrollX: 0, viewport: viewport, now: now)
		XCTAssertEqual(points.count, 1)
		let router = CheckpointRouter()
		XCTAssertNil(router.pending)
		router.open(points[0])
		XCTAssertEqual(router.pending, .scrollToTurn(sessionId: "s1", turnId: "t1"))
		XCTAssertEqual(router.consume(), .scrollToTurn(sessionId: "s1", turnId: "t1"))
		XCTAssertNil(router.pending)
	}

	func testModeChangedWithoutTurnRoutesToDecisionRecord() {
		let event = makeEvent(
			seq: 8, kind: .leaderModeChanged,
			at: now.addingTimeInterval(-840), missionId: "m9")
		let index = SpineIndex(
			missions: [], events: [event], pxPerHour: 48, maxPitch: 320)
		let points = Checkpoints.place(
			index: index, events: [event], range: 0 ..< index.count,
			scrollX: 0, viewport: viewport, now: now)
		XCTAssertEqual(points.count, 1)
		let router = CheckpointRouter()
		router.open(points[0])
		XCTAssertEqual(router.pending, .openDecisionRecord(missionId: "m9", seq: 8))
	}

	func testOpenWithoutMissionIdStillRoutesToDecisionRecord() {
		let event = makeEvent(
			seq: 9, kind: .missionBlocked,
			at: now.addingTimeInterval(-3600))
		let index = SpineIndex(
			missions: [], events: [event], pxPerHour: 48, maxPitch: 320)
		let points = Checkpoints.place(
			index: index, events: [event], range: 0 ..< index.count,
			scrollX: 0, viewport: viewport, now: now)
		XCTAssertEqual(points.count, 1)
		let router = CheckpointRouter()
		router.open(points[0])
		XCTAssertEqual(router.pending, .openDecisionRecord(missionId: "", seq: 9))
	}

	func testConsumeClearsPending() {
		let router = CheckpointRouter()
		XCTAssertNil(router.consume())
	}
}
