import Foundation
import XCTest

@testable import NetaDesktop

/// A client whose `conversation.tail` blocks until released, so two tails
/// can be put in flight and answered out of order.
private actor GatedTailClient: NodeClient {
	let notifications: AsyncStream<NodeNotification>
	private let session: SessionId
	private var seqs: [Int] = []
	private var waiting: [CheckedContinuation<Void, Never>] = []
	private var arrived: [CheckedContinuation<Void, Never>] = []
	private var pending = 0

	init(session: SessionId) {
		self.session = session
		let (stream, continuation) = AsyncStream<NodeNotification>.makeStream()
		notifications = stream
		continuation.finish()
	}

	func setPage(blocks seqs: [Int]) {
		self.seqs = seqs
	}

	/// Waits until a `conversation.tail` is parked inside the client.
	func waitForRequest() async {
		if pending > 0 {
			pending -= 1
			return
		}
		await withCheckedContinuation { continuation in
			arrived.append(continuation)
		}
	}

	/// Lets the oldest parked tail answer.
	func release() {
		guard !waiting.isEmpty else { return }
		waiting.removeFirst().resume()
	}

	/// Lets the newest parked tail answer, so two tails can be answered out
	/// of order.
	func releaseNewest() {
		guard !waiting.isEmpty else { return }
		waiting.removeLast().resume()
	}

	func conversationTail(
		sessionId: Ulid, cursor: String? = nil, limit: Int,
		direction: String? = nil, turnId: TurnId? = nil
	) async throws -> ConversationPage {
		let page = self.page()
		if let continuation = arrived.first {
			arrived.removeFirst()
			continuation.resume()
		} else {
			pending += 1
		}
		await withCheckedContinuation { continuation in
			waiting.append(continuation)
		}
		return page
	}

	private func page() -> ConversationPage {
		let at = Date(timeIntervalSince1970: 1_780_315_200)
		return ConversationPage(
			turns: [Turn(
				id: "t1", sessionId: session, startedAt: at,
				endedAt: at, role: .user, cancelled: nil)],
			blocks: seqs.map { seq in
				Block(
					turnId: "t1", seq: seq, at: at,
					role: seq == 1 ? .user : .agent, kind: .text,
					text: "block \(seq)", data: nil)
			},
			nextCursor: nil, prevCursor: nil)
	}

	func connect() async throws {}
	func snapshot() async throws -> Snapshot { throw NodeClientError.disconnected }
	func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission] { [] }
	func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event] { [] }
	func prompt(sessionId: Ulid, text: String) async throws -> Ulid { "t-new" }
	func cancel(sessionId: Ulid) async throws {}
	func setModel(sessionId: Ulid, model: String) async throws {}
	func listModels(provider: String) async throws -> [ModelInfo] { [] }
	func setMode(workspaceId: String, mode: LeaderMode) async throws {}
	func pin(missionId: Ulid, pinned: Bool) async throws {}
	func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws {}
}

/// T11.1: the chat view model holds turns and applies streaming deltas.
@MainActor
final class ChatViewModelTests: XCTestCase {
	private static let session = "01CHATSESSIONAAAAAAAAA01"
	private static let otherSession = "01OTHERSESSIONAAAAAAAA01"

	private func makeTurn(
		_ id: String, startedAt: TimeInterval = 1_000, role: Role = .agent,
		endedAt: TimeInterval? = nil, cancelled: Bool? = nil, session: String? = nil
	) -> Turn {
		Turn(
			id: id, sessionId: session ?? Self.session,
			startedAt: Date(timeIntervalSince1970: startedAt),
			endedAt: endedAt.map { Date(timeIntervalSince1970: $0) },
			role: role, cancelled: cancelled)
	}

	private func makeBlock(
		_ seq: Int, turnId: String = "t1", text: String? = nil,
		role: Role = .agent, at: TimeInterval = 1_001
	) -> Block {
		Block(
			turnId: turnId, seq: seq, at: Date(timeIntervalSince1970: at),
			role: role, kind: .text, text: text ?? "block \(seq)", data: nil)
	}

	private func makeChange(turn: Turn? = nil, block: Block? = nil, session: String? = nil) -> TurnChange {
		TurnChange(sessionId: session ?? Self.session, turn: turn, block: block)
	}

	private func makeViewModel(session: String? = nil) -> ChatViewModel {
		ChatViewModel(client: FixtureNodeClient(), sessionId: session ?? Self.session)
	}

	func testStreamedBlocksAppendToOpenTurnInOrder() {
		let vm = makeViewModel()
		vm.apply(makeChange(turn: makeTurn("t1")))
		for seq in [0, 1, 2] {
			vm.apply(makeChange(block: makeBlock(seq)))
		}
		XCTAssertEqual(vm.turns.count, 1)
		XCTAssertEqual(vm.turns[0].blocks.map(\.seq), [0, 1, 2])
		XCTAssertEqual(vm.turns[0].blocks.map(\.text), ["block 0", "block 1", "block 2"])
		XCTAssertTrue(vm.turns[0].isOpen)
		XCTAssertEqual(vm.openTurnId, "t1")
	}

	func testOutOfOrderSeqSortsAndRepeatReplaces() {
		let vm = makeViewModel()
		vm.apply(makeChange(turn: makeTurn("t1")))
		vm.apply(makeChange(block: makeBlock(2, text: "two")))
		vm.apply(makeChange(block: makeBlock(0, text: "zero")))
		XCTAssertEqual(vm.turns[0].blocks.map(\.seq), [0, 2])
		vm.apply(makeChange(block: makeBlock(1, text: "one")))
		XCTAssertEqual(vm.turns[0].blocks.map(\.seq), [0, 1, 2])
		vm.apply(makeChange(block: makeBlock(1, text: "one-v2")))
		XCTAssertEqual(vm.turns[0].blocks.count, 3)
		XCTAssertEqual(vm.turns[0].blocks.map(\.seq), [0, 1, 2])
		XCTAssertEqual(vm.turns[0].blocks[1].text, "one-v2")
	}

	func testUnknownTurnIdOpensSyntheticTurn() {
		let vm = makeViewModel()
		vm.apply(makeChange(block: makeBlock(0, turnId: "ghost", text: "boo", role: .user, at: 2_000)))
		XCTAssertEqual(vm.turns.count, 1)
		let ghost = vm.turns[0]
		XCTAssertEqual(ghost.id, "ghost")
		XCTAssertEqual(ghost.role, .user)
		XCTAssertEqual(ghost.startedAt, Date(timeIntervalSince1970: 2_000))
		XCTAssertTrue(ghost.isOpen)
		XCTAssertEqual(ghost.blocks.map(\.seq), [0])
		XCTAssertEqual(ghost.blocks[0].text, "boo")
		XCTAssertEqual(vm.openTurnId, "ghost")
	}

	func testOtherSessionIsIgnored() {
		let vm = makeViewModel()
		vm.apply(makeChange(turn: makeTurn("t1"), session: Self.otherSession))
		vm.apply(makeChange(block: makeBlock(0), session: Self.otherSession))
		XCTAssertTrue(vm.turns.isEmpty)
		XCTAssertNil(vm.openTurnId)
		XCTAssertNil(vm.autoScrollTarget)
	}

	func testTurnsStaySortedByStartedAt() {
		let vm = makeViewModel()
		vm.apply(makeChange(turn: makeTurn("later", startedAt: 3_000)))
		vm.apply(makeChange(turn: makeTurn("earlier", startedAt: 1_000)))
		XCTAssertEqual(vm.turns.map(\.id), ["earlier", "later"])
	}

	func testClosingTurnClearsMatchingOpenTurn() {
		let vm = makeViewModel()
		vm.apply(makeChange(turn: makeTurn("t1", startedAt: 1_000)))
		XCTAssertEqual(vm.openTurnId, "t1")
		vm.apply(makeChange(turn: makeTurn("t1", startedAt: 1_000, endedAt: 2_000)))
		XCTAssertNil(vm.openTurnId)
		XCTAssertFalse(vm.turns[0].isOpen)
		// Closing an unrelated turn leaves the open one alone.
		vm.apply(makeChange(turn: makeTurn("t2", startedAt: 3_000)))
		XCTAssertEqual(vm.openTurnId, "t2")
		vm.apply(makeChange(turn: makeTurn("t1", startedAt: 1_000, endedAt: 2_000)))
		XCTAssertEqual(vm.openTurnId, "t2")
		// A cancelled turn also closes.
		vm.apply(makeChange(turn: makeTurn("t2", startedAt: 3_000, cancelled: true)))
		XCTAssertNil(vm.openTurnId)
		XCTAssertFalse(vm.turns[1].isOpen)
		XCTAssertTrue(vm.turns[1].cancelled)
	}

	func testClosedTurnNotificationBeforePromptAcknowledgementStaysClosed() {
		let vm = makeViewModel()
		vm.apply(makeChange(turn: makeTurn("race", startedAt: 1_000, endedAt: 1_001)))
		vm.acknowledgePrompt(turnId: "race")
		XCTAssertNil(vm.openTurnId)
	}

	/// The target is the newest turn that actually DRAWS. A turn with no
	/// blocks renders nothing and has no view to scroll to (the Node opens
	/// the user turn before any block exists), so scrolling to it left the
	/// transcript stuck short of the bottom.
	func testAutoScrollTargetFollowsAtBottom() {
		let vm = makeViewModel()
		XCTAssertNil(vm.autoScrollTarget)
		vm.apply(makeChange(turn: makeTurn("t1", startedAt: 1_000)))
		vm.apply(makeChange(turn: makeTurn("t2", startedAt: 2_000)))
		XCTAssertNil(vm.autoScrollTarget, "no blocks yet, so nothing is drawn")
		vm.apply(makeChange(block: makeBlock(0, turnId: "t1")))
		XCTAssertEqual(vm.autoScrollTarget, "t1")
		vm.apply(makeChange(block: makeBlock(0, turnId: "t2", at: 2_001)))
		XCTAssertEqual(vm.autoScrollTarget, "t2")
		vm.atBottom = false
		XCTAssertNil(vm.autoScrollTarget)
		vm.atBottom = true
		XCTAssertEqual(vm.autoScrollTarget, "t2")
	}

	/// A blockless turn reserves no room in the transcript: the panel
	/// renders `visibleTurns`, so a `LazyVStack` cannot leave a 24 pt gap
	/// where nothing is drawn.
	func testVisibleTurnsDropTurnsWithNoBlocks() {
		let vm = makeViewModel()
		vm.apply(makeChange(turn: makeTurn("t1", startedAt: 1_000)))
		vm.apply(makeChange(turn: makeTurn("t2", startedAt: 2_000)))
		vm.apply(makeChange(block: makeBlock(0, turnId: "t2", at: 2_001)))
		XCTAssertEqual(vm.turns.map(\.id), ["t1", "t2"])
		XCTAssertEqual(vm.visibleTurns.map(\.id), ["t2"])
	}

	/// A tail a newer `start()` has superseded must not rebuild the window.
	/// Two tails can be in flight at once (a fresh `start()` while the
	/// resubscribe loop is re-tailing), and a page replaces every turn, so
	/// the older answer landing last threw away blocks that had arrived in
	/// the meantime — the re-tail after a session change showed the person's
	/// block and not the agent's.
	func testAStaleTailNeverRebuildsTheWindow() async {
		let client = GatedTailClient(session: Self.session)
		let vm = ChatViewModel(client: client, sessionId: Self.session)

		// The first tail is held open, with only the user block in its page.
		await client.setPage(blocks: [1])
		let firstStart = Task { await vm.start() }
		await client.waitForRequest()

		// A second start supersedes it and tails the full page. Its answer
		// comes back FIRST; the stale one is still parked.
		await client.setPage(blocks: [1, 2])
		let secondStart = Task { await vm.start() }
		await client.waitForRequest()
		await client.releaseNewest()
		await secondStart.value
		XCTAssertEqual(vm.turns.first?.blocks.map(\.seq), [1, 2])

		// Now the first, stale tail lands. It must change nothing.
		await client.release()
		await firstStart.value
		XCTAssertEqual(
			vm.turns.first?.blocks.map(\.seq), [1, 2],
			"a superseded tail cannot roll the window back")
		vm.stop()
	}

	func testConsumeScrollStartsEmpty() {
		let vm = makeViewModel()
		XCTAssertNil(vm.pendingScroll)
		XCTAssertNil(vm.consumeScroll())
	}

	func testStartTailsNewestPage() async throws {
		let client = FixtureNodeClient()
		let first = try await client.prompt(sessionId: Self.session, text: "hello")
		let second = try await client.prompt(sessionId: Self.session, text: "again")
		let vm = ChatViewModel(client: client, sessionId: Self.session)
		await vm.start()
		XCTAssertEqual(vm.turns.map(\.id), [first, second])
		XCTAssertEqual(vm.openTurnId, second)
		// Both tailed turns are the Node's blockless user turns, so neither
		// draws and there is nothing to scroll to yet.
		XCTAssertEqual(vm.visibleTurns, [])
		XCTAssertNil(vm.autoScrollTarget)
	}

	/// FIXPASS G4-7: the client finishes every subscription when the
	/// connection is renewed, which used to end `start()`'s loop for good, so
	/// the chat stopped streaming after a reconnect and never restarted.
	func testStreamResumesAfterTheSubscriptionEnds() async throws {
		let client = FixtureNodeClient()
		let vm = ChatViewModel(client: client, sessionId: Self.session)
		await vm.start()
		// Draining the recording finishes every live subscription, the same
		// way a reconnect does.
		while await client.emitNext() {}
		await client.emit(.turn(makeChange(turn: makeTurn("after-reconnect", startedAt: 5_000))))
		var found = false
		for _ in 0 ..< 500 {
			try await Task.sleep(nanoseconds: 10_000_000)
			if vm.turns.contains(where: { $0.id == "after-reconnect" }) {
				found = true
				break
			}
			await client.emit(.turn(makeChange(turn: makeTurn("after-reconnect", startedAt: 5_000))))
		}
		XCTAssertTrue(found, "the chat never resubscribed after the stream ended")
		let calls = await client.calls
		XCTAssertGreaterThanOrEqual(
			calls.filter { $0.method == "conversationTail" }.count, 2,
			"resubscribing re-tails, which is how the Node re-subscribes the peer")
	}

	func testOpenTurnChangesAreAnnounced() {
		let vm = makeViewModel()
		var announced: [TurnId?] = []
		vm.onOpenTurnChange = { announced.append(vm.openTurnId) }
		vm.apply(makeChange(turn: makeTurn("t1")))
		vm.apply(makeChange(block: makeBlock(0)))
		vm.apply(makeChange(turn: makeTurn("t1", endedAt: 2_000)))
		XCTAssertEqual(announced, ["t1", nil], "opening and closing each announce once")
	}

	func testStartStreamsLiveTurns() async throws {
		let client = FixtureNodeClient()
		let vm = ChatViewModel(client: client, sessionId: Self.session)
		await vm.start()
		await client.emit(.turn(makeChange(turn: makeTurn("live"))))
		var found = false
		for _ in 0 ..< 500 {
			try await Task.sleep(nanoseconds: 10_000_000)
			if vm.turns.contains(where: { $0.id == "live" }) {
				found = true
				break
			}
		}
		XCTAssertTrue(found, "live turn notification was not applied")
	}

	// MARK: - Reconnect (FIXPASS G4-7)

	/// The tail is what re-subscribes this peer to the session on the Node,
	/// and it throws for the whole reconnect, not just the first backoff.
	/// Swallowing that failure and listening anyway left the chat silent.
	func testResubscribeKeepsRetailingUntilTheTailSucceeds() async throws {
		let client = ReconnectingStub()
		let vm = ChatViewModel(client: client, sessionId: Self.session)
		await vm.start()
		defer { vm.stop() }
		let firstSuccesses = await client.successes
		XCTAssertEqual(firstSuccesses, 1, "start() tails once")

		// The connection drops and stays down for several backoffs.
		await client.goDown()
		try await Task.sleep(nanoseconds: 400_000_000)
		let downSuccesses = await client.successes
		let downAttempts = await client.attempts
		XCTAssertEqual(downSuccesses, 1, "no tail can land while the client is down")
		XCTAssertGreaterThanOrEqual(
			downAttempts, 2, "the loop keeps re-tailing while the tail fails")

		// Back up: the next tail lands, and the chat streams again.
		await client.comeBack()
		var found = false
		for _ in 0 ..< 500 {
			try await Task.sleep(nanoseconds: 10_000_000)
			await client.emit(.turn(makeChange(turn: makeTurn("after-reconnect", startedAt: 5_000))))
			if vm.turns.contains(where: { $0.id == "after-reconnect" }) {
				found = true
				break
			}
		}
		XCTAssertTrue(found, "the chat never re-subscribed after the outage ended")
		let finalSuccesses = await client.successes
		XCTAssertGreaterThanOrEqual(
			finalSuccesses, 2, "a successful tail is what re-subscribes the peer")
	}

	/// The subscription is taken before the tail request, so a notification
	/// the Node broadcasts while the tail is in flight is buffered, not lost.
	func testNotificationSentDuringTheTailIsNotLost() async throws {
		let client = ReconnectingStub()
		await client.broadcastDuringTail(
			.turn(makeChange(turn: makeTurn("mid-tail", startedAt: 4_000))))
		let vm = ChatViewModel(client: client, sessionId: Self.session)
		await vm.start()
		defer { vm.stop() }
		var found = false
		for _ in 0 ..< 500 {
			try await Task.sleep(nanoseconds: 10_000_000)
			if vm.turns.contains(where: { $0.id == "mid-tail" }) {
				found = true
				break
			}
		}
		XCTAssertTrue(found, "a notification sent while the tail was in flight was dropped")
	}
}

/// A client that can be taken down and brought back the way a reconnect
/// does: while it is down every subscription is finished and
/// `conversationTail` throws `.disconnected`. It counts tail attempts and
/// successes so a test can tell a swallowed failure from a real re-tail.
///
/// It also models the Node's subscription rule (`src/node/server.ts`: a
/// `turn` reaches only peers whose per-connection `tailed` set holds the
/// session): `emit` delivers nothing until a tail has succeeded on the
/// current connection, so listening without a successful re-tail is silence.
private actor ReconnectingStub: NodeClient {
	private let hub = NotificationHub()
	private var down = false
	private var tailed = false
	private var tailAttempts = 0
	private var tailSuccesses = 0
	private var duringTail: NodeNotification?

	nonisolated var notifications: AsyncStream<NodeNotification> { hub.subscribe() }

	var attempts: Int { tailAttempts }
	var successes: Int { tailSuccesses }

	/// Drops the connection: finishes every live subscription, exactly as
	/// `SocketNodeClient.connect()` does, and fails every tail until
	/// `comeBack()`.
	func goDown() {
		down = true
		tailed = false
		hub.finishAll()
	}

	func comeBack() { down = false }

	/// Delivers only to a peer that has tailed on this connection, the way
	/// the Node does; an untailed peer hears nothing at all.
	func emit(_ notification: NodeNotification) {
		guard tailed else { return }
		hub.broadcast(notification)
	}

	/// Broadcast from inside the next `conversationTail`, i.e. in the window
	/// between subscribing and the tail's answer.
	func broadcastDuringTail(_ notification: NodeNotification) { duringTail = notification }

	func connect() async throws {}
	func snapshot() async throws -> Snapshot { throw NodeClientError.disconnected }
	func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission] { [] }
	func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event] { [] }

	func conversationTail(
		sessionId: Ulid, cursor: String?, limit: Int, direction: String?, turnId: TurnId?
	) async throws -> ConversationPage {
		tailAttempts += 1
		if let duringTail {
			self.duringTail = nil
			hub.broadcast(duringTail)
		}
		if down { throw NodeClientError.disconnected }
		tailSuccesses += 1
		tailed = true
		return ConversationPage(turns: [], blocks: [], nextCursor: nil, prevCursor: nil)
	}

	func prompt(sessionId: Ulid, text: String) async throws -> Ulid {
		throw NodeClientError.disconnected
	}
	func cancel(sessionId: Ulid) async throws {}
	func setModel(sessionId: Ulid, model: String) async throws {}
	func listModels(provider: String) async throws -> [ModelInfo] { [] }
	func setMode(workspaceId: String, mode: LeaderMode) async throws {}
	func pin(missionId: Ulid, pinned: Bool) async throws {}
	func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws {}
	func openWorkspace(path: String) async throws -> Workspace {
		throw NodeClientError.disconnected
	}
}
