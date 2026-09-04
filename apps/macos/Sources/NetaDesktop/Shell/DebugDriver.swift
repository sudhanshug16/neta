import AppKit
import Foundation

/// One command the debug driver understands.
///
/// The parse is pure and total: every line either becomes a command or
/// throws a `DebugCommandError` carrying the reason, so the driver never has
/// to guess what an unrecognised line meant.
public enum DebugCommand: Hashable, Sendable {
	case navigator(Bool)
	case selectLeader
	case selectMission(Int)
	case selectAgent(String)
	case zoomIn
	case zoomOut
	case fit
	case now
	case chat(Bool)
	case resize(width: Double, height: Double)
	case wait(milliseconds: Int)
	case shot(path: String)
	case menu
	/// Reports the real window chrome: appearance, style mask and whether
	/// the content runs under the title bar. The only way to see, on a
	/// machine whose window server composites nothing, that `WindowChrome`
	/// actually landed.
	case window
	case state
	/// The modifiers are a raw `NSEvent.ModifierFlags` value:
	/// `ModifierFlags` is not `Hashable`, and this enum is.
	case key(characters: String, modifiers: UInt)
	case click(x: Double, y: Double)
	case quit

	/// Parses one line. The verb is case-insensitive; a `shot` path keeps
	/// its spaces because it is the whole remainder of the line, and an
	/// agent name keeps its case because the resolve, not the parse, is what
	/// folds case.
	public static func parse(_ line: String) throws -> DebugCommand {
		let trimmed = line.trimmingCharacters(in: .whitespaces)
		guard !trimmed.isEmpty else {
			throw DebugCommandError("empty command")
		}
		let head = trimmed.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
		let verb = head[0].lowercased()
		let rest = head.count > 1
			? String(head[1]).trimmingCharacters(in: .whitespaces) : ""
		switch verb {
		case "navigator":
			return .navigator(try onOff(rest, verb: verb))
		case "chat":
			return .chat(try onOff(rest, verb: verb))
		case "zoom":
			switch rest.lowercased() {
			case "in": return .zoomIn
			case "out": return .zoomOut
			default:
				throw DebugCommandError("zoom wants in or out, got \(quoted(rest))")
			}
		case "select":
			return try parseSelect(rest)
		case "fit":
			try requireNoArgument(rest, verb: verb)
			return .fit
		case "now":
			try requireNoArgument(rest, verb: verb)
			return .now
		case "quit":
			try requireNoArgument(rest, verb: verb)
			return .quit
		case "resize":
			let parts = rest.split(separator: " ", omittingEmptySubsequences: true)
			guard parts.count == 2,
				let width = Double(parts[0]), let height = Double(parts[1]),
				width > 0, height > 0
			else {
				throw DebugCommandError(
					"resize wants two positive numbers, got \(quoted(rest))")
			}
			return .resize(width: width, height: height)
		case "wait":
			guard let ms = Int(rest), ms >= 0 else {
				throw DebugCommandError(
					"wait wants milliseconds, got \(quoted(rest))")
			}
			return .wait(milliseconds: ms)
		case "shot":
			guard !rest.isEmpty else {
				throw DebugCommandError("shot wants a path")
			}
			return .shot(path: rest)
		case "menu":
			try requireNoArgument(rest, verb: verb)
			return .menu
		case "window":
			try requireNoArgument(rest, verb: verb)
			return .window
		case "state":
			try requireNoArgument(rest, verb: verb)
			return .state
		case "key":
			return try parseKey(rest)
		case "click":
			let parts = rest.split(separator: " ", omittingEmptySubsequences: true)
			guard parts.count == 2,
				let x = Double(parts[0]), let y = Double(parts[1])
			else {
				throw DebugCommandError(
					"click wants two numbers, got \(quoted(rest))")
			}
			return .click(x: x, y: y)
		default:
			throw DebugCommandError("unknown command \(quoted(verb))")
		}
	}

	// MARK: - Private

	private static func parseSelect(_ rest: String) throws -> DebugCommand {
		let parts = rest.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
		guard let kind = parts.first?.lowercased() else {
			throw DebugCommandError("select wants leader, mission or agent")
		}
		let argument = parts.count > 1
			? String(parts[1]).trimmingCharacters(in: .whitespaces) : ""
		switch kind {
		case "leader":
			guard argument.isEmpty else {
				throw DebugCommandError(
					"select leader takes no argument, got \(quoted(argument))")
			}
			return .selectLeader
		case "mission":
			guard let number = Int(argument) else {
				throw DebugCommandError(
					"select mission wants a number, got \(quoted(argument))")
			}
			return .selectMission(number)
		case "agent":
			guard !argument.isEmpty else {
				throw DebugCommandError("select agent wants a name")
			}
			return .selectAgent(argument)
		default:
			throw DebugCommandError(
				"select wants leader, mission or agent, got \(quoted(kind))")
		}
	}

	/// `key cmd+l`, `key cmd+shift+n`, `key escape`. The modifier names are
	/// `cmd`, `shift`, `opt`, `ctrl`; the key itself is one character or one
	/// of the named keys below.
	private static func parseKey(_ rest: String) throws -> DebugCommand {
		guard !rest.isEmpty else {
			throw DebugCommandError("key wants a keystroke, e.g. cmd+l")
		}
		var modifiers: NSEvent.ModifierFlags = []
		var characters: String?
		for piece in rest.lowercased().split(separator: "+", omittingEmptySubsequences: true) {
			switch piece {
			case "cmd", "command": modifiers.insert(.command)
			case "shift": modifiers.insert(.shift)
			case "opt", "option", "alt": modifiers.insert(.option)
			case "ctrl", "control": modifiers.insert(.control)
			case "escape", "esc": characters = "\u{1B}"
			case "return", "enter": characters = "\r"
			case "tab": characters = "\t"
			case "space": characters = " "
			default:
				guard piece.count == 1 else {
					throw DebugCommandError(
						"key does not know \(quoted(String(piece)))")
				}
				characters = String(piece)
			}
		}
		guard let characters else {
			throw DebugCommandError("key wants a key, not only modifiers")
		}
		return .key(characters: characters, modifiers: modifiers.rawValue)
	}

	private static func onOff(_ value: String, verb: String) throws -> Bool {
		switch value.lowercased() {
		case "on": return true
		case "off": return false
		default:
			throw DebugCommandError(
				"\(verb) wants on or off, got \(quoted(value))")
		}
	}

	private static func requireNoArgument(_ rest: String, verb: String) throws {
		guard rest.isEmpty else {
			throw DebugCommandError(
				"\(verb) takes no argument, got \(quoted(rest))")
		}
	}

	private static func quoted(_ value: String) -> String {
		value.isEmpty ? "nothing" : "\"\(value)\""
	}
}

/// Why a line was refused. The text is what lands after `error <line>: ` in
/// the driver's log, so it is written to be read by a person at a shell.
public struct DebugCommandError: Error, CustomStringConvertible, Hashable, Sendable {
	public let description: String

	public init(_ description: String) {
		self.description = description
	}
}

/// A file-driven remote control for the running app (debug only).
///
/// It exists because this project is built and checked on Macs with no
/// display attached, no Screen Recording permission and no Accessibility
/// permission: nothing outside the app may drive it or photograph it. The
/// driver runs *inside* the app, so it needs neither permission — an app is
/// always allowed to move its own state and to capture its own windows.
///
/// Everything is gated on `NETA_DEBUG_DRIVER` holding a directory path. With
/// the variable unset `startIfEnabled` returns nil, no object is built, no
/// task runs and no file is read or written.
///
/// The protocol is two files in that directory, so a shell can drive it:
///
/// - `<dir>/cmd` — one command per line. The driver polls it every 200 ms,
///   and only takes the contents once they end in a newline, so a half-written
///   `echo "shot a.png" > <dir>/cmd` is skipped and picked up on the next
///   tick instead of being run in halves. Taking it deletes the file, so the
///   caller can wait for the file to disappear.
/// - `<dir>/log` — one result line per command, appended: `ok <line>` (with a
///   trailing note for `shot`) or `error <line>: <reason>`.
///
/// `now` asks the shell for the live edge (`ShellState.jumpToNow`), which is
/// the same wire the mission bar's Now control uses; the canvas observes
/// `nowRequested` and jumps.
///
/// Driving it, both learned the hard way on the headless Mac:
///
/// - Launch through `open -F -n --env NETA_DIR=... --env
///   NETA_DEBUG_DRIVER=... -a <bundle>`. Without `-F`, a stale
///   `~/Library/Saved Application State/dev.neta.desktop.savedState` leaves
///   the app running with no window at all — the process starts, the run
///   loop turns, no view ever appears, so the driver never starts and there
///   is no error to read, only silence.
/// - Expect `shot` to log `via view` and treat it as normal. With nobody
///   logged in graphically the window server discards the surface of a
///   window that is not frontmost, so the window capture comes back
///   transparent and the fallback draws the content view instead. Everything
///   renders except the Liquid Glass blur, which flattens to the fill
///   colour. This rig cannot answer a question about the blur itself.
@MainActor public final class DebugDriver {
	/// The environment variable that turns the driver on; its value is the
	/// directory holding `cmd` and `log`.
	public static let environmentKey = "NETA_DEBUG_DRIVER"
	/// How often `cmd` is checked.
	public static let pollInterval: Duration = .milliseconds(200)

	/// Keeps the running driver alive; the app has nowhere else to hold it.
	private static var running: DebugDriver?

	private let directory: URL
	private let store: Store
	private let shell: ShellState
	private var pump: Task<Void, Never>?

	public init(directory: URL, store: Store, shell: ShellState) {
		self.directory = directory
		self.store = store
		self.shell = shell
	}

	/// Builds and starts the driver when `NETA_DEBUG_DRIVER` names a
	/// directory, and returns nil otherwise without touching the filesystem.
	/// Starting twice is a no-op: the second call returns the running driver.
	@discardableResult
	public static func startIfEnabled(
		store: Store, shell: ShellState,
		environment: [String: String] = ProcessInfo.processInfo.environment
	) -> DebugDriver? {
		if let running { return running }
		guard let path = environment[environmentKey],
			!path.trimmingCharacters(in: .whitespaces).isEmpty
		else { return nil }
		let driver = DebugDriver(
			directory: URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true),
			store: store, shell: shell)
		running = driver
		driver.start()
		return driver
	}

	/// Starts the poll loop and writes the opening log line.
	public func start() {
		guard pump == nil else { return }
		try? FileManager.default.createDirectory(
			at: directory, withIntermediateDirectories: true)
		try? FileManager.default.removeItem(at: commandURL)
		append("ok driver started")
		pump = Task { [weak self] in
			while !Task.isCancelled {
				try? await Task.sleep(for: DebugDriver.pollInterval)
				guard let self else { return }
				await self.drain()
			}
		}
	}

	public func stop() {
		pump?.cancel()
		pump = nil
	}

	/// Resolves an agent name against the store, folding case. Returns nil
	/// when no agent carries that name.
	public static func agentId(named name: String, in store: Store) -> Ulid? {
		let wanted = name.trimmingCharacters(in: .whitespaces).lowercased()
		return store.agentsById.values
			.first { $0.name.lowercased() == wanted }?
			.id
	}

	/// Runs one command line and returns the log line it produced. Exposed
	/// so a test can drive the same path the poll loop drives.
	@discardableResult
	public func execute(line: String) async -> String {
		var result: String
		var quitting = false
		do {
			let command = try DebugCommand.parse(line)
			let note = try await run(command)
			result = note.isEmpty ? "ok \(line)" : "ok \(line) \(note)"
			if command == .quit { quitting = true }
		} catch let error as DebugCommandError {
			result = "error \(line): \(error.description)"
		} catch {
			result = "error \(line): \(error)"
		}
		append(result)
		if quitting {
			stop()
			NSApplication.shared.terminate(nil)
		}
		return result
	}

	// MARK: - Private

	private var commandURL: URL { directory.appendingPathComponent("cmd", isDirectory: false) }
	private var logURL: URL { directory.appendingPathComponent("log", isDirectory: false) }

	/// Takes whatever `cmd` holds and runs it, one line at a time in order.
	private func drain() async {
		guard let lines = takeCommands() else { return }
		for line in lines {
			await execute(line: line)
		}
	}

	/// Reads and removes `cmd`, but only once the write looks finished (the
	/// contents end in a newline). Returns nil when there is nothing to run.
	private func takeCommands() -> [String]? {
		guard let data = FileManager.default.contents(atPath: commandURL.path),
			!data.isEmpty,
			let text = String(data: data, encoding: .utf8),
			text.hasSuffix("\n")
		else { return nil }
		try? FileManager.default.removeItem(at: commandURL)
		let lines = text
			.split(separator: "\n", omittingEmptySubsequences: true)
			.map { $0.trimmingCharacters(in: .whitespaces) }
			.filter { !$0.isEmpty }
		return lines.isEmpty ? nil : lines
	}

	/// Executes one parsed command; the returned string is a note appended
	/// to the `ok` line (empty for everything but `shot`).
	private func run(_ command: DebugCommand) async throws -> String {
		switch command {
		case .navigator(let on):
			if on { shell.showNavigator() } else { shell.hideNavigator() }
		case .chat(let on):
			shell.chatVisible = on
		case .selectLeader:
			shell.select(.leader)
		case .selectMission(let number):
			guard let mission = store.missionsByNumber[number] else {
				throw DebugCommandError("no mission numbered \(number)")
			}
			shell.select(.mission(mission.id))
		case .selectAgent(let name):
			guard let id = DebugDriver.agentId(named: name, in: store) else {
				throw DebugCommandError("no agent named \"\(name)\"")
			}
			shell.select(.agent(id))
		case .zoomIn:
			shell.zoomIn()
		case .zoomOut:
			shell.zoomOut()
		case .fit:
			shell.fit()
		case .now:
			shell.jumpToNow()
		case .resize(let width, let height):
			guard let window = targetWindow else {
				throw DebugCommandError("no window")
			}
			window.setContentSize(NSSize(width: width, height: height))
			window.displayIfNeeded()
		case .wait(let ms):
			try? await Task.sleep(for: .milliseconds(ms))
		case .shot(let path):
			return try await capture(to: path)
		case .menu:
			return DebugDriver.menuDump()
		case .window:
			guard let window = targetWindow else {
				throw DebugCommandError("no window")
			}
			return DebugDriver.chromeDump(window)
		case .state:
			let selection: String
			switch shell.selection {
			case .leader: selection = "leader"
			case .mission(let id):
				selection = "mission:" + (store.missionsById[id].map { "#\($0.number)" } ?? id)
			case .agent(let id):
				selection = "agent:" + (store.agentsById[id]?.name ?? id)
			}
			return "selection=\(selection)"
				+ " navigator=\(shell.navigatorVisible)"
				+ " chat=\(shell.chatVisible)"
				+ " composerFocused=\(shell.composerFocused)"
				+ " zoom=\(shell.zoomPercent)"
				+ " fitRequested=\(shell.fitRequested)"
				// Which session the chat resolves to, and how many workspaces
				// the Node listed: with two open, the wrong leader silently
				// answers the chat, and a blank transcript looks the same
				// whether the session is wrong or the tail never landed.
				+ " workspaces=\(store.workspaces.count)"
				+ " session=\(shell.sessionId(in: store) ?? "-")"
		case .key(let characters, let modifiers):
			return try sendKey(
				characters: characters,
				modifiers: NSEvent.ModifierFlags(rawValue: modifiers))
		case .click(let x, let y):
			return try await sendClick(x: x, y: y)
		case .quit:
			break
		}
		return ""
	}

	/// Every menu in the real `NSApp.mainMenu`, as
	/// `Menu > Item [key equivalent]`, separators as `-`.
	///
	/// This is the menu bar AppKit built from `NetaCommands`, not a model of
	/// it: a title that follows shell state (Show/Hide Navigator) reads here
	/// as whatever SwiftUI last wrote into the `NSMenuItem`.
	static func menuDump() -> String {
		guard let main = NSApplication.shared.mainMenu else {
			return "no main menu"
		}
		var lines: [String] = []
		func walk(_ menu: NSMenu, path: String) {
			// What AppKit does before it shows a menu; a title that follows
			// state is only guaranteed current after it.
			menu.update()
			for item in menu.items {
				if item.isSeparatorItem {
					lines.append("\(path) > -")
					continue
				}
				var line = "\(path) > \(item.title)"
				if !item.keyEquivalent.isEmpty {
					line += " [\(shortcut(item))]"
				}
				lines.append(line)
				if let submenu = item.submenu {
					walk(submenu, path: "\(path) > \(item.title)")
				}
			}
		}
		main.update()
		for item in main.items {
			lines.append(item.title)
			if let submenu = item.submenu {
				walk(submenu, path: item.title)
			}
		}
		return lines.joined(separator: " | ")
	}

	/// The window chrome as one line: appearance, full-size content, title
	/// bar transparency and how far the content view sits below the window
	/// top (0 when the canvas runs under the traffic lights).
	static func chromeDump(_ window: NSWindow) -> String {
		let appearance = window.effectiveAppearance.name.rawValue
		let full = window.styleMask.contains(.fullSizeContentView)
		let content = window.contentView?.frame.height ?? 0
		let inset = window.frame.height - content
		return "appearance=\(appearance) fullSizeContent=\(full) "
			+ "titlebarTransparent=\(window.titlebarAppearsTransparent) "
			+ "contentInset=\(Int(inset.rounded()))"
	}

	private static func shortcut(_ item: NSMenuItem) -> String {
		var text = ""
		if item.keyEquivalentModifierMask.contains(.control) { text += "ctrl+" }
		if item.keyEquivalentModifierMask.contains(.option) { text += "opt+" }
		if item.keyEquivalentModifierMask.contains(.shift) { text += "shift+" }
		if item.keyEquivalentModifierMask.contains(.command) { text += "cmd+" }
		return text + item.keyEquivalent
	}

	/// Key codes for the named keys the parser knows; everything else is
	/// matched by character, which is what menu key equivalents compare.
	private static func keyCode(for characters: String) -> UInt16 {
		switch characters {
		case "\u{1B}": return 53
		case "\r": return 36
		case "\t": return 48
		case " ": return 49
		default: return 0
		}
	}

	/// Offers one synthesized key-down to the real menu bar first, exactly as
	/// AppKit does for a hardware keystroke, and hands it to the window when
	/// no menu item claims it (which is how Escape reaches `.onExitCommand`).
	private func sendKey(
		characters: String, modifiers: NSEvent.ModifierFlags
	) throws -> String {
		guard let window = targetWindow else {
			throw DebugCommandError("no window")
		}
		NSApplication.shared.activate()
		window.makeKeyAndOrderFront(nil)
		guard let event = NSEvent.keyEvent(
			with: .keyDown,
			location: .zero,
			modifierFlags: modifiers,
			timestamp: ProcessInfo.processInfo.systemUptime,
			windowNumber: window.windowNumber,
			context: nil,
			characters: characters,
			charactersIgnoringModifiers: characters,
			isARepeat: false,
			keyCode: DebugDriver.keyCode(for: characters))
		else {
			throw DebugCommandError("could not build the key event")
		}
		if NSApplication.shared.mainMenu?.performKeyEquivalent(with: event) == true {
			return "via menu"
		}
		window.sendEvent(event)
		return "via window"
	}

	/// A synthesized click at a point in the window's own coordinates, origin
	/// bottom left, which is what `NSWindow` expects.
	private func sendClick(x: Double, y: Double) async throws -> String {
		guard let window = targetWindow else {
			throw DebugCommandError("no window")
		}
		NSApplication.shared.activate()
		window.makeKeyAndOrderFront(nil)
		let point = NSPoint(x: x, y: y)
		func event(_ type: NSEvent.EventType) -> NSEvent? {
			NSEvent.mouseEvent(
				with: type, location: point, modifierFlags: [],
				timestamp: ProcessInfo.processInfo.systemUptime,
				windowNumber: window.windowNumber, context: nil,
				eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)
		}
		guard let down = event(.leftMouseDown), let up = event(.leftMouseUp) else {
			throw DebugCommandError("could not build the mouse events")
		}
		// Through NSApp, which is where a real click enters: it runs the
		// window's own dispatch plus the tracking AppKit does around it.
		NSApplication.shared.sendEvent(down)
		try? await Task.sleep(for: .milliseconds(60))
		NSApplication.shared.sendEvent(up)
		return ""
	}

	/// The window the driver acts on: the main window when AppKit has one,
	/// else the first ordinary visible window. Headless, nothing is "main",
	/// so the fallback is what actually runs.
	private var targetWindow: NSWindow? {
		if let main = NSApplication.shared.mainWindow { return main }
		if let key = NSApplication.shared.keyWindow { return key }
		return NSApplication.shared.windows.first {
			$0.contentView != nil && !($0 is NSPanel)
		}
	}

	/// Captures the app's own window to a PNG.
	///
	/// `CGWindowListCreateImage` limited to one of our own window ids needs
	/// no Screen Recording permission and is the only path that includes what
	/// the window server composites — the Liquid Glass blur lives there, not
	/// in the view's own drawing. When it comes back nil or blank (which is
	/// what a headless window server does), the fallback draws the content
	/// view into a bitmap, which renders every view but flattens the glass.
	private func capture(to path: String) async throws -> String {
		guard let window = targetWindow else {
			throw DebugCommandError("no window")
		}
		// The window server only composites a window it is showing, so the
		// shutter brings it up first. One run loop turn plus a short settle
		// then lets a resize or a selection issued a moment ago lay out.
		NSApplication.shared.activate()
		window.orderFrontRegardless()
		window.displayIfNeeded()
		await Task.yield()
		try? await Task.sleep(for: .milliseconds(150))
		let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
		try? FileManager.default.createDirectory(
			at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
		let skipped: String
		if let image = DebugDriver.ownWindowImage(id: CGWindowID(window.windowNumber)) {
			if image.width > 1, image.height > 1, !DebugDriver.isBlank(image) {
				try write(image, to: url)
				return "via window"
			}
			skipped = image.width > 1 && image.height > 1
				? "window capture blank" : "window capture too small"
		} else {
			skipped = DebugDriver.windowImage == nil
				? "no window capture symbol" : "window capture nil"
		}
		guard let view = window.contentView,
			view.bounds.width > 0, view.bounds.height > 0,
			let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
		else {
			throw DebugCommandError("neither the window nor its view could be captured")
		}
		view.cacheDisplay(in: view.bounds, to: rep)
		guard let data = rep.representation(using: .png, properties: [:]) else {
			throw DebugCommandError("the view bitmap would not encode as PNG")
		}
		try data.write(to: url)
		return "via view (\(skipped))"
	}

	/// The window-server capture of one of our own windows.
	///
	/// `CGWindowListCreateImage` is the one capture that includes what the
	/// window server composites — the Liquid Glass blur lives there, not in
	/// the view's own drawing — and, limited to a window id we own, it needs
	/// no Screen Recording permission. Its replacement, ScreenCaptureKit,
	/// always does, which is exactly the permission this machine cannot grant.
	///
	/// The SDK marked the function unavailable in macOS 15, so it cannot be
	/// called by name any more, but CoreGraphics still exports the symbol for
	/// already-built binaries. This looks it up at run time instead. It is a
	/// debug facility behind an environment variable, never a shipping path;
	/// a future macOS that drops the symbol simply falls back to the view
	/// capture below.
	private static let windowImage: (@convention(c) (
		CGRect, UInt32, CGWindowID, UInt32) -> Unmanaged<CGImage>?)? = {
		guard let symbol = dlsym(
			UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage")
		else { return nil }
		return unsafeBitCast(
			symbol,
			to: (@convention(c) (CGRect, UInt32, CGWindowID, UInt32)
				-> Unmanaged<CGImage>?).self)
	}()

	/// `kCGWindowListOptionIncludingWindow`.
	private static let includingWindow: UInt32 = 1 << 3
	/// `kCGWindowImageBestResolution`: the window's own backing scale.
	private static let bestResolution: UInt32 = 1 << 3

	private static func ownWindowImage(id: CGWindowID) -> CGImage? {
		guard let windowImage else { return nil }
		return windowImage(.null, includingWindow, id, bestResolution)?
			.takeRetainedValue()
	}

	private func write(_ image: CGImage, to url: URL) throws {
		let rep = NSBitmapImageRep(cgImage: image)
		guard let data = rep.representation(using: .png, properties: [:]) else {
			throw DebugCommandError("the window image would not encode as PNG")
		}
		try data.write(to: url)
	}

	/// True when a sampled grid of the capture is mostly transparent.
	///
	/// A window the server is really compositing fills its capture edge to
	/// edge; a window whose surface the server has discarded (which is what a
	/// Mac with no display attached does as soon as the app stops being
	/// frontmost) comes back transparent but for a faint shadow fringe. The
	/// threshold is a quarter of the samples covered, which separates the two
	/// with room to spare.
	///
	/// The bitmap is CoreGraphics' own: a context over a Swift array's
	/// `withUnsafeMutableBytes` buffer keeps a pointer that is no longer
	/// valid once the closure returns, and reads garbage that looks like
	/// content.
	static func isBlank(_ image: CGImage) -> Bool {
		let side = 64
		guard let space = CGColorSpace(name: CGColorSpace.sRGB),
			let context = CGContext(
				data: nil, width: side, height: side, bitsPerComponent: 8,
				bytesPerRow: side * 4, space: space,
				bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
			let data = context.data
		else { return false }
		let full = CGRect(x: 0, y: 0, width: side, height: side)
		context.clear(full)
		context.draw(image, in: full)
		let buffer = data.bindMemory(to: UInt8.self, capacity: side * side * 4)
		var covered = 0
		for index in stride(from: 3, to: side * side * 4, by: 4)
		where buffer[index] >= 16 {
			covered += 1
		}
		return covered * 4 < side * side
	}

	/// Appends one line to `log`, creating it if it is not there yet.
	private func append(_ line: String) {
		let text = line + "\n"
		guard let data = text.data(using: .utf8) else { return }
		if let handle = try? FileHandle(forWritingTo: logURL) {
			defer { try? handle.close() }
			_ = try? handle.seekToEnd()
			try? handle.write(contentsOf: data)
		} else {
			try? data.write(to: logURL)
		}
	}
}
