import AppKit
import CoreGraphics
import Foundation
import XCTest

@testable import NetaDesktop

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
			("shot /tmp/a.png", .shot(path: "/tmp/a.png")),
			("shot /tmp/a b.png", .shot(path: "/tmp/a b.png")),
			("quit", .quit),
			("menu", .menu),
			("state", .state),
			("key cmd+l", .key(characters: "l", modifiers: NSEvent.ModifierFlags.command.rawValue)),
			("key cmd+shift+k", .key(
				characters: "k",
				modifiers: NSEvent.ModifierFlags([.command, .shift]).rawValue)),
			("key escape", .key(characters: "\u{1B}", modifiers: 0)),
			("key cmd+.", .key(characters: ".", modifiers: NSEvent.ModifierFlags.command.rawValue)),
			("click 400 300", .click(x: 400, y: 300)),
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
			"shot",
			"fit now",
			"quit please",
			"menu bar",
			"state of things",
			"key",
			"key cmd",
			"key cmd+wiggle",
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
