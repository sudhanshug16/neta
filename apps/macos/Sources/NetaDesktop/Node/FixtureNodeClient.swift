import Foundation

/// The fixture replay behind `NodeClient` (09-desktop-shell T9.3).
///
/// Loads `node-snapshot.json` once plus the recorded `node-events.ndjson`
/// from `fixtureDirectory` (default: the repo's `test/fixtures`, located
/// relative to this file via `#filePath`). Reads are answered from the
/// in-memory copy; `missionsList`/`eventsList` page backwards from `before`
/// and `conversationTail` pages backwards from `cursor`. Recorded events
/// replay through `notifications` one per `emitNext()`, so tests drive time.
/// Writes mutate the in-memory copy, emit the matching notification, and
/// never touch disk. The client is deliberately lenient: unknown ids record
/// the call and change nothing instead of throwing.
public actor FixtureNodeClient: NodeClient {
	/// The recorded `test/fixtures` directory, found by walking up from this
	/// file until the snapshot is found.
	public static let repoFixtures: URL = {
		let here = URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()
		var dir = here
		for _ in 0 ..< 12 {
			let marker = dir.appendingPathComponent("test/fixtures/node-snapshot.json")
			if FileManager.default.fileExists(atPath: marker.path) {
				return dir.appendingPathComponent("test/fixtures", isDirectory: true)
			}
			dir.deleteLastPathComponent()
		}
		// Fixed-layout fallback: Sources/NetaDesktop/Node -> repo root.
		var root = here
		for _ in 0 ..< 5 { root.deleteLastPathComponent() }
		return root.appendingPathComponent("test/fixtures", isDirectory: true)
	}()

	/// Nonisolated like the real client: every access is its own
	/// subscription, so two consumers each see every notification instead of
	/// splitting one stream between them (FIXPASS G4-3).
	public nonisolated var notifications: AsyncStream<NodeNotification> { hub.subscribe() }

	/// Every call in order: the `NodeClient` method name plus its params as
	/// JSON. Later tasks (11) assert writes against this log.
	public private(set) var calls: [(method: String, json: String)] = []

	private let hub = NotificationHub()
	private let recordedEvents: [Event]
	private var replayIndex = 0
	private var nextSeq: Int

	// Mutable in-memory copy of the snapshot.
	private var missions: [Mission]
	private var workspaces: [Workspace]
	private var agents: [Agent]
	private var leaders: [Leader]
	private var events: [Event]
	private var threads: [SessionId: ConversationThread] = [:]

	// Immutable snapshot parts.
	private let machine: Machine
	private let hasOlder: Bool
	private let completedCounts: [Ulid: Int]
	private let attention: [Mission]
	private let windowDays: Int
	private let protocolVersion: Int
	private let at: Date

	public init(fixtureDirectory: URL = FixtureNodeClient.repoFixtures) {
		func load<T: Decodable>(_ file: String, _ type: T.Type, directory: URL) -> T {
			let url = directory.appendingPathComponent(file, isDirectory: false)
			guard let data = try? Data(contentsOf: url) else {
				fatalError(
					"FixtureNodeClient: cannot read \(url.path); pass the recorded test/fixtures directory")
			}
			do {
				return try NetaJSON.decoder.decode(T.self, from: data)
			} catch {
				fatalError("FixtureNodeClient: cannot decode \(url.path): \(error)")
			}
		}
		let snapshot: Snapshot = load("node-snapshot.json", Snapshot.self, directory: fixtureDirectory)
		let ndjsonURL = fixtureDirectory.appendingPathComponent("node-events.ndjson", isDirectory: false)
		guard let ndjson = try? String(contentsOf: ndjsonURL, encoding: .utf8) else {
			fatalError(
				"FixtureNodeClient: cannot read \(ndjsonURL.path); pass the recorded test/fixtures directory")
		}
		var recorded: [Event] = []
		for line in ndjson.components(separatedBy: .newlines) {
			let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
			guard !trimmed.isEmpty else { continue }
			guard let event = try? NetaJSON.decoder.decode(Event.self, from: Data(trimmed.utf8)) else {
				fatalError("FixtureNodeClient: cannot decode an event line in \(ndjsonURL.path)")
			}
			recorded.append(event)
		}
		self.recordedEvents = recorded
		self.missions = snapshot.missions
		self.agents = snapshot.agents
		self.leaders = snapshot.leaders
		self.events = snapshot.events
		self.nextSeq = (snapshot.events.map(\.seq).max() ?? 0) + 1
		self.machine = snapshot.machine
		self.workspaces = snapshot.workspaces
		self.hasOlder = snapshot.hasOlder
		self.completedCounts = snapshot.completedCounts
		self.attention = snapshot.attention
		self.windowDays = snapshot.windowDays
		self.protocolVersion = snapshot.protocolVersion
		self.at = snapshot.at
	}

	/// Pushes the next recorded event onto `notifications`. Returns false and
	/// finishes the stream once every recorded event has replayed.
	public func emitNext() -> Bool {
		guard replayIndex < recordedEvents.count else {
			hub.finishAll()
			return false
		}
		hub.broadcast(.event(recordedEvents[replayIndex]))
		replayIndex += 1
		if replayIndex == recordedEvents.count {
			hub.finishAll()
		}
		return true
	}

	/// Pushes a made-up notification, for cases the recording has no data for.
	public func emit(_ notification: NodeNotification) {
		hub.broadcast(notification)
	}

	public func connect() async throws {
		record("connect", [:])
	}

	public func snapshot() async throws -> Snapshot {
		record("snapshot", [:])
		return Snapshot(
			machine: machine, workspaces: workspaces, leaders: leaders,
			missions: missions, hasOlder: hasOlder, agents: agents,
			completedCounts: completedCounts, events: events, attention: attention,
			windowDays: windowDays, protocolVersion: protocolVersion, at: at)
	}

	public func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission] {
		var params: [String: Any] = ["workspaceId": workspaceId, "limit": limit]
		if let before { params["before"] = NetaJSON.string(from: before) }
		record("missionsList", params)
		return Array(
			missions
				.filter {
					guard $0.workspaceId == workspaceId else { return false }
					if let before { return $0.createdAt < before }
					return true
				}
				.sorted { ($0.createdAt, $0.number) > ($1.createdAt, $1.number) }
				.prefix(max(limit, 0)))
	}

	public func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event] {
		var params: [String: Any] = ["workspaceId": workspaceId, "limit": limit]
		if let before { params["before"] = NetaJSON.string(from: before) }
		record("eventsList", params)
		return Array(
			events
				.filter {
					guard $0.workspaceId == workspaceId else { return false }
					if let before { return $0.at < before }
					return true
				}
				.sorted { $0.seq > $1.seq }
				.prefix(max(limit, 0)))
	}

	public func conversationTail(
		sessionId: Ulid, cursor: String? = nil, limit: Int,
		direction: String? = nil, turnId: TurnId? = nil
	) async throws -> ConversationPage {
		var params: [String: Any] = ["sessionId": sessionId, "limit": limit]
		if let cursor { params["cursor"] = cursor }
		if let direction { params["direction"] = direction }
		if let turnId { params["turnId"] = turnId }
		record("conversationTail", params)
		let thread = threads[sessionId] ?? ConversationThread()
		let turns = thread.turns.sorted { $0.startedAt < $1.startedAt }
		// 04's `turnId` anchor: the page starting at that turn, or with
		// `direction: "backward"` the page before it. An unknown anchor is
		// lenient like every other unknown id here: it falls back to the
		// cursor behavior below and changes nothing.
		if let turnId, let anchor = turns.firstIndex(where: { $0.id == turnId }) {
			if direction == "backward" {
				return page(thread: thread, turns: turns, end: anchor, limit: limit)
			}
			let start = anchor
			let end = min(start + max(limit, 0), turns.count)
			return page(thread: thread, turns: turns, start: start, end: end)
		}
		let end = cursor.flatMap(Int.init).map { min(max($0, 0), turns.count) } ?? turns.count
		return page(thread: thread, turns: turns, end: end, limit: limit)
	}

	/// One page over pre-sorted `turns`: the `limit` turns ending at `end`.
	private func page(thread: ConversationThread, turns: [Turn], end: Int, limit: Int) -> ConversationPage {
		let end = min(max(end, 0), turns.count)
		let start = max(0, end - max(limit, 0))
		return page(thread: thread, turns: turns, start: start, end: end)
	}

	/// One page over pre-sorted `turns`: `[start, end)`, with the blocks of
	/// those turns. Cursors are end offsets: a nil `prevCursor` is the start
	/// of history and a nil `nextCursor` its end.
	private func page(thread: ConversationThread, turns: [Turn], start: Int, end: Int) -> ConversationPage {
		let page = Array(turns[start ..< end])
		let ids = Set(page.map(\.id))
		let blocks = thread.blocks
			.filter { ids.contains($0.turnId) }
			.sorted { ($0.at, $0.seq) < ($1.at, $1.seq) }
		return ConversationPage(
			turns: page,
			blocks: blocks,
			nextCursor: end < turns.count ? String(end) : nil,
			prevCursor: start > 0 ? String(start) : nil)
	}

	public func prompt(sessionId: Ulid, text: String) async throws -> Ulid {
		record("prompt", ["sessionId": sessionId, "text": text])
		let turn = Turn(
			id: Self.newUlid(), sessionId: sessionId, startedAt: Date(),
			endedAt: nil, role: .user, cancelled: nil)
		var thread = threads[sessionId] ?? ConversationThread()
		thread.turns.append(turn)
		threads[sessionId] = thread
		hub.broadcast(.turn(TurnChange(sessionId: sessionId, turn: turn, block: nil)))
		return turn.id
	}

	public func cancel(sessionId: Ulid) async throws {
		record("cancel", ["sessionId": sessionId])
		guard var thread = threads[sessionId],
			let index = thread.turns.lastIndex(where: { $0.endedAt == nil && $0.cancelled != true })
		else { return }
		let open = thread.turns[index]
		let closed = Turn(
			id: open.id, sessionId: open.sessionId, startedAt: open.startedAt,
			endedAt: Date(), role: open.role, cancelled: true)
		thread.turns[index] = closed
		threads[sessionId] = thread
		hub.broadcast(.turn(TurnChange(sessionId: sessionId, turn: closed, block: nil)))
	}

	public func setModel(sessionId: Ulid, model: String) async throws {
		record("setModel", ["sessionId": sessionId, "model": model])
		if let index = leaders.firstIndex(where: { $0.sessionId == sessionId }) {
			let leader = leaders[index]
			leaders[index] = Leader(
				workspaceId: leader.workspaceId, machineId: leader.machineId,
				name: leader.name,
				sessionId: leader.sessionId, provider: leader.provider, model: model,
				mode: leader.mode, modeSince: leader.modeSince, modeActiveMs: leader.modeActiveMs,
				activeMissionId: leader.activeMissionId, state: leader.state)
			hub.broadcast(.state(StateChange(kind: .leader, record: .leader(leaders[index]))))
		} else if let index = agents.firstIndex(where: { $0.sessionId == sessionId }) {
			let agent = agents[index]
			agents[index] = Agent(
				id: agent.id, missionId: agent.missionId, workspaceId: agent.workspaceId,
				name: agent.name, task: agent.task, access: agent.access,
				provider: agent.provider, model: model, skills: agent.skills,
				sessionId: agent.sessionId, canSpawn: agent.canSpawn, state: agent.state,
				stateBefore: agent.stateBefore, activity: agent.activity,
				pendingQuestion: agent.pendingQuestion, startedAt: agent.startedAt,
				endedAt: agent.endedAt, outcome: agent.outcome)
			hub.broadcast(.state(StateChange(kind: .agent, record: .agent(agents[index]))))
		}
	}

	public func listModels(provider: String) async throws -> [ModelInfo] {
		record("listModels", ["provider": provider])
		var seen = Set<String>()
		var infos: [ModelInfo] = []
		for (modelProvider, model) in leaders.map({ ($0.provider, $0.model) })
			+ agents.map({ ($0.provider, $0.model) })
		{
			guard modelProvider == provider, seen.insert(model).inserted else { continue }
			infos.append(ModelInfo(id: model, provider: modelProvider, label: model))
		}
		return infos.sorted { $0.id < $1.id }
	}

	public func setMode(workspaceId: String, mode: LeaderMode) async throws {
		record("setMode", ["workspaceId": workspaceId, "mode": mode.rawValue])
		guard let index = leaders.firstIndex(where: { $0.workspaceId == workspaceId }) else { return }
		let leader = leaders[index]
		leaders[index] = Leader(
			workspaceId: leader.workspaceId, machineId: leader.machineId,
			name: leader.name,
			sessionId: leader.sessionId, provider: leader.provider, model: leader.model,
			mode: mode, modeSince: Date(), modeActiveMs: leader.modeActiveMs,
			activeMissionId: leader.activeMissionId, state: leader.state)
		hub.broadcast(.state(StateChange(kind: .leader, record: .leader(leaders[index]))))
	}

	public func pin(missionId: Ulid, pinned: Bool) async throws {
		record("pin", ["missionId": missionId, "pinned": pinned])
		let workspaceId = missions.first(where: { $0.id == missionId })?.workspaceId
			?? workspaces.first?.id ?? ""
		let event = Event(
			seq: nextSeq, at: Date(), workspaceId: workspaceId, kind: .userPinned,
			missionId: missionId, agentId: nil, sessionId: nil, turnId: nil,
			data: ["pinned": .bool(pinned)])
		nextSeq += 1
		events.append(event)
		hub.broadcast(.event(event))
	}

	public func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws {
		record("archiveAgent", ["agentId": agentId, "confirmRunning": confirmRunning])
		guard let index = agents.firstIndex(where: { $0.id == agentId }) else { return }
		let agent = agents[index]
		agents[index] = Agent(
			id: agent.id, missionId: agent.missionId, workspaceId: agent.workspaceId,
			name: agent.name, task: agent.task, access: agent.access,
			provider: agent.provider, model: agent.model, skills: agent.skills,
			sessionId: agent.sessionId, canSpawn: agent.canSpawn, state: .archived,
			stateBefore: agent.stateBefore, activity: agent.activity,
			pendingQuestion: agent.pendingQuestion, startedAt: agent.startedAt,
			endedAt: agent.endedAt ?? Date(), outcome: agent.outcome)
		hub.broadcast(.state(StateChange(kind: .agent, record: .agent(agents[index]))))
	}

	/// 04's `workspace.open`: a known root path returns its workspace, an
	/// unknown one adds a `folder` workspace on this machine. Nothing is
	/// written to disk, like every other write here.
	public func openWorkspace(path: String) async throws -> Workspace {
		record("openWorkspace", ["path": path])
		if let known = workspaces.first(where: { $0.roots.contains { $0.path == path } }) {
			return known
		}
		let name = URL(fileURLWithPath: path).lastPathComponent
		let workspace = Workspace(
			id: "folder:\(path)", kind: .folder, name: name, remote: nil,
			roots: [WorkspaceRoot(machineId: machine.id, path: path)],
			createdAt: Date())
		workspaces.append(workspace)
		return workspace
	}

	// MARK: - Private

	private func record(_ method: String, _ params: [String: Any]) {
		let json: String
		if params.isEmpty {
			json = "{}"
		} else if let data = try? JSONSerialization.data(withJSONObject: params, options: [.sortedKeys]),
			let string = String(data: data, encoding: .utf8)
		{
			json = string
		} else {
			json = "{}"
		}
		calls.append((method: method, json: json))
	}

	/// A runtime ULID for turns created by `prompt`: 48-bit millisecond time
	/// plus 80-bit randomness in Crockford base32. Generated, never fixture data.
	private static func newUlid(now: Date = Date()) -> Ulid {
		let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
		var time = UInt64(max(now.timeIntervalSince1970, 0) * 1000)
		var prefix = [Character](repeating: "0", count: 10)
		for i in stride(from: 9, through: 0, by: -1) {
			prefix[i] = alphabet[Int(time & 31)]
			time >>= 5
		}
		var id = String(prefix)
		var rng = SystemRandomNumberGenerator()
		for _ in 0 ..< 16 {
			id.append(alphabet[Int(rng.next() & 31)])
		}
		return id
	}
}

/// One session's turns and blocks, oldest first.
private struct ConversationThread: Sendable {
	var turns: [Turn] = []
	var blocks: [Block] = []
}
