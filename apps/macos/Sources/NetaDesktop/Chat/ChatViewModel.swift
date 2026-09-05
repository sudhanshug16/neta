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
	/// Bumped by every `start()`. Two tails can be in flight at once — a
	/// fresh `start()` while the resubscribe loop is already re-tailing —
	/// and a page rebuilds the whole window, so the older answer landing
	/// last rebuilt the window from a page taken before the newest blocks
	/// existed and dropped them for good (the re-tail after a session change
	/// showed the person's block and not the agent's). A tail whose
	/// generation is stale is discarded instead.
	private var tailGeneration = 0
	/// Terminal ids prevent a prompt acknowledgement that races behind its
	/// closing notification from reopening an already-finished turn.
	private var terminalTurnIds: Set<TurnId> = []
	private var terminalTurnOrder: [TurnId] = []

	/// Called whenever `openTurnId` changes, so the owning panel can follow
	/// the open turn immediately instead of only after a tail or a select
	/// (FIXPASS: the composer stayed on Stop after the turn closed).
	@ObservationIgnored public var onOpenTurnChange: (() -> Void)?
	@ObservationIgnored public var onInboxChange: ((InboxMessage) -> Void)?

	public internal(set) var turns: [ChatTurn] = []
	public var atBottom: Bool = true
	public internal(set) var openTurnId: TurnId?
	public internal(set) var pendingScroll: ScrollRequest?
	/// Changes whenever visible transcript content changes, including a
	/// streamed replacement inside the current turn. The panel follows this
	/// instead of the newest turn id, which is stable for an entire response.
	public private(set) var contentRevision = 0
	@ObservationIgnored private var cachedRowsRevision = -1
	@ObservationIgnored private var cachedRows: [TranscriptRow] = []

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
	/// The locally echoed user turns, oldest first. Held apart from `turns`
	/// so a re-tail (which rebuilds `turns` from the page) cannot swallow
	/// the message the person just sent.
	private var echoes: [ChatTurn] = []

	/// The turns that actually draw something. A turn with no blocks draws
	/// nothing (the Node opens the user turn before any block exists), and a
	/// `LazyVStack` still reserves its spacing, so the transcript renders
	/// this list rather than `turns`.
	public var visibleTurns: [ChatTurn] {
		turns.filter { !$0.blocks.isEmpty }
	}

	/// The newest drawn turn id while the transcript sits at the bottom, else
	/// nil. A blockless turn has no view to scroll to.
	public var autoScrollTarget: TurnId? {
		guard atBottom else { return nil }
		return visibleTurns.last?.id
	}

	/// Block-level rows are cached for one content revision. SwiftUI may ask
	/// for the transcript repeatedly while measuring a scroll, and rebuilding
	/// and coalescing hundreds of tool updates on every measurement defeats
	/// the lazy stack below it.
	public var transcriptRows: [TranscriptRow] {
		if cachedRowsRevision != contentRevision {
			cachedRows = TranscriptRow.rows(for: visibleTurns)
			cachedRowsRevision = contentRevision
		}
		return cachedRows
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
		tailGeneration += 1
		let generation = tailGeneration
		let sessionId = sessionId
		// Subscribe before the tail request, not after: a subscription
		// carries only what is broadcast from the moment it is taken, so a
		// notification the Node sends while the tail is in flight would
		// otherwise fall between the two calls and be lost for good.
		let first = client.notifications
		let firstTailed = await tailLatest(generation: generation)
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
				// A newer `start()` owns the transcript now: stop rather
				// than re-tail into a window this loop no longer owns.
				guard self.tailGeneration == generation else { return }
				stream = self.client.notifications
				tailed = await self.tailLatest(generation: generation)
			}
		}
	}

	/// Asks for the newest page and rebuilds the window from it. Also the
	/// `conversation.tail` that subscribes this peer to the session. Returns
	/// whether the tail actually landed: during a reconnect it throws
	/// `.disconnected`, and a caller that treats that as success stops
	/// listening to a session the Node never re-subscribed it to. A page
	/// from a superseded generation is dropped, never applied.
	private func tailLatest(generation: Int) async -> Bool {
		guard let page = try? await client.conversationTail(
			sessionId: sessionId, cursor: nil, limit: Self.tailLimit)
		else { return false }
		// A tail that a newer `start()` has superseded must not rebuild the
		// window: its page is older than what the window already holds.
		guard generation == tailGeneration else { return false }
		resetToLatest(with: page)
		return true
	}

	/// Whether this transcript is actually live: `start()` has taken a
	/// subscription and a task is listening on it. A `ChatViewModel` that was
	/// built and installed but never started is not streaming, and neither is
	/// one that has been stopped — which is what an unstarted rebuild left
	/// behind the chat panel.
	public var isStreaming: Bool {
		guard let streamTask else { return false }
		return !streamTask.isCancelled
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
		if let inbox = payload.inbox { onInboxChange?(inbox) }
	}

	/// Shows the person's own message at once (FIXPASS "the person's own
	/// message never appears in the chat").
	///
	/// The Node opens the user turn with no blocks at all, so a prompt was
	/// invisible until the agent answered. The echo is a local turn with a
	/// `local-` id carrying the text that was just sent. If the Node ever
	/// does deliver the user's own text, `insert(_:)` drops the echo that
	/// matches it, so the message is never shown twice.
	@discardableResult
	public func echoUserMessage(_ text: String, at date: Date = Date()) -> TurnId? {
		echoUserMessage(text, attachments: [], at: date)
	}

	@discardableResult
	public func echoUserMessage(_ text: String, attachments: [AttachmentDraft], at date: Date = Date()) -> TurnId? {
		guard !text.isEmpty || !attachments.isEmpty else { return nil }
		let id = "local-\(UUID().uuidString)"
		var turn = ChatTurn(id: id, role: .user, startedAt: date, endedAt: date)
		var blocks: [Block] = text.isEmpty ? [] : [Block(
			turnId: id, seq: 0, at: date, role: .user, kind: .text,
			text: text, data: nil)]
		for (index, attachment) in attachments.enumerated() {
			blocks.append(Block(turnId: id, seq: index + 1, at: date, role: .user, kind: .status, text: attachment.name, data: [
				"attachmentId": .string(attachment.id), "name": .string(attachment.name),
				"mimeType": .string(attachment.mimeType), "size": .number(Double(attachment.data.count)),
				"previewBase64": .string(attachment.kind == .image ? attachment.data.base64EncodedString() : ""),
			]))
		}
		turn.blocks = blocks
		turns.append(turn)
		turns.sort(by: Self.turnOrder)
		echoes.append(turn)
		contentChanged()
		return id
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
		// A page rebuild must not swallow a message the person sent a
		// moment ago: echoes the page does not carry itself survive it.
		let delivered = Set(page.blocks.filter { $0.role == .user }.map(\.text))
		echoes.removeAll { delivered.contains($0.blocks.first?.text ?? "") }
		for echo in echoes { merged[echo.id] = echo }
		turns = merged.values.sorted(by: Self.turnOrder)
		terminalTurnOrder = Array(turns.filter { !$0.isOpen }.map(\.id).suffix(64))
		terminalTurnIds = Set(terminalTurnOrder)
		setOpenTurn(turns.last(where: \.isOpen)?.id)
		contentChanged()
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
			recordTerminal(turn.id)
			if openTurnId == turn.id { setOpenTurn(nil) }
		} else {
			setOpenTurn(turn.id)
		}
		contentChanged()
	}

	/// Files a block into its turn by `seq`; a repeat replaces. A user block
	/// arriving from the Node retires the local echo carrying the same text,
	/// so the person's message is shown exactly once.
	func insert(_ block: Block) {
		if block.role == .user { dropEcho(matching: block.text) }
		if case .string(let attachmentId) = block.data?["attachmentId"], let echo = echoes.first(where: { turn in
			turn.blocks.contains { candidate in
				if case .string(let id) = candidate.data?["attachmentId"] { return id == attachmentId }
				return false
			}
		}) { retireEcho(id: echo.id) }
		if let index = turns.firstIndex(where: { $0.id == block.turnId }) {
			turns[index].insert(block)
		} else {
			var synthetic = ChatTurn(id: block.turnId, role: block.role, startedAt: block.at)
			synthetic.insert(block)
			turns.append(synthetic)
			turns.sort(by: Self.turnOrder)
			setOpenTurn(block.turnId)
		}
		contentChanged()
	}

	/// Retires the echo for a message the Node never received: the prompt
	/// threw, so the transcript must not keep showing it as delivered
	/// (11-desktop-chat T11.6).
	public func retireEcho(_ text: String) {
		dropEcho(matching: text)
	}

	public func retireEcho(id: TurnId) {
		echoes.removeAll { $0.id == id }
		turns.removeAll { $0.id == id }
		contentChanged()
	}

	func contentChanged() { contentRevision &+= 1 }

	/// The protocol pages whole turns, so trimming also keeps whole turns.
	/// One turn may itself exceed the nominal budget; retaining that sole
	/// turn is the truthful exception because discarded blocks could not be
	/// fetched back independently.
	public func enforceCacheAroundLatest() {
		guard cacheBytes > ChatCache.limitBytes, let anchor = turns.last?.id else { return }
		trim(around: anchor)
	}

	/// Marks the acknowledged prompt open before its first streamed block.
	/// This bridges the request/notification gap so Stop is immediately real.
	public func acknowledgePrompt(turnId: TurnId) {
		guard !terminalTurnIds.contains(turnId) else { return }
		if let turn = turns.first(where: { $0.id == turnId }), !turn.isOpen { return }
		setOpenTurn(turnId)
	}

	private func recordTerminal(_ id: TurnId) {
		guard terminalTurnIds.insert(id).inserted else { return }
		terminalTurnOrder.append(id)
		if terminalTurnOrder.count > 64 {
			terminalTurnIds.remove(terminalTurnOrder.removeFirst())
		}
	}

	/// Retires the echo whose text the Node has now delivered itself.
	private func dropEcho(matching text: String) {
		guard let index = echoes.firstIndex(where: {
			$0.blocks.first?.text == text
		}) else { return }
		let id = echoes.remove(at: index).id
		turns.removeAll { $0.id == id }
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
