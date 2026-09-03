import XCTest

@testable import NetaDesktop

/// T11.3: the Markdown subset the transcript renders, as a pure parser.
final class MarkdownLiteTests: XCTestCase {
	func testTwoParagraphsFromOneBlankLine() {
		XCTAssertEqual(
			MarkdownLite.parse("First.\n\nSecond."),
			[.paragraph([.text("First.")]), .paragraph([.text("Second.")])]
		)
	}

	func testSingleNewlineStaysOneParagraph() {
		XCTAssertEqual(
			MarkdownLite.parse("line one\nline two"),
			[.paragraph([.text("line one\nline two")])]
		)
	}

	func testInlineCodeSpan() {
		XCTAssertEqual(
			MarkdownLite.parse("Hello `code` world."),
			[.paragraph([.text("Hello "), .code("code"), .text(" world.")])]
		)
	}

	func testUnmatchedBacktickStaysLiteral() {
		XCTAssertEqual(
			MarkdownLite.parse("Hello `world"),
			[.paragraph([.text("Hello `world")])]
		)
	}

	func testFenceWithLanguage() {
		XCTAssertEqual(
			MarkdownLite.parse("```swift\nlet x = 1\n```"),
			[.code(language: "swift", text: "let x = 1")]
		)
	}

	func testFenceWithoutLanguage() {
		XCTAssertEqual(
			MarkdownLite.parse("```\nplain\n```"),
			[.code(language: nil, text: "plain")]
		)
	}

	func testUnclosedFenceRunsToEndOfInput() {
		XCTAssertEqual(
			MarkdownLite.parse("```swift\nlet x = 1\nmore"),
			[.code(language: "swift", text: "let x = 1\nmore")]
		)
	}

	func testFenceSpansBlankLines() {
		XCTAssertEqual(
			MarkdownLite.parse("Before\n\n```\ncode\n\nmore code\n```\n\nAfter"),
			[
				.paragraph([.text("Before")]),
				.code(language: nil, text: "code\n\nmore code"),
				.paragraph([.text("After")]),
			]
		)
	}

	func testBulletList() {
		XCTAssertEqual(
			MarkdownLite.parse("- apple\n- banana"),
			[.list(ordered: false, items: [[.text("apple")], [.text("banana")]])]
		)
	}

	func testStarBulletList() {
		XCTAssertEqual(
			MarkdownLite.parse("* apple\n* banana"),
			[.list(ordered: false, items: [[.text("apple")], [.text("banana")]])]
		)
	}

	func testOrderedList() {
		XCTAssertEqual(
			MarkdownLite.parse("1. first\n2. second\n10. tenth"),
			[
				.list(
					ordered: true,
					items: [[.text("first")], [.text("second")], [.text("tenth")]]
				)
			]
		)
	}

	func testListItemInlineCode() {
		XCTAssertEqual(
			MarkdownLite.parse("- run `make test`\n- ship it"),
			[
				.list(
					ordered: false,
					items: [[.text("run "), .code("make test")], [.text("ship it")]]
				)
			]
		)
	}

	func testMixedMarkerBlockIsParagraph() {
		XCTAssertEqual(
			MarkdownLite.parse("- apple\nplain"),
			[.paragraph([.text("- apple\nplain")])]
		)
	}

	func testImageSyntaxStaysLiteral() {
		XCTAssertEqual(
			MarkdownLite.parse("![alt](https://example.com/img.png)"),
			[.paragraph([.text("![alt](https://example.com/img.png)")])]
		)
	}

	func testEmphasisAndLinksStayLiteral() {
		XCTAssertEqual(
			MarkdownLite.parse("**bold** and [link](https://example.com)"),
			[.paragraph([.text("**bold** and [link](https://example.com)")])]
		)
	}

	func testCrlfEqualsLf() {
		XCTAssertEqual(
			MarkdownLite.parse("First.\r\n\r\nSecond."),
			MarkdownLite.parse("First.\n\nSecond.")
		)
		XCTAssertEqual(
			MarkdownLite.parse("- a\r\n- b"),
			MarkdownLite.parse("- a\n- b")
		)
	}

	func testEmptyInputParsesToNoBlocks() {
		XCTAssertEqual(MarkdownLite.parse(""), [])
		XCTAssertEqual(MarkdownLite.parse("\n\n   \n"), [])
	}
}
