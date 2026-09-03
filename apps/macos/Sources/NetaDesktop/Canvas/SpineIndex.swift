import Foundation

/// Time-ordered mission index backing the spine canvas (T10.3).
///
/// Missions are sorted by `createdAt` then `number` (`id` breaks exact ties
/// so the order is total and deterministic across runs). Times are epoch
/// milliseconds to match `TimeLens`. Layout is pure: no `Store`, no bare
/// `Date()`, no SwiftUI state.
public struct SpineIndex: Sendable {
	private let ordered: [Mission]

	public init(missions: [Mission]) {
		ordered = missions.sorted {
			if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
			if $0.number != $1.number { return $0.number < $1.number }
			return $0.id < $1.id
		}
	}

	public var count: Int { ordered.count }

	public subscript(_ i: Int) -> Mission { ordered[i] }

	/// `createdAt` (epoch ms) of the earliest mission whose state is not
	/// `closed`, or `nil` when every mission is closed (or there are none).
	/// `TimeLens.fitted` and Fit consume this.
	public var earliestOpen: Double? {
		ordered.first(where: { $0.state != .closed })
			.map { $0.createdAt.timeIntervalSince1970 * 1000 }
	}

	/// Lower bound: the index of the first mission with `createdAt >= t`
	/// (epoch ms), or `count` when every mission is older.
	public func firstIndex(atOrAfter t: Double) -> Int {
		var lo = 0
		var hi = ordered.count
		while lo < hi {
			let mid = (lo + hi) / 2
			if ordered[mid].createdAt.timeIntervalSince1970 * 1000 < t {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		return lo
	}
}
