import AppKit
import OSLog
import SwiftUI

/// The shell's menu commands (09-desktop-shell T9.6): `⌘L` navigator, `⌘K`
/// focus composer, `⌘.` cancel turn, `⌘0` Fit, `⌘=`/`⌘-` time zoom, and
/// File > Open Workspace… (`⌘O`). Nothing else is bound here.
///
/// The canvas commands go into the system **View** menu through
/// `CommandGroup(after: .sidebar)`; a second menu named "View" is a bug, not
/// a menu. The group carries no trailing `Divider()`: the system's own View
/// items follow it, and a separator immediately before them reads as a stray
/// line. Open Workspace goes into **File**, not the toolbar: the toolbar is
/// workspace, machine, Fit and zoom only (MANIFESTO.md "Desktop information
/// architecture").
///
/// The app passes the shared shell, store and client directly. SwiftUI scene
/// environment values do not reliably reach `Commands`; direct ownership is
/// what makes menu shortcuts act on the same window state as visible controls.
///
/// Escape is deliberately absent: it calls `dismissOverlay()` via
/// `.onExitCommand` in the root view (T9.7), not through the command menu.
public struct NetaCommands: Commands {
	private let shell: ShellState
	private let store: Store
	private let client: any NodeClient

	public init(shell: ShellState, store: Store, client: any NodeClient) {
		self.shell = shell
		self.store = store
		self.client = client
	}

	public var body: some Commands {
		CommandGroup(after: .newItem) {
			Button("New Project…") { createProject() }
				.keyboardShortcut("n", modifiers: [.command, .shift])
			Button("Open Workspace…") { chooseWorkspace() }
				.keyboardShortcut("o", modifiers: .command)
			Divider()
			Button("Install Command Line Tool…") {
				CommandLineToolInstaller.present()
			}
		}
		CommandGroup(after: .sidebar) {
			Button(Self.navigatorTitle(visible: shell.navigatorVisible)) {
				shell.toggleNavigator()
			}
			.keyboardShortcut("l", modifiers: .command)
			Divider()
			Button("Fit Canvas") { shell.fit() }
				.keyboardShortcut("0", modifiers: .command)
			Button("Zoom In") { shell.zoomIn() }
				.keyboardShortcut("=", modifiers: .command)
			Button("Zoom Out") { shell.zoomOut() }
				.keyboardShortcut("-", modifiers: .command)
		}
		CommandMenu("Session") {
			Button("Quick Switcher") { shell.showQuickSwitcher() }
				.keyboardShortcut("k", modifiers: .command)
			Button("Quick Switcher") { shell.showQuickSwitcher() }
				.keyboardShortcut("i", modifiers: .command)
			Button("Focus Composer") { shell.composerFocused = true }
				.keyboardShortcut("k", modifiers: [.command, .shift])
			Button("Cancel Turn") { cancelTurn() }
				.keyboardShortcut(".", modifiers: .command)
		}
	}

	/// The `⌘L` menu item's title, which says what the item will do:
	/// "Hide Navigator" while the overlay is up, "Show Navigator" while it is
	/// not (the macOS convention). The action is one toggle either way.
	///
	/// **Open question, needs a human with a real screen.** Driven from a
	/// headless rig the item's title never changes: it reads "Show Navigator"
	/// with the navigator up, even after `NSMenu.update` on the View submenu.
	/// Three routes were measured and all three failed identically — the
	/// observable read inline here, the read moved into a nested `View` with
	/// the shell injected, and the title passed in as a plain `Bool` from an
	/// App-level `@State` flipped at runtime. So the `NSMenuItem` title looks
	/// captured when the menu is built and never re-read, and no arrangement
	/// of *this* code changed that.
	///
	/// The caveat that keeps this open rather than closed: every measurement
	/// came from an app that could never be frontmost, and SwiftUI may simply
	/// not rebuild menus for a background app. One look at the View menu with
	/// the navigator open, on a real desktop, settles it. Until then do not
	/// refactor against the failure — a nested `View` here is a trap, because
	/// `@Environment(ShellState.self)` inside a view built in a `Commands`
	/// body resolves to **nil** (the view is not in the window hierarchy), and
	/// that silently turns `⌘L` into a no-op. That regression was shipped
	/// once and caught by the rig.
	static func navigatorTitle(visible: Bool) -> String {
		visible ? "Hide Navigator" : "Show Navigator"
	}

	/// Opens `path` as a workspace and refreshes the picture: the Node's
	/// `workspace.open` answers with the workspace, then one snapshot
	/// replaces the cache whole (never patched) and the shell shows the
	/// workspace that was just opened. Returns false when nothing changed.
	///
	/// A Node that refuses leaves the store untouched, and the reason is
	/// logged rather than dropped: a folder the Node rejects (not a
	/// directory, no permission, an unsupported root) and a Node that is up
	/// but answers with an error both used to end here silently. The shell
	/// has no error surface of its own — adding one is outside T9.6, and
	/// MANIFESTO.md "Desktop information architecture" reserves the window's
	/// surfaces — so the log is where the reason lands until the shell grows
	/// one.
	///
	/// The reason is public and the path is not: the unified log is readable
	/// by anything on the machine, and a person's absolute checkout path is
	/// theirs. `os.Logger` redacts a non-public interpolation, so Console
	/// shows the error with `<private>` where the path was, which still says
	/// why the open failed.
	@MainActor
	@discardableResult
	static func openWorkspace(path: String, client: any NodeClient, store: Store) async -> Bool {
		do {
			let workspace = try await client.openWorkspace(path: path)
			let snapshot = try await client.snapshot()
			store.replace(snapshot: snapshot)
			store.setCurrentWorkspace(workspace.id)
			store.markSessionsReady()
			return true
		} catch {
			log.error(
				"workspace.open failed: \(String(describing: error), privacy: .public) (path \(path, privacy: .private))"
			)
			return false
		}
	}

	/// The shell's log. `os.Logger` is the platform's own sink, so a refusal
	/// is readable in Console without the window growing a surface for it.
	static let log = Logger(subsystem: "io.neta.desktop", category: "shell")

	// MARK: - Private

	/// File > Open Workspace…: a directory chooser, because a workspace is a
	/// checkout, not a file.
	private func chooseWorkspace() {
		let panel = NSOpenPanel()
		panel.canChooseDirectories = true
		panel.canChooseFiles = false
		panel.allowsMultipleSelection = false
		panel.message = "Choose the folder to open as a workspace."
		panel.prompt = "Open"
		guard panel.runModal() == .OK, let url = panel.url else { return }
		Task { await NetaCommands.openWorkspace(path: url.path, client: client, store: store) }
	}

	/// Cancels the selected session's open turn through the Node client. A
	/// missing shell, store, client or session no-ops; a failed cancel is
	/// the Node's state to report, not the menu's.
	private func cancelTurn() {
		guard let sessionId = shell.sessionId(in: store)
		else { return }
		Task { try? await client.cancel(sessionId: sessionId) }
	}

	private func createProject() {
		let panel = NSSavePanel()
		panel.title = "New Project"
		panel.prompt = "Create"
		panel.canCreateDirectories = true
		panel.nameFieldStringValue = "Project name"
		guard panel.runModal() == .OK, let url = panel.url else { return }
		Task { @MainActor in
			guard !FileManager.default.fileExists(atPath: url.path) else { return }
			do {
				try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
				_ = await Self.openWorkspace(path: url.path, client: client, store: store)
			} catch {
				Self.log.error("new project failed: \(String(describing: error), privacy: .public)")
			}
		}
	}
}

private struct NetaNodeClientKey: EnvironmentKey {
	static let defaultValue: (any NodeClient)? = nil
}

extension EnvironmentValues {
	/// The Node client for command actions (`⌘.` cancel, `⌘O` open
	/// workspace). Injected on the scene by the app entry point (T9.7); nil
	/// outside the running app.
	public var netaNodeClient: (any NodeClient)? {
		get { self[NetaNodeClientKey.self] }
		set { self[NetaNodeClientKey.self] = newValue }
	}
}
