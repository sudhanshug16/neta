import Testing
import AppKit
import Foundation
import SwiftUI
@testable import AgentChatKit

@Test func parsesStreamingUnclosedFence() {
	#expect(AgentMarkdownParser.parse("Done\n```swift\nlet answer = 42") == [
		.paragraph("Done"), .code("swift", "let answer = 42")
	])
}

@Test func markdownKeepsLiteralHashesAndChecklistTextWhileJoiningContinuation() {
	#expect(AgentMarkdownParser.parse("#include <x>\ncontinues\n\n- [x] done\n  with evidence\n- [abc] literal") == [
		.paragraph("#include <x>\ncontinues"),
		.list([
			.init(depth: 0, marker: .unordered, text: "[x] done\nwith evidence"),
			.init(depth: 0, marker: .unordered, text: "[abc] literal"),
		]),
	])
}

@Test func markdownPreservesNestedListDepthMarkersContinuationAndOrderedStarts() {
	#expect(AgentMarkdownParser.parse("7. seventh\n   continued\n  - child\n    3. nested ordered\n8. eighth") == [
		.list([
			.init(depth: 0, marker: .ordered(7), text: "seventh\ncontinued"),
			.init(depth: 1, marker: .unordered, text: "child"),
			.init(depth: 2, marker: .ordered(3), text: "nested ordered"),
			.init(depth: 0, marker: .ordered(8), text: "eighth"),
		]),
	])
}

@Test func markdownFencesMatchCharacterAndAtLeastOpeningLength() {
	#expect(AgentMarkdownParser.parse("   ````swift\nlet fence = ```\n```\n````") == [
		.code("swift", "let fence = ```\n```")
	])
	#expect(AgentMarkdownParser.parse("~~~text\n``` stays content\n~~~~") == [
		.code("text", "``` stays content")
	])
	#expect(AgentMarkdownParser.parse("````\nstreaming ``` remains") == [
		.code(nil, "streaming ``` remains")
	])
}

@Test func markdownNormalizesEscapedPipeTableRows() {
	#expect(AgentMarkdownParser.parse("| Name | State |\n| --- | --- |\n| one\\|two | ready | extra |\n| short |") == [
		.table(["Name", "State"], [["one|two", "ready"], ["short", ""]]),
	])
}

@Test func markdownTableKeepsLiteralBackslashesAndRejectsInvalidRules() {
	#expect(AgentMarkdownParser.parse("| Path | Pattern |\n| --- | --- |\n| C:\\Users | \\\\d+ \\| word |") == [
		.table(["Path", "Pattern"], [["C:\\Users", "\\d+ | word"]]),
	])
	#expect(!AgentMarkdownParser.parse("name | state\n- | -\nvalue | ready").contains { if case .table = $0 { return true }; return false })
}

@Test func usageIsCompact() {
	let usage = AgentUsage(inputTokens: 12_450, outputTokens: 982, cachedTokens: 8_000)
	#expect(usage.summary.contains("K in"))
	#expect(usage.summary.contains("982 out"))
	#expect(!usage.summary.contains("inputTokens"))
}

@Test func progressHasNativeUserFacingLabels() {
	#expect(AgentResponseProgress.preparing.label == "Preparing…")
	#expect(AgentResponseProgress.streaming.label == "Responding…")
	#expect(AgentResponseProgress.idle.label == nil)
}

@Test @MainActor func nativeGalleryRendersAtNarrowAndWideWidths() throws {
	let blocks = [
		AgentChatBlock(id: "markdown", role: .agent, kind: .markdown, text: "# Result\n\nA **native** response.\n\n| Item | State |\n| --- | --- |\n| very-long-source-link-that-must-scroll-without-changing-source | Ready |\n\n```swift\nlet answer = veryLongIdentifierThatMustRemainExactlyCopyableWithoutWrappingOrTruncation\n```"),
		AgentChatBlock(id: "tool", role: .agent, kind: .tool, title: "Read workspace", detail: "path: /workspace", toolState: .running),
		AgentChatBlock(id: "plan", role: .agent, kind: .plan, text: "- [x] Inspect\n- [ ] Verify"),
		AgentChatBlock(id: "usage", role: .agent, kind: .usage, usage: AgentUsage(inputTokens: 12_450, outputTokens: 982, cachedTokens: 8_000)),
		AgentChatBlock(id: "file", role: .user, kind: .attachment, attachment: AgentAttachment(name: "very-long-attachment-name-that-must-stay-contained-in-a-narrow-reader-panel.pdf", mimeType: "application/pdf", size: 42_000)),
	]
	for width in [410.0, 720.0] {
		let view = VStack(alignment: .leading, spacing: 12) {
			ForEach(blocks) { AgentMessageBlockView(block: $0, expanded: .constant(true)) }
			AgentGlanceCardView(
				card: AgentGlanceCard(
					id: "recap", actor: "Halden", date: Date(), interrupted: true,
					kind: .onDeviceSummary(headline: "Reader update", bullets: ["A decision changed", "One review remains"])),
				expanded: .constant(true), onOpenSource: {}, onMarkReviewed: {})
			AgentProgressView(.preparing)
			Spacer()
		}.padding().frame(width: width, height: 720).background(Color.white).environment(\.colorScheme, .light)
		let renderer = ImageRenderer(content: view)
		renderer.scale = 1
		let image = try #require(renderer.cgImage)
		#expect(image.width == Int(width))
		#expect(image.height == 720)
		if let directory = ProcessInfo.processInfo.environment["AGENT_CHAT_GALLERY_DIR"] {
			let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
			try data?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("agent-chat-\(Int(width)).png"))
		}
	}
}

@Test @MainActor func nativeCodeAndTableExposeRealHorizontalScrollRanges() async throws {
	let source = """
		| Column | Detail |
		| --- | --- |
		| Runtime | \(String(repeating: "wide-table-value-", count: 12)) |

		```swift
		let exactCopySource = "\(String(repeating: "abcdefghijklmnopqrstuvwxyz", count: 8))"
		```
		"""
	let host = NSHostingView(rootView: AgentMarkdownView(source).frame(width: 410))
	host.frame = NSRect(x: 0, y: 0, width: 410, height: 300)
	let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
	window.animationBehavior = .none
	window.contentView = host
	window.orderFrontRegardless()
	defer { window.orderOut(nil); window.contentView = nil }
	try await Task.sleep(for: .milliseconds(100))
	host.layoutSubtreeIfNeeded()
	host.displayIfNeeded()
	let scrollViews = descendants(of: host).compactMap { $0 as? NSScrollView }
		.filter { scroll in
			guard let document = scroll.documentView else { return false }
			return document.bounds.width > scroll.contentView.bounds.width + 1
		}
	#expect(scrollViews.count >= 2)
	for scroll in scrollViews {
		let before = scroll.contentView.bounds.origin.x
		let maximum = max(0, (scroll.documentView?.bounds.maxX ?? 0) - scroll.contentView.bounds.width)
		scroll.contentView.scroll(to: NSPoint(x: maximum, y: 0))
		scroll.reflectScrolledClipView(scroll.contentView)
		#expect(scroll.contentView.bounds.origin.x > before)
	}
}

@MainActor private func descendants(of view: NSView) -> [NSView] {
	view.subviews + view.subviews.flatMap(descendants(of:))
}
