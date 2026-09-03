import Foundation

/// Swift port of `src/core/lens.ts`: linear inside the focus window,
/// logarithmically compressed outside it on both sides.
///
/// Coordinates: `x(now) == width`, so the leader sits at the live right edge.
/// Time runs in epoch milliseconds, space in points. Layout is pure: no
/// `Store`, no bare `Date()`, no SwiftUI state.
public struct TimeLensOptions: Sendable, Equatable, Codable {
	public var now, focusStart, focusEnd: Double
	public var width, minPxPerHour: Double

	public init(now: Double, focusStart: Double, focusEnd: Double, width: Double, minPxPerHour: Double) {
		self.now = now
		self.focusStart = focusStart
		self.focusEnd = focusEnd
		self.width = width
		self.minPxPerHour = minPxPerHour
	}
}

public struct TimeTick: Sendable, Equatable {
	public let t: Double
	public let label: String

	public init(t: Double, label: String) {
		self.t = t
		self.label = label
	}
}

public struct TimeLens: Sendable, Equatable {
	public static let maxPxPerHour: Double = 4096

	private static let msPerHour: Double = 3_600_000

	/// Manifesto tick labels, newest last.
	private static let tickSteps: [(label: String, back: Double)] = [
		("4w", 28 * 24 * msPerHour),
		("2w", 14 * 24 * msPerHour),
		("1w", 7 * 24 * msPerHour),
		("3d", 3 * 24 * msPerHour),
		("1d", 24 * msPerHour),
		("12h", 12 * msPerHour),
		("3h", 3 * msPerHour),
		("1h", msPerHour),
	]

	public private(set) var options: TimeLensOptions

	public init(_ options: TimeLensOptions) {
		self.options = options
	}

	private var span: Double {
		max(options.focusEnd - options.focusStart, 1)
	}

	private var pxPerMs: Double {
		max(options.minPxPerHour / Self.msPerHour, options.width / span)
	}

	private var startX: Double {
		options.width - (options.now - options.focusStart) * pxPerMs
	}

	private var endX: Double {
		options.width - (options.now - options.focusEnd) * pxPerMs
	}

	private var unit: Double {
		pxPerMs * Self.msPerHour
	}

	public func x(_ t: Double) -> Double {
		if t >= options.focusStart && t <= options.focusEnd {
			return options.width - (options.now - t) * pxPerMs
		}
		if t < options.focusStart {
			return startX - unit * log1p((options.focusStart - t) / Self.msPerHour)
		}
		return endX + unit * log1p((t - options.focusEnd) / Self.msPerHour)
	}

	public func t(_ xPos: Double) -> Double {
		if xPos >= startX && xPos <= endX {
			return options.now - (options.width - xPos) / pxPerMs
		}
		if xPos < startX {
			return options.focusStart - expm1((startX - xPos) / unit) * Self.msPerHour
		}
		return options.focusEnd + expm1((xPos - endX) / unit) * Self.msPerHour
	}

	public func ticks() -> [TimeTick] {
		var out: [TimeTick] = []
		for step in Self.tickSteps {
			let at = options.now - step.back
			let pos = x(at)
			if pos >= 0 && pos <= options.width {
				out.append(TimeTick(t: at, label: step.label))
			}
		}
		if options.width >= 0 {
			out.append(TimeTick(t: options.now, label: "now"))
		}
		return out
	}

	/// Divides the focus duration by `factor` about `t(aroundX)`, holding
	/// `x(t(aroundX))` fixed, then clamps `width / focusHours` into
	/// `[minPxPerHour, maxPxPerHour]`.
	///
	/// The cursor time keeps its fractional position in the window, so once a
	/// clamp pins the span, further zooms in the same direction are exact
	/// no-ops and the time under the cursor never moves.
	public func zoomed(factor: Double, aroundX: Double) -> TimeLens {
		guard factor.isFinite, factor > 0, aroundX.isFinite else { return self }
		let oldSpan = span
		let cursorT = t(aroundX)
		let requestedSpan = max(oldSpan / factor, 1)
		var pxPerHour = options.width / (requestedSpan / Self.msPerHour)
		pxPerHour = min(max(pxPerHour, options.minPxPerHour), Self.maxPxPerHour)
		guard pxPerHour > 0 else { return self }
		let newSpan = max(options.width * Self.msPerHour / pxPerHour, 1)
		let fraction = (cursorT - options.focusStart) / oldSpan
		let newStart = cursorT - fraction * newSpan
		return TimeLens(TimeLensOptions(
			now: options.now,
			focusStart: newStart,
			focusEnd: newStart + newSpan,
			width: options.width,
			minPxPerHour: options.minPxPerHour
		))
	}

	/// Sets `focusStart` to `earliestOpen` (or one hour before `now`) and
	/// `focusEnd` to `now`.
	public func fitted(earliestOpen: Double?, now: Double) -> TimeLens {
		var next = options
		next.now = now
		next.focusStart = earliestOpen ?? (now - Self.msPerHour)
		next.focusEnd = now
		return TimeLens(next)
	}
}
