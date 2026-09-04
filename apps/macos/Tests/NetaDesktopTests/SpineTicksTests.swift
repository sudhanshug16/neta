import CoreGraphics
import Foundation
import XCTest

@testable import NetaDesktop

/// T10.4 contract: proportional age labels with collision drops.
final class SpineTicksTests: XCTestCase {
	private let hourMs = 3_600_000.0
	private var nowMs: Double {
		Date(timeIntervalSince1970: 1_787_712_000).timeIntervalSince1970 * 1000
	}

	private func makeMission(
		id: String, number: Int, at ms: Double
	) -> Mission {
		Mission(
			id: id, number: number,
			workspaceId: "w1", machineId: "m1",
			name: "mission \(number)", objective: "Objective.", changes: [],
			lead: .leader, agentIds: [], access: .readOnly, worktree: nil,
			state: .running, attention: nil,
			createdAt: Date(timeIntervalSince1970: ms / 1000),
			closedAt: nil, disposition: nil, closeReason: nil,
			integration: nil, continuesMissionId: nil)
	}

	private func monthIndex() -> SpineIndex {
		// Items spread across a month: ages 30d, 14d, 7d, 3d, 1d, 12h, 1h, now.
		let agesDays: [Double] = [30.0, 14, 7, 3, 1, 0.5, 1.0 / 24.0, 0]
		let missions = agesDays.enumerated().map { (k, days) in
			makeMission(
				id: "m\(k)", number: k + 1, at: nowMs - days * 24 * hourMs)
		}
		return SpineIndex(
			missions: missions, pxPerHour: 48, maxPitch: 320)
	}

	// MARK: - Placement

	func testLabelsLandInTheirBracketingGapInOrder() {
		let index = monthIndex()
		let ticks = SpineTicks.place(index: index, now: nowMs)
		XCTAssertEqual(ticks.map(\.label), SpineTicks.labels)
		let xs = ticks.map(\.x)
		for i in 1 ..< xs.count {
			XCTAssertGreaterThan(xs[i], xs[i - 1])
		}
		// Each label sits inside the gap bracketing its age.
		for tick in ticks {
			let t = tick.at
			if tick.label == "now" {
				XCTAssertEqual(tick.x, index.x(index.count - 1))
				continue
			}
			var lo = 0
			while lo + 1 < index.count && index[lo + 1].at <= t { lo += 1 }
			if index[lo].at >= t {
				XCTAssertEqual(tick.x, index.x(lo), accuracy: 1e-6)
			} else if lo + 1 < index.count {
				XCTAssertGreaterThanOrEqual(tick.x, index.x(lo))
				XCTAssertLessThanOrEqual(tick.x, index.x(lo + 1))
			} else {
				XCTAssertEqual(
					tick.x, index.x(index.count - 1), accuracy: 1e-6)
			}
		}
	}

	func testLabelOnAnItemSitsExactlyOnIt() throws {
		// An item exactly 1h old: the 1h label lands exactly on its x.
		let missions = [
			makeMission(id: "old", number: 1, at: nowMs - 3 * hourMs),
			makeMission(id: "hour", number: 2, at: nowMs - hourMs),
			makeMission(id: "new", number: 3, at: nowMs),
		]
		let index = SpineIndex(
			missions: missions, pxPerHour: 48, maxPitch: 320)
		let ticks = SpineTicks.place(index: index, now: nowMs)
		let oneHour = try XCTUnwrap(ticks.first { $0.label == "1h" })
		XCTAssertEqual(oneHour.x, index.x(1), accuracy: 1e-9)
	}

	func testCrowdedHourKeepsOnly1hAndNow() {
		let missions = [
			makeMission(id: "a", number: 1, at: nowMs - 50 * 60_000),
			makeMission(id: "b", number: 2, at: nowMs - 30 * 60_000),
			makeMission(id: "c", number: 3, at: nowMs - 10 * 60_000),
		]
		let index = SpineIndex(
			missions: missions, pxPerHour: 48, maxPitch: 320)
		let ticks = SpineTicks.place(index: index, now: nowMs)
		XCTAssertEqual(ticks.map(\.label), ["1h", "now"])
	}

	func testEmptyIndexHasNoLabels() {
		XCTAssertEqual(
			SpineTicks.place(
				index: SpineIndex(
					missions: [], pxPerHour: 48, maxPitch: 320),
				now: nowMs),
			[])
	}

	// MARK: - Determinism

	func testShufflesAgree() {
		let missions = (0 ..< 20).map { k in
			makeMission(
				id: "m\(k)", number: k + 1,
				at: nowMs - Double(k * k) * hourMs)
		}
		let expected = SpineTicks.place(
			index: SpineIndex(
				missions: missions, pxPerHour: 48, maxPitch: 320),
			now: nowMs)
		var rng: UInt64 = 0xABCD_EF01_2345_6789
		for _ in 0 ..< 100 {
			var shuffled = missions
			for i in stride(from: shuffled.count - 1, through: 1, by: -1) {
				rng = rng &* 0xBF58_476D_1CE4_E5B9 &+ 0x9E37_79B9_7F4A_7C15
				shuffled.swapAt(i, Int(rng % UInt64(i + 1)))
			}
			XCTAssertEqual(
				SpineTicks.place(
					index: SpineIndex(
						missions: shuffled, pxPerHour: 48,
						maxPitch: 320),
					now: nowMs),
				expected)
		}
	}
}
