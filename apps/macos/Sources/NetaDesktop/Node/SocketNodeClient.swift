import Foundation
import Network

/// The `node.json` descriptor a running Node leaves in `~/.neta` (04-node
/// T4.2). The file also carries `startedAt`, which this client ignores.
public struct NodeInfo: Codable, Sendable {
	public let socket: String
	public let token: String
	public let pid: Int
	public let protocolVersion: Int
}

/// Starts a Node when `connect()` finds no socket. Sendable so the client
/// actor can hold it; the bundled launcher shells out, test stubs count.
public protocol NodeLauncher: Sendable {
	func start() async throws
}

/// Runs the `neta` binary bundled in `Bundle.main` Resources as
/// `neta node start --detach`, which daemonizes and returns at once.
public struct BundledNodeLauncher: NodeLauncher {
	public init() {}

	public func start() async throws {
		guard let resources = Bundle.main.resourceURL else {
			throw NodeClientError.nodeUnavailable
		}
		let process = Process()
		process.executableURL = resources.appendingPathComponent("neta", isDirectory: false)
		process.arguments = ["node", "start", "--detach"]
		process.standardInput = FileHandle.nullDevice
		process.standardOutput = FileHandle.nullDevice
		process.standardError = FileHandle.nullDevice
		try process.run()
	}
}

/// Everything that can go wrong between the app and the Node.
public enum NodeClientError: Error, Sendable, Equatable {
	/// No socket after `start()` plus the 250 ms / 5 s retry window.
	case nodeUnavailable
	/// The node's protocol version differs from `SocketNodeClient.protocolVersion`.
	/// The payload is the version the node reported.
	case protocolMismatch(Int)
	/// The node rejected the handshake, e.g. a stale token (`UNAUTHORIZED`).
	case rejected(String)
	/// A JSON-RPC error response to a normal request.
	case rpc(code: Int, message: String)
	/// The connection dropped; pending requests fail with this.
	case disconnected
}

/// The real `NodeClient` transport (09-desktop-shell T9.4).
///
/// Reads `node.json` from `netaDirectory`, connects with
/// `NWConnection(to: .unix(path:))`, and sends `hello` first with the token
/// and protocol version. Requests carry a monotonic integer id resumed by a
/// continuation held per id; notifications (no id) are yielded on
/// `notifications`. On disconnect the stream finishes and pending requests
/// fail with `.disconnected`; the caller reconnects with a fresh snapshot.
public actor SocketNodeClient: NodeClient {
	/// 04's `PROTOCOL_VERSION`.
	public static let protocolVersion = 1

	/// `~/.neta`, or `$NETA_DIR` when set (04: it overrides the default).
	public static let defaultDirectory: URL = {
		if let override = ProcessInfo.processInfo.environment["NETA_DIR"], !override.isEmpty {
			return URL(fileURLWithPath: override, isDirectory: true)
		}
		return FileManager.default.homeDirectoryForCurrentUser
			.appendingPathComponent(".neta", isDirectory: true)
	}()

	private static let retryWindow: Duration = .seconds(5)
	private static let retryInterval: Duration = .milliseconds(250)
	private static let attemptTimeout: Double = 4

	/// Nonisolated so it can satisfy the synchronous protocol requirement; the
	/// actor swaps the underlying stream on every `connect()`.
	public nonisolated var notifications: AsyncStream<NodeNotification> { relay.current }

	private let netaDirectory: URL
	private let launcher: any NodeLauncher
	private let ioQueue = DispatchQueue(label: "neta.node-connection")
	private let relay = NotificationRelay()
	private var connection: NWConnection?
	private var connected = false
	private var framer = LineFramer()
	private var nextRequestId = 0
	private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
	private var readyContinuation: CheckedContinuation<Void, Error>?
	private var knownServerVersion: Int?

	public init(
		netaDirectory: URL = SocketNodeClient.defaultDirectory,
		launcher: any NodeLauncher = BundledNodeLauncher()
	) {
		self.netaDirectory = netaDirectory
		self.launcher = launcher
	}

	// MARK: - Connect

	public func connect() async throws {
		if connected { return }
		relay.renew()
		let deadline = Date().addingTimeInterval(5)
		var launched = false
		while true {
			do {
				try await attemptConnect()
				return
			} catch is CancellationError {
				dropConnection()
				relay.finish()
				throw CancellationError()
			} catch let error as NodeClientError {
				switch error {
				case .nodeUnavailable, .disconnected:
					dropConnection()
					if !launched {
						launched = true
						try? await launcher.start()
					}
					guard Date() < deadline else {
						dropConnection()
						relay.finish()
						throw NodeClientError.nodeUnavailable
					}
					try await Task.sleep(for: Self.retryInterval)
				case .protocolMismatch, .rejected, .rpc:
					dropConnection()
					relay.finish()
					throw error
				}
			} catch {
				dropConnection()
				if !launched {
					launched = true
					try? await launcher.start()
				}
				guard Date() < deadline else {
					dropConnection()
					relay.finish()
					throw NodeClientError.nodeUnavailable
				}
				try await Task.sleep(for: Self.retryInterval)
			}
		}
	}

	private func attemptConnect() async throws {
		let info = try readNodeInfo()
		knownServerVersion = info.protocolVersion
		guard info.protocolVersion == Self.protocolVersion else {
			throw NodeClientError.protocolMismatch(info.protocolVersion)
		}
		let socketPath = resolveSocketPath(info)
		try await withTimeout(seconds: Self.attemptTimeout) {
			try await self.waitForReady(path: socketPath)
		}
		startReceiveLoop()
		do {
			let hello: HelloResult = try await withTimeout(seconds: Self.attemptTimeout) {
				try await self.sendRequest(
					method: "hello",
					params: [
						"token": info.token,
						"client": "desktop",
						"protocolVersion": Self.protocolVersion,
					])
			}
			guard hello.protocolVersion == Self.protocolVersion else {
				throw NodeClientError.protocolMismatch(hello.protocolVersion)
			}
			connected = true
		} catch {
			dropConnection()
			throw error
		}
	}

	private func readNodeInfo() throws -> NodeInfo {
		let url = netaDirectory.appendingPathComponent("node.json", isDirectory: false)
		guard let data = try? Data(contentsOf: url),
			let info = try? JSONDecoder().decode(NodeInfo.self, from: data)
		else {
			throw NodeClientError.nodeUnavailable
		}
		return info
	}

	private func resolveSocketPath(_ info: NodeInfo) -> String {
		if info.socket.hasPrefix("/") { return info.socket }
		return netaDirectory.appendingPathComponent(info.socket, isDirectory: false).path
	}

	// MARK: - NodeClient reads and writes

	public func snapshot() async throws -> Snapshot {
		guard connected else { throw NodeClientError.disconnected }
		return try await sendRequest(method: "snapshot", params: [:])
	}

	public func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission] {
		guard connected else { throw NodeClientError.disconnected }
		var params: [String: Any] = ["workspaceId": workspaceId, "limit": limit]
		if let before { params["to"] = NetaJSON.string(from: before) }
		let result: MissionsResult = try await sendRequest(method: "missions.list", params: params)
		return result.missions
	}

	public func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event] {
		guard connected else { throw NodeClientError.disconnected }
		var params: [String: Any] = ["workspaceId": workspaceId, "limit": limit]
		if let before { params["to"] = NetaJSON.string(from: before) }
		let result: EventsResult = try await sendRequest(method: "events.list", params: params)
		return result.events
	}

	public func conversationTail(sessionId: Ulid, cursor: String?, limit: Int) async throws
		-> ConversationPage
	{
		guard connected else { throw NodeClientError.disconnected }
		var params: [String: Any] = ["sessionId": sessionId, "limit": limit]
		if let cursor { params["cursor"] = cursor }
		return try await sendRequest(method: "conversation.tail", params: params)
	}

	public func prompt(sessionId: Ulid, text: String) async throws -> Ulid {
		guard connected else { throw NodeClientError.disconnected }
		let result: PromptResult = try await sendRequest(
			method: "conversation.prompt", params: ["sessionId": sessionId, "text": text])
		return result.turnId
	}

	public func cancel(sessionId: Ulid) async throws {
		guard connected else { throw NodeClientError.disconnected }
		let _: IgnoredResult = try await sendRequest(
			method: "conversation.cancel", params: ["sessionId": sessionId])
	}

	public func setModel(sessionId: Ulid, model: String) async throws {
		guard connected else { throw NodeClientError.disconnected }
		let _: IgnoredResult = try await sendRequest(
			method: "conversation.setModel", params: ["sessionId": sessionId, "model": model])
	}

	public func listModels(provider: String) async throws -> [ModelInfo] {
		guard connected else { throw NodeClientError.disconnected }
		let result: ModelsResult = try await sendRequest(
			method: "models.list", params: ["provider": provider])
		return result.models.map { ModelInfo(id: $0.id, provider: $0.provider, label: $0.name) }
	}

	public func setMode(workspaceId: String, mode: LeaderMode) async throws {
		guard connected else { throw NodeClientError.disconnected }
		let _: IgnoredResult = try await sendRequest(
			method: "leader.setMode", params: ["workspaceId": workspaceId, "mode": mode.rawValue])
	}

	public func pin(missionId: Ulid, pinned: Bool) async throws {
		guard connected else { throw NodeClientError.disconnected }
		let _: IgnoredResult = try await sendRequest(
			method: "mission.pin", params: ["missionId": missionId, "pinned": pinned])
	}

	public func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws {
		guard connected else { throw NodeClientError.disconnected }
		let _: IgnoredResult = try await sendRequest(
			method: "agent.archive", params: ["agentId": agentId, "confirm": confirmRunning])
	}

	// MARK: - Request machinery (seams the tests drive without a socket)

	/// Allocates the next monotonic request id and encodes one framed
	/// JSON-RPC line. Internal so tests can assert ids increase.
	func makeRequestData(method: String, params: [String: Any] = [:]) throws -> (id: Int, data: Data) {
		nextRequestId += 1
		let id = nextRequestId
		let object: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method, "params": params]
		let line = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
		return (id, LineFramer.frame(line))
	}

	/// Maps one error response line to its `NodeClientError`, or nil when the
	/// line carries no error. Internal so tests cover it without a socket.
	func mapResponseError(_ line: Data) -> NodeClientError? {
		guard let envelope = try? NetaJSON.decoder.decode(ErrorEnvelope.self, from: line),
			let error = envelope.error
		else { return nil }
		return mapError(code: error.code, message: error.message, symbol: error.data?.code)
	}

	func mapError(code: Int, message: String, symbol: String?) -> NodeClientError {
		switch symbol {
		case "UNAUTHORIZED":
			return .rejected(message)
		case "PROTOCOL_MISMATCH":
			return .protocolMismatch(knownServerVersion ?? Self.protocolVersion)
		default:
			return .rpc(code: code, message: message)
		}
	}

	private func sendRequest<Result: Decodable>(method: String, params: [String: Any]) async throws
		-> Result
	{
		let (id, line) = try makeRequestData(method: method, params: params)
		try await send(line)
		do {
			let data = try await waitForResponse(id: id)
			return try decodeResponse(data)
		} catch {
			pending.removeValue(forKey: id)
			throw error
		}
	}

	private func decodeResponse<Result: Decodable>(_ data: Data) throws -> Result {
		let envelope = try NetaJSON.decoder.decode(RpcResponse<Result>.self, from: data)
		if let error = envelope.error {
			throw mapError(code: error.code, message: error.message, symbol: error.data?.code)
		}
		guard let result = envelope.result else {
			throw NodeClientError.rpc(code: -32603, message: "malformed response")
		}
		return result
	}

	private func waitForResponse(id: Int) async throws -> Data {
		try await withTaskCancellationHandler {
			try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
				pending[id] = continuation
			}
		} onCancel: {
			Task { await self.cancelPending(id: id) }
		}
	}

	private func cancelPending(id: Int) {
		guard let continuation = pending.removeValue(forKey: id) else { return }
		continuation.resume(throwing: CancellationError())
	}

	private func send(_ line: Data) async throws {
		guard let conn = connection else { throw NodeClientError.disconnected }
		let failed: Bool = await withCheckedContinuation { continuation in
			conn.send(content: line, completion: .contentProcessed { error in
				continuation.resume(returning: error != nil)
			})
		}
		if failed { throw NodeClientError.disconnected }
	}

	// MARK: - Connection events and inbound lines

	private func waitForReady(path: String) async throws {
		let conn = NWConnection(to: .unix(path: path), using: .tcp)
		connection = conn
		conn.stateUpdateHandler = { [weak self] state in
			guard let self else { return }
			let event: ConnectionEvent
			switch state {
			case .ready: event = .ready
			case .failed: event = .failed
			case .cancelled: event = .cancelled
			case .waiting: event = .waiting
			default: return
			}
			Task { await self.handleConnectionEvent(event) }
		}
		conn.start(queue: ioQueue)
		try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
			readyContinuation = continuation
		}
	}

	private func handleConnectionEvent(_ event: ConnectionEvent) {
		switch event {
		case .ready:
			resumeReady(with: .success(()))
		case .failed:
			resumeReady(with: .failure(NodeClientError.nodeUnavailable))
		case .cancelled:
			resumeReady(with: .failure(NodeClientError.disconnected))
		case .waiting:
			break
		}
	}

	private func resumeReady(with result: Result<Void, Error>) {
		guard let continuation = readyContinuation else { return }
		readyContinuation = nil
		continuation.resume(with: result)
	}

	private func startReceiveLoop() {
		receiveOne()
	}

	private func receiveOne() {
		guard let conn = connection else { return }
		conn.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) {
			[weak self] data, _, isComplete, error in
			guard let self else { return }
			Task { await self.handleReceived(chunk: data, isComplete: isComplete, failed: error != nil) }
		}
	}

	private func handleReceived(chunk: Data?, isComplete: Bool, failed: Bool) {
		if let chunk, !chunk.isEmpty {
			for line in framer.push(chunk) {
				handleLine(line)
			}
		}
		guard !failed, !isComplete, chunk != nil else {
			handleRemoteDisconnect()
			return
		}
		receiveOne()
	}

	private func handleLine(_ line: Data) {
		guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }
		if let id = object["id"] as? Int, let continuation = pending.removeValue(forKey: id) {
			continuation.resume(returning: line)
			return
		}
		guard let method = object["method"] as? String,
			let notification = decodeNotification(method: method, object: object)
		else { return }
		relay.yield(notification)
	}

	private func decodeNotification(method: String, object: [String: Any]) -> NodeNotification? {
		guard let params = object["params"],
			let paramsData = try? JSONSerialization.data(withJSONObject: params)
		else { return nil }
		switch method {
		case "event":
		 guard let payload = try? NetaJSON.decoder.decode(EventNotification.self, from: paramsData) else {
				return nil
			}
			return .event(payload.event)
		case "state":
			guard let change = try? NetaJSON.decoder.decode(StateChange.self, from: paramsData) else {
				return nil
			}
			return .state(change)
		case "turn":
			guard let change = try? NetaJSON.decoder.decode(TurnChange.self, from: paramsData) else {
				return nil
			}
			return .turn(change)
		case "node":
			guard let lifecycle = try? NetaJSON.decoder.decode(NodeLifecycle.self, from: paramsData) else {
				return nil
			}
			return .node(lifecycle)
		default:
			return nil
		}
	}

	// MARK: - Teardown

	/// The peer went away: fail pending requests and finish the stream. The
	/// caller reconnects with a fresh snapshot.
	private func handleRemoteDisconnect() {
		dropConnection()
		relay.finish()
	}

	private func dropConnection() {
		connected = false
		if let conn = connection {
			connection = nil
			conn.cancel()
		}
		if let ready = readyContinuation {
			readyContinuation = nil
			ready.resume(throwing: NodeClientError.disconnected)
		}
		let stalled = pending
		pending.removeAll()
		for continuation in stalled.values {
			continuation.resume(throwing: NodeClientError.disconnected)
		}
	}

	private func withTimeout<T: Sendable>(seconds: Double, operation: @escaping @Sendable () async throws -> T)
		async throws -> T
	{
		try await withThrowingTaskGroup(of: T.self) { group in
			group.addTask { try await operation() }
			group.addTask {
				try await Task.sleep(for: .seconds(seconds))
				throw NodeClientError.nodeUnavailable
			}
			guard let first = try await group.next() else {
				throw NodeClientError.nodeUnavailable
			}
			group.cancelAll()
			return first
		}
	}
}

/// Holds the current notification stream outside actor isolation so the
/// synchronous `notifications` requirement stays nonisolated. The actor
/// renews it on every `connect()` (after finishing the stale one) and
/// finishes it on disconnect.
private final class NotificationRelay: @unchecked Sendable {
	private let lock = NSLock()
	private var stream: AsyncStream<NodeNotification>
	private var continuation: AsyncStream<NodeNotification>.Continuation?

	init() {
		let (stream, continuation) = AsyncStream.makeStream(of: NodeNotification.self)
		self.stream = stream
		self.continuation = continuation
	}

	var current: AsyncStream<NodeNotification> {
		lock.withLock { stream }
	}

	func yield(_ notification: NodeNotification) {
		lock.withLock { continuation }?.yield(notification)
	}

	func renew() {
		lock.withLock {
			continuation?.finish()
			let (stream, continuation) = AsyncStream.makeStream(of: NodeNotification.self)
			self.stream = stream
			self.continuation = continuation
		}
	}

	func finish() {
		lock.withLock {
			continuation?.finish()
			continuation = nil
		}
	}
}

// MARK: - Wire types

private enum ConnectionEvent: Sendable {
	case ready
	case failed
	case waiting
	case cancelled
}

/// 04's `hello` result: `{machine, protocolVersion, nodeVersion, pid}`. Only
/// the version gates the handshake, so the rest is lenient.
private struct HelloResult: Decodable {
	let machine: Machine?
	let protocolVersion: Int
	let nodeVersion: String?
	let pid: Int?
}

private struct RpcResponse<Result: Decodable>: Decodable {
	let id: Int
	let result: Result?
	let error: RpcErrorPayload?
}

private struct ErrorEnvelope: Decodable {
	let error: RpcErrorPayload?
}

private struct RpcErrorPayload: Decodable {
	let code: Int
	let message: String
	let data: RpcErrorData?
}

private struct RpcErrorData: Decodable {
	let code: String?
}

/// A result the client ignores; any object decodes.
private struct IgnoredResult: Decodable {}

private struct MissionsResult: Decodable {
	let missions: [Mission]
}

private struct EventsResult: Decodable {
	let events: [Event]
}

private struct PromptResult: Decodable {
	let turnId: TurnId
}

private struct WireModel: Decodable {
	let id: String
	let name: String
	let provider: String
}

private struct ModelsResult: Decodable {
	let models: [WireModel]
}

private struct EventNotification: Decodable {
	let event: Event
}
