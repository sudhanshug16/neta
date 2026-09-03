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
}

/// A launcher that never creates a socket, so `connect()` must exhaust its
/// retry window and throw `nodeUnavailable`.
private actor StubLauncher: NodeLauncher {
	private(set) var starts = 0

	func start() async throws {
		starts += 1
	}
}
