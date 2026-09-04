import Foundation
import XCTest

@testable import NetaDesktop

/// Decodes the fixtures recorded by 04 (`test/fixtures/`) through
/// `NetaJSON`. The recorded files are the only protocol data used here;
/// nothing is hand-written except the tiny unknown-`kind` and
/// notification-payload probes the contract calls for.
final class DomainDecodingTests: XCTestCase {
	func testSnapshotDecodesMissionCount() throws {
		let snapshot = try decodeSnapshot()
		XCTAssertEqual(snapshot.missions.count, 13)
		XCTAssertEqual(snapshot.events.count, 71)
		XCTAssertEqual(snapshot.attention.count, 8)
		XCTAssertEqual(snapshot.windowDays, 14)
		XCTAssertEqual(snapshot.protocolVersion, 1)
		XCTAssertTrue(snapshot.hasOlder)
	}

	func testSnapshotLeaderCarriesItsOwnName() throws {
		let snapshot = try decodeSnapshot()
		let leader = try XCTUnwrap(snapshot.leaders.first)
		XCTAssertEqual(leader.name, "Halden")
		XCTAssertNotEqual(leader.name, snapshot.workspaces.first?.name)
	}

	/// A leader stored before `name` existed must not take the snapshot
	/// down with it: the field decodes empty and the shell says "Leader".
	func testLeaderWithoutANameStillDecodes() throws {
		let json = """
			{"workspaceId":"git:github.com/acme/widget","machineId":"01KT1GW6G03YY7WR8A6BBMKV89",\
			"sessionId":"01KT1GW6G03YY7WR8A6BBMKV8E","provider":"fake","model":"test-model",\
			"mode":"lead","modeSince":"2026-06-01T07:00:00.000Z","modeActiveMs":0,"state":"idle"}
			"""
		let leader = try NetaJSON.decoder.decode(Leader.self, from: Data(json.utf8))
		XCTAssertEqual(leader.name, "")
		XCTAssertEqual(leader.provider, "fake")
		XCTAssertEqual(MissionBarModel.leaderDisplayName(leader), "Leader")
	}

	func testSnapshotMissionFieldsToTheMillisecond() throws {
		let snapshot = try decodeSnapshot()
		let mission = try XCTUnwrap(snapshot.missions.first { $0.number == 2 })
		XCTAssertEqual(mission.number, 2)
		XCTAssertEqual(mission.name, "mission 2")
		XCTAssertEqual(mission.state, .blocked)
		XCTAssertTrue(mission.needsPerson)
		// The decoded Date formats back to the exact fixture string,
		// so sub-second precision survived the round trip.
		XCTAssertEqual(
			NetaJSON.string(from: mission.createdAt), "2026-06-01T07:00:00.000Z")
		XCTAssertEqual(mission.createdAt, NetaJSON.date(from: "2026-06-01T07:00:00.000Z"))
	}

	func testSnapshotCompletedCounts() throws {
		let snapshot = try decodeSnapshot()
		let mission7 = try XCTUnwrap(snapshot.missions.first { $0.number == 7 })
		XCTAssertEqual(snapshot.completedCounts[mission7.id], 12)
	}

	func testEveryNdjsonLineDecodes() throws {
		let lines = try fixture("node-events.ndjson")
			.components(separatedBy: .newlines)
			.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
		XCTAssertEqual(lines.count, 71)
		var seqs: [Int] = []
		for line in lines {
			let event = try NetaJSON.decoder.decode(
				Event.self, from: Data(line.utf8))
			seqs.append(event.seq)
		}
		XCTAssertEqual(seqs, Array(1...71))
	}

	func testUnknownKindBecomesUnknown() throws {
		let json = """
		{"seq":999,"at":"2026-06-01T12:00:00.000Z",\
		"workspaceId":"git:github.com/acme/widget",\
		"kind":"mission.teleported","data":{}}
		"""
		let event = try NetaJSON.decoder.decode(Event.self, from: Data(json.utf8))
		XCTAssertEqual(event.kind, .unknown("mission.teleported"))
		XCTAssertEqual(event.kind.rawValue, "mission.teleported")
	}

	func testKnownKindsRoundTrip() throws {
		XCTAssertEqual(EventKind(rawValue: "mission.created"), .missionCreated)
		XCTAssertEqual(EventKind.missionCreated.rawValue, "mission.created")
		XCTAssertEqual(EventKind(rawValue: "user.pinned"), .userPinned)
	}

	func testMissionReencodedAndDecodedIsEqual() throws {
		let snapshot = try decodeSnapshot()
		let mission = try XCTUnwrap(snapshot.missions.first { $0.number == 4 })
		let data = try NetaJSON.encoder.encode(mission)
		XCTAssertEqual(try NetaJSON.decoder.decode(Mission.self, from: data), mission)
	}

	func testStateChangeMirrorsStatePayload() throws {
		let snapshot = try decodeSnapshot()
		let mission = try XCTUnwrap(snapshot.missions.first { $0.number == 1 })
		let record = String(decoding: try NetaJSON.encoder.encode(mission), as: UTF8.self)
		let json = "{\"kind\":\"mission\",\"record\":\(record)}"
		let change = try NetaJSON.decoder.decode(StateChange.self, from: Data(json.utf8))
		XCTAssertEqual(change.kind, .mission)
		guard case .mission(let decoded) = change.record else {
			return XCTFail("expected a mission record")
		}
		XCTAssertEqual(decoded, mission)
	}

	func testTurnChangeMirrorsTurnPayload() throws {
		let json = """
		{"sessionId":"01KT1GW6G03YY7WR8A6BBMKV8E",\
		"turn":{"id":"01KT1GW6G03YY7WR8A6BBMKVB0",\
		"sessionId":"01KT1GW6G03YY7WR8A6BBMKV8E",\
		"startedAt":"2026-06-01T12:00:00.000Z","role":"agent"},\
		"block":{"turnId":"01KT1GW6G03YY7WR8A6BBMKVB0","seq":0,\
		"at":"2026-06-01T12:00:00.000Z","role":"agent","kind":"text",\
		"text":"hello"}}
		"""
		let change = try NetaJSON.decoder.decode(TurnChange.self, from: Data(json.utf8))
		XCTAssertEqual(change.sessionId, "01KT1GW6G03YY7WR8A6BBMKV8E")
		XCTAssertEqual(change.turn?.role, .agent)
		XCTAssertEqual(change.block?.kind, .text)
		XCTAssertEqual(change.block?.text, "hello")
	}

	func testNodeLifecycleMirrorsNodePayload() throws {
		for (json, phase) in [
			("{\"phase\":\"restarting\"}", NodePhase.restarting),
			("{\"phase\":\"stopping\"}", NodePhase.stopping),
		] as [(String, NodePhase)] {
			XCTAssertEqual(
				try NetaJSON.decoder.decode(NodeLifecycle.self, from: Data(json.utf8)).phase,
				phase)
		}
	}

	func testDatesAreFractionalUtcBothWays() throws {
		// Fractional seconds out, UTC `Z` suffix.
		XCTAssertEqual(
			NetaJSON.string(from: Date(timeIntervalSince1970: 1_780_315_200.789)),
			"2026-06-01T12:00:00.789Z")
		// Fractional seconds back in, exactly.
		XCTAssertEqual(
			NetaJSON.date(from: "2026-06-01T12:00:00.789Z"),
			Date(timeIntervalSince1970: 1_780_315_200.789))
		// Tolerant read of the same shape without fractions.
		XCTAssertNotNil(NetaJSON.date(from: "2026-06-01T12:00:00Z"))
	}

	func testNoKeyRenaming() throws {
		let domain = try domainSource()
		XCTAssertFalse(
			domain.contains("convertFromSnakeCase"),
			"field names must stay identical; no key strategy on decode")
		XCTAssertFalse(
			domain.contains("convertToSnakeCase"),
			"field names must stay identical; no key strategy on encode")
		XCTAssertFalse(
			domain.contains("CodingKeys"),
			"no per-type key maps; names are identical by construction")
	}

	func testNeedsPerson() {
		for state in [MissionState.blocked, .failed, .readyToClose, .mergedNotClosed] {
			XCTAssertTrue(mission(in: state).needsPerson, "\(state)")
		}
		for state in [MissionState.running, .closed] {
			XCTAssertFalse(mission(in: state).needsPerson, "\(state)")
		}
	}

	// MARK: - Helpers

	private func repoRoot() -> URL {
		URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()  // file -> NetaDesktopTests
			.deletingLastPathComponent()  // -> Tests
			.deletingLastPathComponent()  // -> macos (package)
			.deletingLastPathComponent()  // -> apps
			.deletingLastPathComponent()  // -> neta (repo root)
	}

	private func fixture(_ name: String) throws -> String {
		try String(
			contentsOf: repoRoot().appendingPathComponent("test/fixtures/\(name)"),
			encoding: .utf8)
	}

	private func decodeSnapshot() throws -> Snapshot {
		try NetaJSON.decoder.decode(
			Snapshot.self, from: Data(try fixture("node-snapshot.json").utf8))
	}

	private func domainSource() throws -> String {
		let package = repoRoot()
			.appendingPathComponent("apps/macos/Sources/NetaDesktop/Model/Domain.swift")
		return try String(contentsOf: package, encoding: .utf8)
	}

	private func mission(in state: MissionState) -> Mission {
		Mission(
			id: "01KT1GW6G03YY7WR8A6BBMKV8F", number: 1,
			workspaceId: "git:github.com/acme/widget",
			machineId: "01KT1GW6G03YY7WR8A6BBMKV89",
			name: "mission 1", objective: "Objective 1.", changes: [],
			lead: .leader, agentIds: [], access: .readOnly, worktree: nil,
			state: state, attention: nil,
			createdAt: Date(timeIntervalSince1970: 1_780_315_200),
			closedAt: nil, disposition: nil, closeReason: nil,
			integration: nil, continuesMissionId: nil)
	}
}
