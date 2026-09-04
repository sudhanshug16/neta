import CoreGraphics
import Foundation

/// The time-ordered spine sequence: missions and checkpoint events merged
/// into one `SpineItem` list with cumulative x from T10.1 (T10.3).
///
/// Only events carrying a `Checkpoints.icon` participate; every other kind
/// is not a checkpoint and never enters the spacing. Layout is pure: no
/// `Store`, no bare `Date()`, no SwiftUI state.
public struct SpineIndex: Sendable {
	private let items: [SpineItem]
	private let xs: [CGFloat]
	private let missions: [Mission]
	private let events: [Event]
	private let missionsById: [MissionId: Mission]
	private let pxPerHour: Double
	private let maxPitch: CGFloat

	public init(
		missions: [Mission], events: [Event] = [],
		pxPerHour: Double, maxPitch: CGFloat
	) {
		self.missions = missions
		self.events = events
		var items: [SpineItem] = []
		items.reserveCapacity(missions.count + events.count)
		var byId: [MissionId: Mission] = [:]
		byId.reserveCapacity(missions.count)
		for mission in missions {
			byId[mission.id] = mission
			items.append(.mission(
				id: mission.id,
				at: mission.createdAt.timeIntervalSince1970 * 1000,
				number: mission.number))
		}
		for event in events where Checkpoints.icon(for: event.kind) != nil {
			items.append(.checkpoint(
				eventSeq: event.seq,
				at: event.at.timeIntervalSince1970 * 1000))
		}
		let ordered = items.sorted(by: SequenceSpacing.order)
		self.items = ordered
		self.xs = SequenceSpacing.spacing(
			items: ordered, pxPerHour: pxPerHour, maxPitch: maxPitch)
		self.missionsById = byId
		self.pxPerHour = pxPerHour
		self.maxPitch = maxPitch
	}

	public var count: Int { items.count }

	public subscript(_ i: Int) -> SpineItem { items[i] }

	/// Cumulative content x of item `i`.
	public func x(_ i: Int) -> CGFloat { xs[i] }

	/// The mission behind item `i`, or `nil` for checkpoints.
	public func mission(_ i: Int) -> Mission? {
		switch items[i] {
		case .mission(let id, _, _): return missionsById[id]
		case .checkpoint: return nil
		}
	}

	/// The spacing inputs this index was built with.
	public var spacing: (pxPerHour: Double, maxPitch: CGFloat) {
		(pxPerHour, maxPitch)
	}

	/// The same sequence re-spaced, for zoom and Fit.
	public func respaced(pxPerHour: Double, maxPitch: CGFloat) -> SpineIndex {
		SpineIndex(
			missions: missions, events: events,
			pxPerHour: pxPerHour, maxPitch: maxPitch)
	}

	/// Trailing content edge: the leader card's far edge, so the leader is
	/// always reachable by pan and `jumpToNow`.
	public var contentWidth: CGFloat {
		(xs.last ?? 0) + SpinePlacement.leaderGap
			+ SpineMetrics.standard.leaderCardWidth
	}

	/// Index of the earliest mission whose state is not `closed`, or `nil`
	/// when there is none. Fit consumes this.
	public var earliestOpen: Int? {
		for i in 0 ..< items.count {
			if let mission = mission(i), mission.state != .closed {
				return i
			}
		}
		return nil
	}

	/// Lower bound over cumulative x: the first index with `x >= t`, or
	/// `count` when every item is older. A binary search: `x` is monotonic
	/// in the index.
	public func firstIndex(atOrAfter t: CGFloat) -> Int {
		var lo = 0
		var hi = xs.count
		while lo < hi {
			let mid = (lo + hi) / 2
			if xs[mid] < t {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		return lo
	}
}
