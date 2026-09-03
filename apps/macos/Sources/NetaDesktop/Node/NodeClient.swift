import Foundation

/// The one interface the app talks to (09-desktop-shell T9.3).
///
/// The app never owns a session and never spawns an agent; it reads through
/// this client. `SocketNodeClient` (T9.4) is the real transport;
/// `FixtureNodeClient` replays the recorded `test/fixtures` data behind the
/// same interface for tests and previews.
public protocol NodeClient: Sendable {
	func connect() async throws
	func snapshot() async throws -> Snapshot
	func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission]
	func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event]
	func conversationTail(sessionId: Ulid, cursor: String?, limit: Int) async throws -> ConversationPage
	func prompt(sessionId: Ulid, text: String) async throws -> Ulid
	func cancel(sessionId: Ulid) async throws
	func setModel(sessionId: Ulid, model: String) async throws
	func listModels(provider: String) async throws -> [ModelInfo]
	func setMode(workspaceId: String, mode: LeaderMode) async throws
	func pin(missionId: Ulid, pinned: Bool) async throws
	func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws
	var notifications: AsyncStream<NodeNotification> { get }
}

/// 04's `conversation.tail` result: one page of a session's turns and the
/// blocks that belong to those turns. `cursor`/`prevCursor` are opaque
/// offsets minted by the client; a nil `prevCursor` is the start of history
/// and a nil `nextCursor` the end.
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
}
