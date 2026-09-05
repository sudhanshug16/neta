import AppKit
import CoreGraphics
import Foundation
import XCTest

@testable import NetaDesktop

private final class ClosureTarget: NSObject {
	let action: () -> Void
	init(_ action: @escaping () -> Void) { self.action = action }
	@objc func invoke() { action() }
}

/// Contract for the headless debug driver: every command form parses,
/// garbage is refused with a reason, an agent name resolves case-insensitively
/// against a fixture-backed store, and nothing at all happens without
/// `NETA_DEBUG_DRIVER`.
@MainActor
final class DebugDriverTests: XCTestCase {
	func testEveryCommandFormParses() throws {
		let cases: [(String, DebugCommand)] = [
			("navigator on", .navigator(true)),
			("navigator off", .navigator(false)),
			("NAVIGATOR ON", .navigator(true)),
			("chat on", .chat(true)),
			("chat off", .chat(false)),
			("select leader", .selectLeader),
			("select mission 3", .selectMission(3)),
			("select agent Scout", .selectAgent("Scout")),
			("select agent two words", .selectAgent("two words")),
			("zoom in", .zoomIn),
			("zoom out", .zoomOut),
			("fit", .fit),
			("now", .now),
			("window", .window),
			("resize 1600 1000", .resize(width: 1600, height: 1000)),
			("wait 500", .wait(milliseconds: 500)),
			("await-ready 5000", .awaitReady(milliseconds: 5000)),
			("await-state 5000 idle", .awaitState(milliseconds: 5000, predicate: "idle")),
			("await-state 5000 session-not old", .awaitState(milliseconds: 5000, predicate: "session-not old")),
			("await-state 5000 inbox uncertain 1", .awaitState(milliseconds: 5000, predicate: "inbox uncertain 1")),
			("shot /tmp/a.png", .shot(path: "/tmp/a.png")),
			("shot /tmp/a b.png", .shot(path: "/tmp/a b.png")),
			("shot-content /tmp/content view.png", .shotContent(path: "/tmp/content view.png")),
			("quit", .quit),
			("menu", .menu),
			("state", .state),
			("ax-dump", .axDump),
			("ax-press Send", .axPress(label: "Send")),
			("key cmd+l", .key(characters: "l", modifiers: NSEvent.ModifierFlags.command.rawValue)),
			("key cmd+shift+k", .key(
				characters: "k",
				modifiers: NSEvent.ModifierFlags([.command, .shift]).rawValue)),
			("key escape", .key(characters: "\u{1B}", modifiers: 0)),
			("key cmd+.", .key(characters: ".", modifiers: NSEvent.ModifierFlags.command.rawValue)),
			("click 400 300", .click(x: 400, y: 300)),
			("drag 1 2 3 4", .drag(x0: 1, y0: 2, x1: 3, y1: 4)),
			// A draft is prose: the remainder of the line is kept whole,
			// spaces, punctuation and all, and an empty one clears the field.
			("draft Close #305 once the checks pass.", .draft(
				text: "Close #305 once the checks pass.")),
			("draft", .draft(text: "")),
			("  fit  ", .fit),
		]
		for (line, expected) in cases {
			XCTAssertEqual(
				try DebugCommand.parse(line), expected,
				"parsing \(line)")
		}
	}

	func testGarbageIsRefusedWithAReason() {
		let bad = [
			"",
			"   ",
			"wiggle",
			"navigator",
			"navigator sideways",
			"chat maybe",
			"zoom sideways",
			"select",
			"select workspace 1",
			"select leader 2",
			"select mission three",
			"select agent",
			"resize 1600",
			"resize wide tall",
			"resize 0 0",
			"wait soon",
			"wait -1",
			"await-ready 0",
			"await-state 0 idle",
			"await-state 5000",
			"await-state 5000 someday",
			"await-state 5000 inbox mystery 1",
			"shot",
			"shot-content",
			"fit now",
			"quit please",
			"menu bar",
			"state of things",
			"ax-dump extra",
			"ax-press",
			"key",
			"key cmd",
			"key cmd+wiggle",
			"drag 1 2 3",
			"click 400",
			"click here there",
		]
		for line in bad {
			XCTAssertThrowsError(try DebugCommand.parse(line), "\(line) must be refused") { error in
				let reason = (error as? DebugCommandError)?.description ?? ""
				XCTAssertFalse(reason.isEmpty, "\(line) must say why")
			}
		}
	}

	func testAgentNameResolvesIgnoringCase() async throws {
		let store = try await fixtureStore()
		let agent = try XCTUnwrap(store.agentsById.values.first)
		XCTAssertEqual(
			DebugDriver.agentId(named: agent.name, in: store), agent.id)
		XCTAssertEqual(
			DebugDriver.agentId(named: agent.name.uppercased(), in: store),
			agent.id)
		XCTAssertEqual(
			DebugDriver.agentId(named: "  \(agent.name.lowercased())  ", in: store),
			agent.id)
		XCTAssertNil(DebugDriver.agentId(named: "no such agent", in: store))
	}

	/// The gate: without the variable there is no driver, and the directory
	/// the variable would have named is never touched.
	func testNoEnvironmentVariableMeansNoDriver() throws {
		let directory = FileManager.default.temporaryDirectory
			.appendingPathComponent("neta-driver-gate-\(UUID().uuidString)")
		XCTAssertNil(
			DebugDriver.startIfEnabled(
				store: Store(), shell: ShellState(), environment: [:]))
		XCTAssertNil(
			DebugDriver.startIfEnabled(
				store: Store(), shell: ShellState(),
				environment: [DebugDriver.environmentKey: "   "]))
		XCTAssertNil(
			DebugDriver.startIfEnabled(
				store: Store(), shell: ShellState(),
				environment: ["SOMETHING_ELSE": directory.path]))
		XCTAssertFalse(
			FileManager.default.fileExists(atPath: directory.path),
			"the gated driver must not create its directory")
	}

	func testAccessibilityPressUsesRealControlsAndRejectsDuplicateLabels() async throws {
		var presses = 0
		let target = ClosureTarget { presses += 1 }
		let first = NSButton(title: "Probe", target: target, action: #selector(ClosureTarget.invoke))
		first.setAccessibilityIdentifier("probe-action")
		let firstRoot = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 200))
		firstRoot.addSubview(first)
		let firstWindow = NSWindow(contentRect: firstRoot.frame, styleMask: [.titled], backing: .buffered, defer: false)
		firstWindow.isReleasedWhenClosed = false
		firstWindow.animationBehavior = .none
		firstWindow.contentView = firstRoot
		firstWindow.orderFront(nil)

		let second = NSButton(title: "Probe", target: nil, action: nil)
		let secondRoot = NSView(frame: NSRect(x: 0, y: 0, width: 200, height: 100))
		secondRoot.addSubview(second)
		let secondWindow = NSWindow(contentRect: secondRoot.frame, styleMask: [.titled], backing: .buffered, defer: false)
		secondWindow.isReleasedWhenClosed = false
		secondWindow.animationBehavior = .none
		secondWindow.contentView = secondRoot
		secondWindow.orderFront(nil)

		let directory = FileManager.default.temporaryDirectory.appendingPathComponent("neta-driver-ax-\(UUID().uuidString)")
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		let driver = DebugDriver(directory: directory, store: Store(), shell: ShellState())
		let pressed = await driver.execute(line: "ax-press probe-action")
		XCTAssertTrue(pressed.contains("dispatched probe-action"), pressed)
		XCTAssertEqual(presses, 1)
		let ambiguous = await driver.execute(line: "ax-press Probe")
		XCTAssertTrue(ambiguous.contains("ambiguous"), ambiguous)

		for window in [secondWindow, firstWindow] {
			window.orderOut(nil)
			window.contentView = nil
			window.close()
		}
		try? FileManager.default.removeItem(at: directory)
		await Task.yield()
	}

	func testOneXContentCaptureUsesRequestedGeometryAndRestoresTheLiveView() throws {
		let view = NSView(frame: NSRect(x: 4, y: 6, width: 20, height: 30))
		let original = view.frame
		let url = FileManager.default.temporaryDirectory
			.appendingPathComponent("neta-content-\(UUID().uuidString).png")
		defer { try? FileManager.default.removeItem(at: url) }

		try DebugDriver.writeOneXContent(
			view, requestedSize: NSSize(width: 1600, height: 1000), to: url)

		let image = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: url)))
		XCTAssertEqual(image.pixelsWide, 1600)
		XCTAssertEqual(image.pixelsHigh, 1000)
		XCTAssertEqual(view.frame, original, "capture restores the live root")
	}

	/// The state commands move the shell, `now` included.
	func testCommandsMoveTheShell() async throws {
		let store = try await fixtureStore()
		let shell = ShellState()
		let directory = FileManager.default.temporaryDirectory
			.appendingPathComponent("neta-driver-\(UUID().uuidString)")
		let driver = DebugDriver(directory: directory, store: store, shell: shell)
		defer { try? FileManager.default.removeItem(at: directory) }
		try FileManager.default.createDirectory(
			at: directory, withIntermediateDirectories: true)

		let navigatorOn = await driver.execute(line: "navigator on")
		XCTAssertEqual(navigatorOn, "ok navigator on")
		XCTAssertTrue(shell.navigatorVisible)
		let navigatorOff = await driver.execute(line: "navigator off")
		XCTAssertEqual(navigatorOff, "ok navigator off")
		XCTAssertFalse(shell.navigatorVisible)

		let chatOff = await driver.execute(line: "chat off")
		XCTAssertEqual(chatOff, "ok chat off")
		XCTAssertFalse(shell.chatVisible)

		let agent = try XCTUnwrap(store.agentsById.values.first)
		_ = await driver.execute(line: "select agent \(agent.name.uppercased())")
		XCTAssertEqual(shell.selection, .agent(agent.id))

		let mission = try XCTUnwrap(store.missions.first)
		_ = await driver.execute(line: "select mission \(mission.number)")
		XCTAssertEqual(shell.selection, .mission(mission.id))
		_ = await driver.execute(line: "select leader")
		XCTAssertEqual(shell.selection, .leader)

		_ = await driver.execute(line: "zoom in")
		XCTAssertGreaterThan(shell.timeZoom, 1.0)
		_ = await driver.execute(line: "fit")
		XCTAssertEqual(shell.timeZoom, 1.0)

		let noAgent = await driver.execute(line: "select agent nobody")
		XCTAssertTrue(noAgent.hasPrefix("error select agent nobody: "))
		// `now` asks the shell for the live edge, the same wire the mission
		// bar's Now control uses; the canvas observes the counter.
		let before = shell.nowRequested
		let now = await driver.execute(line: "now")
		XCTAssertEqual(now, "ok now")
		XCTAssertEqual(shell.nowRequested, before + 1)

		let log = try String(
			contentsOf: directory.appendingPathComponent("log"), encoding: .utf8)
		XCTAssertTrue(log.contains("ok navigator on"))
		XCTAssertTrue(log.contains("ok now"))
	}

	/// The capture guard: a transparent image is blank however large, a
	/// filled one is not, and a shadow fringe on an otherwise empty capture
	/// still counts as blank. (The first version of this read a CoreGraphics
	/// context whose buffer had already gone out of scope, so an empty capture
	/// looked full of content and was written to disk as an empty PNG.)
	func testBlankCaptureIsRecognised() throws {
		XCTAssertTrue(DebugDriver.isBlank(try image(coverage: 0)))
		XCTAssertTrue(DebugDriver.isBlank(try image(coverage: 0.05)))
		XCTAssertFalse(DebugDriver.isBlank(try image(coverage: 1)))
		XCTAssertFalse(DebugDriver.isBlank(try image(coverage: 0.6)))
	}

	// MARK: - Helpers

	/// A 400 x 400 image whose bottom `coverage` fraction is opaque white and
	/// whose remainder is transparent.
	private func image(coverage: Double) throws -> CGImage {
		let side = 400
		let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
		let context = try XCTUnwrap(CGContext(
			data: nil, width: side, height: side, bitsPerComponent: 8,
			bytesPerRow: side * 4, space: space,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
		context.clear(CGRect(x: 0, y: 0, width: side, height: side))
		context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
		context.fill(CGRect(
			x: 0, y: 0, width: Double(side),
			height: Double(side) * coverage))
		return try XCTUnwrap(context.makeImage())
	}


	private func fixtureStore() async throws -> Store {
		let client = FixtureNodeClient()
		let store = Store()
		store.replace(snapshot: try await client.snapshot())
		return store
	}
}
