import AppKit
import CoreGraphics
import SwiftUI

/// Two-finger trackpad panning for the spine canvas (T10.8).
///
/// A transparent overlay view installs a local scroll-wheel monitor. Events
/// are swallowed only inside the uncovered canvas region: the event must
/// belong to the view's own window, and its location must land in `bounds`
/// minus `interactionInsets` — the shell's insets for the surfaces covering
/// the canvas (chat trailing, mission bar bottom) — so those surfaces keep
/// their own scrolling. Non-precise (line-based) deltas are scaled by
/// `nonPreciseScale`; deltas are coalesced per run-loop turn and delivered
/// once to `onScroll`. Nodes never scale here; the parent maps the delta to
/// `SpineViewportState.pan`.
public struct TrackpadPanCapture: NSViewRepresentable {
	public typealias NSViewType = TrackpadPanCaptureView

	private var isEnabled: Bool
	private var interactionInsets: EdgeInsets
	private var onScroll: (CGSize) -> Void

	public init(
		isEnabled: Bool, interactionInsets: EdgeInsets,
		onScroll: @escaping (CGSize) -> Void
	) {
		self.isEnabled = isEnabled
		self.interactionInsets = interactionInsets
		self.onScroll = onScroll
	}

	public func makeNSView(context: Context) -> TrackpadPanCaptureView {
		let view = TrackpadPanCaptureView()
		view.configure(
			isEnabled: isEnabled, interactionInsets: nsInsets,
			onScroll: onScroll)
		return view
	}

	public func updateNSView(
		_ nsView: TrackpadPanCaptureView, context: Context
	) {
		nsView.configure(
			isEnabled: isEnabled, interactionInsets: nsInsets,
			onScroll: onScroll)
	}

	public static func dismantleNSView(
		_ nsView: TrackpadPanCaptureView, coordinator: ()
	) {
		nsView.teardown()
	}

	private var nsInsets: NSEdgeInsets {
		NSEdgeInsets(
			top: interactionInsets.top, left: interactionInsets.leading,
			bottom: interactionInsets.bottom, right: interactionInsets.trailing)
	}
}

/// Transparent overlay hosting the scroll-wheel monitor.
///
/// The monitor is installed once and torn down with the view. Filtering,
/// scaling and coalescing live here so `TrackpadPanCapture` stays a thin
/// representable.
public final class TrackpadPanCaptureView: NSView {
	/// Scale for line-based (non-precise) scroll deltas.
	public static let nonPreciseScale: CGFloat = 18

	/// Pure delta scaling, extracted for tests.
	public static func scaledDelta(_ delta: CGFloat, precise: Bool) -> CGFloat {
		precise ? delta : delta * nonPreciseScale
	}

	private var isEnabled = true
	private var interactionInsets = NSEdgeInsets()
	private var onScroll: ((CGSize) -> Void)?
	/// Installed monitor token. Main-thread confined like the view;
	/// `nonisolated(unsafe)` so `deinit` can remove it.
	private nonisolated(unsafe) var monitor: Any?
	private var pending = CGSize.zero
	private var flushScheduled = false

	public override init(frame frameRect: NSRect) {
		super.init(frame: frameRect)
	}

	public required init?(coder: NSCoder) {
		super.init(coder: coder)
	}

	func configure(
		isEnabled: Bool, interactionInsets: NSEdgeInsets,
		onScroll: @escaping (CGSize) -> Void
	) {
		self.isEnabled = isEnabled
		self.interactionInsets = interactionInsets
		self.onScroll = onScroll
		ensureMonitor()
	}

	func teardown() {
		if let monitor {
			NSEvent.removeMonitor(monitor)
			self.monitor = nil
		}
	}

	deinit {
		if let monitor {
			NSEvent.removeMonitor(monitor)
		}
	}

	/// The canvas region that swallows scrolls: `bounds` minus the shell's
	/// covering-surface insets. `top`/`bottom` are distance from the upper /
	/// lower edge, `left`/`right` from the leading / trailing edge.
	func captureRect(in bounds: NSRect) -> NSRect {
		NSRect(
			x: bounds.minX + interactionInsets.left,
			y: bounds.minY + interactionInsets.bottom,
			width: max(
				0, bounds.width - interactionInsets.left
					- interactionInsets.right),
			height: max(
				0, bounds.height - interactionInsets.top
					- interactionInsets.bottom))
	}

	private func ensureMonitor() {
		guard monitor == nil else { return }
		monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) {
			[weak self] event in
			guard let self else { return event }
			return self.handle(event) ? nil : event
		}
	}

	/// Returns true when the event is swallowed.
	private func handle(_ event: NSEvent) -> Bool {
		guard isEnabled, let window, event.window == window else {
			return false
		}
		let point = convert(event.locationInWindow, from: nil)
		guard captureRect(in: bounds).contains(point) else { return false }
		let delta = CGSize(
			width: Self.scaledDelta(
				event.scrollingDeltaX,
				precise: event.hasPreciseScrollingDeltas),
			height: Self.scaledDelta(
				event.scrollingDeltaY,
				precise: event.hasPreciseScrollingDeltas))
		guard delta != .zero else { return true }
		pending.width += delta.width
		pending.height += delta.height
		if !flushScheduled {
			flushScheduled = true
			DispatchQueue.main.async { [weak self] in self?.flush() }
		}
		return true
	}

	private func flush() {
		let delta = pending
		pending = .zero
		flushScheduled = false
		if delta != .zero {
			onScroll?(delta)
		}
	}
}
