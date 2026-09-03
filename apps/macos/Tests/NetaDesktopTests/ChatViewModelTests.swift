import Foundation
import XCTest

@testable import NetaDesktop

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

	func testAutoScrollTargetFollowsAtBottom() {
		let vm = makeViewModel()
		XCTAssertNil(vm.autoScrollTarget)
		vm.apply(makeChange(turn: makeTurn("t1", startedAt: 1_000)))
		vm.apply(makeChange(turn: makeTurn("t2", startedAt: 2_000)))
		XCTAssertEqual(vm.autoScrollTarget, "t2")
		vm.atBottom = false
		XCTAssertNil(vm.autoScrollTarget)
		vm.atBottom = true
		XCTAssertEqual(vm.autoScrollTarget, "t2")
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
		XCTAssertEqual(vm.autoScrollTarget, second)
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
}
