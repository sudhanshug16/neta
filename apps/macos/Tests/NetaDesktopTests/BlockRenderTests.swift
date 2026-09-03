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
}
