import Foundation

/// The per-session transcript budget (11-desktop-chat T11.2).
///
/// Mirrors MANIFESTO.md "Clients, cache, and offline state": at most 1 MB of
/// recently viewed display messages per ACP conversation. `ChatViewModel.trim`
/// enforces it over the loaded window; the owning Node keeps the authoritative
/// history, and `jumpToLatest` re-tails it.
public enum ChatCache {
	/// Maximum encoded transcript bytes kept in one view model's window.
	public static let limitBytes = 1_048_576
}

extension ChatViewModel {
	/// How many turns one paging fetch asks for.
	static let pagingPageLimit = 50
	/// Upper bound on pages one `scrollTo(turnId:)` fetches.
	static let scrollToMaxPages = 32

	/// Encoded size of the loaded window: every loaded turn plus its blocks
	/// as `NetaJSON` bytes. Computed live, so prepends, trims and streaming
	/// inserts can never drift from it.
	public var cacheBytes: Int {
		turns.reduce(0) { $0 + Self.encodedSize(of: $1, in: sessionId) }
	}

	/// True when turns older than the loaded window may exist: an unfetched
	/// `prevCursor`, or older turns dropped by `trim`.
	public var hasOlder: Bool { olderCursor != nil || droppedOlderTurns }

	/// True when the loaded window no longer reaches the live end: a
	/// mid-history scroll anchor or a trim that dropped newer turns. While
	/// true, `apply` drops payloads for turns outside the window.
	public var hasNewer: Bool { windowHasNewer }

	/// Reveals `turnId`, flashing it when it is already loaded. Otherwise
	/// anchors a `conversation.tail` page on the turn (04's `turnId`) and
	/// pages backward with `loadOlder` until the turn arrives, `prevCursor`
	/// runs out, or 32 pages have been fetched. Leaves `pendingScroll` nil
	/// when the turn never appears.
	public func scrollTo(turnId: TurnId) async {
		if turns.contains(where: { $0.id == turnId }) {
			pendingScroll = ScrollRequest(turnId: turnId, flash: true)
			return
		}
		var fetched = 0
		if let anchor = try? await client.conversationTail(
			sessionId: sessionId, cursor: nil, limit: Self.pagingPageLimit,
			direction: nil, turnId: turnId)
		{
			fetched += 1
			anchorWindow(with: anchor)
		}
		while !turns.contains(where: { $0.id == turnId }) && hasOlder
			&& fetched < Self.scrollToMaxPages
		{
			guard await loadOlder() else { break }
			fetched += 1
		}
		if turns.contains(where: { $0.id == turnId }) {
			pendingScroll = ScrollRequest(turnId: turnId, flash: true)
		} else {
			pendingScroll = nil
		}
	}

	/// Prepends the page before the oldest loaded one (`direction:
	/// "backward"` from its `prevCursor`). Returns true when a page was
	/// fetched and merged; false when no older cursor is known or the fetch
	/// failed, leaving the window untouched.
	@discardableResult
	public func loadOlder() async -> Bool {
		guard let cursor = olderCursor else { return false }
		guard let page = try? await client.conversationTail(
			sessionId: sessionId, cursor: cursor, limit: Self.pagingPageLimit,
			direction: "backward", turnId: nil)
		else { return false }
		prepend(page)
		return true
	}

	/// Re-tails the newest page and returns the transcript to the live end:
	/// the newer-side window opens again and `atBottom` is restored.
	public func jumpToLatest() async {
		if let page = try? await client.conversationTail(
			sessionId: sessionId, cursor: nil, limit: Self.pagingPageLimit)
		{
			resetToLatest(with: page)
		}
		atBottom = true
	}

	/// Shrinks the window to a contiguous run around `anchor` until
	/// `cacheBytes` fits `ChatCache.limitBytes`, dropping the turns furthest
	/// from the anchor first (ties drop the older end). The anchor itself is
	/// never dropped. Dropping newer turns sets `hasNewer`; dropping older
	/// ones sets `hasOlder`. Dropped turns stay dropped until the next
	/// re-tail. An unknown anchor leaves the window untouched.
	public func trim(around anchor: TurnId) {
		guard let center = turns.firstIndex(where: { $0.id == anchor }) else { return }
		let sizes = turns.map { Self.encodedSize(of: $0, in: sessionId) }
		var total = sizes.reduce(0, +)
		var lo = turns.startIndex
		var hi = turns.endIndex - 1
		while total > ChatCache.limitBytes && lo < hi {
			if hi - center > center - lo {
				total -= sizes[hi]
				hi -= 1
			} else {
				total -= sizes[lo]
				lo += 1
			}
		}
		let droppedOlder = lo > turns.startIndex
		let droppedNewer = hi < turns.endIndex - 1
		guard droppedOlder || droppedNewer else { return }
		turns = Array(turns[lo ... hi])
		if let open = openTurnId, !turns.contains(where: { $0.id == open }) {
			openTurnId = turns.last(where: \.isOpen)?.id
		}
		if droppedOlder { droppedOlderTurns = true }
		if droppedNewer { windowHasNewer = true }
	}

	// MARK: - Window maintenance

	/// Rebuilds the window from a newest page: the live end is reached, so
	/// neither side is held back.
	func resetToLatest(with page: ConversationPage) {
		replace(with: page)
		olderCursor = page.prevCursor
		windowHasNewer = false
		droppedOlderTurns = false
	}

	/// Rebuilds the window from a `turnId`-anchored page (04): the newer
	/// side stays open exactly when the anchor page has a `nextCursor`.
	func anchorWindow(with page: ConversationPage) {
		replace(with: page)
		olderCursor = page.prevCursor
		windowHasNewer = page.nextCursor != nil
		droppedOlderTurns = false
	}

	/// Merges one backward page in front of the window; the newer side is
	/// untouched.
	func prepend(_ page: ConversationPage) {
		for turn in page.turns { upsert(turn) }
		for block in page.blocks { insert(block) }
		turns.sort(by: Self.turnOrder)
		openTurnId = turns.last(where: \.isOpen)?.id
		olderCursor = page.prevCursor
	}

	/// True when `payload` must not disturb the window: the window no longer
	/// reaches the live end and the payload names no loaded turn.
	func shouldDropTurnPayload(_ payload: TurnChange) -> Bool {
		guard windowHasNewer else { return false }
		let id = payload.turn?.id ?? payload.block?.turnId
		guard let id else { return false }
		return !turns.contains(where: { $0.id == id })
	}

	// MARK: - Encoded sizes

	/// `NetaJSON` bytes for one window turn: its `Turn` plus its blocks — the
	/// same units `loadOlder` accounts per page.
	static func encodedSize(of turn: ChatTurn, in sessionId: SessionId) -> Int {
		let domain = Turn(
			id: turn.id, sessionId: sessionId, startedAt: turn.startedAt,
			endedAt: turn.endedAt, role: turn.role,
			cancelled: turn.cancelled ? true : nil)
		var size = 0
		if let data = try? NetaJSON.encoder.encode(domain) {
			size += data.count
		} else {
			size += turn.id.utf8.count
		}
		for block in turn.blocks {
			if let data = try? NetaJSON.encoder.encode(block) {
				size += data.count
			} else {
				size += block.text.utf8.count
			}
		}
		return size
	}
}
