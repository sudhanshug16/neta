import CoreGraphics
import Foundation
import Observation

/// Keyboard zoom step for ⌘= / ⌘- (T10.9).
public enum ZoomStep: Sendable {
	case zoomIn
	case zoomOut
}

/// The spine canvas's spacing and pan (T10.9).
///
/// Zoom changes `pxPerHour` and `maxPitch` only — `minPitch` and
/// `checkpointPitch` are constant, so zooming out collapses toward a uniform
/// sequence. Nodes never scale, so text keeps its point size. Panning moves
/// `scrollX`/`scrollY` only and never the spacing. Fit restores a useful
/// spacing and pan.
@Observable @MainActor public final class SpineViewportState {
	/// Pixels per hour at the default spacing.
	public static let defaultPxPerHour: Double = 48
	/// Zoom floor: at the minimum the maximum gap meets the minimum column
	/// and the spine reads as a uniform sequence.
	public static let minPxPerHour: Double = 4
	public static let maxPxPerHour: Double = 4096
	/// The maximum gap at the default spacing (T10.1).
	public static let defaultMaxPitch: CGFloat = 320
	/// The minimum column never changes under zoom.
	public static let minPitch: CGFloat = 120
	/// Breathing room Fit leaves to the left of the oldest open mission's
	/// widest node. Fit solved for the exact usable width, so that node's
	/// left border landed on the viewport edge with nothing beside it and the
	/// oldest column read as clipped even though nothing was cut off.
	public static let fitLeadingMargin: CGFloat = 12
	/// A safety rail for an otherwise unbounded canvas. It is deliberately
	/// unrelated to mission content: an empty workspace is still pannable.
	public static let maxPan: CGFloat = 1_000_000

	public private(set) var pxPerHour: Double
	public private(set) var maxPitch: CGFloat
	public private(set) var scrollX: CGFloat = 0
	public private(set) var scrollY: CGFloat = 0
	public var expanded: Set<MissionId> = []

	public init(pxPerHour: Double) {
		let clamped = min(
			max(pxPerHour, Self.minPxPerHour), Self.maxPxPerHour)
		self.pxPerHour = clamped
		self.maxPitch = Self.maxPitch(for: clamped)
	}

	/// The maximum gap scales with the spacing, floored at the minimum
	/// column so the floor reads uniform.
	static func maxPitch(for pxPerHour: Double) -> CGFloat {
		max(
			Self.minPitch,
			Self.defaultMaxPitch * CGFloat(
				pxPerHour / Self.defaultPxPerHour))
	}

	/// Horizontal delta changes `scrollX`, clamped by
	/// `SpinePlacement.clampScrollX`: back to the oldest item at the left
	/// edge, forward no further than the live edge. Nothing exists right of
	/// Now, so the live edge is always the forward limit — including when it
	/// is negative, which is every sequence narrower than the usable width.
	/// Vertical changes `scrollY`, clamped to
	/// `0...max(0, contentHeight - viewport.height)`. Neither touches the
	/// spacing.
	public func pan(
		by delta: CGSize, index: SpineIndex, viewport: CGRect,
		contentHeight: CGFloat, trailingInset: CGFloat = 0
	) {
		guard delta.width.isFinite, delta.height.isFinite else { return }
		scrollX = min(max(scrollX + delta.width, -Self.maxPan), Self.maxPan)
		scrollY = min(max(scrollY + delta.height, -Self.maxPan), Self.maxPan)
	}

	/// Applies a resolved scroll target: the shell's Now jump
	/// (`SpineCanvasView.applyShellNow`) or the first layout's jump to Now.
	/// The target is already the live edge, which is negative when the
	/// sequence is narrower than the viewport, so nothing is clamped here.
	public func jump(to scrollX: CGFloat) {
		self.scrollX = scrollX
	}

	public func recenter(to scrollX: CGFloat) {
		self.scrollX = min(max(scrollX, -Self.maxPan), Self.maxPan)
		scrollY = 0
	}

	/// Pinch zoom: scales the spacing about the cursor, re-solving `scrollX`
	/// after the rebuild so the content under the cursor holds.
	///
	/// `atCursorX` is a viewport-local offset (canvases resolve viewports at
	/// the origin, so a gesture location is already the offset). The
	/// re-solved scroll is clamped into the same range a pan uses, so a
	/// zoom on a sequence narrower than the usable width leaves the leader
	/// at Now instead of snapping it back to content x 0. Pass the canvas's
	/// viewport and trailing inset: with no viewport the usable width is
	/// zero and the clamp degenerates to `0...contentWidth`.
	public func zoom(
		factor: Double, atCursorX: CGFloat, index: SpineIndex,
		viewport: CGRect = .zero, trailingInset: CGFloat = 0
	) {
		guard factor.isFinite, factor > 0, atCursorX.isFinite else { return }
		guard index.count > 0 else {
			pxPerHour = min(
				max(pxPerHour * factor, Self.minPxPerHour),
				Self.maxPxPerHour)
			maxPitch = Self.maxPitch(for: pxPerHour)
			return
		}
		let contentX = scrollX + atCursorX
		let t = SpineTicks.time(index: index, x: contentX, now: .infinity)
		let next = min(
			max(pxPerHour * factor, Self.minPxPerHour), Self.maxPxPerHour)
		guard next != pxPerHour else { return }
		pxPerHour = next
		maxPitch = Self.maxPitch(for: next)
		let rebuilt = index.respaced(pxPerHour: next, maxPitch: maxPitch)
		let nextX = SpineTicks.x(
			index: rebuilt, t: t, now: .infinity)
		scrollX = min(max(nextX - atCursorX, -Self.maxPan), Self.maxPan)
	}

	/// ⌘= zooms in ×1.25, ⌘- zooms out ×0.8, about the viewport centre.
	public func zoom(
		_ step: ZoomStep, index: SpineIndex, viewport: CGRect,
		trailingInset: CGFloat = 0
	) {
		switch step {
		case .zoomIn:
			zoom(
				factor: 1.25, atCursorX: viewport.midX - viewport.minX,
				index: index, viewport: viewport,
				trailingInset: trailingInset)
		case .zoomOut:
			zoom(
				factor: 0.8, atCursorX: viewport.midX - viewport.minX,
				index: index, viewport: viewport,
				trailingInset: trailingInset)
		}
	}

	/// ⌘0: the largest `pxPerHour` at which every open mission from
	/// `index.earliestOpen` through the leader card fits in the usable
	/// width, else the minimum. Either way the view ends right-aligned at
	/// the live edge, exactly where `applyShellNow` lands. Resets
	/// `scrollY`.
	public func fit(
		index: SpineIndex, viewport: CGRect, trailingInset: CGFloat = 0
	) {
		let usable = max(0, viewport.width - trailingInset)
		guard let first = index.earliestOpen, index.count > 0 else {
			recenter(to: SpinePlacement.liveScrollX(
				index: index, viewport: viewport,
				trailingInset: trailingInset))
			return
		}
		if spanFits(
			index: index, from: first, width: usable,
			pxPerHour: Self.minPxPerHour)
		{
			var lo = Self.minPxPerHour
			var hi = Self.maxPxPerHour
			for _ in 0 ..< 40 {
				let mid = (lo + hi) / 2
				if spanFits(
					index: index, from: first, width: usable,
					pxPerHour: mid)
				{
					lo = mid
				} else {
					hi = mid
				}
			}
			pxPerHour = lo
		} else {
			pxPerHour = Self.minPxPerHour
		}
		maxPitch = Self.maxPitch(for: pxPerHour)
		recenter(to: SpinePlacement.liveScrollX(
			index: index.respaced(pxPerHour: pxPerHour, maxPitch: maxPitch),
			viewport: viewport, trailingInset: trailingInset)
		)
	}

	/// Expands or collapses a mission's completed-agent stack in place.
	public func toggleExpanded(_ id: MissionId) {
		if expanded.contains(id) {
			expanded.remove(id)
		} else {
			expanded.insert(id)
		}
	}

	// MARK: - Private

	/// Whether item `from` through the leader card's far edge fits in
	/// `width` at `pxPerHour`. The leader is pinned at the live edge, so the
	/// span that has to fit ends at `contentWidth`, not at the newest item.
	///
	/// It starts at `from`'s LEFT EDGE, not at its anchor: nodes are centred
	/// on their anchors, so measuring from the anchor left half the oldest
	/// open mission's card outside the band and Fit cut its number, name and
	/// state off the left window edge (10-desktop-spine T10.9 item 7: Fit
	/// brings every open mission into view).
	/// The span also has to leave `fitLeadingMargin` beside that left edge:
	/// solving for the exact width put the oldest open column's border on the
	/// viewport edge, which reads as clipped.
	private func spanFits(
		index: SpineIndex, from: Int, width: CGFloat, pxPerHour: Double
	) -> Bool {
		let rebuilt = index.respaced(
			pxPerHour: pxPerHour,
			maxPitch: Self.maxPitch(for: pxPerHour))
		let left = rebuilt.x(from)
			- SpinePlacement.halfWidth(of: from, in: rebuilt)
		return rebuilt.contentWidth - left <= max(0, width - Self.fitLeadingMargin)
	}
}
