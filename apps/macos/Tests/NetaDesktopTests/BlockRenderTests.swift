import Foundation
import XCTest

@testable import NetaDesktop

/// T11.4: block and turn rendering — the pure parts (`BlockStyle.of` and
/// the `BlockText` helpers). `BlockView`/`TurnView` compose these with
/// `Theme` and `MarkdownLite`, which their own suites cover.
final class BlockRenderTests: XCTestCase {
	private func block(
		kind: BlockKind, role: Role = .agent, text: String = "",
		data: [String: DataValue]? = nil
	) -> Block {
		Block(
			turnId: "t1", seq: 0, at: Date(timeIntervalSince1970: 0),
			role: role, kind: kind, text: text, data: data)
	}

	// MARK: - BlockStyle.of

	func testStyleOfAllKindsForBothRoles() {
		let roles: [Role] = [.user, .agent]
		for role in roles {
			XCTAssertEqual(
				BlockStyle.of(kind: .text, role: role),
				BlockStyle(size: 12.5, weight: .regular, mono: false, secondary: false, alignment: .leading))
			XCTAssertEqual(
				BlockStyle.of(kind: .thought, role: role),
				BlockStyle(size: 12.5, weight: .regular, mono: false, secondary: true, alignment: .leading))
			XCTAssertEqual(
				BlockStyle.of(kind: .tool, role: role),
				BlockStyle(size: 12.5, weight: .medium, mono: false, secondary: false, alignment: .leading))
			XCTAssertEqual(
				BlockStyle.of(kind: .diff, role: role),
				BlockStyle(size: 11.5, weight: .regular, mono: true, secondary: false, alignment: .leading))
			XCTAssertEqual(
				BlockStyle.of(kind: .status, role: role),
				BlockStyle(size: 10, weight: .medium, mono: false, secondary: true, alignment: .center))
		}
	}

	func testStatusStyleIsCentredSecondary() {
		for role: Role in [.user, .agent] {
			let style = BlockStyle.of(kind: .status, role: role)
			XCTAssertEqual(style.alignment, .center)
			XCTAssertTrue(style.secondary)
			XCTAssertEqual(style.size, 10)
			XCTAssertEqual(style.weight, .medium)
		}
	}

	func testDiffStyleIsMono() {
		for role: Role in [.user, .agent] {
			XCTAssertTrue(BlockStyle.of(kind: .diff, role: role).mono)
			XCTAssertFalse(BlockStyle.of(kind: .text, role: role).mono)
		}
	}

	// MARK: - thoughtSummary

	func testThoughtSummaryShortTextUnchanged() {
		XCTAssertEqual(BlockText.thoughtSummary("Considering options."), "Considering options.")
	}

	func testThoughtSummaryTruncatesOnWordBoundary() {
		let text = "The quick brown fox jumps over the lazy dog near the riverbank"
		let summary = BlockText.thoughtSummary(text, limit: 20)
		XCTAssertTrue(summary.hasSuffix("…"))
		XCTAssertLessThanOrEqual(summary.count, 21)
		// Cut at the last word boundary at or before the limit: "The quick brown fox" is
		// 19 chars, so the summary is exactly that plus the ellipsis.
		XCTAssertEqual(summary, "The quick brown fox…")
	}

	func testThoughtSummaryHardCutsOneLongWord() {
		XCTAssertEqual(BlockText.thoughtSummary("abcdefghij", limit: 4), "abcd…")
	}

	func testThoughtSummaryCollapsesNewlines() {
		XCTAssertEqual(
			BlockText.thoughtSummary("line one\nline two\n\nline three"),
			"line one line two line three")
	}

	func testThoughtSummaryCustomLimit() {
		let summary = BlockText.thoughtSummary("one two three four five", limit: 9)
		XCTAssertEqual(summary, "one two…")
	}

	// MARK: - toolTitle / toolDetail

	func testToolDetailNilForMissingData() {
		XCTAssertNil(BlockText.toolDetail(block(kind: .tool, text: "Read")))
	}

	func testToolDetailNilForEmptyData() {
		XCTAssertNil(BlockText.toolDetail(block(kind: .tool, text: "Read", data: [:])))
	}

	func testToolDetailSortedKeyValueLines() {
		let b = block(kind: .tool, text: "Read", data: [
			"path": .string("/tmp/x"),
			"name": .string("Read"),
			"retries": .number(2),
			"follow": .bool(true),
			"note": .null,
		])
		XCTAssertEqual(
			BlockText.toolDetail(b),
			"follow: true\nname: Read\nnote: null\npath: /tmp/x\nretries: 2")
	}

	func testToolTitlePrefersNameDatum() {
		let b = block(kind: .tool, text: "first line\nsecond", data: ["name": .string("Read")])
		XCTAssertEqual(BlockText.toolTitle(b), "Read")
	}

	func testToolTitleFallsBackToFirstLine() {
		let b = block(kind: .tool, text: "\n  first line\nsecond")
		XCTAssertEqual(BlockText.toolTitle(b), "first line")
	}

	func testToolTitleFallsBackToPlaceholder() {
		XCTAssertEqual(BlockText.toolTitle(block(kind: .tool, text: "  \n ")), "Tool call")
	}

	// MARK: - diffLines

	func testDiffLinesClassify() {
		let lines = BlockText.diffLines("@@ -1,2 +1,2 @@\n context\n+added\n-removed")
		XCTAssertEqual(lines, [
			DiffLine(kind: .meta, text: "@@ -1,2 +1,2 @@"),
			DiffLine(kind: .context, text: " context"),
			DiffLine(kind: .added, text: "+added"),
			DiffLine(kind: .removed, text: "-removed"),
		])
	}

	func testDiffLinesFileHeadersAreMeta() {
		let lines = BlockText.diffLines("--- a/file\n+++ b/file\n+body")
		XCTAssertEqual(lines.map(\.kind), [.meta, .meta, .added])
	}

	func testDiffLinesEmptyTextIsEmpty() {
		XCTAssertEqual(BlockText.diffLines(""), [])
	}

	func testDiffLinesBareContextLine() {
		let lines = BlockText.diffLines("unchanged")
		XCTAssertEqual(lines, [DiffLine(kind: .context, text: "unchanged")])
	}

	// MARK: - TurnView bubbles

	/// PAPER-SPINE Revision 3 surface 2: user bubbles violet glass at 0.35
	/// with the rim, agent bubbles white at 0.06. The tree carried 0.25 and
	/// the 0.045 `subtleSurface` instead. The tones are tokens, never
	/// literals restated in the view.
	func testTurnBubblesTakeTheirTonesFromGlass() throws {
		let source = try turnViewSource()
		XCTAssertTrue(
			source.contains("tint: Theme.Glass.userBubble"), "user bubble is violet 0.35")
		XCTAssertTrue(
			source.contains("Theme.Glass.agentBubble"), "agent bubble is white 0.06")
		XCTAssertFalse(source.contains("Theme.subtleSurface"), "0.045 is not the bubble tone")
		XCTAssertFalse(source.contains("opacity(0.25)"), "no restated literal")
		// A bubble is content inside the chat panel, so it draws on the
		// nested `.rounded(_)` radius and never takes the outer shadow.
		XCTAssertFalse(source.contains("netaFloatingGlass"), "bubbles sit on the chat panel")
		XCTAssertTrue(source.contains("netaGlass(.rounded("), "bubbles use the nested radius")
	}

	/// The Node opens ONE turn with role `user` and files the agent's reply
	/// into it as further blocks (seq 1 role user, seq 2 role agent, verified
	/// on the wire), so a bubble styled by `turn.role` drew the leader's
	/// answer inside the person's violet bubble. Runs follow the blocks'
	/// own roles.
	func testBlocksSplitIntoRunsByTheirOwnRole() {
		let at = Date(timeIntervalSince1970: 1_780_315_200)
		func block(_ seq: Int, _ role: Role, _ text: String) -> Block {
			Block(
				turnId: "t1", seq: seq, at: at, role: role, kind: .text,
				text: text, data: nil)
		}
		let runs = TurnView.runs(of: [
			block(1, .user, "Where are we this morning?"),
			block(2, .agent, "First paragraph continues."),
			block(3, .agent, "Second paragraph."),
			block(4, .user, "Void them."),
		])
		XCTAssertEqual(runs.map(\.role), [.user, .agent, .user])
		XCTAssertEqual(runs.map { $0.blocks.map(\.seq) }, [[1], [2, 3], [4]])
		XCTAssertEqual(runs.map(\.id), [1, 2, 4])
		XCTAssertEqual(TurnView.runs(of: []).count, 0)
	}

	/// And the view styles the run, not the turn.
	func testTurnViewStylesEachRunByItsOwnRole() throws {
		let source = try turnViewSource()
		XCTAssertFalse(
			source.contains("turn.role =="),
			"a bubble follows its blocks' roles, never the turn's")
		XCTAssertTrue(source.contains("run.role == .user"))
	}

	private func turnViewSource() throws -> String {
		var url = URL(fileURLWithPath: #filePath, isDirectory: false)
			.deletingLastPathComponent()
		url.deleteLastPathComponent()
		url.deleteLastPathComponent()
		url.appendPathComponent("Sources/NetaDesktop/Chat/TurnView.swift")
		return try String(contentsOf: url, encoding: .utf8)
	}
}
