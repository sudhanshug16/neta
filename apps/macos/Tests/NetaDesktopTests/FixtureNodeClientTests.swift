import Foundation
import XCTest

@testable import NetaDesktop

/// T9.3: the fixture client answers reads from the recorded fixtures,
/// pages backwards, replays events in order, and records every call.
/// Protocol data always comes from `test/fixtures`; nothing is hand-written.
final class FixtureNodeClientTests: XCTestCase {
	func testRepoFixturesResolvesRecordedData() {
		let dir = FixtureNodeClient.repoFixtures
		for file in ["node-snapshot.json", "node-events.ndjson"] {
			XCTAssertTrue(
				FileManager.default.fileExists(atPath: dir.appendingPathComponent(file).path),
				"missing \(file) in \(dir.path)")
		}
	}

	func testSnapshotReturnsFixtureMissions() async throws {
		let snapshot = try await FixtureNodeClient().snapshot()
		XCTAssertEqual(snapshot.missions.count, 13)
		XCTAssertEqual(snapshot.events.count, 71)
		XCTAssertEqual(snapshot.protocolVersion, 1)
		let mission = try XCTUnwrap(snapshot.missions.first { $0.number == 2 })
		XCTAssertEqual(mission.name, "mission 2")
		XCTAssertEqual(mission.state, .blocked)
	}

	func testMissionsListPagesStrictlyOlderWithoutRepeats() async throws {
		let client = FixtureNodeClient()
		let workspaceId = "git:github.com/acme/widget"
		let first = try await client.missionsList(workspaceId: workspaceId, before: nil, limit: 5)
		XCTAssertEqual(first.count, 5)
		XCTAssertTrue(
			zip(first, first.dropFirst()).allSatisfy { $0.createdAt >= $1.createdAt },
			"newest first")
		let oldest = try XCTUnwrap(first.last)
		let rest = try await client.missionsList(
			workspaceId: workspaceId, before: oldest.createdAt, limit: 50)
		XCTAssertEqual(rest.count, 8)
		XCTAssertTrue(rest.allSatisfy { $0.createdAt < oldest.createdAt }, "strictly older")
		let ids = Set(first.map(\.id)).union(rest.map(\.id))
		XCTAssertEqual(ids.count, 13, "no repeats, nothing lost")
		let missing = try await client.missionsList(
			workspaceId: "no-such-workspace", before: nil, limit: 10)
		XCTAssertEqual(missing.count, 0)
	}

	func testEventsListIsNewestFirstAndBounded() async throws {
		let client = FixtureNodeClient()
		let workspaceId = "git:github.com/acme/widget"
		let page = try await client.eventsList(workspaceId: workspaceId, before: nil, limit: 30)
		XCTAssertEqual(page.map(\.seq), Array((42 ... 71).reversed()))
		let oldest = try XCTUnwrap(page.last)
		let older = try await client.eventsList(workspaceId: workspaceId, before: oldest.at, limit: 100)
		XCTAssertTrue(older.allSatisfy { $0.at < oldest.at })
		XCTAssertTrue(Set(older.map(\.seq)).isDisjoint(with: Set(page.map(\.seq))))
		let missing = try await client.eventsList(
			workspaceId: "no-such-workspace", before: nil, limit: 10)
		XCTAssertEqual(missing.count, 0)
	}

	func testConversationTailPagesBackward() async throws {
		let client = FixtureNodeClient()
		let sessionId = "01KT1GW6G03YY7WR8A6BBMKV8E"
		var ids: [String] = []
		for i in 0 ..< 3 {
			ids.append(try await client.prompt(sessionId: sessionId, text: "msg \(i)"))
		}
		let newest = try await client.conversationTail(sessionId: sessionId, cursor: nil, limit: 2)
		XCTAssertEqual(newest.turns.map(\.id), Array(ids.suffix(2)))
		XCTAssertNil(newest.nextCursor)
		let prev = try XCTUnwrap(newest.prevCursor)
		let older = try await client.conversationTail(sessionId: sessionId, cursor: prev, limit: 10)
		XCTAssertEqual(older.turns.map(\.id), [ids[0]])
		XCTAssertNil(older.prevCursor)
		XCTAssertEqual(older.nextCursor, "1")
	}

	func testListModelsComesFromFixtureProviders() async throws {
		let client = FixtureNodeClient()
		let models = try await client.listModels(provider: "fake")
		XCTAssertEqual(models.map(\.id), ["test-model"])
		XCTAssertTrue(models.allSatisfy { $0.provider == "fake" })
		let missing = try await client.listModels(provider: "no-such-provider")
		XCTAssertEqual(missing.count, 0)
	}

	func testEmitNextReplaysInOrderThenFinishesStream() async throws {
		let client = FixtureNodeClient()
		let collector = Task { () -> [Event] in
			var replayed: [Event] = []
			for await notification in await client.notifications {
				if case .event(let event) = notification {
					replayed.append(event)
				}
			}
			return replayed
		}
		var pushed = 0
		while await client.emitNext() { pushed += 1 }
		XCTAssertEqual(pushed, 71)
		let replayed = await collector.value
		XCTAssertEqual(replayed.map(\.seq), Array(1 ... 71))
		let extra = await client.emitNext()
		XCTAssertFalse(extra)
	}

	func testPromptEmitsTurnAndIsTailed() async throws {
		let client = FixtureNodeClient()
		let snapshot = try await client.snapshot()
		let sessionId = try XCTUnwrap(snapshot.leaders.first?.sessionId)
		let first = Task { () -> TurnChange? in
			for await notification in await client.notifications {
				if case .turn(let change) = notification { return change }
			}
			return nil
		}
		let turnId = try await client.prompt(sessionId: sessionId, text: "hello leader")
		let firstChange = await first.value
		let change = try XCTUnwrap(firstChange)
		XCTAssertEqual(change.sessionId, sessionId)
		XCTAssertEqual(change.turn?.id, turnId)
		let page = try await client.conversationTail(sessionId: sessionId, cursor: nil, limit: 10)
		XCTAssertEqual(page.turns.map(\.id), [turnId])
		XCTAssertNil(page.nextCursor)
		XCTAssertNil(page.prevCursor)
		let calls = await client.calls
		XCTAssertTrue(calls.contains { $0.method == "prompt" && $0.json.contains("hello leader") })
	}

	func testWritesMutateMemoryAndEmit() async throws {
		let client = FixtureNodeClient()
		let snapshot = try await client.snapshot()
		let workspaceId = "git:github.com/acme/widget"
		let mission = try XCTUnwrap(snapshot.missions.first)
		let agent = try XCTUnwrap(snapshot.agents.first)
		let sessionId = try XCTUnwrap(snapshot.leaders.first?.sessionId)
		let collected = Task { () -> [NodeNotification] in
			var out: [NodeNotification] = []
			for await notification in await client.notifications {
				out.append(notification)
				if out.count == 6 { break }
			}
			return out
		}
		let turnId = try await client.prompt(sessionId: sessionId, text: "hi")
		try await client.cancel(sessionId: sessionId)
		try await client.pin(missionId: mission.id, pinned: true)
		try await client.archiveAgent(agentId: agent.id, confirmRunning: true)
		try await client.setMode(workspaceId: workspaceId, mode: .leadPlus)
		try await client.setModel(sessionId: sessionId, model: "other-model")
		let notifications = await collected.value
		XCTAssertEqual(notifications.count, 6)

		var turns: [TurnChange] = []
		var events: [Event] = []
		var states: [StateChange] = []
		for notification in notifications {
			switch notification {
			case .turn(let change): turns.append(change)
			case .event(let event): events.append(event)
			case .state(let change): states.append(change)
			case .node: XCTFail("no node notification was emitted")
			}
		}
		XCTAssertEqual(turns.count, 2)
		XCTAssertEqual(turns[0].turn?.id, turnId)
		XCTAssertNotEqual(turns[0].turn?.cancelled, true)
		XCTAssertEqual(turns[1].turn?.id, turnId)
		XCTAssertEqual(turns[1].turn?.cancelled, true)
		XCTAssertEqual(events.count, 1)
		XCTAssertEqual(events[0].kind, .userPinned)
		XCTAssertEqual(events[0].missionId, mission.id)
		XCTAssertEqual(events[0].data["pinned"], .bool(true))
		XCTAssertEqual(states.count, 3)

		let after = try await client.snapshot()
		XCTAssertTrue(after.events.contains {
			$0.kind == .userPinned && $0.missionId == mission.id
		})
		XCTAssertEqual(after.agents.first { $0.id == agent.id }?.state, .archived)
		XCTAssertEqual(after.leaders.first { $0.workspaceId == workspaceId }?.mode, .leadPlus)
		XCTAssertEqual(after.leaders.first { $0.workspaceId == workspaceId }?.model, "other-model")
		let page = try await client.conversationTail(sessionId: sessionId, cursor: nil, limit: 10)
		XCTAssertEqual(page.turns.map(\.id), [turnId])
		XCTAssertEqual(page.turns.first?.cancelled, true)

		let methods = await client.calls.map(\.method)
		XCTAssertEqual(
			methods,
			["snapshot", "prompt", "cancel", "pin", "archiveAgent", "setMode", "setModel",
				"snapshot", "conversationTail"])
	}

	func testWritesNeverTouchDisk() async throws {
		let files = ["node-snapshot.json", "node-events.ndjson"]
		let urls = files.map { FixtureNodeClient.repoFixtures.appendingPathComponent($0) }
		let before = try urls.map { try Data(contentsOf: $0) }
		let client = FixtureNodeClient()
		let snapshot = try await client.snapshot()
		let sessionId = try XCTUnwrap(snapshot.leaders.first?.sessionId)
		let missionId = try XCTUnwrap(snapshot.missions.first?.id)
		let agentId = try XCTUnwrap(snapshot.agents.first?.id)
		_ = try await client.prompt(sessionId: sessionId, text: "disk check")
		try await client.cancel(sessionId: sessionId)
		try await client.setModel(sessionId: sessionId, model: "other-model")
		try await client.setMode(workspaceId: "git:github.com/acme/widget", mode: .leadPlus)
		try await client.pin(missionId: missionId, pinned: true)
		try await client.archiveAgent(agentId: agentId, confirmRunning: true)
		await client.emit(.node(NodeLifecycle(phase: .restarting)))
		while await client.emitNext() {}
		XCTAssertEqual(try urls.map { try Data(contentsOf: $0) }, before)
	}
}
