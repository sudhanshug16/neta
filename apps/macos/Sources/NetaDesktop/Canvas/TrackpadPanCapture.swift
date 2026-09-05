import AppKit
import CoreGraphics
import SwiftUI

/// Two-finger trackpad panning for the spine canvas (T10.8).
///
/// A transparent overlay view installs a local scroll-wheel monitor. Events
/// are swallowed only inside the uncovered canvas region: the event must
/// belong to the view's own window, and its location must land in `bounds`
/// and outside every `excludedRects` entry — the rects the shell's floating
/// surfaces actually cover (`ShellLayout.covered`) — so those surfaces keep
/// their own scrolling and the canvas beside them keeps its panning. The
/// rects are in the SwiftUI coordinate space of the canvas, origin top left.
/// Non-precise (line-based) deltas are scaled by
/// `nonPreciseScale`; deltas are coalesced per run-loop turn and delivered
/// once to `onScroll`. Nodes never scale here; the parent maps the delta to
/// `SpineViewportState.pan`.
public struct TrackpadPanCapture: NSViewRepresentable {
	public typealias NSViewType = TrackpadPanCaptureView

	private var isEnabled: Bool
	private var excludedRects: [CGRect]
	private var onScroll: (CGSize) -> Void
	private var dragExclusions: [CGRect]
	private var onDrag: (CGSize) -> Void

	public init(
		isEnabled: Bool, excludedRects: [CGRect], dragExclusions: [CGRect] = [],
		onScroll: @escaping (CGSize) -> Void, onDrag: @escaping (CGSize) -> Void = { _ in }
	) {
		self.isEnabled = isEnabled
		self.excludedRects = excludedRects
		self.dragExclusions = dragExclusions
		self.onScroll = onScroll
		self.onDrag = onDrag
	}

	public func makeNSView(context: Context) -> TrackpadPanCaptureView {
		let view = TrackpadPanCaptureView()
		view.configure(
			isEnabled: isEnabled, excludedRects: excludedRects, dragExclusions: dragExclusions,
			onScroll: onScroll, onDrag: onDrag)
		return view
	}

	public func updateNSView(
		_ nsView: TrackpadPanCaptureView, context: Context
	) {
		nsView.configure(
			isEnabled: isEnabled, excludedRects: excludedRects, dragExclusions: dragExclusions,
			onScroll: onScroll, onDrag: onDrag)
	}

	public static func dismantleNSView(
		_ nsView: TrackpadPanCaptureView, coordinator: ()
	) {
		nsView.teardown()
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
	private var excludedRects: [CGRect] = []
	private var onScroll: ((CGSize) -> Void)?
	private var dragExclusions: [CGRect] = []
	private var onDrag: ((CGSize) -> Void)?
	private var dragOrigin: NSPoint?
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
		isEnabled: Bool, excludedRects: [CGRect], dragExclusions: [CGRect] = [],
		onScroll: @escaping (CGSize) -> Void, onDrag: @escaping (CGSize) -> Void = { _ in }
	) {
		self.isEnabled = isEnabled
		self.excludedRects = excludedRects
		self.dragExclusions = dragExclusions
		self.onScroll = onScroll
		self.onDrag = onDrag
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

	/// Whether a point in the view's own coordinates is canvas the capture
	/// owns: inside `bounds` and outside every covered rect.
	///
	/// The rects arrive in SwiftUI's space (origin top left) and this view
	/// is unflipped (origin bottom left), so the point is mapped once here
	/// rather than every rect being flipped.
	func capturesPoint(_ point: NSPoint, in bounds: NSRect) -> Bool {
		guard bounds.contains(point) else { return false }
		let topLeft = CGPoint(
			x: point.x - bounds.minX,
			y: bounds.maxY - point.y)
		return !excludedRects.contains { $0.contains(topLeft) }
	}

	private func ensureMonitor() {
		guard monitor == nil else { return }
		monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .leftMouseDown, .leftMouseDragged, .leftMouseUp]) {
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
		if event.type == .leftMouseDown {
			let topLeft = CGPoint(x: point.x - bounds.minX, y: bounds.maxY - point.y)
			dragOrigin = capturesPoint(point, in: bounds) && !dragExclusions.contains(where: { $0.contains(topLeft) }) ? point : nil
			return false
		}
		if event.type == .leftMouseUp { dragOrigin = nil; return false }
		if event.type == .leftMouseDragged, let origin = dragOrigin {
			let delta = CGSize(width: origin.x - point.x, height: point.y - origin.y)
			dragOrigin = point
			if delta != .zero { onDrag?(delta) }
			return false
		}
		guard event.type == .scrollWheel, capturesPoint(point, in: bounds) else { return false }
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
