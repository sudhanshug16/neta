import CoreGraphics
import Foundation
import XCTest

@testable import NetaDesktop

private let now = Date(timeIntervalSince1970: 1_787_712_000)

private var nowMs: Double { now.timeIntervalSince1970 * 1000 }

private func makeMission(
	id: String, number: Int, state: MissionState = .running,
	age: Double
) -> Mission {
	Mission(
		id: id, number: number,
		workspaceId: "w1", machineId: "m1",
		name: "mission \(number)", objective: "Objective.", changes: [],
		lead: .leader, agentIds: [], access: .readOnly, worktree: nil,
		state: state, attention: nil,
		createdAt: now.addingTimeInterval(-age),
		closedAt: nil, disposition: nil, closeReason: nil,
		integration: nil, continuesMissionId: nil)
}

private func makeIndex(
	_ missions: [Mission], pxPerHour: Double = 48
) -> SpineIndex {
	SpineIndex(
		missions: missions, pxPerHour: pxPerHour, maxPitch: 320)
}

/// T10.9 contract: the Now label and live edge, jump staging and clearing,
/// the off-screen leader flip, pan moving scroll but never spacing, zoom
/// holding the cursor, and Fit.
@MainActor
final class NowStateTests: XCTestCase {
	private let viewport = CGRect(x: 0, y: 0, width: 1600, height: 1000)

	private func leaderRect(
		_ index: SpineIndex, scrollX: CGFloat
	) -> CGRect {
		SpinePlacement.leaderRect(
			index: index, scrollX: scrollX, viewport: viewport,
			spineY: viewport.midY)
	}

	// MARK: - Live edge

	func testLitAtLiveEdge() {
		let index = makeIndex([
			makeMission(id: "a", number: 1, age: 3600),
			makeMission(id: "b", number: 2, age: 60),
		])
		let state = NowState()
		state.update(
			index: index, scrollX: 0, viewport: viewport,
			leader: leaderRect(index, scrollX: 0), now: now)
		XCTAssertTrue(state.isLive)
		XCTAssertEqual(state.label, "Now")
	}

	func testLitAtHalfPixelOvershoot() {
		let index = makeIndex([
			makeMission(id: "a", number: 1, age: 60),
		])
		// Newest item half a point past the right edge still counts.
		let newestX = index.x(index.count - 1)
		let scrollX = newestX - viewport.width - 0.5
		let state = NowState()
		state.update(
			index: index, scrollX: scrollX, viewport: viewport,
			leader: leaderRect(index, scrollX: scrollX), now: now)
		XCTAssertTrue(state.isLive)
		XCTAssertEqual(state.label, "Now")
		// Past the grace the view is back in time.
		let past = NowState()
		past.update(
			index: index, scrollX: scrollX - 0.1, viewport: viewport,
			leader: leaderRect(index, scrollX: scrollX - 0.1), now: now)
		XCTAssertFalse(past.isLive)
	}

	func testBackLabels() {
		let threeDays = makeIndex([
			makeMission(id: "a", number: 1, age: 3 * 86400 + 60),
			makeMission(id: "b", number: 2, age: 3 * 86400),
		])
		let state = NowState()
		// Newest item off the right edge: 120 past a 100-wide viewport.
		let narrow = CGRect(x: 0, y: 0, width: 100, height: 1000)
		state.update(
			index: threeDays, scrollX: 0, viewport: narrow,
			leader: leaderRect(threeDays, scrollX: 0), now: now)
		XCTAssertFalse(state.isLive)
		XCTAssertEqual(state.label, "Now · 3d back")

		let fiveHours = makeIndex([
			makeMission(id: "c", number: 3, age: 5 * 3600 + 60),
			makeMission(id: "d", number: 4, age: 5 * 3600),
		])
		let hours = NowState()
		hours.update(
			index: fiveHours, scrollX: 0, viewport: narrow,
			leader: leaderRect(fiveHours, scrollX: 0), now: now)
		XCTAssertFalse(hours.isLive)
		XCTAssertEqual(hours.label, "Now · 5h back")
	}

	// MARK: - Jump

	func testConsumeJumpClearsTheRequest() {
		let index = makeIndex([
			makeMission(id: "a", number: 1, age: 3600),
		])
		let state = NowState()
		XCTAssertNil(state.jumpRequest)
		state.jumpToNow(index: index, viewport: viewport)
		let request = state.jumpRequest
		XCTAssertNotNil(request)
		XCTAssertEqual(
			request, max(0, index.contentWidth - viewport.width))
		XCTAssertEqual(state.consumeJump(), request)
		XCTAssertNil(state.consumeJump())
	}

	// MARK: - Off-screen leader

	func testLeaderOffScreenFlipsAtTheViewportEdge() {
		let index = makeIndex([
			makeMission(id: "a", number: 1, age: 60),
		])
		let state = NowState()
		let leader = leaderRect(index, scrollX: 0)
		state.update(
			index: index, scrollX: 0, viewport: viewport, leader: leader,
			now: now)
		XCTAssertFalse(state.leaderOffScreen)
		// A viewport ending one point left of the leader's leading edge.
		let clipped = CGRect(
			x: 0, y: 0, width: leader.minX - 1, height: 1000)
		state.update(
			index: index, scrollX: 0, viewport: clipped, leader: leader,
			now: now)
		XCTAssertTrue(state.leaderOffScreen)
	}

	// MARK: - Pan

	func testHorizontalPanMovesScrollXOnly() {
		// Seven missions a day apart: six gaps clamped to `maxPitch` keep
		// the content (6 x 320 + 270) wider than the viewport, so the pan
		// has room to land.
		let index = makeIndex((0 ..< 7).map { k in
			makeMission(
				id: "m\(k)", number: k + 1, age: Double(6 - k) * 86400)
		})
		let state = SpineViewportState(pxPerHour: 48)
		XCTAssertGreaterThan(index.contentWidth, viewport.width)
		state.pan(
			by: CGSize(width: 100, height: 0), index: index,
			viewport: viewport, contentHeight: 1000)
		XCTAssertEqual(state.scrollX, 100)
		XCTAssertEqual(state.pxPerHour, 48)
		XCTAssertEqual(state.maxPitch, 320)
		XCTAssertEqual(
			SpineMetrics.standard.rowGap, 10,
			"pan leaves metrics untouched")
	}

	func testVerticalPanChangesScrollYOnlyAndClamps() {
		let index = makeIndex([makeMission(id: "a", number: 1, age: 60)])
		let state = SpineViewportState(pxPerHour: 48)
		state.pan(
			by: CGSize(width: 0, height: 40), index: index,
			viewport: viewport, contentHeight: 1400)
		XCTAssertEqual(state.scrollY, 40)
		XCTAssertEqual(state.scrollX, 0)
		state.pan(
			by: CGSize(width: 0, height: 10_000), index: index,
			viewport: viewport, contentHeight: 1400)
		XCTAssertEqual(state.scrollY, 400)
		state.pan(
			by: CGSize(width: 0, height: -10_000), index: index,
			viewport: viewport, contentHeight: 1400)
		XCTAssertEqual(state.scrollY, 0)
	}

	func testPanClampsScrollXToContent() {
		let index = makeIndex([makeMission(id: "a", number: 1, age: 60)])
		XCTAssertLessThan(index.contentWidth, viewport.width)
		let state = SpineViewportState(pxPerHour: 48)
		state.pan(
			by: CGSize(width: 500, height: 0), index: index,
			viewport: viewport, contentHeight: 1000)
		XCTAssertEqual(state.scrollX, 0)
	}

	// MARK: - Zoom

	func testZoomHoldsContentUnderCursor() {
		let missions = (0 ..< 20).map { k in
			makeMission(
				id: "m\(k)", number: k + 1, age: Double(20 - k) * 3600)
		}
		// 200 px/h keeps hour gaps unclamped, so the zoom re-solves
		// nontrivially.
		let state = SpineViewportState(pxPerHour: 200)
		var index = makeIndex(missions, pxPerHour: 200)
		let cursorX: CGFloat = 800
		let before = SpineTicks.time(
			index: index, x: state.scrollX + cursorX, now: .infinity)
		state.zoom(factor: 1.25, atCursorX: cursorX, index: index)
		XCTAssertEqual(state.pxPerHour, 250)
		index = index.respaced(
			pxPerHour: state.pxPerHour, maxPitch: state.maxPitch)
		let after = SpineTicks.time(
			index: index, x: state.scrollX + cursorX, now: .infinity)
		XCTAssertEqual(after, before, accuracy: 1e-9)
		// ...so the content under the cursor holds within one point.
		let afterX = SpineTicks.x(index: index, t: after, now: .infinity)
		XCTAssertEqual(afterX - state.scrollX, cursorX, accuracy: 1.0)
	}

	func testZoomNeverChangesTheMinimumPitch() {
		let state = SpineViewportState(pxPerHour: 48)
		XCTAssertEqual(SpineViewportState.minPitch, 120)
		let index = makeIndex([makeMission(id: "a", number: 1, age: 60)])
		state.zoom(factor: 0.001, atCursorX: 800, index: index)
		XCTAssertEqual(state.pxPerHour, SpineViewportState.minPxPerHour)
		XCTAssertEqual(state.maxPitch, SpineViewportState.minPitch)
	}

	func testFloorGivesAUniformSequence() {
		let missions = (0 ..< 10).map { k in
			makeMission(
				id: "m\(k)", number: k + 1, age: Double(10 - k) * 24 * 3600)
		}
		let state = SpineViewportState(pxPerHour: 48)
		let index = makeIndex(missions)
		state.zoom(factor: 0.0001, atCursorX: 800, index: index)
		let floored = index.respaced(
			pxPerHour: state.pxPerHour, maxPitch: state.maxPitch)
		for i in 1 ..< floored.count {
			XCTAssertEqual(
				floored.x(i) - floored.x(i - 1), 120, accuracy: 1e-9)
		}
	}

	// MARK: - Fit

	func testFitShowsEveryOpenMissionWhenTheyFit() {
		let missions = [
			makeMission(id: "a", number: 1, age: 5 * 3600),
			makeMission(id: "b", number: 2, age: 3600),
			makeMission(id: "c", number: 3, age: 60),
		]
		let state = SpineViewportState(pxPerHour: 48)
		let index = makeIndex(missions)
		state.fit(index: index, viewport: viewport)
		let fitted = index.respaced(
			pxPerHour: state.pxPerHour, maxPitch: state.maxPitch)
		let first = fitted.earliestOpen ?? 0
		XCTAssertGreaterThanOrEqual(state.scrollX, 0)
		XCTAssertLessThanOrEqual(
			fitted.x(fitted.count - 1) - state.scrollX, viewport.width)
		XCTAssertLessThanOrEqual(state.scrollX, fitted.x(first) + 1)
		XCTAssertEqual(state.scrollY, 0)
	}

	func testFitPansToNewestWhenOpenMissionsDoNotFit() {
		let missions = (0 ..< 200).map { k in
			makeMission(
				id: "m\(k)", number: k + 1, age: Double(200 - k) * 3600)
		}
		let state = SpineViewportState(pxPerHour: 48)
		let index = makeIndex(missions)
		state.fit(index: index, viewport: viewport)
		XCTAssertEqual(state.pxPerHour, SpineViewportState.minPxPerHour)
		let floored = index.respaced(
			pxPerHour: state.pxPerHour, maxPitch: state.maxPitch)
		XCTAssertEqual(
			state.scrollX,
			max(0, floored.contentWidth - viewport.width), accuracy: 1e-6)
	}
}
