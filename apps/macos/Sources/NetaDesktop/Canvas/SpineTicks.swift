import CoreGraphics
import Foundation

/// An age label on the spine: which age it names, when that age is, and
/// where it sits in content x.
public struct SpineTick: Sendable, Equatable, Identifiable {
	public let id: String
	public let label: String
	public let at: Double
	public let x: CGFloat

	public init(id: String, label: String, at: Double, x: CGFloat) {
		self.id = id
		self.label = label
		self.at = at
		self.x = x
	}
}

/// The age labels (T10.4, PAPER-SPINE Revision 4).
///
/// Every label but `now` names an age before `now`; each sits proportionally
/// by time inside the one gap bracketing its age. Labels annotate only:
/// nothing in the placement depends on them. Layout is pure: no `Store`, no
/// bare `Date()`, no SwiftUI state.
public enum SpineTicks {
	public static let labels = ["2w", "1w", "3d", "1d", "12h", "3h", "1h", "now"]

	private static let hourMs = 3_600_000.0
	static func ageMs(for label: String) -> Double {
		switch label {
		case "2w": return 14 * 24 * hourMs
		case "1w": return 7 * 24 * hourMs
		case "3d": return 3 * 24 * hourMs
		case "1d": return 24 * hourMs
		case "12h": return 12 * hourMs
		case "3h": return 3 * hourMs
		case "1h": return hourMs
		case "now": return 0
		default: return 0
		}
	}

	public static func place(
		index: SpineIndex, now: Double, minLabelGap: CGFloat = 24
	) -> [SpineTick] {
		guard index.count > 0 else { return [] }
		// Position every label, then drop collisions newest-first so a live
		// label (`now`, `1h`) always wins its pixel over stale ages pinned
		// to the first item. Returned oldest to newest.
		var positioned: [(label: String, at: Double, x: CGFloat)] = []
		positioned.reserveCapacity(labels.count)
		for label in labels {
			let age = label == "now" ? now : now - ageMs(for: label)
			positioned.append((label, age, x(index: index, t: age, now: now)))
		}
		var kept: [(label: String, at: Double, x: CGFloat)] = []
		for tick in positioned.reversed() {
			if let last = kept.last,
				abs(tick.x - last.x) < minLabelGap
			{
				continue
			}
			kept.append(tick)
		}
		return kept.reversed().map {
			SpineTick(id: $0.label, label: $0.label, at: $0.at, x: $0.x)
		}
	}

	/// Content x for time `t`: proportional by time inside the bracketing
	/// gap, pinned to `x(0)` when older than the first item and to the last
	/// item's x (the leader's) at or past `now`.
	static func x(index: SpineIndex, t: Double, now: Double) -> CGFloat {
		guard index.count > 0 else { return 0 }
		let last = index.count - 1
		if t >= now || t >= index[last].at { return index.x(last) }
		if t <= index[0].at { return index.x(0) }
		var lo = 0
		var hi = last
		while hi - lo > 1 {
			let mid = (lo + hi) / 2
			if index[mid].at <= t {
				lo = mid
			} else {
				hi = mid
			}
		}
		let t0 = index[lo].at
		let t1 = index[hi].at
		guard t1 > t0 else { return index.x(lo) }
		let fraction = (t - t0) / (t1 - t0)
		return index.x(lo) + fraction * (index.x(hi) - index.x(lo))
	}

	/// The time at content x, by the same proportional rule inverted:
	/// clamps to the first/last item's time outside the sequence. Powers the
	/// Now label and cursor-anchored zoom.
	static func time(index: SpineIndex, x: CGFloat, now: Double) -> Double {
		guard index.count > 0 else { return now }
		let last = index.count - 1
		if x <= index.x(0) { return index[0].at }
		if x >= index.x(last) { return min(now, index[last].at) }
		var lo = 0
		var hi = last
		while hi - lo > 1 {
			let mid = (lo + hi) / 2
			if index.x(mid) <= x {
				lo = mid
			} else {
				hi = mid
			}
		}
		let x0 = index.x(lo)
		let x1 = index.x(hi)
		guard x1 > x0 else { return index[lo].at }
		let fraction = (x - x0) / (x1 - x0)
		return index[lo].at + fraction * (index[hi].at - index[lo].at)
	}
}
