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
/// Neighbouring items sit `elapsedHours * pxPerHour` apart, capped at
/// `maxPitch` and then floored (`checkpointPitch` when either item is a
/// checkpoint, else `minPitch` or `sameSidePitch`). The floor is applied
/// last and therefore always wins: `maxPitch` shrinks with zoom while the
/// floors never do, so a cap under the floor must not be allowed to pull
/// two nodes together. A run of checkpoints between two missions
/// then widens so the missions stay at least `minPitch` apart. An item's x
/// depends only on the items before it: appending never moves existing items
/// and a state change never moves anything.
///
/// PAPER-SPINE Revision 4 rests the 120 pt minimum column on alternation —
/// "Neighbours alternate sides, so 120 px never overlaps 220 px cards" — and
/// the side is a pure function of the permanent number (T10.3), so two
/// neighbours share a side whenever the numbers do not run in time order
/// (paged-in history, a mission continued from an older one). Two same-side
/// neighbours at 120 pt draw their cards and stacks through each other, so
/// their floor is the wider `sameSidePitch` instead. Alternating neighbours
/// are untouched, which is every ordinary sequence.
public enum SequenceSpacing {
	/// The floor between two missions on the SAME side of the spine: the
	/// widest node (`agentRowWidth`) plus the gutter, so neither card nor
	/// stack can reach its neighbour.
	public static let defaultSameSidePitch: CGFloat =
		SpineMetrics.standard.agentRowWidth + SpineMetrics.standard.leadGap

	public static func spacing(
		items: [SpineItem],
		pxPerHour: Double,
		minPitch: CGFloat = 120,
		maxPitch: CGFloat = 320,
		checkpointPitch: CGFloat = 28,
		sameSidePitch: CGFloat = SequenceSpacing.defaultSameSidePitch
	) -> [CGFloat] {
		let ordered = items.sorted(by: Self.order)
		guard !ordered.isEmpty else { return [] }
		func missionFloor(_ a: SpineItem, _ b: SpineItem) -> CGFloat {
			guard case .mission(_, _, let m) = a,
				case .mission(_, _, let n) = b,
				m.isMultiple(of: 2) == n.isMultiple(of: 2)
			else { return minPitch }
			return max(minPitch, sameSidePitch)
		}
		var gaps = [CGFloat](repeating: 0, count: ordered.count)
		for i in 1 ..< ordered.count {
			let floor =
				(ordered[i - 1].isCheckpoint || ordered[i].isCheckpoint)
				? checkpointPitch : missionFloor(ordered[i - 1], ordered[i])
			let elapsedHours =
				(ordered[i].at - ordered[i - 1].at) / 3_600_000
			// The floor is applied LAST, so the maximum gap can never cut
			// below it. `maxPitch` scales with zoom (`SpineViewportState`),
			// so at 64% it is 204.8 — under the 230 pt same-side floor — and
			// clamping in the other order emitted 204.8 for a same-side
			// pair, drawing 220 pt agent rows 15 pt through each other.
			gaps[i] = max(
				floor, min(maxPitch, CGFloat(elapsedHours * pxPerHour)))
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
				let target = max(
					missionFloor(ordered[i], ordered[j]),
					checkpointPitch * CGFloat(run))
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
