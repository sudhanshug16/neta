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
		let live = SpinePlacement.liveScrollX(
			index: index, viewport: viewport, trailingInset: 0)
		let state = NowState()
		state.update(
			index: index, scrollX: live, viewport: viewport,
			leader: leaderRect(index, scrollX: live), now: now)
		XCTAssertTrue(state.isLive)
		XCTAssertEqual(state.label, "Now")
	}

	/// The other direction of the same test. A sequence narrower than the
	/// viewport has a negative live edge, so `scrollX` 0 draws the leader
	/// far from the right edge, out at the left — the un-anchored placement
	/// the fix pass removed. Now must not claim to be lit there.
	func testNotLiveWhenTheLeaderIsLeftOfTheLiveEdge() {
		let index = makeIndex([
			makeMission(id: "a", number: 1, age: 3600),
			makeMission(id: "b", number: 2, age: 60),
		])
		XCTAssertLessThan(index.contentWidth, viewport.width)
		let live = SpinePlacement.liveScrollX(
			index: index, viewport: viewport, trailingInset: 0)
		XCTAssertLessThan(live, 0, "a young workspace's live edge is negative")
		let leader = leaderRect(index, scrollX: 0)
		XCTAssertLessThan(
			leader.maxX, viewport.maxX - 1,
			"at scrollX 0 the leader is far left of the live edge")
		let state = NowState()
		state.update(
			index: index, scrollX: 0, viewport: viewport,
			leader: leader, now: now)
		XCTAssertFalse(state.isLive)
		XCTAssertFalse(state.leaderOffScreen)
		XCTAssertTrue(state.label.hasPrefix("Now · "))
	}

	func testLitAtHalfPixelOvershoot() {
		let index = makeIndex([
			makeMission(id: "a", number: 1, age: 60),
		])
		let live = SpinePlacement.liveScrollX(
			index: index, viewport: viewport, trailingInset: 0)
		// Half a point off the live edge still counts.
		let state = NowState()
		state.update(
			index: index, scrollX: live - 0.5, viewport: viewport,
			leader: leaderRect(index, scrollX: live - 0.5), now: now)
		XCTAssertTrue(state.isLive)
		XCTAssertEqual(state.label, "Now")
		// Past the grace the view is back in time.
		let past = NowState()
		past.update(
			index: index, scrollX: live - 1, viewport: viewport,
			leader: leaderRect(index, scrollX: live - 1), now: now)
		XCTAssertFalse(past.isLive)
	}

	/// Now follows the leader card, not the newest item: scrolled so the
	/// leader would sit behind the chat, the control must not claim to be
	/// live. The usable right edge is `viewport.maxX - trailingInset`.
	func testNotLiveWhenTheLeaderIsNotAtTheLiveEdge() {
		let index = makeIndex([
			makeMission(id: "a", number: 1, age: 3600),
			makeMission(id: "b", number: 2, age: 60),
		])
		let inset: CGFloat = 450
		let live = SpinePlacement.liveScrollX(
			index: index, viewport: viewport, trailingInset: inset)
		let leader = leaderRect(index, scrollX: live)
		XCTAssertEqual(
			leader.maxX, viewport.maxX - inset, accuracy: 1e-9,
			"the live edge is the canvas's usable right edge")
		let state = NowState()
		state.update(
			index: index, scrollX: live, viewport: viewport,
			leader: leader, now: now, trailingInset: inset)
		XCTAssertTrue(state.isLive)
		XCTAssertEqual(state.label, "Now")
		XCTAssertEqual(state.liveScrollX ?? .nan, live, accuracy: 1e-9)
		// Right-aligned on the whole viewport instead, the leader hides
		// behind the chat: that is not Now.
		let behind = index.contentWidth - viewport.width
		XCTAssertLessThan(behind, live)
		let hidden = NowState()
		hidden.update(
			index: index, scrollX: behind, viewport: viewport,
			leader: leaderRect(index, scrollX: behind), now: now,
			trailingInset: inset)
		XCTAssertFalse(hidden.isLive)
		XCTAssertTrue(hidden.label.hasPrefix("Now · "))
	}

	/// An empty index is the workspace's first minute: the leader alone at
	/// Now, which is live. Panned off the canvas it is not.
	func testEmptyIndexWithTheLeaderInViewIsLive() {
		let index = makeIndex([])
		XCTAssertEqual(index.count, 0)
		let inset: CGFloat = 450
		let live = SpinePlacement.liveScrollX(
			index: index, viewport: viewport, trailingInset: inset)
		let leader = leaderRect(index, scrollX: live)
		XCTAssertEqual(
			leader.maxX, viewport.maxX - inset, accuracy: 1e-9)
		let state = NowState()
		state.update(
			index: index, scrollX: live, viewport: viewport,
			leader: leader, now: now, trailingInset: inset)
		XCTAssertTrue(state.isLive)
		XCTAssertFalse(state.leaderOffScreen)
		XCTAssertEqual(state.label, "Now")
		let away = live - viewport.width
		let gone = NowState()
		gone.update(
			index: index, scrollX: away, viewport: viewport,
			leader: leaderRect(index, scrollX: away), now: now,
			trailingInset: inset)
		XCTAssertFalse(gone.isLive)
		XCTAssertTrue(gone.leaderOffScreen)
		XCTAssertEqual(gone.label, "Now", "no sequence, nothing to be back from")
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
			request,
			SpinePlacement.liveScrollX(
				index: index, viewport: viewport, trailingInset: 0))
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

	/// The two Now signals are separate. `isLive` is a test on the time
	/// axis; whether the leader card happens to be scrolled off vertically
	/// is `leaderOffScreen`, which drives the in-canvas marker. A Now jump
	/// never touches `scrollY`, so coupling them would report a time the
	/// view is not at and leave the control dead: it would stage the
	/// `scrollX` the view already has and nothing would move.
	func testLeaderScrolledOffVerticallyIsStillLive() {
		let index = makeIndex([
			makeMission(id: "a", number: 1, age: 3 * 3600),
			makeMission(id: "b", number: 2, age: 60),
		])
		let inset: CGFloat = 450
		let live = SpinePlacement.liveScrollX(
			index: index, viewport: viewport, trailingInset: inset)
		// The rendered rect the canvas passes: the placed leader shifted by
		// `scrollY`, here panned far enough down to clear the viewport.
		let leader = leaderRect(index, scrollX: live)
			.offsetBy(dx: 0, dy: -2000)
		XCTAssertFalse(leader.intersects(viewport))
		let state = NowState()
		state.update(
			index: index, scrollX: live, viewport: viewport,
			leader: leader, now: now, trailingInset: inset)
		XCTAssertTrue(
			state.isLive,
			"the view has not moved in time, so Now is lit")
		XCTAssertTrue(state.leaderOffScreen, "the marker still shows")
		XCTAssertEqual(state.label, "Now")
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
		// A sequence wider than the viewport, so `scrollX` 0 is inside the
		// scroll range and a vertical pan has nothing to re-clamp.
		let index = makeIndex((0 ..< 7).map { k in
			makeMission(
				id: "m\(k)", number: k + 1, age: Double(6 - k) * 86400)
		})
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

	/// Nothing exists right of Now, so the live edge is the forward limit
	/// even when it is negative. A sequence narrower than the usable width
	/// cannot be panned off Now: the leader's far edge stays on the usable
	/// right edge instead of sliding back behind the navigator band.
	func testPanClampsScrollXToTheLiveEdge() {
		let index = makeIndex([makeMission(id: "a", number: 1, age: 60)])
		XCTAssertLessThan(index.contentWidth, viewport.width)
		let inset: CGFloat = 450
		let live = SpinePlacement.liveScrollX(
			index: index, viewport: viewport, trailingInset: inset)
		XCTAssertLessThan(live, 0)
		let state = SpineViewportState(pxPerHour: 48)
		state.pan(
			by: CGSize(width: 500, height: 0), index: index,
			viewport: viewport, contentHeight: 1000, trailingInset: inset)
		XCTAssertEqual(state.scrollX, live, accuracy: 1e-9)
		XCTAssertEqual(
			leaderRect(index, scrollX: state.scrollX).maxX,
			viewport.maxX - inset, accuracy: 1e-6)
		// And back the other way it stops at the oldest item, not past it.
		state.pan(
			by: CGSize(width: -10_000, height: 0), index: index,
			viewport: viewport, contentHeight: 1000, trailingInset: inset)
		XCTAssertEqual(state.scrollX, live, accuracy: 1e-9)
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

	/// A young workspace is narrower than the usable width, so its live edge
	/// is negative. Zooming must re-solve into that range, not floor at 0:
	/// one ⌘- used to throw the leader card back to the far left, behind the
	/// navigator band.
	func testZoomKeepsANarrowSequenceAtTheLiveEdge() {
		let index = makeIndex([
			makeMission(id: "a", number: 1, age: 3600),
			makeMission(id: "b", number: 2, age: 60),
		])
		let inset: CGFloat = 450
		XCTAssertLessThan(index.contentWidth, viewport.width - inset)
		let state = SpineViewportState(pxPerHour: 48)
		state.jump(to: SpinePlacement.liveScrollX(
			index: index, viewport: viewport, trailingInset: inset))
		var current = index
		for step in [ZoomStep.zoomOut, .zoomIn, .zoomOut, .zoomOut] {
			state.zoom(
				step, index: current, viewport: viewport,
				trailingInset: inset)
			let respaced = current.respaced(
				pxPerHour: state.pxPerHour, maxPitch: state.maxPitch)
			current = respaced
			XCTAssertEqual(
				state.scrollX,
				SpinePlacement.liveScrollX(
					index: respaced, viewport: viewport,
					trailingInset: inset),
				accuracy: 1e-9)
			let leader = SpinePlacement.leaderRect(
				index: respaced, scrollX: state.scrollX, viewport: viewport,
				spineY: viewport.midY)
			XCTAssertEqual(
				leader.maxX, viewport.maxX - inset, accuracy: 1e-6,
				"the leader stays at Now through a zoom")
		}
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
		state.fit(index: index, viewport: viewport, trailingInset: 450)
		let fitted = index.respaced(
			pxPerHour: state.pxPerHour, maxPitch: state.maxPitch)
		let first = fitted.earliestOpen ?? 0
		// Fit ends right-aligned at the live edge, exactly where a Now jump
		// lands, with every open mission still in view.
		XCTAssertEqual(
			state.scrollX,
			SpinePlacement.liveScrollX(
				index: fitted, viewport: viewport, trailingInset: 450),
			accuracy: 1e-9)
		// The earliest open mission's LEFT EDGE, not its anchor: its card and
		// rows are centred on the anchor, so measuring the span from the
		// anchor left half the card off the window edge and Fit cut the
		// oldest open mission's number, name and state out of view.
		// And it clears that edge by `fitLeadingMargin`: solving for the exact
		// usable width put the widest node of the oldest open column (the
		// 220 pt agent row, wider than its 210 pt card) hard against the
		// viewport border, which reads as clipped.
		let left = fitted.x(first) - SpinePlacement.halfWidth(of: first, in: fitted)
		XCTAssertGreaterThanOrEqual(
			left - state.scrollX,
			SpineViewportState.fitLeadingMargin - 1e-6,
			"Fit leaves breathing room left of the oldest open column")
		XCTAssertLessThanOrEqual(
			fitted.contentWidth - state.scrollX, viewport.width - 450 + 1e-6)
		XCTAssertEqual(state.scrollY, 0)
	}

	/// The same with closed missions ahead of the earliest open one, the
	/// shape the seeded demo has: Fit still puts the whole of the oldest
	/// OPEN column on screen (10-desktop-spine T10.9 item 7).
	func testFitClearsTheLeftEdgeWithClosedMissionsInFront() {
		let missions = [
			makeMission(id: "a", number: 5, state: .closed, age: 30 * 3600),
			makeMission(id: "b", number: 4, age: 12 * 3600),
			makeMission(id: "c", number: 3, age: 6 * 3600),
			makeMission(id: "d", number: 1, age: 3 * 3600),
			makeMission(id: "e", number: 2, age: 1800),
		]
		let state = SpineViewportState(pxPerHour: 48)
		let index = makeIndex(missions)
		state.fit(index: index, viewport: viewport, trailingInset: 450)
		let fitted = index.respaced(
			pxPerHour: state.pxPerHour, maxPitch: state.maxPitch)
		let first = try? XCTUnwrap(fitted.earliestOpen)
		let position = first ?? 0
		let placed = SpinePlacement.place(
			index: fitted,
			agents: [:], range: 0 ..< fitted.count, scrollX: state.scrollX,
			viewport: viewport)
		let column = placed.columns.first { $0.id == fitted.mission(position)?.id }
		XCTAssertGreaterThanOrEqual(
			column?.card.minX ?? -1,
			viewport.minX + SpineViewportState.fitLeadingMargin - 1e-6,
			"the oldest open mission's card is fully on screen after Fit, with a margin")
	}

	func testFitPansToNewestWhenOpenMissionsDoNotFit() {
		let missions = (0 ..< 200).map { k in
			makeMission(
				id: "m\(k)", number: k + 1, age: Double(200 - k) * 3600)
		}
		let state = SpineViewportState(pxPerHour: 48)
		let index = makeIndex(missions)
		state.fit(index: index, viewport: viewport, trailingInset: 450)
		XCTAssertEqual(state.pxPerHour, SpineViewportState.minPxPerHour)
		let floored = index.respaced(
			pxPerHour: state.pxPerHour, maxPitch: state.maxPitch)
		XCTAssertEqual(
			state.scrollX,
			SpinePlacement.liveScrollX(
				index: floored, viewport: viewport, trailingInset: 450),
			accuracy: 1e-6)
		XCTAssertGreaterThan(state.scrollX, 0)
	}

	/// Fit and a Now jump agree: both put the live edge on the canvas's
	/// usable right edge, so ⌘0 and the bar's Now control never disagree
	/// about where Now is.
	func testFitAndJumpToNowLandOnTheSameRightAlignment() {
		let missions = (0 ..< 12).map { k in
			makeMission(
				id: "m\(k)", number: k + 1, age: Double(12 - k) * 7200)
		}
		let index = makeIndex(missions)
		let inset: CGFloat = 450
		let state = SpineViewportState(pxPerHour: 48)
		state.fit(index: index, viewport: viewport, trailingInset: inset)
		let fitted = index.respaced(
			pxPerHour: state.pxPerHour, maxPitch: state.maxPitch)
		let now = NowState()
		now.jumpToNow(
			index: fitted, viewport: viewport, trailingInset: inset)
		let jump = now.consumeJump()
		XCTAssertNotNil(jump)
		XCTAssertEqual(state.scrollX, jump ?? .nan, accuracy: 1e-9)
		let leader = SpinePlacement.leaderRect(
			index: fitted, scrollX: state.scrollX, viewport: viewport,
			spineY: viewport.midY)
		XCTAssertEqual(
			leader.maxX, viewport.maxX - inset, accuracy: 1e-6)
	}
}
