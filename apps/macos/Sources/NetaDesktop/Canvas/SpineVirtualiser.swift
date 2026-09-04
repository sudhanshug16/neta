import CoreGraphics
import Foundation

/// The materialised slice of the spine: the columns drawn as views plus the
/// one-`Canvas` backdrop marks (T10.5).
///
/// `columns` holds at most `SpineMetrics.maxLiveColumns` entries; every other
/// mission in range stays visible as `ticks`, at most one per pixel column.
/// `labels` are the visible age labels at screen x. `liveViewCount` is the
/// number of materialised column views.
public struct VisibleWindow: Sendable, Equatable {
	public let range: Range<Int>
	public let columns: [MissionColumn]
	public let ticks: [MissionTick]
	public let labels: [SpineTick]
	public let leader: CGRect
	public let spineY: CGFloat
	public var liveViewCount: Int

	public init(
		range: Range<Int>, columns: [MissionColumn],
		ticks: [MissionTick], labels: [SpineTick], leader: CGRect,
		spineY: CGFloat, liveViewCount: Int
	) {
		self.range = range
		self.columns = columns
		self.ticks = ticks
		self.labels = labels
		self.leader = leader
		self.spineY = spineY
		self.liveViewCount = liveViewCount
	}
}

/// Pure index-based virtualisation over `SpineIndex` (T10.5).
///
/// The visible content range is binary-searched and only that range is
/// placed, so `SpinePlacement.place` never walks the other ~100k missions.
/// Past `maxLiveColumns` the columns nearest `viewport.midX` are kept and
/// the rest stay visible as ticks. No `Store`, no bare `Date()`, no SwiftUI
/// state.
public enum SpineVirtualiser {
	public static func window(
		index: SpineIndex,
		agents: [MissionId: [Agent]],
		scrollX: CGFloat,
		viewport: CGRect,
		now: Double,
		metrics: SpineMetrics = .standard,
		expanded: Set<MissionId> = []
	) -> VisibleWindow {
		let spineY = viewport.midY
		let leader = SpinePlacement.leaderRect(
			index: index, scrollX: scrollX, viewport: viewport,
			spineY: spineY, metrics: metrics)
		guard index.count > 0, viewport.width > 0 else {
			return VisibleWindow(
				range: 0 ..< 0, columns: [], ticks: [], labels: [],
				leader: leader, spineY: spineY, liveViewCount: 0)
		}

		// `x` is monotonic in the index, so the visible items form one
		// contiguous range: the content under the viewport widened one
		// lead-card width each side as a buffer.
		let lo = max(
			0,
			index.firstIndex(
				atOrAfter: scrollX - metrics.leadCardWidth))
		let hi = min(
			index.count,
			index.firstIndex(
				atOrAfter: scrollX + viewport.width
					+ metrics.leadCardWidth))
		let range = lo ..< hi

		var placement = SpinePlacement.place(
			index: index, agents: agents, range: range, scrollX: scrollX,
			viewport: viewport, metrics: metrics, expanded: expanded)

		// Past `maxLiveColumns`, keep the columns nearest the viewport
		// centre with index order restored; the rest stay visible as ticks.
		if placement.columns.count > metrics.maxLiveColumns {
			let midX = viewport.midX
			let nearest = placement.columns.indices.sorted {
				let da = abs(placement.columns[$0].anchor.x - midX)
				let db = abs(placement.columns[$1].anchor.x - midX)
				if da != db { return da < db }
				return $0 < $1
			}
			let kept = Set(nearest.prefix(metrics.maxLiveColumns))
			let columns = placement.columns.indices
				.filter { kept.contains($0) }
				.map { placement.columns[$0] }
			placement = Placement(
				spineY: placement.spineY, leader: placement.leader,
				columns: columns, ticks: placement.ticks)
		}

		let ticks = bucketTicks(
			index: index, scrollX: scrollX, viewport: viewport)
		let labels = SpineTicks.place(index: index, now: now)
			.filter { tick in
				let screenX = tick.x - scrollX + viewport.minX
				return screenX >= viewport.minX - 40
					&& screenX <= viewport.maxX + 40
			}
			.map { tick in
				SpineTick(
					id: tick.id, label: tick.label, at: tick.at,
					x: tick.x - scrollX + viewport.minX)
			}
		return VisibleWindow(
			range: range, columns: placement.columns, ticks: ticks,
			labels: labels, leader: leader, spineY: spineY,
			liveViewCount: placement.columns.count)
	}

	/// One tick per viewport pixel column at most. Bucket `[px, px + 1)`
	/// holds the items with `scrollX + px <= x < scrollX + px + 1`, found by
	/// binary search, and carries the bucket's strongest state. `x` is
	/// monotonic in the index, so the bucket scan touches visible items
	/// only, never every mission.
	static func bucketTicks(
		index: SpineIndex, scrollX: CGFloat, viewport: CGRect
	) -> [MissionTick] {
		let pixelCount = max(0, Int(viewport.width))
		guard pixelCount > 0, index.count > 0 else { return [] }
		var ticks: [MissionTick] = []
		ticks.reserveCapacity(min(pixelCount, index.count))
		// Pixel `i` covers content [scrollX + i, scrollX + i + 1).
		var a = index.firstIndex(atOrAfter: scrollX)
		for i in 0 ..< pixelCount {
			let px = viewport.minX + CGFloat(i)
			let b = index.firstIndex(atOrAfter: scrollX + CGFloat(i) + 1)
			if b > a {
				var strongest = index.mission(a)?.state ?? .closed
				var best = tickPriority(strongest)
				var j = a + 1
				while j < b {
					let state = index.mission(j)?.state ?? .closed
					let p = tickPriority(state)
					if p < best {
						best = p
						strongest = state
						if best == 0 { break }
					}
					j += 1
				}
				ticks.append(MissionTick(x: px + 0.5, state: strongest))
			}
			a = b
		}
		return ticks
	}

	/// Bucket state priority: blocked, failed, readyToClose, mergedNotClosed,
	/// running, closed. Checkpoints carry no state and read as closed, the
	/// weakest: a checkpoint-heavy pixel never outranks a mission.
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
