import Foundation
import Network
import Darwin

/// The `node.json` descriptor a running Node leaves in `~/.neta` (04-node
/// T4.2). The file also carries `startedAt`, which this client ignores.
public struct NodeInfo: Codable, Sendable, Equatable {
	public let socket: String
	public let token: String
	public let pid: Int
	public let protocolVersion: Int
	public let runtimeBuild: String?

	public init(socket: String, token: String, pid: Int, protocolVersion: Int, runtimeBuild: String? = nil) {
		self.socket = socket; self.token = token; self.pid = pid
		self.protocolVersion = protocolVersion; self.runtimeBuild = runtimeBuild
	}
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
		try await withCheckedThrowingContinuation { continuation in
			process.terminationHandler = { _ in continuation.resume() }
			do { try process.run() } catch { continuation.resume(throwing: error) }
		}
		guard process.terminationStatus == 0 else { throw NodeClientError.nodeUnavailable }
	}
}

/// Everything that can go wrong between the app and the Node.
public enum NodeClientError: Error, Sendable, Equatable {
	/// No socket after `start()` plus the 250 ms / 5 s retry window.
	case nodeUnavailable
	/// The node's protocol version differs from `SocketNodeClient.protocolVersion`.
	/// The payload is the version the node reported.
	case protocolMismatch(Int)
	case runtimeMismatch
	/// The node rejected the handshake, e.g. a stale token (`UNAUTHORIZED`).
	case rejected(String)
	/// A JSON-RPC error response to a normal request.
	case rpc(code: Int, message: String)
	/// The connection dropped; pending requests fail with this.
	case disconnected
}

extension NodeClientError: LocalizedError {
	public var errorDescription: String? {
		switch self {
		case .protocolMismatch, .runtimeMismatch:
			"This app needs to update the running Neta service."
		case .nodeUnavailable: "The Neta service is unavailable."
		case .rejected(let message), .rpc(_, let message): message
		case .disconnected: "The Neta service disconnected."
		}
	}
}

/// Fans one Node's notifications out to every consumer (FIXPASS G4-3).
///
/// An `AsyncStream` delivers each element to exactly one waiting consumer, so
/// one shared stream split the Node's traffic between the store loop and the
/// chat: each saw about half of it. Every `notifications` access instead takes
/// its own subscription here and receives every notification from that moment
/// on. A subscription buffers the newest `bufferLimit` notifications and drops
/// the oldest beyond that, matching 04's rule that a connection 1000
/// notifications behind is dropped. `finishAll()` ends every subscription, so
/// a consumer can tell the connection ended and resubscribe.
///
/// A subscription carries only what is broadcast after `subscribe()`, so a
/// consumer takes its stream *before* the request whose window it cannot
/// afford to miss (`snapshot`, `conversation.tail`), never after.
final class NotificationHub: @unchecked Sendable {
	/// Notifications buffered per subscription before the oldest are dropped.
	static let bufferLimit = 1_000

	private let lock = NSLock()
	private var subscribers: [Int: AsyncStream<NodeNotification>.Continuation] = [:]
	private var nextId = 0

	/// A fresh stream carrying every notification broadcast from now on.
	func subscribe() -> AsyncStream<NodeNotification> {
		let (stream, continuation) = AsyncStream.makeStream(
			of: NodeNotification.self,
			bufferingPolicy: .bufferingNewest(Self.bufferLimit))
		let id: Int = lock.withLock {
			nextId += 1
			subscribers[nextId] = continuation
			return nextId
		}
		continuation.onTermination = { [weak self] _ in
			guard let self else { return }
			_ = self.lock.withLock { self.subscribers.removeValue(forKey: id) }
		}
		return stream
	}

	/// Hands one notification to every live subscription.
	func broadcast(_ notification: NodeNotification) {
		for continuation in lock.withLock({ Array(subscribers.values) }) {
			continuation.yield(notification)
		}
	}

	/// Ends every subscription. A consumer whose `for await` ends this way
	/// resubscribes; the next `subscribe()` gets a live stream again.
	func finishAll() {
		let ending: [AsyncStream<NodeNotification>.Continuation] = lock.withLock {
			let all = Array(subscribers.values)
			subscribers.removeAll()
			return all
		}
		for continuation in ending { continuation.finish() }
	}

	/// Live subscriptions, for tests.
	var subscriberCount: Int { lock.withLock { subscribers.count } }
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
	public static let protocolVersion = 3

	/// `~/.neta`, or `$NETA_DIR` when set (04: it overrides the default).
	public static let defaultDirectory: URL = {
		if let override = ProcessInfo.processInfo.environment["NETA_DIR"], !override.isEmpty {
			return URL(fileURLWithPath: override, isDirectory: true)
		}
		return FileManager.default.homeDirectoryForCurrentUser
			.appendingPathComponent(".neta", isDirectory: true)
	}()

	private static let defaultRetryWindow: Duration = .seconds(5)
	private static let defaultRetryInterval: Duration = .milliseconds(250)
	private static let attemptTimeout: Double = 4
	/// Consecutive failing `connect()` calls that may still start a Node
	/// before the client stops launching one (FIXPASS G4-2). A successful
	/// connect resets the count, so a Node quit later is started again.
	static let maxLaunchAttempts = 5

	/// Nonisolated so it can satisfy the synchronous protocol requirement.
	/// Every access is its own subscription: two consumers must never share
	/// one `AsyncStream`, which would split the traffic between them.
	public nonisolated var notifications: AsyncStream<NodeNotification> { hub.subscribe() }

	private let netaDirectory: URL
	private let launcher: any NodeLauncher
	private let retryWindow: Duration
	private let retryInterval: Duration
	private let ioQueue = DispatchQueue(label: "neta.node-connection")
	private let hub = NotificationHub()
	private var connection: NWConnection?
	private var connected = false
	private var framer = LineFramer()
	private var nextRequestId = 0
	private var launchAttempts = 0
	private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
	private var readyContinuation: CheckedContinuation<Void, Error>?
	private var knownServerVersion: Int?

	public init(
		netaDirectory: URL = SocketNodeClient.defaultDirectory,
		launcher: any NodeLauncher = BundledNodeLauncher()
	) {
		self.init(
			netaDirectory: netaDirectory, launcher: launcher,
			retryWindow: SocketNodeClient.defaultRetryWindow,
			retryInterval: SocketNodeClient.defaultRetryInterval)
	}

	/// The retry knobs are internal so tests can shrink the 5 s window
	/// instead of waiting it out; nothing outside the module sets them.
	init(
		netaDirectory: URL, launcher: any NodeLauncher,
		retryWindow: Duration, retryInterval: Duration
	) {
		self.netaDirectory = netaDirectory
		self.launcher = launcher
		self.retryWindow = retryWindow
		self.retryInterval = retryInterval
	}

	/// Launches at most once per `connect()` call, and at most
	/// `maxLaunchAttempts` times across consecutive failures.
	private func launchIfAllowed() async throws {
		guard launchAttempts < Self.maxLaunchAttempts else { return }
		launchAttempts += 1
		try await launcher.start()
	}

	// MARK: - Connect

	/// Connects, starting a Node once if none is running. Every subscription
	/// handed out for the previous connection is finished first, so its
	/// consumers resubscribe against the new one.
	public func connect() async throws {
		if connected { return }
		hub.finishAll()
		let deadline = Date().addingTimeInterval(retryWindowSeconds)
		var launched = false
		while true {
			do {
				try await attemptConnect()
				launchAttempts = 0
				return
			} catch is CancellationError {
				dropConnection()
				hub.finishAll()
				throw CancellationError()
			} catch let error as NodeClientError {
				switch error {
				case .nodeUnavailable, .disconnected:
					dropConnection()
					if !launched {
						launched = true
						try await launchIfAllowed()
					}
					guard Date() < deadline else {
						dropConnection()
						hub.finishAll()
						throw NodeClientError.nodeUnavailable
					}
					try await Task.sleep(for: retryInterval)
				case .protocolMismatch, .runtimeMismatch, .rejected, .rpc:
					dropConnection()
					hub.finishAll()
					throw error
				}
			} catch {
				dropConnection()
				if !launched {
					launched = true
					try await launchIfAllowed()
				}
				guard Date() < deadline else {
					dropConnection()
					hub.finishAll()
					throw NodeClientError.nodeUnavailable
				}
				try await Task.sleep(for: retryInterval)
			}
		}
	}

	/// Uses the bundled CLI's authenticated handshake to stop the recorded
	/// service during an app upgrade. If that succeeds but the exact same
	/// descriptor remains live, terminate only that authenticated PID.
	public func stopIncompatibleNode() async throws {
		let original = try readNodeInfo()
		guard let resources = Bundle.main.resourceURL else { throw NodeClientError.nodeUnavailable }
		let process = Process()
		process.executableURL = resources.appendingPathComponent("neta", isDirectory: false)
		process.arguments = ["node", "stop"]
		process.standardInput = FileHandle.nullDevice
		process.standardOutput = FileHandle.nullDevice
		let errors = Pipe()
		process.standardError = errors
		var environment = ProcessInfo.processInfo.environment
		environment["NETA_DIR"] = netaDirectory.path
		process.environment = environment
		try await withCheckedThrowingContinuation { continuation in
			process.terminationHandler = { _ in continuation.resume() }
			do { try process.run() } catch { continuation.resume(throwing: error) }
		}
		let message = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
			.trimmingCharacters(in: .whitespacesAndNewlines)
		// This precise failure occurs only after the CLI read the descriptor,
		// authenticated its token, and received node.stop. Other failures never
		// authorize signalling a process.
		let authenticatedTimeout = Self.authorizesForcedStop(message: message, pid: original.pid)
		let mayForceOwnedService = forceEligible(original)
		guard process.terminationStatus == 0 || authenticatedTimeout || mayForceOwnedService else {
			throw NodeClientError.rejected(message?.isEmpty == false ? message! : "The old Neta service could not be stopped.")
		}
		for _ in 0..<20 {
			if kill(pid_t(original.pid), 0) != 0, errno == ESRCH { break }
			try await Task.sleep(for: .milliseconds(100))
		}
		if kill(pid_t(original.pid), 0) == 0, (authenticatedTimeout || mayForceOwnedService),
			(try? readNodeInfo()) == original
		{
			_ = kill(pid_t(original.pid), SIGTERM)
			for _ in 0..<20 {
				if kill(pid_t(original.pid), 0) != 0, errno == ESRCH { break }
				try await Task.sleep(for: .milliseconds(100))
			}
			if kill(pid_t(original.pid), 0) == 0, (try? readNodeInfo()) == original {
				_ = kill(pid_t(original.pid), SIGKILL)
			}
		}
		dropConnection()
		launchAttempts = 0
		knownServerVersion = nil
	}

	static func authorizesForcedStop(message: String?, pid: Int) -> Bool {
		message?.hasPrefix("neta: timed out waiting for pid \(pid) to stop") == true
	}

	private func forceEligible(_ info: NodeInfo) -> Bool {
		guard kill(pid_t(info.pid), 0) == 0, (try? readNodeInfo()) == info else { return false }
		let socket = URL(fileURLWithPath: resolveSocketPath(info)).standardizedFileURL
		guard socket.deletingLastPathComponent() == netaDirectory.standardizedFileURL else { return false }
		var bytes = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
		let count = proc_pidpath(Int32(info.pid), &bytes, UInt32(bytes.count))
		guard count > 0 else { return false }
		let path = String(decoding: bytes.prefix(Int(count)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
		let executable = URL(fileURLWithPath: path).resolvingSymlinksInPath()
		return executable.lastPathComponent == "neta"
	}

	/// `retryWindow` in seconds, for the wall-clock deadline above.
	private var retryWindowSeconds: Double {
		let components = retryWindow.components
		return Double(components.seconds) + Double(components.attoseconds) * 1e-18
	}

	private func attemptConnect() async throws {
		let info = try readNodeInfo()
		knownServerVersion = info.protocolVersion
		if kill(pid_t(info.pid), 0) != 0, errno == ESRCH {
			try? FileManager.default.removeItem(at: netaDirectory.appendingPathComponent("node.json"))
			throw NodeClientError.nodeUnavailable
		}
		guard info.protocolVersion == Self.protocolVersion else {
			throw NodeClientError.protocolMismatch(info.protocolVersion)
		}
		if let expected = Bundle.main.object(forInfoDictionaryKey: "NetaRuntimeBuild") as? String,
			!expected.isEmpty, info.runtimeBuild != expected
		{
			throw NodeClientError.runtimeMismatch
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

	public func conversationTail(
		sessionId: Ulid, cursor: String? = nil, limit: Int,
		direction: String? = nil, turnId: TurnId? = nil
	) async throws -> ConversationPage {
		guard connected else { throw NodeClientError.disconnected }
		var params: [String: Any] = ["sessionId": sessionId, "limit": limit]
		if let cursor { params["cursor"] = cursor }
		if let direction { params["direction"] = direction }
		if let turnId { params["turnId"] = turnId }
		return try await sendRequest(method: "conversation.tail", params: params)
	}

	public func prompt(sessionId: Ulid, text: String) async throws -> Ulid {
		try await prompt(sessionId: sessionId, text: text, attachments: [])
	}

	public func prompt(sessionId: Ulid, text: String, attachments: [PromptAttachment]) async throws -> Ulid {
		guard connected else { throw NodeClientError.disconnected }
		var params: [String: Any] = ["sessionId": sessionId, "text": text]
		if !attachments.isEmpty {
			params["attachments"] = attachments.map { ["id": $0.id, "kind": $0.kind.rawValue, "name": $0.name, "mimeType": $0.mimeType, "dataBase64": $0.dataBase64] }
		}
		let result: PromptResult = try await sendRequest(
			method: "conversation.prompt", params: params)
		guard let id = result.turnId ?? result.messageId else { throw NodeClientError.rejected("Prompt acknowledgement had no id") }
		return id
	}

	public func conversationInbox(sessionId: Ulid) async throws -> [InboxMessage] {
		guard connected else { throw NodeClientError.disconnected }
		let result: InboxResult = try await sendRequest(method: "conversation.inbox", params: ["sessionId": sessionId])
		return result.messages
	}

	public func capabilities(sessionId: Ulid) async throws -> ConversationCapabilities {
		guard connected else { throw NodeClientError.disconnected }
		return try await sendRequest(method: "conversation.capabilities", params: ["sessionId": sessionId])
	}

	public func glanceList(workspaceId: String, after: Int, limit: Int) async throws -> GlancePage {
		try await sendRequest(method: "glance.list", params: ["workspaceId": workspaceId, "after": after, "limit": limit])
	}
	public func glanceSource(workspaceId: String, id: String) async throws -> GlanceSource {
		try await sendRequest(method: "glance.source", params: ["workspaceId": workspaceId, "id": id])
	}
	public func glanceComplete(workspaceId: String, id: String, sourceHash: String, result: GlanceResult) async throws -> GlanceCard {
		let encoded = try JSONSerialization.jsonObject(with: NetaJSON.encoder.encode(result))
		let response: GlanceCardEnvelope = try await sendRequest(method: "glance.complete", params: ["workspaceId": workspaceId, "id": id, "sourceHash": sourceHash, "result": encoded])
		return response.card
	}
	public func glanceMarkReviewed(workspaceId: String, through: Int) async throws -> Int {
		let response: GlanceReviewEnvelope = try await sendRequest(method: "glance.markReviewed", params: ["workspaceId": workspaceId, "throughGlanceSeq": through])
		return response.reviewedThroughGlanceSeq
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
		return result.models.map { ModelInfo(id: $0.id, provider: $0.provider, label: $0.name, description: $0.description) }
	}

	public func listModels(sessionId: Ulid) async throws -> [ModelInfo] {
		guard connected else { throw NodeClientError.disconnected }
		let result: ModelsResult = try await sendRequest(method: "models.list", params: ["sessionId": sessionId])
		return result.models.map { ModelInfo(id: $0.id, provider: $0.provider, label: $0.name, description: $0.description) }
	}

	public func listProviders() async throws -> [ProviderInfo] {
		try await listProviders(sessionId: "")
	}

	public func listProviders(sessionId: Ulid) async throws -> [ProviderInfo] {
		guard connected else { throw NodeClientError.disconnected }
		let result: ProvidersResult = try await sendRequest(method: "providers.list", params: sessionId.isEmpty ? [:] : ["sessionId": sessionId])
		return result.providers
	}

	public func prepareHandoff(sessionId: Ulid) async throws -> String {
		guard connected else { throw NodeClientError.disconnected }
		let result: HandoffResult = try await sendRequest(method: "conversation.prepareHandoff", params: ["sessionId": sessionId])
		return result.markdown
	}

	public func setProvider(sessionId: Ulid, provider: String, model: String?, handoff: String?) async throws -> ProviderSwitchResult {
		guard connected else { throw NodeClientError.disconnected }
		var params: [String: String] = ["sessionId": sessionId, "provider": provider]
		if let model { params["model"] = model }
		if let handoff { params["handoff"] = handoff }
		return try await sendRequest(method: "conversation.setProvider", params: params)
	}

	public func resetChat(sessionId: Ulid) async throws -> ProviderSwitchResult {
		guard connected else { throw NodeClientError.disconnected }
		return try await sendRequest(method: "conversation.reset", params: ["sessionId": sessionId])
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

	/// 04's `workspace.open {path} -> {workspace, leader}`. The leader comes
	/// back on the same result and again as a `state` notification, so only
	/// the workspace is returned here; the store takes the leader from the
	/// notification like every other record.
	public func openWorkspace(path: String) async throws -> Workspace {
		guard connected else { throw NodeClientError.disconnected }
		let result: WorkspaceOpenResult = try await sendRequest(
			method: "workspace.open", params: ["path": path])
		return result.workspace
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
		hub.broadcast(notification)
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
		case "glance.changed":
			guard let change = try? NetaJSON.decoder.decode(GlanceChange.self, from: paramsData) else { return nil }
			return .glance(change)
		default:
			return nil
		}
	}

	// MARK: - Teardown

	/// The peer went away: fail pending requests and finish the stream. The
	/// caller reconnects with a fresh snapshot.
	private func handleRemoteDisconnect() {
		dropConnection()
		hub.finishAll()
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
	let turnId: TurnId?
	let messageId: Ulid?
	let status: String?
}
private struct InboxResult: Decodable { let messages: [InboxMessage] }
private struct GlanceCardEnvelope: Decodable { let card: GlanceCard }
private struct GlanceReviewEnvelope: Decodable { let reviewedThroughGlanceSeq: Int }

private struct WireModel: Decodable {
	let id: String
	let name: String
	let provider: String
	let description: String?
}

private struct ModelsResult: Decodable {
	let models: [WireModel]
}

private struct EventNotification: Decodable {
	let event: Event
}

/// 04's `workspace.open` result: `{workspace, leader}`.
private struct WorkspaceOpenResult: Decodable {
	let workspace: Workspace
	let leader: Leader?
}

private struct ProvidersResult: Decodable { let providers: [ProviderInfo] }
private struct HandoffResult: Decodable { let sessionId: Ulid; let markdown: String }
