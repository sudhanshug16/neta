import AppKit
import CoreGraphics
import Foundation
import SwiftUI
import XCTest

@testable import NetaDesktop

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

/// T10.8 contract: the Now label and live edge, jump staging and clearing,
/// the off-screen leader flip, pan moving time but never metrics, vertical
/// pan clamping scroll only, zoom holding the cursor time, and Fit showing
/// the earliest open mission.
@MainActor
final class NowStateTests: XCTestCase {
	private let viewport = CGRect(x: 0, y: 0, width: 1600, height: 1000)

	/// The leader card as T10.9 places it: centred on wall-clock `now`
	/// mapped through the lens (which trails wall time after a pan).
	private func leaderRect(_ lens: TimeLens) -> CGRect {
		let x = CGFloat(lens.x(nowMs))
		return CGRect(x: x - 105, y: 463, width: 210, height: 74)
	}

	// MARK: - Live edge

	func testLitAtLiveEdge() {
		let state = NowState()
		let lens = lens()
		state.update(
			lens: lens, viewport: viewport, leader: leaderRect(lens),
			now: now)
		XCTAssertTrue(state.isLive)
		XCTAssertEqual(state.label, "Now")
	}

	func testLitAtHalfPixelOvershoot() {
		let state = NowState()
		let lens = lens()
		// Live edge half a point past the viewport edge still counts.
		let atGrace = CGRect(x: -0.5, y: 0, width: 1600, height: 1000)
		state.update(
			lens: lens, viewport: atGrace, leader: leaderRect(lens),
			now: now)
		XCTAssertTrue(state.isLive)
		XCTAssertEqual(state.label, "Now")
		// Past the grace the view is back in time.
		let pastGrace = CGRect(x: -0.6, y: 0, width: 1600, height: 1000)
		state.update(
			lens: lens, viewport: pastGrace, leader: leaderRect(lens),
			now: now)
		XCTAssertFalse(state.isLive)
		XCTAssertTrue(state.label.hasPrefix("Now · "))
		XCTAssertTrue(state.label.hasSuffix(" back"))
	}

	func testBackLabelInDaysAndHours() {
		let state = NowState()
		let wide = TimeLens(TimeLensOptions(
			now: nowMs,
			focusStart: nowMs - 7 * 24 * 3_600_000,
			focusEnd: nowMs,
			width: 1600,
			minPxPerHour: 8))
		let threeDays = CGFloat(wide.x(nowMs - 3 * 24 * 3_600_000))
		state.update(
			lens: wide,
			viewport: CGRect(
				x: threeDays - 1600, y: 0, width: 1600, height: 1000),
			leader: leaderRect(wide), now: now)
		XCTAssertFalse(state.isLive)
		XCTAssertEqual(state.label, "Now · 3d back")

		let fiveHours = CGFloat(wide.x(nowMs - 5 * 3_600_000))
		state.update(
			lens: wide,
			viewport: CGRect(
				x: fiveHours - 1600, y: 0, width: 1600, height: 1000),
			leader: leaderRect(wide), now: now)
		XCTAssertFalse(state.isLive)
		XCTAssertEqual(state.label, "Now · 5h back")
	}

	// MARK: - Jump

	func testConsumeJumpClearsRequest() {
		let state = NowState()
		XCTAssertNil(state.consumeJump())
		state.jumpToNow(lens: lens(), viewport: viewport, now: now)
		let jumped = state.consumeJump()
		XCTAssertNotNil(jumped)
		XCTAssertNil(state.consumeJump())
	}

	func testJumpToNowReanchorsLiveEdgeKeepingDuration() {
		let state = NowState()
		let viewportState = SpineViewportState(lens: lens())
		// Pan back: the view leaves the live edge...
		viewportState.pan(
			by: CGSize(width: 800, height: 0), viewport: viewport,
			contentHeight: 1000)
		state.update(
			lens: viewportState.lens, viewport: viewport,
			leader: leaderRect(viewportState.lens), now: now)
		XCTAssertFalse(state.isLive)
		XCTAssertTrue(state.leaderOffScreen)
		// ...and jumping returns exactly to the pre-pan lens: the live
		// edge sits at the viewport edge with the focus duration kept.
		state.jumpToNow(
			lens: viewportState.lens, viewport: viewport, now: now)
		let jumped = state.consumeJump()
		XCTAssertNotNil(jumped)
		XCTAssertEqual(jumped, lens())
		XCTAssertEqual(
			jumped!.t(Double(viewport.maxX)), nowMs, accuracy: 1.0)
		XCTAssertEqual(
			jumped!.x(nowMs), Double(viewport.maxX), accuracy: 1e-9)
		state.update(
			lens: jumped!, viewport: viewport,
			leader: leaderRect(jumped!), now: now)
		XCTAssertTrue(state.isLive)
		XCTAssertEqual(state.label, "Now")
		XCTAssertFalse(state.leaderOffScreen)
	}

	// MARK: - Leader marker

	func testLeaderOffScreenFlipsAtViewportEdge() {
		let state = NowState()
		let lens = lens()
		state.update(
			lens: lens, viewport: viewport, leader: leaderRect(lens),
			now: now)
		XCTAssertFalse(state.leaderOffScreen)

		// Leader fully past the left edge.
		let gone = CGRect(x: -500, y: 463, width: 210, height: 74)
		state.update(
			lens: lens, viewport: viewport, leader: gone, now: now)
		XCTAssertTrue(state.leaderOffScreen)

		// Touching the edge without overlapping is still off-screen.
		let touching = CGRect(
			x: viewport.minX - 210, y: 463, width: 210, height: 74)
		state.update(
			lens: lens, viewport: viewport, leader: touching, now: now)
		XCTAssertTrue(state.leaderOffScreen)

		// One point of overlap is on-screen.
		let overlap = CGRect(
			x: viewport.minX - 209, y: 463, width: 210, height: 74)
		state.update(
			lens: lens, viewport: viewport, leader: overlap, now: now)
		XCTAssertFalse(state.leaderOffScreen)
	}

	// MARK: - Pan

	func testHorizontalPanMovesTimeAndLeavesMetricsUntouched() {
		let state = SpineViewportState(lens: lens())
		let before = state.lens.t(Double(viewport.midX))
		state.pan(
			by: CGSize(width: 100, height: 0), viewport: viewport,
			contentHeight: 1000)
		let after = state.lens.t(Double(viewport.midX))
		XCTAssertNotEqual(after, before)
		XCTAssertEqual(SpineMetrics.standard, SpineMetrics())
	}

	func testVerticalPanChangesScrollOnlyAndClamps() {
		let state = SpineViewportState(lens: lens())
		let lensBefore = state.lens
		state.pan(
			by: CGSize(width: 0, height: 200), viewport: viewport,
			contentHeight: 2400)
		XCTAssertEqual(state.scrollY, 200)
		XCTAssertEqual(state.lens, lensBefore)

		// Clamps to the bottom.
		state.pan(
			by: CGSize(width: 0, height: 5000), viewport: viewport,
			contentHeight: 2400)
		XCTAssertEqual(state.scrollY, 1400)
		XCTAssertEqual(state.lens, lensBefore)

		// Clamps to the top.
		state.pan(
			by: CGSize(width: 0, height: -5000), viewport: viewport,
			contentHeight: 2400)
		XCTAssertEqual(state.scrollY, 0)
		XCTAssertEqual(state.lens, lensBefore)
	}

	// MARK: - Zoom and fit

	func testZoomHoldsCursorTime() {
		let state = SpineViewportState(lens: lens())
		// At the max clamp further zooms are exact no-ops: the time under
		// every cursor stays put within a millisecond.
		state.zoom(factor: 1e9, atCursorX: 800)
		for cursorX in [0.0, 400, 800, 1200, 1600] {
			let cursorT = state.lens.t(cursorX)
			state.zoom(factor: 2, atCursorX: cursorX)
			XCTAssertEqual(
				state.lens.t(cursorX), cursorT, accuracy: 1.0,
				"cursor time at x=\(cursorX)")
		}
	}

	func testKeyboardZoomStepsAboutViewportCentre() {
		let state = SpineViewportState(lens: lens())
		let span = state.lens.options.focusEnd - state.lens.options.focusStart
		state.zoom(.zoomIn, viewport: viewport)
		XCTAssertEqual(
			state.lens.options.focusEnd - state.lens.options.focusStart,
			span / 1.25, accuracy: 1.0)
		state.zoom(.zoomOut, viewport: viewport)
		XCTAssertEqual(
			state.lens.options.focusEnd - state.lens.options.focusStart,
			span, accuracy: 1.0)
	}

	func testFitShowsEarliestOpenAndResetsScroll() {
		let earliest = now.addingTimeInterval(-3 * 24 * 3600)
		let index = SpineIndex(missions: [
			makeMission(
				id: "closed-old", number: 1, state: .closed,
				createdAt: now.addingTimeInterval(-10 * 24 * 3600)),
			makeMission(
				id: "open-early", number: 2, state: .running,
				createdAt: earliest),
			makeMission(
				id: "open-late", number: 3, state: .blocked,
				createdAt: now.addingTimeInterval(-3600)),
		])
		let state = SpineViewportState(lens: lens())
		state.pan(
			by: CGSize(width: 0, height: 300), viewport: viewport,
			contentHeight: 2400)
		XCTAssertEqual(state.scrollY, 300)
		state.fit(index: index, viewport: viewport, now: now)
		XCTAssertEqual(state.scrollY, 0)
		let earliestMs = earliest.timeIntervalSince1970 * 1000
		XCTAssertGreaterThanOrEqual(state.lens.x(earliestMs), 0)
		XCTAssertEqual(
			state.lens.options.focusStart, earliestMs, accuracy: 1e-9)
		XCTAssertEqual(state.lens.options.focusEnd, nowMs, accuracy: 1e-9)
	}

	func testToggleExpanded() {
		let state = SpineViewportState(lens: lens())
		XCTAssertTrue(state.expanded.isEmpty)
		state.toggleExpanded("m1")
		XCTAssertEqual(state.expanded, ["m1"])
		state.toggleExpanded("m1")
		XCTAssertTrue(state.expanded.isEmpty)
	}

	// MARK: - Trackpad capture

	func testNonPreciseDeltasScaleByEighteen() {
		XCTAssertEqual(
			TrackpadPanCaptureView.scaledDelta(2, precise: true), 2)
		XCTAssertEqual(
			TrackpadPanCaptureView.scaledDelta(2, precise: false), 36)
		XCTAssertEqual(TrackpadPanCaptureView.nonPreciseScale, 18)
	}

	func testCaptureRectCarvesOutInteractionInsets() {
		let view = TrackpadPanCaptureView(
			frame: NSRect(x: 0, y: 0, width: 1600, height: 1000))
		let bounds = NSRect(x: 0, y: 0, width: 1600, height: 1000)
		let full = view.captureRect(in: bounds)
		XCTAssertEqual(full, bounds)
		view.configure(
			isEnabled: true,
			interactionInsets: NSEdgeInsets(
				top: 0, left: 0, bottom: 56, right: 426),
			onScroll: { _ in })
		XCTAssertEqual(
			view.captureRect(in: bounds),
			NSRect(x: 0, y: 56, width: 1174, height: 944))
	}

	// MARK: - Helpers

	private func makeMission(
		id: String, number: Int, state: MissionState, createdAt: Date
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
}
