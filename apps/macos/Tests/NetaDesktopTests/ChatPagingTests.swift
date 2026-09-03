import Foundation
import XCTest

@testable import NetaDesktop

private let pagingSession = "01PAGINGSESSIONAAAAAAAA01"

private func pagingTurn(_ id: String, startedAt: TimeInterval) -> Turn {
	Turn(
		id: id, sessionId: pagingSession,
		startedAt: Date(timeIntervalSince1970: startedAt),
		endedAt: Date(timeIntervalSince1970: startedAt + 1),
		role: .agent, cancelled: nil)
}

private func pagingBlock(_ turnId: String, size: Int, seq: Int = 0) -> Block {
	Block(
		turnId: turnId, seq: seq, at: Date(timeIntervalSince1970: 2_000),
		role: .agent, kind: .text, text: String(repeating: "x", count: size), data: nil)
}

private func pagingPage(
	turns: [Turn], blocks: [Block] = [],
	next: String? = nil, prev: String? = nil
) -> ConversationPage {
	ConversationPage(turns: turns, blocks: blocks, nextCursor: next, prevCursor: prev)
}

/// A scripted `NodeClient`: `conversationTail` answers come from an enqueued
/// queue or a handler, and every tail call is recorded for assertions.
private actor StubNodeClient: NodeClient {
	struct TailCall: Sendable {
		let cursor: String?
		let limit: Int
		let direction: String?
		let turnId: TurnId?
	}

	private(set) var tailCalls: [TailCall] = []
	var queuedPages: [ConversationPage] = []
	var tailHandler: (@Sendable (TailCall) -> ConversationPage)?
	let notifications: AsyncStream<NodeNotification>

	init() {
		let (stream, continuation) = AsyncStream<NodeNotification>.makeStream()
		notifications = stream
		continuation.finish()
	}

	func enqueue(_ pages: [ConversationPage]) {
		queuedPages.append(contentsOf: pages)
	}

	func setTailHandler(_ handler: @escaping @Sendable (TailCall) -> ConversationPage) {
		tailHandler = handler
	}

	func connect() async throws {}
	func snapshot() async throws -> Snapshot { throw NodeClientError.disconnected }
	func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission] { [] }
	func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event] { [] }

	func conversationTail(
		sessionId: Ulid, cursor: String? = nil, limit: Int,
		direction: String? = nil, turnId: TurnId? = nil
	) async throws -> ConversationPage {
		let call = TailCall(cursor: cursor, limit: limit, direction: direction, turnId: turnId)
		tailCalls.append(call)
		if let tailHandler { return tailHandler(call) }
		guard !queuedPages.isEmpty else { throw NodeClientError.disconnected }
		return queuedPages.removeFirst()
	}

	func prompt(sessionId: Ulid, text: String) async throws -> Ulid { "stub" }
	func cancel(sessionId: Ulid) async throws {}
	func setModel(sessionId: Ulid, model: String) async throws {}
	func listModels(provider: String) async throws -> [ModelInfo] { [] }
	func setMode(workspaceId: String, mode: LeaderMode) async throws {}
	func pin(missionId: Ulid, pinned: Bool) async throws {}
	func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws {}
}

/// T11.2: paging and scroll to turn.
@MainActor
final class ChatPagingTests: XCTestCase {
	private func makeViewModel(_ stub: StubNodeClient) -> ChatViewModel {
		ChatViewModel(client: stub, sessionId: pagingSession)
	}

	private func change(turn: Turn? = nil, block: Block? = nil) -> TurnChange {
		TurnChange(sessionId: pagingSession, turn: turn, block: block)
	}

	func testScrollToLoadedTurnSetsFlashingRequest() async {
		let stub = StubNodeClient()
		let vm = makeViewModel(stub)
		vm.apply(change(turn: pagingTurn("t1", startedAt: 1_000)))
		vm.apply(change(turn: pagingTurn("t2", startedAt: 2_000)))
		await vm.scrollTo(turnId: "t1")
		XCTAssertEqual(vm.pendingScroll, ScrollRequest(turnId: "t1", flash: true))
		let calls = await stub.tailCalls
		XCTAssertTrue(calls.isEmpty)
	}

	func testScrollToUnloadedTurnPagesThreeTimesAndStops() async {
		let stub = StubNodeClient()
		await stub.setTailHandler { call in
			// A scripted history where the anchor page misses the target, so
			// scrollTo must walk backward twice to reach it.
			if call.turnId == "t6" {
				return pagingPage(turns: [pagingTurn("t7", startedAt: 1_007)], next: "n0", prev: "c1")
			}
			if call.cursor == "c1" {
				return pagingPage(turns: [pagingTurn("t5", startedAt: 1_005)], next: "c0", prev: "c2")
			}
			return pagingPage(turns: [pagingTurn("t6", startedAt: 1_006)], next: "c1", prev: nil)
		}
		let vm = makeViewModel(stub)
		await vm.scrollTo(turnId: "t6")
		let calls = await stub.tailCalls
		XCTAssertEqual(calls.count, 3)
		XCTAssertEqual(calls[0].turnId, "t6")
		XCTAssertNil(calls[0].cursor)
		XCTAssertNil(calls[0].direction)
		XCTAssertEqual(calls[1].cursor, "c1")
		XCTAssertEqual(calls[1].direction, "backward")
		XCTAssertNil(calls[1].turnId)
		XCTAssertEqual(calls[2].cursor, "c2")
		XCTAssertEqual(calls[2].direction, "backward")
		XCTAssertEqual(vm.turns.map(\.id), ["t5", "t6", "t7"])
		XCTAssertEqual(vm.pendingScroll, ScrollRequest(turnId: "t6", flash: true))
		XCTAssertFalse(vm.hasOlder)
	}

	func testScrollToMissingTurnStopsAtNilCursor() async {
		let stub = StubNodeClient()
		await stub.enqueue([
			pagingPage(turns: [pagingTurn("t9", startedAt: 1_009)], prev: "c1"),
			pagingPage(turns: [pagingTurn("t8", startedAt: 1_008)], prev: nil),
		])
		let vm = makeViewModel(stub)
		await vm.scrollTo(turnId: "never")
		let missingCalls = await stub.tailCalls
		XCTAssertEqual(missingCalls.count, 2)
		XCTAssertNil(vm.pendingScroll)
		XCTAssertEqual(vm.turns.map(\.id), ["t8", "t9"])
		XCTAssertFalse(vm.hasOlder)
	}

	func testScrollToStopsAfter32Pages() async {
		let stub = StubNodeClient()
		let pad = pagingPage(turns: [pagingTurn("pad", startedAt: 500)], prev: "c")
		await stub.enqueue(Array(repeating: pad, count: 40))
		let vm = makeViewModel(stub)
		await vm.scrollTo(turnId: "never")
		let cappedCalls = await stub.tailCalls
		XCTAssertEqual(cappedCalls.count, 32)
		XCTAssertTrue(cappedCalls.dropFirst().allSatisfy { $0.direction == "backward" })
		XCTAssertNil(vm.pendingScroll)
	}

	func testLoadOlderPrependsAndTracksCursors() async {
		let stub = StubNodeClient()
		await stub.enqueue([
			pagingPage(
				turns: [pagingTurn("t8", startedAt: 1_008), pagingTurn("t9", startedAt: 1_009)],
				prev: "c8"),
			pagingPage(turns: [pagingTurn("t7", startedAt: 1_007)], prev: nil),
		])
		let vm = makeViewModel(stub)
		await vm.start()
		XCTAssertTrue(vm.hasOlder)
		XCTAssertFalse(vm.hasNewer)
		let loaded = await vm.loadOlder()
		XCTAssertTrue(loaded)
		XCTAssertEqual(vm.turns.map(\.id), ["t7", "t8", "t9"])
		XCTAssertFalse(vm.hasOlder)
		let loadedAgain = await vm.loadOlder()
		XCTAssertFalse(loadedAgain)
		let calls = await stub.tailCalls
		XCTAssertEqual(calls.count, 2)
		XCTAssertEqual(calls[1].cursor, "c8")
		XCTAssertEqual(calls[1].direction, "backward")
	}

	private func makeBigWindow(_ vm: ChatViewModel, count: Int = 60) -> [String] {
		var ids: [String] = []
		for i in 0 ..< count {
			let id = String(format: "t%02d", i)
			ids.append(id)
			vm.apply(change(turn: pagingTurn(id, startedAt: 1_000 + Double(i))))
			vm.apply(change(block: pagingBlock(id, size: 20_000)))
		}
		return ids
	}

	func testTrimAroundNewestDropsOlderEnd() {
		let vm = makeViewModel(StubNodeClient())
		let ids = makeBigWindow(vm)
		XCTAssertGreaterThan(vm.cacheBytes, ChatCache.limitBytes)
		vm.trim(around: ids.last!)
		XCTAssertLessThanOrEqual(vm.cacheBytes, ChatCache.limitBytes)
		XCTAssertEqual(vm.turns.last?.id, ids.last)
		// The window is the surviving suffix of the original order.
		let first = ids.firstIndex(of: vm.turns.first!.id)!
		XCTAssertEqual(vm.turns.map(\.id), Array(ids[first...]))
		XCTAssertTrue(vm.hasOlder)
		XCTAssertFalse(vm.hasNewer)
	}

	func testTrimAroundMiddleDropsBothSides() {
		let vm = makeViewModel(StubNodeClient())
		let ids = makeBigWindow(vm)
		vm.trim(around: ids[30])
		XCTAssertLessThanOrEqual(vm.cacheBytes, ChatCache.limitBytes)
		XCTAssertTrue(vm.turns.contains(where: { $0.id == ids[30] }))
		let first = ids.firstIndex(of: vm.turns.first!.id)!
		let last = ids.firstIndex(of: vm.turns.last!.id)!
		XCTAssertEqual(vm.turns.map(\.id), Array(ids[first ... last]))
		XCTAssertLessThan(first, 30)
		XCTAssertLessThan(30, last)
		XCTAssertTrue(vm.hasOlder)
		XCTAssertTrue(vm.hasNewer)
	}

	func testJumpToLatestRestoresTail() async {
		let stub = StubNodeClient()
		await stub.enqueue([
			pagingPage(
				turns: [pagingTurn("t2", startedAt: 1_002), pagingTurn("t3", startedAt: 1_003)],
				next: "n", prev: "c0"),
			pagingPage(
				turns: [pagingTurn("t8", startedAt: 1_008), pagingTurn("t9", startedAt: 1_009)],
				prev: "c8"),
		])
		let vm = makeViewModel(stub)
		vm.atBottom = false
		await vm.scrollTo(turnId: "t2")
		XCTAssertTrue(vm.hasNewer)
		await vm.jumpToLatest()
		XCTAssertEqual(vm.turns.map(\.id), ["t8", "t9"])
		XCTAssertFalse(vm.hasNewer)
		XCTAssertTrue(vm.hasOlder)
		XCTAssertTrue(vm.atBottom)
	}

	func testApplyDropsOutsideWindowWhileHasNewer() async {
		let stub = StubNodeClient()
		await stub.enqueue([
			pagingPage(
				turns: [pagingTurn("t2", startedAt: 1_002), pagingTurn("t3", startedAt: 1_003)],
				next: "n"),
		])
		let vm = makeViewModel(stub)
		await vm.scrollTo(turnId: "t2")
		XCTAssertTrue(vm.hasNewer)
		// A block for an unknown turn opens nothing while the live end is cut.
		vm.apply(change(block: pagingBlock("ghost", size: 8)))
		XCTAssertEqual(vm.turns.map(\.id), ["t2", "t3"])
		// A newer turn outside the window is dropped too.
		vm.apply(change(turn: pagingTurn("t4", startedAt: 1_004)))
		XCTAssertEqual(vm.turns.map(\.id), ["t2", "t3"])
		// Payloads inside the window still land.
		vm.apply(change(block: pagingBlock("t2", size: 8)))
		XCTAssertEqual(vm.turns.first(where: { $0.id == "t2" })?.blocks.map(\.seq), [0])
	}

	func testFixtureTailTurnIdAnchor() async throws {
		let client = FixtureNodeClient()
		let session = "01PAGINGFIXTUREAAAAAAAA01"
		var ids: [String] = []
		for i in 0 ..< 3 {
			ids.append(try await client.prompt(sessionId: session, text: "m\(i)"))
			try await Task.sleep(nanoseconds: 10_000_000)
		}
		let page = try await client.conversationTail(
			sessionId: session, cursor: nil, limit: 10, direction: nil, turnId: ids[1])
		XCTAssertEqual(page.turns.map(\.id), [ids[1], ids[2]])
		XCTAssertEqual(page.prevCursor, "1")
		XCTAssertNil(page.nextCursor)
		let before = try await client.conversationTail(
			sessionId: session, cursor: nil, limit: 10, direction: "backward", turnId: ids[2])
		XCTAssertEqual(before.turns.map(\.id), [ids[0], ids[1]])
		XCTAssertNil(before.prevCursor)
		let calls = await client.calls
		XCTAssertTrue(
			calls.contains { $0.method == "conversationTail" && $0.json.contains("\"turnId\"") })
		XCTAssertTrue(
			calls.contains { $0.method == "conversationTail" && $0.json.contains("\"backward\"") })
	}
}
