import AppKit
import SwiftUI

struct TrackpadPanCapture: NSViewRepresentable {
	let onPan: @MainActor (CGSize) -> Void

	func makeNSView(context: Context) -> TrackpadPanView {
		let view = TrackpadPanView()
		view.onPan = onPan
		return view
	}

	func updateNSView(_ view: TrackpadPanView, context: Context) {
		view.onPan = onPan
	}
}

@MainActor
final class TrackpadPanView: NSView {
	var onPan: (@MainActor (CGSize) -> Void)?

	private var eventMonitor: EventMonitorToken?
	private var pendingDelta = CGSize.zero
	private var deliveryScheduled = false

	override func viewDidMoveToWindow() {
		super.viewDidMoveToWindow()
		removeEventMonitor()
		guard window != nil else { return }

		eventMonitor = EventMonitorToken(
			NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
				self?.handle(event) ?? event
			}
		)
	}

	deinit {
		if let value = eventMonitor?.value {
			NSEvent.removeMonitor(value)
		}
	}

	private func handle(_ event: NSEvent) -> NSEvent? {
		guard event.window === window else { return event }
		let location = convert(event.locationInWindow, from: nil)
		guard bounds.contains(location) else { return event }

		let multiplier: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 18
		pendingDelta.width += event.scrollingDeltaX * multiplier
		pendingDelta.height += event.scrollingDeltaY * multiplier
		scheduleDelivery()
		return nil
	}

	private func scheduleDelivery() {
		guard !deliveryScheduled else { return }
		deliveryScheduled = true
		DispatchQueue.main.async { [weak self] in
			guard let self else { return }
			let delta = pendingDelta
			pendingDelta = .zero
			deliveryScheduled = false
			onPan?(delta)
		}
	}

	private func removeEventMonitor() {
		guard let eventMonitor else { return }
		if let value = eventMonitor.value {
			NSEvent.removeMonitor(value)
		}
		self.eventMonitor = nil
	}
}

private final class EventMonitorToken: @unchecked Sendable {
	let value: Any?

	init(_ value: Any?) {
		self.value = value
	}
}
