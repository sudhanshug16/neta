import SwiftUI

/// The app entry point (09-desktop-shell T9.7).
///
/// Builds one `Store`, one `ShellState` and one `SocketNodeClient`, then runs
/// the sync loop: `connect()`, `snapshot()` into `replace(snapshot:)`, live
/// `notifications` into `apply(notification:)`. When the stream ends the Node
/// went away, so the loop reconnects and replaces the cache whole with a full
/// snapshot — the cache is never patched across connections.
///
/// The window stays `.hiddenTitleBar`, 1600x1000 default, 1100x700 minimum.
/// The store, shell and client are injected on the scene so `NetaCommands`
/// (which reads them from the environment) sees them; values set inside the
/// window content would not propagate to commands.
@main
struct NetaDesktopApp: App {
	@State private var store = Store()
	@State private var shell = ShellState()
	private let client: any NodeClient = SocketNodeClient()

	var body: some Scene {
		WindowGroup {
			RootView(store: store, shell: shell, client: client)
				.preferredColorScheme(.dark)
				.frame(minWidth: 1100, minHeight: 700)
				.task {
					while !Task.isCancelled {
						do {
							try await client.connect()
							let snapshot = try await client.snapshot()
							store.replace(snapshot: snapshot)
							for await notification in client.notifications {
								store.apply(notification: notification)
							}
						} catch is CancellationError {
							break
						} catch {
							try? await Task.sleep(for: .seconds(1))
						}
					}
				}
		}
		.windowStyle(.hiddenTitleBar)
		.defaultSize(width: 1600, height: 1000)
		.commands { NetaCommands() }
		.environment(shell)
		.environment(store)
		.environment(\.netaNodeClient, client)
	}
}
