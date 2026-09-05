import SwiftUI

/// The app entry point (09-desktop-shell T9.7).
///
/// Builds one `Store`, one `ShellState` and one `SocketNodeClient`, then runs
/// `NodeSync.run`: `connect()`, `snapshot()` into `replace(snapshot:)`, live
/// `notifications` into `apply(notification:)`. When the stream ends the Node
/// went away, so the loop reconnects and replaces the cache whole with a full
/// snapshot — the cache is never patched across connections.
///
/// The window stays `.hiddenTitleBar`, 1600x1000 default, 1100x700 minimum,
/// and `WindowChrome` pins it to the dark appearance and full-size content so
/// the canvas runs under the traffic lights instead of starting below an
/// empty strip.
/// The store, shell and client are injected on the scene so `NetaCommands`
/// (which reads them from the environment) sees them; values set inside the
/// window content would not propagate to commands.
@main
struct NetaDesktopApp: App {
	@State private var store = Store()
	@State private var shell = ShellState()
	@State private var syncController = NodeSyncController()
	@State private var workspaceResume = WorkspaceResumeController()
	private let client: any NodeClient = SocketNodeClient()

	init() {
		// SwiftUI builds its hosting accessibility tree during scene creation.
		// Enable the richer in-process tree first when, and only when, the
		// file-driven test driver was explicitly requested.
		DebugDriver.enableAccessibilityIfRequested()
	}

	var body: some Scene {
		WindowGroup {
			RootView(store: store, shell: shell, client: client, workspaceResume: workspaceResume)
				.preferredColorScheme(.dark)
				// The window itself, not only the SwiftUI environment: the
				// glass material and the title-bar strip are AppKit's.
				.background(WindowChromeConfigurator())
				.ignoresSafeArea(.all)
				.frame(minWidth: 1100, minHeight: 700)
				.onAppear { syncController.start(generation: store.nodeRecoveryGeneration, client: client, store: store, workspaceResume: workspaceResume) }
				.onChange(of: store.nodeRecoveryGeneration) { _, generation in
					syncController.start(generation: generation, client: client, store: store, workspaceResume: workspaceResume)
				}
				// Debug only, and dormant unless NETA_DEBUG_DRIVER names a
				// directory: see DebugDriver.
				.onAppear { DebugDriver.startIfEnabled(store: store, shell: shell) }
		}
		.windowStyle(.hiddenTitleBar)
		.defaultSize(width: 1600, height: 1000)
		.commands { NetaCommands(shell: shell, store: store, client: client) }
		.environment(shell)
		.environment(store)
		.environment(\.netaNodeClient, client)
	}
}

@Observable @MainActor public final class NodeSyncController {
	private var generation: Int?
	private var task: Task<Void, Never>?
	public init() {}

	public func start(generation: Int, client: any NodeClient, store: Store, workspaceResume: WorkspaceResumeController) {
		guard self.generation != generation else { return }
		self.generation = generation
		task?.cancel()
		task = Task { await NodeSync.run(client: client, store: store, workspaceResume: workspaceResume) }
	}
}

@Observable @MainActor public final class WorkspaceResumeController {
	private var generation = 0
	private var task: Task<Void, Never>?
	public init() {}

	public func resume(workspaceId: WorkspaceId, client: any NodeClient, store: Store) async {
		generation += 1
		let requested = generation
		task?.cancel()
		store.beginSessionsResume()
		let next = Task { @MainActor in
			do {
				guard let workspace = store.workspaces.first(where: { $0.id == workspaceId }) else { return }
				guard let root = workspace.roots.first(where: { $0.machineId == store.machine?.id }) else {
					guard generation == requested, store.currentWorkspaceId == workspaceId else { return }
					if store.leader == nil { store.markSessionsReady() }
					else { store.setNodeError("This workspace is not available on this Mac.") }
					return
				}
				_ = try await client.openWorkspace(path: root.path)
				let snapshot = try await client.snapshot()
				guard !Task.isCancelled, generation == requested, store.currentWorkspaceId == workspaceId else { return }
				store.replace(snapshot: snapshot)
				store.setNodeError(nil)
				store.markSessionsReady()
			} catch is CancellationError {
				return
			} catch {
				guard generation == requested, store.currentWorkspaceId == workspaceId else { return }
				store.setNodeError("Provider could not resume: \(error.localizedDescription)")
			}
		}
		task = next
		await next.value
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
		workspaceResume: WorkspaceResumeController = WorkspaceResumeController(),
		backoff: @Sendable (Int) -> Duration = NodeSync.backoff(afterFailure:)
	) async {
		var failures = 0
		var upgradeAttempted = false
		while !Task.isCancelled {
			do {
				try await client.connect()
				upgradeAttempted = false
				failures = 0
				store.setNodeOffline(false)
				store.setNodeError(nil)
				// Subscribe before the snapshot request. A subscription
				// carries only what is broadcast after it is taken, so a
				// notification the Node sends while the snapshot is in
				// flight would otherwise fall between the two calls and
				// never reach the store until the next reconnect.
				let stream = client.notifications
				store.beginSessionsResume()
				let snapshot = try await client.snapshot()
				store.replace(snapshot: snapshot)
				// A fresh Node has durable workspace and leader records but no
				// live ACP processes. Reopen the workspace the app was showing so
				// its recorded session is resumed before chat becomes interactive.
				let wanted = store.currentWorkspaceId ?? snapshot.workspaces.first?.id
				if let workspace = snapshot.workspaces.first(where: { $0.id == wanted }) {
					await workspaceResume.resume(workspaceId: workspace.id, client: client, store: store)
				} else {
					// A snapshot with no resumable session is safe to browse. There
					// is no ACP owner to wait for and composer RPCs remain gated by
					// their empty session id.
					store.markSessionsReady()
				}
				for await notification in stream {
					store.apply(notification: notification)
				}
			} catch is CancellationError {
				return
			} catch let error as NodeClientError {
				if case .protocolMismatch = error, !upgradeAttempted {
					upgradeAttempted = true
					store.beginNodeRecovery()
					do {
						try await client.stopIncompatibleNode()
						store.finishNodeRecovery(error: nil)
						continue
					} catch {
						store.finishNodeRecovery(error: "The Neta service could not be updated: \(error.localizedDescription)")
					}
				} else if case .runtimeMismatch = error, !upgradeAttempted {
					upgradeAttempted = true
					store.beginNodeRecovery()
					do {
						try await client.stopIncompatibleNode()
						store.finishNodeRecovery(error: nil)
						continue
					} catch {
						store.finishNodeRecovery(error: "The Neta service could not be updated: \(error.localizedDescription)")
					}
				} else {
					store.setNodeError(error.localizedDescription)
				}
				failures += 1
				if failures >= fastAttempts { store.setNodeOffline(true) }
				do { try await Task.sleep(for: backoff(failures)) } catch { return }
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
