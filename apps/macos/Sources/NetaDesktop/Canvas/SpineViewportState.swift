import CoreGraphics
import Foundation
import Observation

/// Keyboard zoom step for ⌘= / ⌘- (T10.8).
public enum ZoomStep: Sendable {
	case zoomIn
	case zoomOut
}

/// The spine canvas's time window and vertical pan (T10.8).
///
/// Zoom stretches time horizontally through `TimeLens.zoomed`; nodes never
/// scale, so text keeps its point size. Vertical movement pans `scrollY`
/// only and never the lens. Fit restores a useful time window.
@Observable @MainActor public final class SpineViewportState {
	public private(set) var lens: TimeLens
	public private(set) var scrollY: CGFloat = 0
	public var expanded: Set<MissionId> = []

	public init(lens: TimeLens) {
		self.lens = lens
	}

	/// Horizontal delta shifts the focus window in time. The translation is
	/// rigid — `now`, `focusStart` and `focusEnd` move together — because a
	/// focus-only shift leaves `t(x)` unchanged in the linear region. The
	/// shift is the time equivalent of the pan at the viewport centre, with
	/// content following the fingers: a positive delta reveals older time.
	/// Vertical delta moves `scrollY`, clamped to
	/// `0...max(0, contentHeight - viewport.height)`, and never the lens.
	public func pan(
		by delta: CGSize, viewport: CGRect, contentHeight: CGFloat
	) {
		if delta.width != 0 {
			let midX = Double(viewport.midX)
			let shift = lens.t(midX - Double(delta.width)) - lens.t(midX)
			if shift.isFinite, shift != 0 {
				var options = lens.options
				options.now += shift
				options.focusStart += shift
				options.focusEnd += shift
				lens = TimeLens(options)
			}
		}
		let maxY = max(0, contentHeight - viewport.height)
		scrollY = min(max(scrollY + delta.height, 0), maxY)
	}

	/// Pinch zoom: maps magnification to `TimeLens.zoomed`, holding the
	/// cursor time.
	public func zoom(factor: Double, atCursorX: CGFloat) {
		lens = lens.zoomed(factor: factor, aroundX: Double(atCursorX))
	}

	/// ⌘= zooms in ×1.25, ⌘- zooms out ×0.8, about the viewport centre.
	public func zoom(_ step: ZoomStep, viewport: CGRect) {
		switch step {
		case .zoomIn:
			zoom(factor: 1.25, atCursorX: viewport.midX)
		case .zoomOut:
			zoom(factor: 0.8, atCursorX: viewport.midX)
		}
	}

	/// ⌘0: the focus window becomes all open missions via
	/// `index.earliestOpen`, and the vertical pan resets.
	public func fit(index: SpineIndex, viewport: CGRect, now: Date) {
		lens = lens.fitted(
			earliestOpen: index.earliestOpen,
			now: now.timeIntervalSince1970 * 1000)
		scrollY = 0
	}

	/// Expands or collapses a mission's completed-agent stack in place.
	public func toggleExpanded(_ id: MissionId) {
		if expanded.contains(id) {
			expanded.remove(id)
		} else {
			expanded.insert(id)
		}
	}
}
