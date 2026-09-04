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

	/// Horizontal delta changes `scrollX`, clamped to
	/// `0...max(0, index.contentWidth - viewport.width)`; vertical changes
	/// `scrollY`, clamped to `0...max(0, contentHeight - viewport.height)`;
	/// neither touches the spacing.
	public func pan(
		by delta: CGSize, index: SpineIndex, viewport: CGRect,
		contentHeight: CGFloat
	) {
		let maxX = max(0, index.contentWidth - viewport.width)
		scrollX = min(max(scrollX + delta.width, 0), maxX)
		let maxY = max(0, contentHeight - viewport.height)
		scrollY = min(max(scrollY + delta.height, 0), maxY)
	}

	/// Applies a staged Now jump: the live edge moves to the viewport's
	/// right. T10.10 calls this with `NowState.consumeJump()`.
	public func jump(to scrollX: CGFloat) {
		self.scrollX = max(0, scrollX)
	}

	/// Pinch zoom: scales the spacing about the cursor, re-solving `scrollX`
	/// after the rebuild so the content under the cursor holds.
	///
	/// `atCursorX` is a viewport-local offset (canvases resolve viewports at
	/// the origin, so a gesture location is already the offset).
	public func zoom(
		factor: Double, atCursorX: CGFloat, index: SpineIndex
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
		scrollX = max(0, nextX - atCursorX)
	}

	/// ⌘= zooms in ×1.25, ⌘- zooms out ×0.8, about the viewport centre.
	public func zoom(
		_ step: ZoomStep, index: SpineIndex, viewport: CGRect
	) {
		switch step {
		case .zoomIn:
			zoom(
				factor: 1.25, atCursorX: viewport.midX - viewport.minX,
				index: index)
		case .zoomOut:
			zoom(
				factor: 0.8, atCursorX: viewport.midX - viewport.minX,
				index: index)
		}
	}

	/// ⌘0: the largest `pxPerHour` at which every open mission from
	/// `index.earliestOpen` to the newest fits in `viewport.width`, else the
	/// minimum with a pan to the newest. Resets `scrollY`.
	public func fit(index: SpineIndex, viewport: CGRect) {
		defer { scrollY = 0 }
		guard let first = index.earliestOpen, index.count > 0 else {
			return
		}
		let last = index.count - 1
		if !spanFits(
			index: index, from: first, to: last, width: viewport.width,
			pxPerHour: Self.minPxPerHour)
		{
			pxPerHour = Self.minPxPerHour
			maxPitch = Self.maxPitch(for: pxPerHour)
			scrollX = max(
				0,
				index.respaced(pxPerHour: pxPerHour, maxPitch: maxPitch)
					.contentWidth - viewport.width)
			return
		}
		var lo = Self.minPxPerHour
		var hi = Self.maxPxPerHour
		for _ in 0 ..< 40 {
			let mid = (lo + hi) / 2
			if spanFits(
				index: index, from: first, to: last, width: viewport.width,
				pxPerHour: mid)
			{
				lo = mid
			} else {
				hi = mid
			}
		}
		pxPerHour = lo
		maxPitch = Self.maxPitch(for: lo)
		let rebuilt = index.respaced(pxPerHour: lo, maxPitch: maxPitch)
		scrollX = max(0, rebuilt.x(first))
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

	/// Whether items `from...to` fit in `width` at `pxPerHour`.
	private func spanFits(
		index: SpineIndex, from: Int, to: Int, width: CGFloat,
		pxPerHour: Double
	) -> Bool {
		let rebuilt = index.respaced(
			pxPerHour: pxPerHour,
			maxPitch: Self.maxPitch(for: pxPerHour))
		return rebuilt.x(to) - rebuilt.x(from) <= width
	}
}
