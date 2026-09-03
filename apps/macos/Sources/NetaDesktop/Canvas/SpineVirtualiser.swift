import CoreGraphics
import Foundation

/// The materialised slice of the spine: the columns drawn as views plus the
/// one-`Canvas` backdrop marks (T10.4).
///
/// `columns` holds at most `SpineMetrics.maxLiveColumns` entries; every other
/// mission in range stays visible as `ticks`, at most one per pixel column.
/// `liveViewCount` is the number of materialised column views.
public struct VisibleWindow: Sendable, Equatable {
	public let columns: [MissionColumn]
	public let ticks: [MissionTick]
	public let leader: CGRect
	public let spineY: CGFloat
	public var liveViewCount: Int

	public init(
		columns: [MissionColumn], ticks: [MissionTick], leader: CGRect,
		spineY: CGFloat, liveViewCount: Int
	) {
		self.columns = columns
		self.ticks = ticks
		self.leader = leader
		self.spineY = spineY
		self.liveViewCount = liveViewCount
	}
}

/// Pure virtualisation over `SpineIndex` (T10.4).
///
/// The viewport's time range is binary-searched, widened one column each
/// side, and only that range is laid out through a sub-index, so
/// `SpineLayout.layout` never walks the other ~100k missions. Past
/// `maxLiveColumns` the columns nearest `viewport.midX` are kept and the rest
/// stay visible as ticks. No `Store`, no bare `Date()`, no SwiftUI state.
public enum SpineVirtualiser {
	public static func window(
		index: SpineIndex,
		agents: [MissionId: [Agent]],
		lens: TimeLens,
		viewport: CGRect,
		metrics: SpineMetrics = .standard,
		expanded: Set<MissionId> = []
	) -> VisibleWindow {
		let spineY = viewport.midY
		let nowX = CGFloat(lens.x(lens.options.now))
		let leader = CGRect(
			x: nowX - metrics.leadCardWidth / 2,
			y: spineY - metrics.leadCardHeight / 2,
			width: metrics.leadCardWidth,
			height: metrics.leadCardHeight)
		guard index.count > 0, viewport.width > 0 else {
			return VisibleWindow(
				columns: [], ticks: [], leader: leader, spineY: spineY,
				liveViewCount: 0)
		}

		// `x` is monotonic in `createdAt`, so the visible missions form one
		// contiguous index range; widen it one column each side as a buffer.
		let lo = max(
			0, index.firstIndex(atOrAfter: lens.t(Double(viewport.minX))) - 1)
		let hi = min(
			index.count,
			index.firstIndex(atOrAfter: lens.t(Double(viewport.maxX))) + 1)

		var columns: [MissionColumn] = []
		if hi > lo {
			var slice: [Mission] = []
			slice.reserveCapacity(hi - lo)
			for i in lo ..< hi { slice.append(index[i]) }
			columns = SpineLayout.layout(
				index: SpineIndex(missions: slice), agents: agents, lens: lens,
				viewport: viewport, metrics: metrics, expanded: expanded
			).columns
		}

		// Past `maxLiveColumns`, keep the columns nearest the viewport centre
		// with index order restored; the rest stay visible as ticks.
		if columns.count > metrics.maxLiveColumns {
			let midX = viewport.midX
			let nearest = columns.indices.sorted {
				let da = abs(columns[$0].anchor.x - midX)
				let db = abs(columns[$1].anchor.x - midX)
				if da != db { return da < db }
				return $0 < $1
			}
			let kept = Set(nearest.prefix(metrics.maxLiveColumns))
			columns = columns.indices.filter { kept.contains($0) }.map { columns[$0] }
		}

		let ticks = bucketTicks(index: index, lens: lens, viewport: viewport)
		return VisibleWindow(
			columns: columns, ticks: ticks, leader: leader, spineY: spineY,
			liveViewCount: columns.count)
	}

	/// One tick per viewport pixel column at most. Bucket `[px, px + 1)`
	/// holds the missions with `lens.t(px) <= createdAt < lens.t(px + 1)`,
	/// found by binary search, and carries the bucket's strongest state.
	/// Adjacent buckets share a boundary value, so each time edge is searched
	/// once; the bucket scan touches visible missions only, never every
	/// mission.
	static func bucketTicks(
		index: SpineIndex, lens: TimeLens, viewport: CGRect
	) -> [MissionTick] {
		let pixelCount = max(0, Int(viewport.width))
		guard pixelCount > 0, index.count > 0 else { return [] }
		var ticks: [MissionTick] = []
		ticks.reserveCapacity(min(pixelCount, index.count))
		var a = index.firstIndex(atOrAfter: lens.t(Double(viewport.minX)))
		for i in 0 ..< pixelCount {
			let px = viewport.minX + CGFloat(i)
			let b = index.firstIndex(atOrAfter: lens.t(Double(px + 1)))
			if b > a {
				var strongest = index[a].state
				var best = tickPriority(strongest)
				for j in (a + 1) ..< b {
					let p = tickPriority(index[j].state)
					if p < best {
						best = p
						strongest = index[j].state
						if best == 0 { break }
					}
				}
				ticks.append(MissionTick(x: px + 0.5, state: strongest))
			}
			a = b
		}
		return ticks
	}

	/// Bucket state priority: blocked, failed, readyToClose, mergedNotClosed,
	/// running, closed.
	static func tickPriority(_ state: MissionState) -> Int {
		switch state {
		case .blocked: return 0
		case .failed: return 1
		case .readyToClose: return 2
		case .mergedNotClosed: return 3
		case .running: return 4
		case .closed: return 5
		}
	}
}
