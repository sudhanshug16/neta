import Foundation

/// The one interface the app talks to (09-desktop-shell T9.3).
///
/// The app never owns a session and never spawns an agent; it reads through
/// this client. `SocketNodeClient` (T9.4) is the real transport;
/// `FixtureNodeClient` replays the recorded `test/fixtures` data behind the
/// same interface for tests and previews.
public protocol NodeClient: Sendable {
	func connect() async throws
	func stopIncompatibleNode() async throws
	func snapshot() async throws -> Snapshot
	func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission]
	func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event]
	func conversationTail(
		sessionId: Ulid, cursor: String?, limit: Int, direction: String?, turnId: TurnId?
	) async throws -> ConversationPage
	func prompt(sessionId: Ulid, text: String) async throws -> Ulid
	func prompt(sessionId: Ulid, text: String, attachments: [PromptAttachment]) async throws -> Ulid
	func conversationInbox(sessionId: Ulid) async throws -> [InboxMessage]
	func capabilities(sessionId: Ulid) async throws -> ConversationCapabilities
	func cancel(sessionId: Ulid) async throws
	func setModel(sessionId: Ulid, model: String) async throws
	func listModels(provider: String) async throws -> [ModelInfo]
	func listModels(sessionId: Ulid) async throws -> [ModelInfo]
	func listProviders() async throws -> [ProviderInfo]
	func listProviders(sessionId: Ulid) async throws -> [ProviderInfo]
	func prepareHandoff(sessionId: Ulid) async throws -> String
	func setProvider(sessionId: Ulid, provider: String, model: String?, handoff: String?) async throws -> ProviderSwitchResult
	func resetChat(sessionId: Ulid) async throws -> ProviderSwitchResult
	func terminalAttach(sessionId: Ulid, cols: Int, rows: Int) async throws -> TerminalAttachment
	func terminalInput(sessionId: Ulid, attachmentId: String, data: Data) async throws
	func terminalResize(sessionId: Ulid, attachmentId: String, cols: Int, rows: Int) async throws
	func terminalDetach(sessionId: Ulid, attachmentId: String) async throws
	func setMode(workspaceId: String, mode: LeaderMode) async throws
	func pin(missionId: Ulid, pinned: Bool) async throws
	func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws
	func openWorkspace(path: String) async throws -> Workspace
	func glanceList(workspaceId: String, after: Int, limit: Int) async throws -> GlancePage
	func glanceSource(workspaceId: String, id: String) async throws -> GlanceSource
	func glanceComplete(workspaceId: String, id: String, sourceHash: String, result: GlanceResult) async throws -> GlanceCard
	func glanceMarkReviewed(workspaceId: String, through: Int) async throws -> Int
	/// Every access returns its own subscription that receives every
	/// notification from now on. Two consumers must never split one stream:
	/// an `AsyncStream` hands each element to exactly one waiting consumer,
	/// so a shared stream loses half of the traffic to each side.
	var notifications: AsyncStream<NodeNotification> { get }
}

/// 04's `conversation.tail` result: one page of a session's turns and the
/// blocks that belong to those turns. `cursor`/`prevCursor` are opaque
/// offsets minted by the client; a nil `prevCursor` is the start of history
/// and a nil `nextCursor` the end. A `turnId` anchors the page on that turn
/// (the page starting at it, or the page before it with
/// `direction: "backward"`); `direction: "backward"` pages older history
/// from `cursor`.
///
/// The three-argument tail below keeps earlier callers compiling: it asks
/// for the newest page, exactly as before.
public extension NodeClient {
	func glanceList(workspaceId: String, after: Int, limit: Int) async throws -> GlancePage { .init(cards: [], reviewedThroughGlanceSeq: 0, hasMore: false) }
	func glanceSource(workspaceId: String, id: String) async throws -> GlanceSource { throw NodeClientError.rpc(code: -32601, message: "Glance unavailable") }
	func glanceComplete(workspaceId: String, id: String, sourceHash: String, result: GlanceResult) async throws -> GlanceCard { throw NodeClientError.rpc(code: -32601, message: "Glance unavailable") }
	func glanceMarkReviewed(workspaceId: String, through: Int) async throws -> Int { through }
	func stopIncompatibleNode() async throws {
		throw NodeClientError.rpc(code: -32601, message: "service upgrade is unavailable on this client")
	}
	func conversationTail(sessionId: Ulid, cursor: String?, limit: Int) async throws -> ConversationPage {
		try await conversationTail(
			sessionId: sessionId, cursor: cursor, limit: limit, direction: nil, turnId: nil)
	}

	/// 04's `workspace.open`. The real transport and the fixture replay both
	/// implement it; a client that has no workspaces to open (a test stub)
	/// answers the way the Node answers an unknown method.
	///
	/// Temporary, and it weakens the protocol: a conformer that forgets
	/// `openWorkspace` compiles and fails only at runtime. It exists so the
	/// stubs in `Tests/NetaDesktopTests/{ChatPagingTests,ComposerTests}.swift`
	/// — owned by other fix groups — keep compiling. Delete this default once
	/// those two stubs implement the requirement.
	func openWorkspace(path: String) async throws -> Workspace {
		throw NodeClientError.rpc(code: -32601, message: "workspace.open is unavailable on this client")
	}
	func listModels(sessionId: Ulid) async throws -> [ModelInfo] { [] }
	func prompt(sessionId: Ulid, text: String, attachments: [PromptAttachment]) async throws -> Ulid {
		guard attachments.isEmpty else { throw NodeClientError.rpc(code: -32601, message: "attachments are unavailable") }
		return try await prompt(sessionId: sessionId, text: text)
	}
	func capabilities(sessionId: Ulid) async throws -> ConversationCapabilities { .init(image: false, embeddedContext: false) }
	func conversationInbox(sessionId: Ulid) async throws -> [InboxMessage] { [] }
	func listProviders() async throws -> [ProviderInfo] { [] }
	func listProviders(sessionId: Ulid) async throws -> [ProviderInfo] { try await listProviders() }
	func prepareHandoff(sessionId: Ulid) async throws -> String { "" }
	func setProvider(sessionId: Ulid, provider: String, model: String?, handoff: String?) async throws -> ProviderSwitchResult {
		throw NodeClientError.rpc(code: -32601, message: "provider switching is unavailable")
	}
	func resetChat(sessionId: Ulid) async throws -> ProviderSwitchResult {
		throw NodeClientError.rpc(code: -32601, message: "chat reset is unavailable")
	}
	func terminalAttach(sessionId: Ulid, cols: Int, rows: Int) async throws -> TerminalAttachment {
		throw NodeClientError.rpc(code: -32601, message: "terminal unavailable")
	}
	func terminalInput(sessionId: Ulid, attachmentId: String, data: Data) async throws {}
	func terminalResize(sessionId: Ulid, attachmentId: String, cols: Int, rows: Int) async throws {}
	func terminalDetach(sessionId: Ulid, attachmentId: String) async throws {}
}

public struct TerminalOutput: Codable, Sendable, Equatable {
	public let generation: String
	public let seq: Int
	public let dataBase64: String
	public init(generation: String, seq: Int, dataBase64: String) { self.generation = generation; self.seq = seq; self.dataBase64 = dataBase64 }
	public var data: Data? { Data(base64Encoded: dataBase64) }
}

public struct TerminalAttachment: Codable, Sendable, Equatable {
	public let sessionId: SessionId
	public let attachmentId: String
	public let pid: Int
	public let generation: String
	public let replay: [TerminalOutput]
	public let replayTruncated: Bool
	public init(sessionId: SessionId, attachmentId: String, pid: Int, generation: String, replay: [TerminalOutput], replayTruncated: Bool = false) {
		self.sessionId = sessionId; self.attachmentId = attachmentId; self.pid = pid; self.generation = generation; self.replay = replay; self.replayTruncated = replayTruncated
	}
}

public struct TerminalState: Codable, Sendable, Equatable {
	public enum Phase: String, Codable, Sendable { case running, exited, restarting }
	public let sessionId: SessionId
	public let generation: String
	public let phase: Phase
	public let pid: Int?
	public let exitCode: Int?
	public let signal: String?
}

public enum GlanceResult: Codable, Sendable, Hashable {
	case onDeviceSummary(headline: String, bullets: [String], schemaVersion: Int)
	case excerptFallback(excerpt: String, reason: String)
	private enum Keys: String, CodingKey { case kind, headline, bullets, engine, schemaVersion, excerpt, reason }
	public init(from decoder: Decoder) throws { let c = try decoder.container(keyedBy: Keys.self); switch try c.decode(String.self, forKey: .kind) { case "onDeviceSummary": self = .onDeviceSummary(headline: try c.decode(String.self, forKey: .headline), bullets: try c.decode([String].self, forKey: .bullets), schemaVersion: try c.decode(Int.self, forKey: .schemaVersion)); case "excerptFallback": self = .excerptFallback(excerpt: try c.decode(String.self, forKey: .excerpt), reason: try c.decode(String.self, forKey: .reason)); default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown Glance result") } }
	public func encode(to encoder: Encoder) throws { var c=encoder.container(keyedBy: Keys.self); switch self { case .onDeviceSummary(let headline,let bullets,let version): try c.encode("onDeviceSummary",forKey:.kind);try c.encode(headline,forKey:.headline);try c.encode(bullets,forKey:.bullets);try c.encode("apple-on-device",forKey:.engine);try c.encode(version,forKey:.schemaVersion); case .excerptFallback(let excerpt,let reason):try c.encode("excerptFallback",forKey:.kind);try c.encode(excerpt,forKey:.excerpt);try c.encode(reason,forKey:.reason) } }
}
public struct GlanceCard: Codable, Sendable, Identifiable, Hashable { public let id:String; public let workspaceId:String; public let glanceSeq:Int; public let at:Date; public let sessionId:String; public let turnId:String; public let sourceHash:String; public let preview:String; public let sourceTruncated:Bool?; public let interrupted:Bool; public let actorKind:String; public let missionId:String?; public let agentId:String?; public let agentLabel:String?; public let result:GlanceResult? }
public struct GlancePage: Codable, Sendable { public let cards:[GlanceCard]; public let reviewedThroughGlanceSeq:Int; public let hasMore:Bool; public init(cards:[GlanceCard],reviewedThroughGlanceSeq:Int,hasMore:Bool){self.cards=cards;self.reviewedThroughGlanceSeq=reviewedThroughGlanceSeq;self.hasMore=hasMore} }
public struct GlanceSource: Codable, Sendable { public let id:String; public let sourceHash:String; public let source:String; public let sourceTruncated:Bool }
public struct GlanceChange: Codable, Sendable { public let card:GlanceCard?; public let workspaceId:String?; public let reviewedThroughGlanceSeq:Int? }

public struct ConversationPage: Codable, Sendable {
	public let turns: [Turn]
	public let blocks: [Block]
	public let nextCursor: String?
	public let prevCursor: String?
}

/// 04's `models.list` entry: `{id, name, provider}` on the wire, where the
/// display name arrives here as `label`.
public struct ModelInfo: Codable, Sendable, Identifiable {
	public let id: String
	public let provider: String
	public let label: String
	public let description: String?

	public init(id: String, provider: String, label: String, description: String? = nil) {
		self.id = id; self.provider = provider; self.label = label; self.description = description
	}
}

public struct ProviderInfo: Codable, Sendable, Identifiable {
	public let id: String
	public let label: String
	public let defaultModel: String
	public let available: Bool
	public let unavailableReason: String?
	public let note: String?

	public init(id: String, label: String, defaultModel: String, available: Bool = true, unavailableReason: String? = nil, note: String? = nil) {
		self.id = id; self.label = label; self.defaultModel = defaultModel
		self.available = available; self.unavailableReason = unavailableReason; self.note = note
	}
}

public struct PromptAttachment: Codable, Sendable, Identifiable, Hashable {
	public enum Kind: String, Codable, Sendable { case image, file }
	public let id: String
	public let kind: Kind
	public let name: String
	public let mimeType: String
	public let dataBase64: String
}

public struct ConversationCapabilities: Codable, Sendable, Equatable {
	public let image: Bool
	public let embeddedContext: Bool
}

public struct ProviderSwitchResult: Codable, Sendable {
	public let sessionId: Ulid
	public let provider: String
	public let model: String
	public let contextReset: Bool
}
