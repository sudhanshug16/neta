@preconcurrency import Foundation

private struct BridgeRequest: Encodable, Sendable {
	let id: String
	let command: String
	var sessionId: String?
	var actorId: String?
	var cwd: String?
	var backend: String?
	var since: Int?
	var text: String?
}

private struct BridgeEnvelope<Value: Decodable & Sendable>: Decodable, Sendable {
	let id: String
	let ok: Bool
	let data: Value?
	let error: String?
}

private struct EmptyResponse: Decodable, Sendable {}

private struct ProjectListResponse: Decodable, Sendable {
	let projects: [BridgeProject]
}

private struct OpenProjectResponse: Decodable, Sendable {
	let sessionId: String
}

private struct BridgeProject: Decodable, Sendable {
	let id: String
	let logicalId: String
	let name: String
	let path: String
	let owned: Bool
	let lifecycle: ProjectLifecycle
	let updatedAt: Double
	let resumable: Bool
	let workspace: BridgeWorkspace?
	let error: String?
	let agents: [BridgeActor]
}

private struct BridgeWorkspace: Decodable, Sendable {
	let provider: String
	let branch: String?
	let availability: WorkspaceAvailability
}

private struct BridgeActor: Decodable, Sendable {
	let id: String
	let name: String
	let role: String
	let backend: String
	let kind: AgentKind
	let state: AgentState
	let task: String?
	let writer: Bool?
}

private struct MessagePageResponse: Decodable, Sendable {
	let cursor: Int
	let messages: [BridgeMessage]
}

private struct BridgeMessage: Decodable, Sendable {
	let id: String
	let author: MessageAuthor
	let text: String
	let at: Double
}

private enum BridgeTransportError: LocalizedError {
	case resourceMissing
	case stopped
	case invalidResponse
	case bridge(String)

	var errorDescription: String? {
		switch self {
		case .resourceMissing:
			"The bundled Neta ACP bridge is missing. Rebuild the app with scripts/build-app.sh."
		case .stopped:
			"The Neta ACP bridge stopped unexpectedly."
		case .invalidResponse:
			"The Neta ACP bridge returned an invalid response."
		case let .bridge(message):
			message
		}
	}
}

private actor BridgeTransport {
	private var process: Process?
	private var input: FileHandle?
	private var readerTask: Task<Void, Never>?
	private var pending: [String: CheckedContinuation<Data, Error>] = [:]
	private let encoder = JSONEncoder()
	private let decoder = JSONDecoder()

	deinit {
		readerTask?.cancel()
		process?.terminate()
	}

	func request<Value: Decodable & Sendable>(_ request: BridgeRequest, as type: Value.Type) async throws -> Value {
		try startIfNeeded()
		let payload = try encoder.encode(request) + Data([0x0A])
		guard let input else { throw BridgeTransportError.stopped }
		let responseData = try await withCheckedThrowingContinuation { continuation in
			pending[request.id] = continuation
			do {
				try input.write(contentsOf: payload)
			} catch {
				pending.removeValue(forKey: request.id)
				continuation.resume(throwing: error)
			}
		}
		let envelope = try decoder.decode(BridgeEnvelope<Value>.self, from: responseData)
		guard envelope.ok else { throw BridgeTransportError.bridge(envelope.error ?? "Unknown bridge error") }
		guard let data = envelope.data else { throw BridgeTransportError.invalidResponse }
		return data
	}

	private func startIfNeeded() throws {
		if process?.isRunning == true { return }
		guard let bridgeURL = Bundle.main.url(forResource: "neta-bridge", withExtension: nil) else {
			throw BridgeTransportError.resourceMissing
		}
		let process = Process()
		let stdout = Pipe()
		let stdin = Pipe()
		process.executableURL = bridgeURL
		process.arguments = ["desktop-bridge"]
		process.standardInput = stdin
		process.standardOutput = stdout
		process.standardError = FileHandle.nullDevice
		var environment = ProcessInfo.processInfo.environment
		let home = FileManager.default.homeDirectoryForCurrentUser.path
		let additions = ["\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]
		environment["PATH"] = (additions + [environment["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
		process.environment = environment
		try process.run()
		self.process = process
		input = stdin.fileHandleForWriting
		let output = stdout.fileHandleForReading
		readerTask = Task { [weak self] in
			do {
				for try await line in output.bytes.lines {
					await self?.receive(Data(line.utf8))
				}
				await self?.failPending(BridgeTransportError.stopped)
			} catch {
				await self?.failPending(error)
			}
		}
	}

	private func receive(_ data: Data) {
		guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
			let id = object["id"] as? String,
			let continuation = pending.removeValue(forKey: id)
		else { return }
		continuation.resume(returning: data)
	}

	private func failPending(_ error: Error) {
		let continuations = pending.values
		pending.removeAll()
		for continuation in continuations {
			continuation.resume(throwing: error)
		}
		process = nil
		input = nil
	}
}

actor NetaBridgeClient: AgentSessionClient {
	private let transport = BridgeTransport()
	private var messages: [String: [AgentMessage]] = [:]
	private var cursors: [String: Int] = [:]

	func loadWorkspace() async throws -> WorkspaceSnapshot {
		let response: ProjectListResponse = try await request(command: "list")
		return WorkspaceSnapshot(projects: response.projects.map(project))
	}

	func loadArchives() async throws -> [NetaProject] {
		let response: ProjectListResponse = try await request(command: "archives")
		return response.projects.map(project)
	}

	func loadMessages(projectID: String, agentID: String) async throws -> [AgentMessage] {
		let key = cacheKey(projectID: projectID, agentID: agentID)
		let page: MessagePageResponse = try await request(
			command: "tail",
			sessionId: projectID,
			actorId: agentID,
			since: cursors[key] ?? 0
		)
		var cached = messages[key] ?? []
		cached.append(contentsOf: page.messages.map { message in
			AgentMessage(
				id: stableUUID(message.id),
				author: message.author,
				text: message.text,
				createdAt: Date(timeIntervalSince1970: message.at / 1_000)
			)
		})
		messages[key] = cached
		cursors[key] = page.cursor
		return cached
	}

	func send(_ text: String, projectID: String, agentID: String) async throws {
		let _: EmptyResponse = try await request(
			command: "prompt",
			sessionId: projectID,
			actorId: agentID,
			text: text
		)
	}

	func stop(projectID: String, agentID: String) async throws {
		let _: EmptyResponse = try await request(command: "stop", sessionId: projectID, actorId: agentID)
	}

	func openProject(at path: String) async throws {
		let _: OpenProjectResponse = try await request(command: "open", cwd: path)
	}

	func resumeProject(_ projectID: String) async throws -> String {
		let response: OpenProjectResponse = try await request(command: "resume", sessionId: projectID)
		return response.sessionId
	}

	private func project(_ source: BridgeProject) -> NetaProject {
		NetaProject(
			id: source.id,
			name: source.name,
			path: source.path,
			isOwned: source.owned,
			lifecycle: source.lifecycle,
			updatedAt: Date(timeIntervalSince1970: source.updatedAt / 1_000),
			isResumable: source.resumable,
			workspace: source.workspace.map {
				ProjectWorkspace(provider: $0.provider, branch: $0.branch, availability: $0.availability)
			},
			errorMessage: source.error,
			agents: source.agents.enumerated().map { index, agent in
				NetaAgent(
					id: agent.id,
					name: agent.name,
					role: agent.role,
					backend: agent.backend,
					kind: agent.kind,
					state: agent.state,
					position: position(index: index, kind: agent.kind),
					messages: messages[cacheKey(projectID: source.id, agentID: agent.id)] ?? [],
					canChat: source.lifecycle == .active && (agent.kind == .worker || source.owned),
					canStop: source.lifecycle == .active && canStop(agent: agent, owned: source.owned)
				)
			}
		)
	}

	private func canStop(agent: BridgeActor, owned: Bool) -> Bool {
		if agent.kind == .leader { return owned && agent.state == .thinking }
		return agent.state == .running || agent.state == .thinking || agent.state == .waiting
	}

	private func position(index: Int, kind: AgentKind) -> CanvasPosition {
		if kind == .leader { return CanvasPosition(x: -0.16, y: -0.02) }
		let worker = max(0, index - 1)
		let columns = 3
		let column = worker % columns
		let row = worker / columns
		return CanvasPosition(x: 0.18 + Double(column) * 0.22, y: -0.34 + Double(row) * 0.34)
	}

	private func request<Value: Decodable & Sendable>(
		command: String,
		sessionId: String? = nil,
		actorId: String? = nil,
		cwd: String? = nil,
		since: Int? = nil,
		text: String? = nil
	) async throws -> Value {
		try await transport.request(
			BridgeRequest(
				id: UUID().uuidString,
				command: command,
				sessionId: sessionId,
				actorId: actorId,
				cwd: cwd,
				backend: nil,
				since: since,
				text: text
			),
			as: Value.self
		)
	}

	private func cacheKey(projectID: String, agentID: String) -> String {
		"\(projectID)::\(agentID)"
	}

	private func stableUUID(_ value: String) -> UUID {
		if let uuid = UUID(uuidString: value) { return uuid }
		var bytes = Array(value.utf8.prefix(16))
		bytes.append(contentsOf: repeatElement(0, count: max(0, 16 - bytes.count)))
		return UUID(uuid: (
			bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
			bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
		))
	}
}
