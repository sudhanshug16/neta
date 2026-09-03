import Foundation
import XCTest

@testable import NetaDesktop

private struct LensFixtureCase: Decodable {
	struct Opts: Decodable {
		let now: Double
		let focusStart: Double
		let focusEnd: Double
		let width: Double
		let minPxPerHour: Double
	}
	struct Sample: Decodable {
		let t: Double
		let x: Double
	}
	let opts: Opts
	let samples: [Sample]
}

private func lensFixtureCases() throws -> [LensFixtureCase] {
	// test/fixtures/lens-cases.json lives five levels up from this file:
	// TimeLensTests.swift -> NetaDesktopTests -> Tests -> macos -> apps -> repo root.
	var url = URL(fileURLWithPath: #filePath, isDirectory: false)
	for _ in 0..<5 { url.deleteLastPathComponent() }
	url.appendPathComponent("test/fixtures/lens-cases.json")
	let data = try Data(contentsOf: url)
	return try JSONDecoder().decode([LensFixtureCase].self, from: data)
}

private func makeLens(_ opts: LensFixtureCase.Opts) -> TimeLens {
	TimeLens(TimeLensOptions(
		now: opts.now,
		focusStart: opts.focusStart,
		focusEnd: opts.focusEnd,
		width: opts.width,
		minPxPerHour: opts.minPxPerHour
	))
}

final class TimeLensTests: XCTestCase {
	func testFixtureSamplesWithinPointTolerance() throws {
		let cases = try lensFixtureCases()
		XCTAssertFalse(cases.isEmpty)
		for c in cases {
			let lens = makeLens(c.opts)
			for s in c.samples {
				XCTAssertEqual(lens.x(s.t), s.x, accuracy: 0.001, "x(\(s.t)) with \(c.opts)")
			}
		}
	}

	func testRoundTripWithinOneMillisecond() throws {
		let cases = try lensFixtureCases()
		for c in cases {
			let lens = makeLens(c.opts)
			var times = c.samples.map(\.t)
			times.append(contentsOf: [
				c.opts.now + 3_600_000,
				c.opts.focusStart - 1_000_000_000,
				c.opts.focusEnd + 1_000_000_000,
			])
			for t in times {
				XCTAssertEqual(lens.t(lens.x(t)), t, accuracy: 1.0, "t(x(\(t)))")
			}
			// Pixel sweep stays invertible too.
			var xPos = -500.0
			while xPos <= c.opts.width + 500 {
				XCTAssertEqual(lens.x(lens.t(xPos)), xPos, accuracy: 1e-6, "x(t(\(xPos)))")
				xPos += 137
			}
		}
	}

	func testXIsMonotonic() throws {
		let cases = try lensFixtureCases()
		for c in cases {
			let lens = makeLens(c.opts)
			let times = c.samples.map(\.t).sorted()
			let xs = times.map(lens.x)
			for i in 1..<xs.count {
				XCTAssertGreaterThan(xs[i], xs[i - 1], "monotonic at \(times[i])")
			}
		}
	}

	func testLinearInsideFocusWindow() throws {
		let now = 1_787_712_000_000.0
		let lens = TimeLens(TimeLensOptions(
			now: now, focusStart: now - 24 * 3_600_000, focusEnd: now, width: 1600, minPxPerHour: 8))
		XCTAssertEqual(lens.x(now), 1600, accuracy: 1e-9)
		let a = now - 20 * 3_600_000
		let b = now - 10 * 3_600_000
		let c = now - 5 * 3_600_000
		XCTAssertEqual(lens.x(b) - lens.x(a), 2 * (lens.x(c) - lens.x(b)), accuracy: 1e-9)
	}

	func testTicksLieInsideWidthWithNowLast() {
		let now = 1_787_712_000_000.0
		let lens = TimeLens(TimeLensOptions(
			now: now, focusStart: now - 30 * 24 * 3_600_000, focusEnd: now, width: 1600, minPxPerHour: 4))
		let ticks = lens.ticks()
		XCTAssertFalse(ticks.isEmpty)
		let known: Set<String> = ["now", "1h", "3h", "12h", "1d", "3d", "1w", "2w"]
		for tick in ticks {
			XCTAssertTrue(known.contains(tick.label), "unexpected label \(tick.label)")
			let pos = lens.x(tick.t)
			XCTAssertGreaterThanOrEqual(pos, 0)
			XCTAssertLessThanOrEqual(pos, 1600)
		}
		XCTAssertEqual(ticks.last?.label, "now")
	}

	func testZoomedDividesDurationAboutCursor() {
		let now = 1_787_712_000_000.0
		let base = TimeLens(TimeLensOptions(
			now: now, focusStart: now - 24 * 3_600_000, focusEnd: now, width: 1600, minPxPerHour: 8))
		let oldSpan = base.options.focusEnd - base.options.focusStart
		let zoomed = base.zoomed(factor: 2, aroundX: 800)
		let newSpan = zoomed.options.focusEnd - zoomed.options.focusStart
		XCTAssertEqual(newSpan, oldSpan / 2, accuracy: 1.0)
		let oldRate = base.options.width / (oldSpan / 3_600_000)
		let newRate = zoomed.options.width / (newSpan / 3_600_000)
		XCTAssertEqual(newRate, oldRate * 2, accuracy: 1e-9)
		// Cursor time keeps its fractional position in the window.
		let cursorT = base.t(800)
		let oldFraction = (cursorT - base.options.focusStart) / oldSpan
		let newFraction = (cursorT - zoomed.options.focusStart) / newSpan
		XCTAssertEqual(newFraction, oldFraction, accuracy: 1e-9)
	}

	func testZoomedHoldsCursorTimeUnderMaxClamp() {
		let now = 1_787_712_000_000.0
		let base = TimeLens(TimeLensOptions(
			now: now, focusStart: now - 24 * 3_600_000, focusEnd: now, width: 1600, minPxPerHour: 8))
		let deep = base.zoomed(factor: 1e9, aroundX: 800)
		let deepSpan = deep.options.focusEnd - deep.options.focusStart
		XCTAssertEqual(deep.options.width / (deepSpan / 3_600_000), TimeLens.maxPxPerHour, accuracy: 1e-9)
		for aroundX in [0.0, 400, 800, 1200, 1600] {
			let cursorT = deep.t(aroundX)
			let again = deep.zoomed(factor: 37, aroundX: aroundX)
			XCTAssertEqual(again.t(aroundX), cursorT, accuracy: 1.0, "cursor time at x=\(aroundX)")
		}
	}

	func testZoomedHoldsCursorTimeUnderMinClamp() {
		let now = 1_787_712_000_000.0
		// 200 h at 1600 pt sits exactly on the 8 px/h floor.
		let wide = TimeLens(TimeLensOptions(
			now: now, focusStart: now - 200 * 3_600_000, focusEnd: now, width: 1600, minPxPerHour: 8))
		let wideSpan = wide.options.focusEnd - wide.options.focusStart
		XCTAssertEqual(wide.options.width / (wideSpan / 3_600_000), 8, accuracy: 1e-9)
		for aroundX in [0.0, 400, 800, 1200, 1600] {
			let cursorT = wide.t(aroundX)
			let again = wide.zoomed(factor: 0.01, aroundX: aroundX)
			let againSpan = again.options.focusEnd - again.options.focusStart
			XCTAssertEqual(again.options.width / (againSpan / 3_600_000), 8, accuracy: 1e-9)
			XCTAssertEqual(again.t(aroundX), cursorT, accuracy: 1.0, "cursor time at x=\(aroundX)")
		}
	}

	func testZoomedStaysMonotonicAndInvertible() {
		let now = 1_787_712_000_000.0
		let base = TimeLens(TimeLensOptions(
			now: now, focusStart: now - 24 * 3_600_000, focusEnd: now, width: 1600, minPxPerHour: 8))
		for (factor, aroundX) in [(4.0, 200.0), (0.25, 1400.0), (1e9, 800.0), (1e-9, 800.0)] {
			let lens = base.zoomed(factor: factor, aroundX: aroundX)
			let times = [now - 400 * 3_600_000, now - 3_600_000, now, now + 3_600_000]
			let xs = times.map(lens.x)
			for i in 1..<xs.count { XCTAssertGreaterThan(xs[i], xs[i - 1]) }
			for t in times { XCTAssertEqual(lens.t(lens.x(t)), t, accuracy: 1.0) }
		}
	}

	func testFittedAnchorsEarliestOpen() {
		let now = 1_787_712_000_000.0
		let base = TimeLens(TimeLensOptions(
			now: now, focusStart: now - 24 * 3_600_000, focusEnd: now, width: 1600, minPxPerHour: 8))
		let earliest = now - 3 * 3_600_000
		let fitted = base.fitted(earliestOpen: earliest, now: now)
		XCTAssertEqual(fitted.options.focusStart, earliest, accuracy: 1e-9)
		XCTAssertEqual(fitted.options.focusEnd, now, accuracy: 1e-9)
		XCTAssertEqual(fitted.x(now), fitted.options.width, accuracy: 1e-9)
		XCTAssertGreaterThanOrEqual(fitted.x(earliest), 0)
	}

	func testFittedDefaultsToOneHourBack() {
		let now = 1_787_712_000_000.0
		let base = TimeLens(TimeLensOptions(
			now: now - 24 * 3_600_000, focusStart: now - 48 * 3_600_000,
			focusEnd: now - 24 * 3_600_000, width: 1600, minPxPerHour: 8))
		let fitted = base.fitted(earliestOpen: nil, now: now)
		XCTAssertEqual(fitted.options.focusStart, now - 3_600_000, accuracy: 1e-9)
		XCTAssertEqual(fitted.options.focusEnd, now, accuracy: 1e-9)
		XCTAssertEqual(fitted.options.now, now, accuracy: 1e-9)
		XCTAssertGreaterThanOrEqual(fitted.x(fitted.options.focusStart), 0)
	}
}
