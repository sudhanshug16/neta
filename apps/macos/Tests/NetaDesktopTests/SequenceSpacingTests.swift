import CoreGraphics
import Foundation
import XCTest

@testable import NetaDesktop

/// T10.1 contract: the pure sequence gap rule.
@MainActor
final class SequenceSpacingTests: XCTestCase {
	private let hourMs = 3_600_000.0

	private func mission(
		_ id: String, hoursAgo: Double, number: Int? = nil
	) -> SpineItem {
		.mission(
			id: id, at: -hoursAgo * hourMs,
			number: number ?? Int(id.dropFirst()) ?? 0)
	}

	// MARK: - Shape

	func testXStrictlyIncreasing() {
		let items: [SpineItem] = [
			mission("m1", hoursAgo: 500),
			.checkpoint(eventSeq: 3, at: -100 * hourMs),
			mission("m2", hoursAgo: 100),
			.checkpoint(eventSeq: 9, at: -hourMs),
			mission("m3", hoursAgo: 0),
		]
		let xs = SequenceSpacing.spacing(items: items, pxPerHour: 48)
		XCTAssertEqual(xs.count, 5)
		XCTAssertEqual(xs[0], 0)
		for i in 1 ..< xs.count {
			XCTAssertGreaterThan(xs[i], xs[i - 1])
		}
	}

	func testEmptyAndSingle() {
		XCTAssertEqual(
			SequenceSpacing.spacing(items: [], pxPerHour: 48), [])
		XCTAssertEqual(
			SequenceSpacing.spacing(
				items: [mission("m1", hoursAgo: 0)], pxPerHour: 48),
			[0])
	}

	// MARK: - Clamp rule

	func testMinuteApartSitsExactlyMinPitch() {
		let xs = SequenceSpacing.spacing(
			items: [
				mission("m1", hoursAgo: 1 / 60),
				mission("m2", hoursAgo: 0),
			],
			pxPerHour: 48)
		XCTAssertEqual(xs, [0, 120])
	}

	/// Revision 4 rests the 120 pt minimum column on alternation
	/// ("Neighbours alternate sides, so 120 px never overlaps 220 px
	/// cards"), and the side is a pure function of the permanent number, so
	/// two neighbours share a side whenever the numbers do not run in time
	/// order. At 120 pt their 210 pt cards and 220 pt stacks draw through
	/// each other — the fix-pass render showed exactly that, an agent row of
	/// one column cutting the state label off its neighbour.
	func testSameSideNeighboursGetTheWiderColumn() {
		let sameSide = SequenceSpacing.spacing(
			items: [
				mission("m3", hoursAgo: 1 / 60, number: 3),
				mission("m1", hoursAgo: 0, number: 1),
			],
			pxPerHour: 48)
		XCTAssertEqual(sameSide, [0, SequenceSpacing.defaultSameSidePitch])
		XCTAssertGreaterThanOrEqual(
			SequenceSpacing.defaultSameSidePitch,
			SpineMetrics.standard.agentRowWidth,
			"wider than the widest node, so neither stack reaches the other")

		let alternating = SequenceSpacing.spacing(
			items: [
				mission("m2", hoursAgo: 1 / 60, number: 2),
				mission("m1", hoursAgo: 0, number: 1),
			],
			pxPerHour: 48)
		XCTAssertEqual(alternating, [0, 120], "ordinary sequences are untouched")

		// A checkpoint run between two same-side missions widens to the same
		// floor, not to the alternating one.
		let withCheckpoints = SequenceSpacing.spacing(
			items: [
				mission("m3", hoursAgo: 1 / 60, number: 3),
				.checkpoint(eventSeq: 1, at: -0.9 / 60 * 3_600_000),
				mission("m1", hoursAgo: 0, number: 1),
			],
			pxPerHour: 48)
		XCTAssertEqual(
			withCheckpoints[2], SequenceSpacing.defaultSameSidePitch)
	}

	/// The same-side floor is not a default-zoom luxury: `maxPitch` scales
	/// with zoom (`SpineViewportState.maxPitch(for:)`) and floors at the
	/// 120 pt minimum column, so two zoom-outs put it at 204.8 — below the
	/// 230 pt same-side pitch. Clamping the cap after the floor emitted
	/// 204.8 for a same-side pair and drew 220 pt agent rows 15 pt through
	/// each other. The floor wins.
	func testTheSameSideFloorSurvivesAMaxPitchBelowIt() {
		let floor = SequenceSpacing.defaultSameSidePitch
		// 64% time zoom: pxPerHour 30.72, maxPitch 320 * 0.64.
		for maxPitch in [204.8 as CGFloat, SpineViewportState.minPitch, 60] {
			let sameSide = SequenceSpacing.spacing(
				items: [
					mission("m3", hoursAgo: 6, number: 3),
					mission("m1", hoursAgo: 3, number: 1),
				],
				pxPerHour: 30.72, maxPitch: maxPitch)
			XCTAssertEqual(
				sameSide, [0, floor],
				"the same-side floor holds at maxPitch \(maxPitch)")
			// Alternating neighbours still collapse to the minimum column.
			let alternating = SequenceSpacing.spacing(
				items: [
					mission("m2", hoursAgo: 6, number: 2),
					mission("m1", hoursAgo: 3, number: 1),
				],
				pxPerHour: 30.72, maxPitch: maxPitch)
			XCTAssertEqual(alternating, [0, 120])
		}
	}

	/// `SpineViewportState.maxPitch(for:)` really does go under the same-side
	/// floor at the zoom two ⌘- presses reach, which is what made the clamp
	/// order load-bearing.
	func testTwoZoomOutsPutMaxPitchUnderTheSameSideFloor() {
		let zoomed = SpineViewportState.defaultPxPerHour * 0.8 * 0.8
		XCTAssertLessThan(
			SpineViewportState.maxPitch(for: zoomed),
			SequenceSpacing.defaultSameSidePitch)
	}

	func testThreeWeeksApartSitsExactlyMaxPitch() {
		let xs = SequenceSpacing.spacing(
			items: [
				mission("m1", hoursAgo: 3 * 7 * 24),
				mission("m2", hoursAgo: 0),
			],
			pxPerHour: 48)
		XCTAssertEqual(xs, [0, 320])
	}

	func testMidRangeIsExactlyElapsedTimesPxPerHour() {
		// 4 h at 48 px/h = 192, inside [120, 320].
		let xs = SequenceSpacing.spacing(
			items: [
				mission("m1", hoursAgo: 4),
				mission("m2", hoursAgo: 0),
			],
			pxPerHour: 48)
		XCTAssertEqual(xs, [0, 192])
	}

	// MARK: - Checkpoint runs

	func testGapHoldingFourCheckpoints() {
		let items: [SpineItem] = [
			mission("m1", hoursAgo: 1 / 60),
			.checkpoint(eventSeq: 1, at: -30_000),
			.checkpoint(eventSeq: 2, at: -25_000),
			.checkpoint(eventSeq: 3, at: -20_000),
			.checkpoint(eventSeq: 4, at: -10_000),
			mission("m2", hoursAgo: 0),
		]
		let xs = SequenceSpacing.spacing(items: items, pxPerHour: 48)
		XCTAssertGreaterThanOrEqual(xs.last! - xs.first!, 28 * 5)
		for i in 1 ..< xs.count {
			XCTAssertGreaterThanOrEqual(xs[i] - xs[i - 1], 28)
		}
	}

	func testNeighbouringMissionsAlwaysAtLeastMinPitchApart() {
		// One checkpoint between two missions a minute apart: the raw gaps
		// floor at 28 + 28 = 56, widened to 120.
		let xs = SequenceSpacing.spacing(
			items: [
				mission("m1", hoursAgo: 1 / 60),
				.checkpoint(eventSeq: 1, at: -30_000),
				mission("m2", hoursAgo: 0),
			],
			pxPerHour: 48)
		XCTAssertEqual(xs.count, 3)
		XCTAssertEqual(xs[0], 0)
		XCTAssertEqual(xs[2] - xs[0], 120, accuracy: 1e-9)
		XCTAssertEqual(xs[1] - xs[0], 60, accuracy: 1e-9)
	}

	func testCheckpointTieSortsBeforeMission() {
		let at = -hourMs
		let items: [SpineItem] = [
			.mission(id: "m1", at: at, number: 1),
			.checkpoint(eventSeq: 7, at: at),
			.checkpoint(eventSeq: 3, at: at),
		]
		let xs = SequenceSpacing.spacing(items: items, pxPerHour: 48)
		// Order is checkpoint 3, checkpoint 7, mission — but spacing
		// returns cumulative x in sorted order, so assert the shape: the
		// two checkpoint gaps floor at 28 and the mission sits past them.
		XCTAssertEqual(xs, [0, 28, 56])
	}

	// MARK: - Stability

	func testAppendingNeverMovesExistingItems() {
		let first: [SpineItem] = [
			mission("m1", hoursAgo: 10),
			mission("m2", hoursAgo: 5),
		]
		let before = SequenceSpacing.spacing(items: first, pxPerHour: 48)
		let after = SequenceSpacing.spacing(
			items: first + [mission("m3", hoursAgo: 0)], pxPerHour: 48)
		XCTAssertEqual(Array(after.prefix(2)), before)
	}

	func testShufflesAgree() {
		var items: [SpineItem] = []
		for i in 0 ..< 30 {
			items.append(mission("m\(i)", hoursAgo: Double(i) * 7.3))
			if i % 3 == 0 {
				items.append(
					.checkpoint(
						eventSeq: i, at: -Double(i) * 7.3 * hourMs + 1_000))
			}
		}
		let expected = SequenceSpacing.spacing(items: items, pxPerHour: 48)
		var rng: UInt64 = 0x1234_5678_9ABC_DEF1
		for _ in 0 ..< 100 {
			var shuffled = items
			for i in stride(from: shuffled.count - 1, through: 1, by: -1) {
				rng = rng &* 0xBF58_476D_1CE4_E5B9 &+ 0x9E37_79B9_7F4A_7C15
				shuffled.swapAt(i, Int(rng % UInt64(i + 1)))
			}
			XCTAssertEqual(
				SequenceSpacing.spacing(items: shuffled, pxPerHour: 48),
				expected)
		}
	}
}
