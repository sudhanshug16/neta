import SwiftUI

/// The app entry point (09-desktop-shell T9.7).
///
/// Builds one `Store`, one `ShellState` and one `SocketNodeClient`, then runs
/// `NodeSync.run`: `connect()`, `snapshot()` into `replace(snapshot:)`, live
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
				.task { await NodeSync.run(client: client, store: store) }
		}
		.windowStyle(.hiddenTitleBar)
		.defaultSize(width: 1600, height: 1000)
		.commands { NetaCommands() }
		.environment(shell)
		.environment(store)
		.environment(\.netaNodeClient, client)
	}
}

/// The app's sync loop, split out of the scene so it can be tested.
///
/// Every failing `connect()` starts a Node once, so a Node that cannot start
/// used to leave a growing trail of children behind a one-second retry loop
/// (FIXPASS G4-2). The loop now backs off — 1, 2, 4, 8 s — and on the fifth
/// failure records the Node as offline on the store and keeps trying at
/// `slowInterval`, so the machine reads `Offline` and the app costs one
/// attempt every 30 s instead of one a second. The client stops launching a
/// Node after the same five attempts. A successful connect clears the flag and
/// the count, and the loop carries on as before.
public enum NodeSync {
	/// Failures before the Node counts as offline.
	public static let fastAttempts = 5
	/// The retry interval once the Node counts as offline.
	public static let slowInterval: Duration = .seconds(30)

	/// The wait after `attempt` consecutive failures (1-based): 1, 2, 4, 8 s
	/// while attempts remain, then `slowInterval` forever.
	public static func backoff(afterFailure attempt: Int) -> Duration {
		guard attempt < fastAttempts else { return slowInterval }
		return .seconds(1 << max(attempt - 1, 0))
	}

	/// Connects, snapshots and folds notifications into the store until the
	/// task is cancelled. `backoff` is a seam for the tests, which cannot
	/// wait out the real one.
	@MainActor
	public static func run(
		client: any NodeClient, store: Store,
		backoff: @Sendable (Int) -> Duration = NodeSync.backoff(afterFailure:)
	) async {
		var failures = 0
		while !Task.isCancelled {
			do {
				try await client.connect()
				failures = 0
				store.setNodeOffline(false)
				// Subscribe before the snapshot request. A subscription
				// carries only what is broadcast after it is taken, so a
				// notification the Node sends while the snapshot is in
				// flight would otherwise fall between the two calls and
				// never reach the store until the next reconnect.
				let stream = client.notifications
				let snapshot = try await client.snapshot()
				store.replace(snapshot: snapshot)
				for await notification in stream {
					store.apply(notification: notification)
				}
			} catch is CancellationError {
				return
			} catch {
				failures += 1
				if failures >= fastAttempts {
					store.setNodeOffline(true)
				}
				do {
					try await Task.sleep(for: backoff(failures))
				} catch {
					return
				}
			}
		}
	}
}
