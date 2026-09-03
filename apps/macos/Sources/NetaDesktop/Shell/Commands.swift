import SwiftUI

/// The six shell shortcuts (09-desktop-shell T9.6): `⌘L` navigator, `⌘K`
/// focus composer, `⌘.` cancel turn, `⌘0` Fit, `⌘=`/`⌘-` time zoom. Nothing
/// else is bound here.
///
/// The shell, store and client arrive from the environment, so T9.7's app
/// wiring only has to inject them on the scene (`.environment(shell)` and
/// friends propagate to commands; values set inside the window content do
/// not). Every lookup is optional: a missing value disables nothing and the
/// action no-ops, so previews without a Node stay usable.
///
/// Escape is deliberately absent: it calls `dismissOverlay()` via
/// `.onExitCommand` in the root view (T9.7), not through the command menu.
public struct NetaCommands: Commands {
	@Environment(ShellState.self) private var shell: ShellState?
	@Environment(Store.self) private var store: Store?
	@Environment(\.netaNodeClient) private var client: (any NodeClient)?

	public init() {}

	public var body: some Commands {
		CommandMenu("View") {
			Button("Toggle Navigator") { shell?.toggleNavigator() }
				.keyboardShortcut("l", modifiers: .command)
			Divider()
			Button("Fit Canvas") { shell?.fit() }
				.keyboardShortcut("0", modifiers: .command)
			Button("Zoom In") { shell?.zoomIn() }
				.keyboardShortcut("=", modifiers: .command)
			Button("Zoom Out") { shell?.zoomOut() }
				.keyboardShortcut("-", modifiers: .command)
		}
		CommandMenu("Session") {
			Button("Focus Composer") { shell?.composerFocused = true }
				.keyboardShortcut("k", modifiers: .command)
			Button("Cancel Turn") { cancelTurn() }
				.keyboardShortcut(".", modifiers: .command)
		}
	}

	// MARK: - Private

	/// Cancels the selected session's open turn through the Node client. A
	/// missing shell, store, client or session no-ops; a failed cancel is
	/// the Node's state to report, not the menu's.
	private func cancelTurn() {
		guard let shell, let store, let client,
			let sessionId = shell.sessionId(in: store)
		else { return }
		Task { try? await client.cancel(sessionId: sessionId) }
	}
}

private struct NetaNodeClientKey: EnvironmentKey {
	static let defaultValue: (any NodeClient)? = nil
}

extension EnvironmentValues {
	/// The Node client for command actions (`⌘.` cancel). Injected on the
	/// scene by the app entry point (T9.7); nil outside the running app.
	public var netaNodeClient: (any NodeClient)? {
		get { self[NetaNodeClientKey.self] }
		set { self[NetaNodeClientKey.self] = newValue }
	}
}
