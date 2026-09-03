import AppKit
import Foundation
import SwiftUI
import XCTest

@testable import NetaDesktop

// MARK: - dataset.json names

private struct DatasetPerson: Decodable {
	let name: String
}

private struct DatasetMission: Decodable {
	let lead: DatasetPerson?
	let agents: [DatasetPerson]
}

private struct Dataset: Decodable {
	let leader: DatasetPerson
	let missions: [DatasetMission]
}

private func datasetNames() throws -> [String] {
	// design/canvas-directions/dataset.json lives five levels up from this
	// file: FadingTests.swift -> NetaDesktopTests -> Tests -> macos -> apps
	// -> repo root.
	var url = URL(fileURLWithPath: #filePath, isDirectory: false)
	for _ in 0 ..< 5 { url.deleteLastPathComponent() }
	url.appendPathComponent("design/canvas-directions/dataset.json")
	let data = try Data(contentsOf: url)
	let dataset = try JSONDecoder().decode(Dataset.self, from: data)
	var names = [dataset.leader.name]
	for mission in dataset.missions {
		if let lead = mission.lead { names.append(lead.name) }
		names.append(contentsOf: mission.agents.map(\.name))
	}
	return names
}

// MARK: - Builders

private let base = Date(timeIntervalSince1970: 1_787_712_000)

private func mission(state: MissionState, createdAt: Date = base) -> Mission {
	Mission(
		id: "m1", number: 298, workspaceId: "w", machineId: "m",
		name: "mission", objective: "Objective.", changes: [], lead: .leader,
		agentIds: [], access: .readOnly, worktree: nil, state: state,
		attention: nil, createdAt: createdAt,
		closedAt: state == .closed ? createdAt : nil, disposition: nil,
		closeReason: nil, integration: nil, continuesMissionId: nil)
}

private func agent(state: AgentState) -> Agent {
	Agent(
		id: "a-\(state.rawValue)", missionId: "m1", workspaceId: "w",
		name: "agent", task: "Task.", access: .readOnly, provider: "fake",
		model: "test-model", skills: [], sessionId: "s", canSpawn: false,
		state: state, stateBefore: nil, activity: nil, pendingQuestion: nil,
		startedAt: base, endedAt: nil, outcome: nil)
}

private func rgba(_ color: Color) -> (Double, Double, Double, Double) {
	let ns = NSColor(color).usingColorSpace(.sRGB) ?? NSColor(color)
	var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
	ns.getRed(&r, green: &g, blue: &b, alpha: &a)
	return (Double(r), Double(g), Double(b), Double(a))
}

private func assertSameColor(
	_ actual: Color, _ expected: Color, _ message: String,
	file: StaticString = #filePath, line: UInt = #line
) {
	let a = rgba(actual)
	let e = rgba(expected)
	XCTAssertEqual(a.0, e.0, accuracy: 0.005, "\(message) red", file: file, line: line)
	XCTAssertEqual(a.1, e.1, accuracy: 0.005, "\(message) green", file: file, line: line)
	XCTAssertEqual(a.2, e.2, accuracy: 0.005, "\(message) blue", file: file, line: line)
	XCTAssertEqual(a.3, e.3, accuracy: 0.005, "\(message) alpha", file: file, line: line)
}

final class FadingTests: XCTestCase {
	// MARK: - Sigil stability and reference vectors

	func testSigilStableForEveryDatasetName() throws {
		let names = try datasetNames()
		XCTAssertGreaterThan(names.count, 100, "dataset should name every agent")
		for name in names {
			XCTAssertEqual(Sigil(name: name), Sigil(name: name), "stable for \(name)")
			XCTAssertEqual(Sigil.hash(name), Sigil.hash(name), "hash stable for \(name)")
		}
	}

	func testSigilMatchesLibMjsOnTenNames() {
		// (name, FNV-1a hash, clamped bits, hue index) from lib.mjs.
		let vectors: [(String, UInt32, UInt8, Int)] = [
			("Halden", 1_086_674_697, 0xA3, 3),
			("Wren", 4_059_929_951, 0xEC, 5),
			("Lark", 3_708_541_597, 0xE6, 1),
			("Cleo", 3_227_243_078, 0x3C, 2),
			("Otter", 1_263_846_601, 0x51, 1),
			("Moss", 1_563_603_059, 0x25, 5),
			("Ember", 3_536_412_132, 0xCF, 0),
			("Thane", 3_390_377_357, 0x2C, 5),
			("Kai", 3_574_614_088, 0xD3, 4),
			("Xen", 451_365_144, 0xF1, 0),
		]
		for (name, hash, bits, hue) in vectors {
			XCTAssertEqual(Sigil.hash(name), hash, "hash \(name)")
			let sigil = Sigil(name: name)
			XCTAssertEqual(sigil.bits, bits, "bits \(name)")
			XCTAssertEqual(sigil.hueIndex, hue, "hue \(name)")
			XCTAssertTrue(
				Theme.agentHues.indices.contains(sigil.hueIndex),
				"hue indexes agentHues for \(name)")
		}
	}

	func testSigilAlwaysHasThreeToSixBitsSet() throws {
		for name in try datasetNames() {
			let count = Sigil(name: name).bits.nonzeroBitCount
			XCTAssertTrue((3 ... 6).contains(count), "\(name) has \(count) bits set")
		}
	}

	func testSigilGridMirrorsLeftToRight() throws {
		for name in try datasetNames() {
			let sigil = Sigil(name: name)
			for row in 0 ..< 4 {
				XCTAssertEqual(
					sigil.isOn(row: row, column: 0), sigil.isOn(row: row, column: 3),
					"mirror 0/3 for \(name) row \(row)")
				XCTAssertEqual(
					sigil.isOn(row: row, column: 1), sigil.isOn(row: row, column: 2),
					"mirror 1/2 for \(name) row \(row)")
			}
		}
	}

	func testSigilIsOnReadsMirroredBitIndex() {
		// Halden bits 0xA3 = 0b10100011: bit0=1 bit1=1 bit2=0 bit3=0
		// bit4=0 bit5=1 bit6=0 bit7=1.
		let sigil = Sigil(name: "Halden")
		XCTAssertEqual(sigil.bits, 0xA3)
		XCTAssertTrue(sigil.isOn(row: 0, column: 0))
		XCTAssertTrue(sigil.isOn(row: 0, column: 1))
		XCTAssertFalse(sigil.isOn(row: 1, column: 0))
		XCTAssertFalse(sigil.isOn(row: 1, column: 1))
		XCTAssertFalse(sigil.isOn(row: 2, column: 0))
		XCTAssertTrue(sigil.isOn(row: 2, column: 1))
		XCTAssertFalse(sigil.isOn(row: 3, column: 0))
		XCTAssertTrue(sigil.isOn(row: 3, column: 1))
	}

	// MARK: - Colour and label tables

	func testMissionStateColors() {
		assertSameColor(CanvasStyle.color(for: MissionState.running), Theme.mint, "running")
		assertSameColor(CanvasStyle.color(for: MissionState.blocked), Theme.amber, "blocked")
		assertSameColor(CanvasStyle.color(for: MissionState.failed), Theme.red, "failed")
		assertSameColor(
			CanvasStyle.color(for: MissionState.readyToClose), Theme.blue, "readyToClose")
		assertSameColor(
			CanvasStyle.color(for: MissionState.mergedNotClosed), Theme.blue,
			"mergedNotClosed")
		assertSameColor(
			CanvasStyle.color(for: MissionState.closed), Theme.textSecondary, "closed")
	}

	func testAgentStateColors() {
		assertSameColor(CanvasStyle.color(for: AgentState.running), Theme.mint, "running")
		assertSameColor(CanvasStyle.color(for: AgentState.blocked), Theme.amber, "blocked")
		assertSameColor(CanvasStyle.color(for: AgentState.failed), Theme.red, "failed")
		assertSameColor(
			CanvasStyle.color(for: AgentState.completed), Theme.green, "completed")
		assertSameColor(
			CanvasStyle.color(for: AgentState.archived), Theme.textSecondary, "archived")
	}

	func testMissionStateLabels() {
		XCTAssertEqual(CanvasStyle.label(for: MissionState.running), "Running")
		XCTAssertEqual(CanvasStyle.label(for: MissionState.blocked), "Blocked")
		XCTAssertEqual(CanvasStyle.label(for: MissionState.failed), "Failed")
		XCTAssertEqual(
			CanvasStyle.label(for: MissionState.readyToClose), "Ready to close")
		XCTAssertEqual(
			CanvasStyle.label(for: MissionState.mergedNotClosed), "Merged · not closed")
		XCTAssertEqual(CanvasStyle.label(for: MissionState.closed), "Closed")
	}

	func testAgentStateLabels() {
		XCTAssertEqual(CanvasStyle.label(for: AgentState.starting), "Starting")
		XCTAssertEqual(CanvasStyle.label(for: AgentState.running), "Running")
		XCTAssertEqual(CanvasStyle.label(for: AgentState.blocked), "Blocked")
		XCTAssertEqual(CanvasStyle.label(for: AgentState.failed), "Failed")
		XCTAssertEqual(CanvasStyle.label(for: AgentState.completed), "Completed")
		XCTAssertEqual(CanvasStyle.label(for: AgentState.interrupted), "Interrupted")
		XCTAssertEqual(CanvasStyle.label(for: AgentState.archived), "Archived")
	}

	// MARK: - Emphasis table

	func testEmphasisTable() {
		let live = [agent(state: .running)]
		XCTAssertEqual(
			CanvasStyle.emphasis(mission: mission(state: .blocked), agents: live), 1.0)
		XCTAssertEqual(
			CanvasStyle.emphasis(mission: mission(state: .failed), agents: live), 1.0)
		XCTAssertEqual(
			CanvasStyle.emphasis(mission: mission(state: .closed), agents: live), 0.55)
		XCTAssertEqual(
			CanvasStyle.emphasis(mission: mission(state: .readyToClose), agents: live),
			0.70)
		XCTAssertEqual(
			CanvasStyle.emphasis(
				mission: mission(state: .mergedNotClosed), agents: live),
			0.70)
		XCTAssertEqual(
			CanvasStyle.emphasis(mission: mission(state: .running), agents: live), 1.0)
	}

	func testBlockedAndFailedStayFullAtThirtyDaysOld() {
		let old = base.addingTimeInterval(-30 * 86_400)
		XCTAssertEqual(
			CanvasStyle.emphasis(mission: mission(state: .blocked, createdAt: old), agents: []),
			1.0)
		XCTAssertEqual(
			CanvasStyle.emphasis(mission: mission(state: .failed, createdAt: old), agents: []),
			1.0)
	}

	func testRunningWithoutLiveAgentsFades() {
		let idle: [Agent] = [agent(state: .completed), agent(state: .failed)]
		XCTAssertEqual(
			CanvasStyle.emphasis(mission: mission(state: .running), agents: idle), 0.70)
		XCTAssertEqual(
			CanvasStyle.emphasis(mission: mission(state: .running), agents: []), 0.70)
		XCTAssertEqual(
			CanvasStyle.emphasis(
				mission: mission(state: .running), agents: [agent(state: .starting)]),
			1.0)
	}

	// MARK: - Contrast floor

	func testFadedSecondaryTextMeetsContrastFloor() {
		for emphasis in [0.55, 0.70, 1.0] {
			let faded = CanvasStyle.text(
				Theme.textSecondary, emphasis: emphasis, over: Theme.nodeFill)
			XCTAssertGreaterThanOrEqual(
				CanvasStyle.contrastRatio(faded, over: Theme.nodeFill),
				CanvasStyle.contrastFloor,
				"faded textSecondary at emphasis \(emphasis)")
		}
	}

	func testContrastFloorValue() {
		XCTAssertEqual(CanvasStyle.contrastFloor, 4.5, accuracy: 1e-9)
	}
}
