import AppKit
import SwiftTerm
import SwiftUI
import XCTest

@testable import NetaDesktop

private final class TerminalNodeClient: @unchecked Sendable, NodeClient {
	let lock = NSLock()
	let stream: AsyncStream<NodeNotification>
	let continuation: AsyncStream<NodeNotification>.Continuation
	var inputs: [Data] = []
	var sizes: [(Int, Int)] = []
	var attaches = 0
	var outputDuringAttach: NodeNotification?

	init() {
		(stream, continuation) = AsyncStream.makeStream(of: NodeNotification.self)
	}
	var notifications: AsyncStream<NodeNotification> { stream }
	func terminalAttach(sessionId: Ulid, cols: Int, rows: Int) async throws -> TerminalAttachment {
		lock.withLock { attaches += 1 }
		if let outputDuringAttach { continuation.yield(outputDuringAttach) }
		return .init(sessionId: sessionId, attachmentId: "attachment", pid: 42, generation: "g1", replay: [
			.init(generation: "g1", seq: 1, dataBase64: Data("ready\r\n".utf8).base64EncodedString())
		])
	}
	func terminalInput(sessionId: Ulid, attachmentId: String, data: Data) async throws {
		lock.withLock { inputs.append(data) }
	}
	func terminalResize(sessionId: Ulid, attachmentId: String, cols: Int, rows: Int) async throws {
		lock.withLock { sizes.append((cols, rows)) }
	}
	func terminalDetach(sessionId: Ulid, attachmentId: String) async throws {}
	func connect() async throws {}
	func snapshot() async throws -> Snapshot { throw NodeClientError.disconnected }
	func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission] { [] }
	func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event] { [] }
	func conversationTail(sessionId: Ulid, cursor: String?, limit: Int, direction: String?, turnId: TurnId?) async throws -> ConversationPage { .init(turns: [], blocks: [], nextCursor: nil, prevCursor: nil) }
	func prompt(sessionId: Ulid, text: String) async throws -> Ulid { "turn" }
	func cancel(sessionId: Ulid) async throws {}
	func setModel(sessionId: Ulid, model: String) async throws {}
	func listModels(provider: String) async throws -> [ModelInfo] { [] }
	func setMode(workspaceId: String, mode: LeaderMode) async throws {}
	func pin(missionId: Ulid, pinned: Bool) async throws {}
	func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws {}
}

@MainActor final class PiTerminalTests: XCTestCase {
	func testRegistryRetainsOneRealTerminalViewPerSession() {
		let registry = PiTerminalRegistry(client: TerminalNodeClient())
		let first = registry.controller(sessionId: "session-a")
		XCTAssertTrue(first === registry.controller(sessionId: "session-a"))
		XCTAssertTrue(first.terminalView !== registry.controller(sessionId: "session-b").terminalView)
		XCTAssertEqual(first.terminalView.nativeForegroundColor, NSColor.textColor)
		XCTAssertEqual(first.terminalView.nativeBackgroundColor, NSColor.textBackgroundColor)
	}

	func testAttachFeedsReplayAndLiveOutputIntoTerminal() async throws {
		let client = TerminalNodeClient()
		client.outputDuringAttach = .terminalOutput(sessionId: "session", output: .init(generation: "g1", seq: 2, dataBase64: Data("live".utf8).base64EncodedString()))
		let controller = PiTerminalController(sessionId: "session", client: client)
		controller.appear()
		try await eventually { client.lock.withLock { client.attaches == 1 } }
		try await eventually {
			let text = controller.terminalView.getTerminal().getText(start: .init(col: 0, row: 0), end: .init(col: 20, row: 2))
			return text.contains("ready") && text.contains("live")
		}
		let text = controller.terminalView.getTerminal().getText(start: .init(col: 0, row: 0), end: .init(col: 20, row: 2))
		XCTAssertTrue(text.contains("ready"))
		XCTAssertTrue(text.contains("live"))
		controller.disappear()
	}

	func testImagePasteSendsPiClipboardBindingAndTextUsesNativePaste() async throws {
		let client = TerminalNodeClient()
		let controller = PiTerminalController(sessionId: "session", client: client)
		controller.appear()
		try await eventually { client.lock.withLock { client.attaches == 1 } }

		let imageBoard = NSPasteboard(name: .init("pi-image-\(UUID())"))
		imageBoard.clearContents()
		imageBoard.writeObjects([NSImage(size: NSSize(width: 2, height: 2))])
		controller.terminalView.pasteboard = { imageBoard }
		controller.terminalView.paste(controller)
		try await eventually { client.lock.withLock { client.inputs.contains(Data([0x16])) } }

		let textBoard = NSPasteboard.general
		textBoard.clearContents()
		textBoard.setString("hello", forType: .string)
		controller.terminalView.pasteboard = { textBoard }
		controller.terminalView.paste(controller)
		try await eventually { client.lock.withLock { client.inputs.contains(Data("hello".utf8)) } }
		controller.disappear()
	}

	func testHostedTerminalFocusesAndResizeIsCoalesced() async throws {
		let client = TerminalNodeClient()
		let controller = PiTerminalController(sessionId: "session", client: client)
		let host = NSHostingView(rootView: PiTerminalHost(controller: controller).frame(width: 500, height: 300))
		let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 500, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
		window.isReleasedWhenClosed = false
		window.animationBehavior = .none
		window.contentView = host
		window.makeKeyAndOrderFront(nil)
		host.layoutSubtreeIfNeeded()
		try await eventually { window.firstResponder === controller.terminalView }

		controller.sizeChanged(source: controller.terminalView, newCols: 90, newRows: 30)
		controller.sizeChanged(source: controller.terminalView, newCols: 100, newRows: 40)
		try await eventually { client.lock.withLock { client.sizes.contains(where: { $0 == (100, 40) }) } }
		XCTAssertFalse(client.lock.withLock { client.sizes.contains(where: { $0 == (90, 30) }) })
		window.orderOut(nil)
		window.contentView = nil
		window.close()
	}

	private func eventually(_ condition: @escaping @MainActor () -> Bool) async throws {
		for _ in 0..<100 {
			if condition() { return }
			try await Task.sleep(for: .milliseconds(10))
		}
		XCTFail("condition did not become true")
	}
}
