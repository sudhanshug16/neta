import AppKit
import SwiftUI

/// The window's own chrome (09-desktop-shell T9.7).
///
/// SwiftUI's `.windowStyle(.hiddenTitleBar)` hides the title bar but leaves
/// the window taking the system appearance and, on this SDK, without the
/// full-size content mask: the canvas started below an empty strip where the
/// title bar had been, and the Liquid Glass material resolved against Aqua
/// and rendered pale grey instead of the Revision 3 dark material.
///
/// The design is dark only (BRIEF.md: ground `#0E0F13`, every token a dark
/// token; PAPER-SPINE Revision 3 states its material "dark mode"), so the
/// window is pinned to `darkAqua` rather than following the person's system
/// setting, and the content is made full-size so the canvas runs to the top
/// edge with the traffic lights over it. The traffic lights themselves are
/// left exactly as the system draws them.
public enum WindowChrome {
	/// Applies the chrome to one window. Idempotent, so the configurator can
	/// call it on every layout pass.
	@MainActor
	public static func apply(to window: NSWindow) {
		window.appearance = NSAppearance(named: .darkAqua)
		window.styleMask.insert(.fullSizeContentView)
		window.titlebarAppearsTransparent = true
		window.titleVisibility = .hidden
		window.isMovableByWindowBackground = false
		window.backgroundColor = .black
	}
}

/// Reaches the `NSWindow` behind the SwiftUI scene and applies
/// `WindowChrome`. It draws nothing.
public struct WindowChromeConfigurator: NSViewRepresentable {
	public typealias NSViewType = NSView

	public init() {}

	public func makeNSView(context: Context) -> NSView {
		let view = NSView(frame: .zero)
		DispatchQueue.main.async {
			if let window = view.window { WindowChrome.apply(to: window) }
		}
		return view
	}

	public func updateNSView(_ nsView: NSView, context: Context) {
		DispatchQueue.main.async {
			if let window = nsView.window { WindowChrome.apply(to: window) }
		}
	}
}
