import CoreGraphics
import Foundation

/// One item in the spine sequence: a mission anchor or a checkpoint icon.
///
/// Times are epoch milliseconds. Layout is pure: no `Store`, no bare
/// `Date()`, no SwiftUI state.
public enum SpineItem: Sendable, Equatable {
	case mission(id: MissionId, at: Double, number: Int)
	case checkpoint(eventSeq: Int, at: Double)

	public var at: Double {
		switch self {
		case .mission(_, let at, _): return at
		case .checkpoint(_, let at): return at
		}
	}

	public var isCheckpoint: Bool {
		switch self {
		case .mission: return false
		case .checkpoint: return true
		}
	}
}

/// The pure gap rule turning one time-ordered sequence into x positions
/// (T10.1, PAPER-SPINE Revision 4).
///
/// Neighbouring items sit `elapsedHours * pxPerHour` apart, clamped into a
/// floor (`checkpointPitch` when either item is a checkpoint, else
/// `minPitch`) through `maxPitch`. A run of checkpoints between two missions
/// then widens so the missions stay at least `minPitch` apart. An item's x
/// depends only on the items before it: appending never moves existing items
/// and a state change never moves anything.
public enum SequenceSpacing {
	public static func spacing(
		items: [SpineItem],
		pxPerHour: Double,
		minPitch: CGFloat = 120,
		maxPitch: CGFloat = 320,
		checkpointPitch: CGFloat = 28
	) -> [CGFloat] {
		let ordered = items.sorted(by: Self.order)
		guard !ordered.isEmpty else { return [] }
		var gaps = [CGFloat](repeating: 0, count: ordered.count)
		for i in 1 ..< ordered.count {
			let floor =
				(ordered[i - 1].isCheckpoint || ordered[i].isCheckpoint)
				? checkpointPitch : minPitch
			let elapsedHours =
				(ordered[i].at - ordered[i - 1].at) / 3_600_000
			gaps[i] = min(
				maxPitch, max(floor, CGFloat(elapsedHours * pxPerHour)))
		}
		// Widen checkpoint runs so flanking missions keep `minPitch`.
		var i = 0
		while i < ordered.count {
			guard case .mission = ordered[i] else {
				i += 1
				continue
			}
			var j = i + 1
			while j < ordered.count, ordered[j].isCheckpoint { j += 1 }
			if j < ordered.count, j > i + 1,
				case .mission = ordered[j]
			{
				let run = j - i // gaps touched: i + 1 ... j
				let target = max(minPitch, checkpointPitch * CGFloat(run))
				let sum = gaps[(i + 1)...j].reduce(CGFloat(0), +)
				if sum < target {
					let extra = (target - sum) / CGFloat(run)
					for k in (i + 1)...j { gaps[k] += extra }
				}
			}
			i = j
		}
		var xs = [CGFloat](repeating: 0, count: ordered.count)
		for i in 1 ..< ordered.count { xs[i] = xs[i - 1] + gaps[i] }
		return xs
	}

	/// Total order: by time, ties checkpoint before mission, then `eventSeq`
	/// or `number`. Deterministic, so shuffles agree.
	static func order(_ a: SpineItem, _ b: SpineItem) -> Bool {
		if a.at != b.at { return a.at < b.at }
		if a.isCheckpoint != b.isCheckpoint {
			return a.isCheckpoint && !b.isCheckpoint
		}
		switch (a, b) {
		case (.checkpoint(let s, _), .checkpoint(let t, _)):
			return s < t
		case (.mission(let a, _, let m), .mission(let b, _, let n)):
			if m != n { return m < n }
			return a < b
		default:
			return false
		}
	}
}
