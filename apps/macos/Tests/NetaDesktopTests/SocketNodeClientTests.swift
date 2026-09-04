import Foundation
import XCTest

@testable import NetaDesktop

/// T9.4: framing, request ids, error mapping and the start-and-retry path.
/// No test opens a real socket or Node: framing and mapping are pure, ids
/// come from the request encoder, and `connect()` runs against an empty
/// directory with a launcher stub that never creates a socket.
final class SocketNodeClientTests: XCTestCase {
	// MARK: - LineFramer

	func testFramerSplitsIdenticalLinesAtEveryByteOffset() {
		let payloads = ["{\"jsonrpc\":\"2.0\",\"id\":1}", "{\"method\":\"event\"}", "{\"x\":3}"]
		let whole = payloads.map { Data(($0 + "\n").utf8) }.reduce(Data(), +)
		for offset in 0 ... whole.count {
			var framer = LineFramer()
			let first = framer.push(whole.prefix(offset))
			let rest = framer.push(whole.suffix(whole.count - offset))
			XCTAssertEqual(
				(first + rest).map { String(data: $0, encoding: .utf8) }, payloads,
				"offset \(offset)")
		}
	}

	func testFramerReassemblesLineSplitMidUTF8() {
		let text = "{\"text\":\"héllo wörld 🎉 日本語\"}"
		let framed = Data((text + "\n").utf8)
		// Split inside the 🎉 bytes (U+1F389 is 4 bytes in UTF-8).
		let emojiStart = framed.firstIndex(of: 0xF0)!
		for offset in [emojiStart, emojiStart + 1, emojiStart + 2, emojiStart + 3] {
			var framer = LineFramer()
			XCTAssertEqual(framer.push(framed.prefix(offset)), [], "offset \(offset)")
			let lines = framer.push(framed.suffix(framed.count - offset))
			XCTAssertEqual(lines.count, 1, "offset \(offset)")
			XCTAssertEqual(String(data: lines[0], encoding: .utf8), text, "offset \(offset)")
		}
	}

	func testFramerIgnoresBlankLinesAndNeverEmitsPartial() {
		var framer = LineFramer()
		XCTAssertEqual(framer.push(Data("\n   \n\t\n".utf8)), [])
		XCTAssertEqual(framer.push(Data("{\"a\":1".utf8)), [], "partial line stays buffered")
		XCTAssertEqual(
			framer.push(Data("}\n\n{\"b\":2}\r\n\n".utf8)).map({ String(data: $0, encoding: .utf8) }),
			["{\"a\":1}", "{\"b\":2}"])
	}

	func testFrameAppendsNewlineTerminator() {
		XCTAssertEqual(LineFramer.frame(Data("{\"a\":1}".utf8)), Data("{\"a\":1}\n".utf8))
	}

	// MARK: - NodeInfo

	func testNodeInfoDecodesNodeJsonIgnoringStartedAt() throws {
		let json = """
			{"socket":"/tmp/x/node.sock","token":"ab","pid":12,"protocolVersion":1,\
			"startedAt":"2026-01-01T00:00:00.000Z"}
			"""
		let info = try JSONDecoder().decode(NodeInfo.self, from: Data(json.utf8))
		XCTAssertEqual(info.socket, "/tmp/x/node.sock")
		XCTAssertEqual(info.token, "ab")
		XCTAssertEqual(info.pid, 12)
		XCTAssertEqual(info.protocolVersion, 1)
	}

	// MARK: - Request ids and error mapping

	func testRequestIdsIncreaseMonotonically() async throws {
		let client = SocketNodeClient(netaDirectory: URL(fileURLWithPath: "/nonexistent"))
		var ids: [Int] = []
		for _ in 0 ..< 5 {
			let (id, data) = try await client.makeRequestData(method: "snapshot")
			ids.append(id)
			let object = try XCTUnwrap(
				JSONSerialization.jsonObject(with: data) as? [String: Any])
			XCTAssertEqual(object["method"] as? String, "snapshot")
			XCTAssertTrue(data.last == 0x0A, "request line is newline-terminated")
		}
		XCTAssertEqual(ids, ids.sorted())
		XCTAssertEqual(Set(ids).count, ids.count)
		XCTAssertTrue(zip(ids, ids.dropFirst()).allSatisfy { $0 + 1 == $1 })
	}

	func testErrorResponseMapsToRpc() async {
		let client = SocketNodeClient(netaDirectory: URL(fileURLWithPath: "/nonexistent"))
		let line = Data("{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":{\"code\":-32603,\"message\":\"boom\"}}".utf8)
		let mapped = await client.mapResponseError(line)
		XCTAssertEqual(mapped, .rpc(code: -32603, message: "boom"))
	}

	func testUnauthorizedMapsToRejectedAndResultLineMapsToNil() async {
		let client = SocketNodeClient(netaDirectory: URL(fileURLWithPath: "/nonexistent"))
		let denied = Data(
			("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"bad token\","
				+ "\"data\":{\"code\":\"UNAUTHORIZED\"}}}").utf8)
		let mapped = await client.mapResponseError(denied)
		XCTAssertEqual(mapped, .rejected("bad token"))
		let ok = Data("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}".utf8)
		let none = await client.mapResponseError(ok)
		XCTAssertNil(none)
	}

	// MARK: - Retry then nodeUnavailable

	func testConnectRetriesThenThrowsNodeUnavailable() async throws {
		let dir = FileManager.default.temporaryDirectory
			.appendingPathComponent(UUID().uuidString, isDirectory: true)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		defer { try? FileManager.default.removeItem(at: dir) }
		let launcher = StubLauncher()
		let client = SocketNodeClient(netaDirectory: dir, launcher: launcher)
		let start = Date()
		do {
			try await client.connect()
			XCTFail("connect should throw when no socket ever appears")
		} catch let error as NodeClientError {
			XCTAssertEqual(error, .nodeUnavailable)
		} catch {
			XCTFail("wrong error: \(error)")
		}
		let elapsed = Date().timeIntervalSince(start)
		XCTAssertGreaterThan(elapsed, 4.0, "the client retries instead of failing at once")
		XCTAssertLessThan(elapsed, 12.0, "the retry window stays bounded near 5 s")
		let starts = await launcher.starts
		XCTAssertEqual(starts, 1, "the launcher starts the node exactly once")
	}

	/// FIXPASS G4-2: a Node that never starts used to leave a new
	/// `neta node start --detach` behind every retry, forever.
	func testLauncherStopsAfterTheBoundedAttempts() async throws {
		let dir = try Self.emptyDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let launcher = StubLauncher()
		let client = SocketNodeClient(
			netaDirectory: dir, launcher: launcher,
			retryWindow: .milliseconds(20), retryInterval: .milliseconds(5))
		for _ in 0 ..< (SocketNodeClient.maxLaunchAttempts + 3) {
			try? await client.connect()
		}
		let starts = await launcher.starts
		XCTAssertEqual(
			starts, SocketNodeClient.maxLaunchAttempts,
			"one launch per connect, and no launch past the bound")
	}

	// MARK: - Notification fan-out (G4-3)

	func testEverySubscriptionSeesEveryNotification() async {
		let hub = NotificationHub()
		let first = hub.subscribe()
		let second = hub.subscribe()
		XCTAssertEqual(hub.subscriberCount, 2)
		for phase in [NodePhase.restarting, .stopping, .restarting] {
			hub.broadcast(.node(NodeLifecycle(phase: phase)))
		}
		hub.finishAll()
		XCTAssertEqual(hub.subscriberCount, 0, "finishAll drops every subscription")

		func phases(_ stream: AsyncStream<NodeNotification>) async -> [NodePhase] {
			var seen: [NodePhase] = []
			for await notification in stream {
				guard case .node(let lifecycle) = notification else { continue }
				seen.append(lifecycle.phase)
			}
			return seen
		}
		let expected: [NodePhase] = [.restarting, .stopping, .restarting]
		let firstSeen = await phases(first)
		let secondSeen = await phases(second)
		XCTAssertEqual(firstSeen, expected)
		XCTAssertEqual(secondSeen, expected, "the second consumer sees the same three")
	}

	func testSubscribingAfterFinishGetsALiveStream() async {
		let hub = NotificationHub()
		let stale = hub.subscribe()
		hub.finishAll()
		var staleCount = 0
		for await _ in stale { staleCount += 1 }
		XCTAssertEqual(staleCount, 0, "the old subscription ended")

		let fresh = hub.subscribe()
		hub.broadcast(.node(NodeLifecycle(phase: .stopping)))
		hub.finishAll()
		var freshCount = 0
		for await _ in fresh { freshCount += 1 }
		XCTAssertEqual(freshCount, 1, "a subscription taken after a finish is live")
	}

	// MARK: - workspace.open (G4-8)

	func testWorkspaceOpenRequestEncoding() async throws {
		let client = SocketNodeClient(netaDirectory: URL(fileURLWithPath: "/nonexistent"))
		let (_, data) = try await client.makeRequestData(
			method: "workspace.open", params: ["path": "/tmp/repo"])
		let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
		XCTAssertEqual(object["method"] as? String, "workspace.open")
		XCTAssertEqual((object["params"] as? [String: Any])?["path"] as? String, "/tmp/repo")
	}

	func testWorkspaceOpenWithoutAConnectionFails() async throws {
		let client = SocketNodeClient(netaDirectory: URL(fileURLWithPath: "/nonexistent"))
		do {
			_ = try await client.openWorkspace(path: "/tmp/repo")
			XCTFail("workspace.open needs a connection")
		} catch let error as NodeClientError {
			XCTAssertEqual(error, .disconnected)
		}
	}

	// MARK: - The app's sync loop (G4-2)

	func testBackoffGrowsThenSettlesOnTheSlowInterval() {
		let waits = (1 ... 6).map { NodeSync.backoff(afterFailure: $0) }
		XCTAssertEqual(
			waits,
			[.seconds(1), .seconds(2), .seconds(4), .seconds(8),
			 NodeSync.slowInterval, NodeSync.slowInterval])
	}

	@MainActor
	func testSyncLoopMarksTheNodeOfflineAndStopsLaunching() async throws {
		let dir = try Self.emptyDirectory()
		defer { try? FileManager.default.removeItem(at: dir) }
		let launcher = StubLauncher()
		let client = SocketNodeClient(
			netaDirectory: dir, launcher: launcher,
			retryWindow: .milliseconds(10), retryInterval: .milliseconds(5))
		let store = Store()
		XCTAssertFalse(store.nodeOffline)
		let loop = Task { await NodeSync.run(client: client, store: store, backoff: { _ in .milliseconds(1) }) }
		var offline = false
		for _ in 0 ..< 400 {
			try await Task.sleep(nanoseconds: 10_000_000)
			if store.nodeOffline {
				offline = true
				break
			}
		}
		loop.cancel()
		XCTAssertTrue(offline, "the loop records the Node as offline once the attempts run out")
		let starts = await launcher.starts
		XCTAssertLessThanOrEqual(
			starts, SocketNodeClient.maxLaunchAttempts,
			"the loop never spawns another Node past the bound")
	}

	/// The store loop subscribes before it asks for the snapshot. A
	/// subscription carries only what is broadcast after it is taken, so a
	/// notification sent while the snapshot was in flight used to fall
	/// between the two calls and never reach the store.
	@MainActor
	func testSyncLoopKeepsNotificationsSentDuringTheSnapshot() async throws {
		let client = SnapshotWindowStub()
		let store = Store()
		let loop = Task {
			await NodeSync.run(client: client, store: store, backoff: { _ in .milliseconds(1) })
		}
		var seen = false
		for _ in 0 ..< 400 {
			try await Task.sleep(nanoseconds: 10_000_000)
			if store.nodeState?.phase == .restarting {
				seen = true
				break
			}
		}
		loop.cancel()
		XCTAssertTrue(seen, "a notification sent while the snapshot was in flight was dropped")
	}

	// MARK: - Helpers

	private static func emptyDirectory() throws -> URL {
		let dir = FileManager.default.temporaryDirectory
			.appendingPathComponent(UUID().uuidString, isDirectory: true)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		return dir
	}
}

/// A launcher that never creates a socket, so `connect()` must exhaust its
/// retry window and throw `nodeUnavailable`.
private actor StubLauncher: NodeLauncher {
	private(set) var starts = 0

	func start() async throws {
		starts += 1
	}
}

/// A client that broadcasts one notification from inside `snapshot()`, i.e.
/// in the window between subscribing and the snapshot's answer.
private actor SnapshotWindowStub: NodeClient {
	private let hub = NotificationHub()
	private let at = Date(timeIntervalSince1970: 1_780_315_200)

	nonisolated var notifications: AsyncStream<NodeNotification> { hub.subscribe() }

	func connect() async throws {}

	func snapshot() async throws -> Snapshot {
		hub.broadcast(.node(NodeLifecycle(phase: .restarting)))
		return Snapshot(
			machine: Machine(id: "m1", name: "machine", createdAt: at),
			workspaces: [], leaders: [], missions: [], hasOlder: false,
			agents: [], completedCounts: [:], events: [], attention: [],
			windowDays: 14, protocolVersion: 1, at: at)
	}

	func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission] { [] }
	func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event] { [] }
	func conversationTail(
		sessionId: Ulid, cursor: String?, limit: Int, direction: String?, turnId: TurnId?
	) async throws -> ConversationPage {
		ConversationPage(turns: [], blocks: [], nextCursor: nil, prevCursor: nil)
	}
	func prompt(sessionId: Ulid, text: String) async throws -> Ulid {
		throw NodeClientError.disconnected
	}
	func cancel(sessionId: Ulid) async throws {}
	func setModel(sessionId: Ulid, model: String) async throws {}
	func listModels(provider: String) async throws -> [ModelInfo] { [] }
	func setMode(workspaceId: String, mode: LeaderMode) async throws {}
	func pin(missionId: Ulid, pinned: Bool) async throws {}
	func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws {}
	func openWorkspace(path: String) async throws -> Workspace {
		throw NodeClientError.disconnected
	}
}
