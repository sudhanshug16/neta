import Foundation
import Observation

/// One session's turns with streaming deltas (11-desktop-chat T11.1).
///
/// `start()` tails the newest page, then forwards every `.turn`
/// notification for this session to `apply(_:)`. `apply(_:)` also stands
/// alone: it drops other sessions, upserts turns by id keeping `turns`
/// sorted by `startedAt`, and files blocks by `seq` — out-of-order deltas
/// land in place, a repeat replaces. A block for an unknown turn opens a
/// synthetic turn from the block's role and time.
@MainActor @Observable public final class ChatViewModel {
	/// How many of the newest turns `start()` tails.
	private static let tailLimit = 50

	let client: any NodeClient
	let sessionId: SessionId
	private var streamTask: Task<Void, Never>?

	public internal(set) var turns: [ChatTurn] = []
	public var atBottom: Bool = true
	public internal(set) var openTurnId: TurnId?
	public internal(set) var pendingScroll: ScrollRequest?

	// MARK: - Paging window (11-desktop-chat T11.2; behavior in ChatPaging.swift)

	/// `prevCursor` of the oldest loaded page; nil when no older history is
	/// known. Backs `hasOlder` together with `droppedOlderTurns`.
	var olderCursor: String?
	/// True once the loaded window no longer reaches the live end: a
	/// mid-history scroll anchor or a trim that dropped newer turns. While
	/// true, `apply` drops payloads for turns outside the window.
	var windowHasNewer = false
	/// True once a trim has dropped turns older than the loaded window.
	var droppedOlderTurns = false

	/// The newest turn id while the transcript sits at the bottom, else nil.
	public var autoScrollTarget: TurnId? {
		guard atBottom else { return nil }
		return turns.last?.id
	}

	public init(client: any NodeClient, sessionId: SessionId) {
		self.client = client
		self.sessionId = sessionId
	}

	/// Tails the newest page, then applies this session's live turns.
	public func start() async {
		if let page = try? await client.conversationTail(
			sessionId: sessionId, cursor: nil, limit: Self.tailLimit)
		{
			resetToLatest(with: page)
		}
		streamTask?.cancel()
		let stream = client.notifications
		let sessionId = sessionId
		streamTask = Task { [weak self] in
			for await notification in stream {
				guard let self else { return }
				if Task.isCancelled { break }
				guard case .turn(let change) = notification else { continue }
				guard change.sessionId == sessionId else { continue }
				self.apply(change)
			}
		}
	}

	/// Folds one turn notification in; other sessions are dropped.
	public func apply(_ payload: TurnChange) {
		guard payload.sessionId == sessionId else { return }
		guard !shouldDropTurnPayload(payload) else { return }
		if let turn = payload.turn {
			upsert(turn)
		}
		if let block = payload.block {
			insert(block)
		}
	}

	/// Takes the pending scroll request, leaving none behind.
	public func consumeScroll() -> ScrollRequest? {
		let request = pendingScroll
		pendingScroll = nil
		return request
	}

	// MARK: - Turn and block merging

	/// Rebuilds `turns` from a tail page.
	func replace(with page: ConversationPage) {
		var merged: [TurnId: ChatTurn] = [:]
		for turn in page.turns {
			merged[turn.id] = ChatTurn(
				id: turn.id, role: turn.role, startedAt: turn.startedAt,
				endedAt: turn.endedAt, cancelled: turn.cancelled ?? false)
		}
		for block in page.blocks {
			merged[block.turnId, default: ChatTurn(
				id: block.turnId, role: block.role, startedAt: block.at)]
				.insert(block)
		}
		turns = merged.values.sorted(by: Self.turnOrder)
		openTurnId = turns.last(where: \.isOpen)?.id
	}

	/// Inserts a turn or refreshes its close state by id.
	func upsert(_ turn: Turn) {
		if let index = turns.firstIndex(where: { $0.id == turn.id }) {
			turns[index].endedAt = turn.endedAt
			turns[index].cancelled = turn.cancelled ?? false
		} else {
			turns.append(ChatTurn(
				id: turn.id, role: turn.role, startedAt: turn.startedAt,
				endedAt: turn.endedAt, cancelled: turn.cancelled ?? false))
			turns.sort(by: Self.turnOrder)
		}
		if turn.endedAt != nil || turn.cancelled == true {
			if openTurnId == turn.id { openTurnId = nil }
		} else {
			openTurnId = turn.id
		}
	}

	/// Files a block into its turn by `seq`; a repeat replaces.
	func insert(_ block: Block) {
		if let index = turns.firstIndex(where: { $0.id == block.turnId }) {
			turns[index].insert(block)
		} else {
			var synthetic = ChatTurn(id: block.turnId, role: block.role, startedAt: block.at)
			synthetic.insert(block)
			turns.append(synthetic)
			turns.sort(by: Self.turnOrder)
			openTurnId = block.turnId
		}
	}

	static func turnOrder(_ a: ChatTurn, _ b: ChatTurn) -> Bool {
		if a.startedAt != b.startedAt { return a.startedAt < b.startedAt }
		return a.id < b.id
	}
}

/// Block filing shared by the page and streaming paths.
private extension ChatTurn {
	mutating func insert(_ block: Block) {
		if let index = blocks.firstIndex(where: { $0.seq == block.seq }) {
			blocks[index] = block
		} else {
			blocks.append(block)
			blocks.sort { $0.seq < $1.seq }
		}
	}
}
