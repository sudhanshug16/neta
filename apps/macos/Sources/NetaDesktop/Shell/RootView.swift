import SwiftUI

/// The window content (09-desktop-shell T9.7).
///
/// A `GeometryReader` over a `ZStack`: the canvas fills the window, and the
/// toolbar capsule (top centre, 12 down), navigator, chat and mission bar
/// float above it, each in `.netaGlass(...)` and positioned from
/// `ShellLayout.compute(size:chatVisible:navigatorVisible:)`. The canvas keeps
/// the full window and is told which rects are covered (`ShellLayout.covered`)
/// so floating surfaces never steal its trackpad panning.
///
/// Escape closes the top overlay via `.onExitCommand` (the T9.6 wiring); the
/// six `⌘` shortcuts live in `NetaCommands`.
public struct RootView: View {
	private let store: Store
	private let shell: ShellState
	private let client: any NodeClient

	/// - Parameters:
	///   - store: The app's picture of the Node; views own nothing.
	///   - shell: The person's view: selection, overlays, focus, zoom.
	///   - client: The Node transport. The shell itself only reads; the chat
	///     (11) and canvas (10) prompt through it.
	public init(store: Store, shell: ShellState, client: any NodeClient) {
		self.store = store
		self.shell = shell
		self.client = client
	}

	public var body: some View {
		GeometryReader { proxy in
			let layout = ShellLayout.compute(
				size: proxy.size,
				chatVisible: shell.chatVisible,
				navigatorVisible: shell.navigatorVisible)
			ZStack {
				SpineCanvasView(store: store, shell: shell)
					.frame(width: layout.canvas.width, height: layout.canvas.height)
				VStack(spacing: 0) {
					ToolbarPlaceholder()
						.netaGlass(.capsule)
					Spacer(minLength: 0)
				}
				.padding(.top, Theme.Metric.barGap)
				.frame(width: layout.canvas.width, height: layout.canvas.height)
				if let navigator = layout.navigator {
					NavigatorPlaceholder()
						.netaGlass()
						.frame(width: navigator.width, height: navigator.height)
						.position(x: navigator.midX, y: navigator.midY)
				}
				if let chat = layout.chat {
					ChatPanel(client: client, store: store, shell: shell, windowWidth: proxy.size.width)
						.netaGlass()
						.frame(width: chat.width, height: chat.height)
						.position(x: chat.midX, y: chat.midY)
				}
				MissionBarPlaceholder()
					.netaGlass(.capsule)
					.frame(width: layout.missionBar.width, height: layout.missionBar.height)
					.position(x: layout.missionBar.midX, y: layout.missionBar.midY)
			}
			.frame(width: proxy.size.width, height: proxy.size.height)
			.background(Theme.ground)
			.onExitCommand { _ = shell.dismissOverlay() }
		}
	}
}

/// Stand-in for the spine canvas (10): fills the window, full-bleed, and is
/// told which rects floating surfaces cover so trackpad panning that starts
/// on glass never reaches the canvas.
public struct CanvasPlaceholder: View {
	/// Floating-surface rects, in window coordinates, the canvas must not pan from.
	public let covered: [CGRect]

	public init(covered: [CGRect] = []) {
		self.covered = covered
	}

	public var body: some View {
		Theme.ground.overlay {
			Text("Canvas")
				.font(Theme.text(13, .regular))
				.foregroundStyle(Theme.textSecondary)
		}
	}
}

/// Stand-in for the chat surface (11): 410 wide on the right, top 48, hidden
/// only by the person's toggle.
public struct ChatPlaceholder: View {
	public init() {}

	public var body: some View {
		Text("Chat")
			.font(Theme.text(13, .regular))
			.foregroundStyle(Theme.textSecondary)
			.frame(maxWidth: .infinity, maxHeight: .infinity)
	}
}

/// Stand-in for the toolbar capsule (T9.8): top centre, 12 down.
public struct ToolbarPlaceholder: View {
	public init() {}

	public var body: some View {
		Text("Toolbar")
			.font(Theme.text(13, .regular))
			.foregroundStyle(Theme.textSecondary)
			.padding(.horizontal, 16)
			.padding(.vertical, 8)
	}
}

/// Stand-in for the mission bar (T9.9): a 52-tall capsule 16 inset along the
/// bottom.
public struct MissionBarPlaceholder: View {
	public init() {}

	public var body: some View {
		Text("Mission bar")
			.font(Theme.text(13, .regular))
			.foregroundStyle(Theme.textSecondary)
			.frame(maxWidth: .infinity, maxHeight: .infinity)
	}
}

/// Stand-in for the navigator overlay (T9.10): a 300-wide overlay 12 inset in
/// the chat's band.
public struct NavigatorPlaceholder: View {
	public init() {}

	public var body: some View {
		Text("Navigator")
			.font(Theme.text(13, .regular))
			.foregroundStyle(Theme.textSecondary)
			.frame(maxWidth: .infinity, maxHeight: .infinity)
	}
}
