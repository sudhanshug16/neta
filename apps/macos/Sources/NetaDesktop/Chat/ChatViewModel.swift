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
	/// The pause before re-tailing after the notification stream ended, so a
	/// Node that stays down cannot spin the loop.
	static let resubscribeDelay: Duration = .milliseconds(200)

	let client: any NodeClient
	let sessionId: SessionId
	private var streamTask: Task<Void, Never>?

	/// Called whenever `openTurnId` changes, so the owning panel can follow
	/// the open turn immediately instead of only after a tail or a select
	/// (FIXPASS: the composer stayed on Stop after the turn closed).
	@ObservationIgnored public var onOpenTurnChange: (() -> Void)?

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
	///
	/// The client finishes every subscription when the connection is renewed,
	/// which used to end this loop for good (FIXPASS G4-7). When the stream
	/// ends and the task is still live, the loop subscribes again and re-tails
	/// — the tail is also how the Node re-subscribes this peer to the session
	/// (`src/node/server.ts`: a `turn` goes only to peers whose `tailed` set
	/// holds it, and that set is new on every connection). A reconnect takes
	/// longer than one backoff, so the tail throws `.disconnected` for a
	/// while; the loop keeps re-tailing until one succeeds rather than
	/// listening to a session it is not subscribed to.
	public func start() async {
		streamTask?.cancel()
		let sessionId = sessionId
		// Subscribe before the tail request, not after: a subscription
		// carries only what is broadcast from the moment it is taken, so a
		// notification the Node sends while the tail is in flight would
		// otherwise fall between the two calls and be lost for good.
		let first = client.notifications
		let firstTailed = await tailLatest()
		streamTask = Task { [weak self] in
			var stream = first
			var tailed = firstTailed
			while !Task.isCancelled {
				if tailed {
					for await notification in stream {
						if Task.isCancelled { return }
						guard case .turn(let change) = notification else { continue }
						guard change.sessionId == sessionId else { continue }
						guard let self else { return }
						self.apply(change)
					}
					if Task.isCancelled { return }
				}
				// The tail is what re-subscribes this peer to the session on
				// the Node, and it fails for as long as the client is
				// reconnecting. Keep re-tailing on the backoff until one
				// succeeds; only then is listening worth anything.
				try? await Task.sleep(for: Self.resubscribeDelay)
				if Task.isCancelled { return }
				guard let self else { return }
				stream = self.client.notifications
				tailed = await self.tailLatest()
			}
		}
	}

	/// Asks for the newest page and rebuilds the window from it. Also the
	/// `conversation.tail` that subscribes this peer to the session. Returns
	/// whether the tail actually landed: during a reconnect it throws
	/// `.disconnected`, and a caller that treats that as success stops
	/// listening to a session the Node never re-subscribed it to.
	private func tailLatest() async -> Bool {
		guard let page = try? await client.conversationTail(
			sessionId: sessionId, cursor: nil, limit: Self.tailLimit)
		else { return false }
		resetToLatest(with: page)
		return true
	}

	/// Stops the live stream. The panel calls it when it drops this
	/// transcript, so a rebuilt one is the only listener.
	public func stop() {
		streamTask?.cancel()
		streamTask = nil
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
		setOpenTurn(turns.last(where: \.isOpen)?.id)
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
			if openTurnId == turn.id { setOpenTurn(nil) }
		} else {
			setOpenTurn(turn.id)
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
			setOpenTurn(block.turnId)
		}
	}

	/// The one writer of `openTurnId`, so the panel hears every change.
	func setOpenTurn(_ id: TurnId?) {
		guard openTurnId != id else { return }
		openTurnId = id
		onOpenTurnChange?()
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
