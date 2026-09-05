import AgentChatKit
import AppKit
import FoundationModels
import SwiftUI
import XCTest

@testable import NetaDesktop

private actor GlanceStub: NodeClient {
    private var stored: [GlanceCard]
    private let sources: [String: GlanceSource]
    private var completions = 0
	private var marks: [Int] = []
    private let stream: AsyncStream<NodeNotification>
    private let continuation: AsyncStream<NodeNotification>.Continuation
    nonisolated var notifications: AsyncStream<NodeNotification> { stream }
    init(cards: [GlanceCard], sources: [String: GlanceSource]) {
        stored = cards; self.sources = sources
        let pair = AsyncStream<NodeNotification>.makeStream()
        stream = pair.stream; continuation = pair.continuation
    }
    func connect() async throws {}
    func snapshot() async throws -> Snapshot { throw NodeClientError.disconnected }
    func missionsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Mission] { [] }
    func eventsList(workspaceId: String, before: Date?, limit: Int) async throws -> [Event] { [] }
    func conversationTail(sessionId: Ulid, cursor: String?, limit: Int, direction: String?, turnId: TurnId?) async throws -> ConversationPage { .init(turns: [], blocks: [], nextCursor: nil, prevCursor: nil) }
    func prompt(sessionId: Ulid, text: String) async throws -> Ulid { "turn" }
    func cancel(sessionId: Ulid) async throws {}
    func setModel(sessionId: Ulid, model: String) async throws {}
    func listModels(provider: String) async throws -> [ModelInfo] { [] }
    func listModels(sessionId: Ulid) async throws -> [ModelInfo] { [] }
    func setMode(workspaceId: String, mode: LeaderMode) async throws {}
    func pin(missionId: Ulid, pinned: Bool) async throws {}
    func archiveAgent(agentId: Ulid, confirmRunning: Bool) async throws {}
    func openWorkspace(path: String) async throws -> Workspace { throw NodeClientError.disconnected }
    func glanceList(workspaceId: String, after: Int, limit: Int) async throws -> GlancePage {
        let values = stored.filter { $0.workspaceId == workspaceId && $0.glanceSeq > after }
        return .init(cards: Array(values.prefix(limit)), reviewedThroughGlanceSeq: 0, hasMore: values.count > limit)
    }
    func glanceSource(workspaceId: String, id: String) async throws -> GlanceSource {
        guard let source = sources[id] else { throw NodeClientError.rpc(code: -1, message: "missing") }
        return source
    }
    func glanceComplete(workspaceId: String, id: String, sourceHash: String, result: GlanceResult) async throws -> GlanceCard {
        guard let index = stored.firstIndex(where: { $0.id == id && $0.sourceHash == sourceHash }) else { throw NodeClientError.rpc(code: -1, message: "stale") }
        let old = stored[index]
        let updated = GlanceCard(id: old.id, workspaceId: old.workspaceId, glanceSeq: old.glanceSeq, at: old.at, sessionId: old.sessionId, turnId: old.turnId, sourceHash: old.sourceHash, preview: old.preview, sourceTruncated: old.sourceTruncated, interrupted: old.interrupted, actorKind: old.actorKind, missionId: old.missionId, agentId: old.agentId, agentLabel: old.agentLabel, result: result)
        stored[index] = updated; completions += 1; return updated
    }
	func glanceMarkReviewed(workspaceId: String, through: Int) async throws -> Int { marks.append(through); return through }
	func completionCount() -> Int { completions }
	func marked() -> [Int] { marks }
    func emit(_ change: GlanceChange) { continuation.yield(.glance(change)) }
}

private struct SlowGlanceSummarizer: GlanceSummarizer {
	func summarize(_ source: String) async -> GlanceResult {
		try? await Task.sleep(for: .seconds(2))
		return .excerptFallback(excerpt: source, reason: "generationFailed")
	}
}

private struct FixtureGlanceSummarizer: GlanceSummarizer {
    func summarize(_ source: String) async -> GlanceResult { .onDeviceSummary(headline: "Decision recorded", bullets: [source], schemaVersion: 1) }
}

@MainActor final class GlanceTests: XCTestCase {
    private func card(_ id: String = "g1", seq: Int = 1, truncated: Bool = false, result: GlanceResult? = nil) -> GlanceCard {
        GlanceCard(id: id, workspaceId: "w", glanceSeq: seq, at: Date(timeIntervalSince1970: 1), sessionId: "old-session", turnId: "turn-1", sourceHash: "hash-\(id)", preview: "Visible while preparing", sourceTruncated: truncated, interrupted: false, actorKind: "leader", missionId: nil, agentId: nil, agentLabel: "Halden", result: result)
    }
    func testPendingCardCompletesOnceAndReviewIsExplicit() async throws {
        let value = card(); let source = GlanceSource(id: value.id, sourceHash: value.sourceHash, source: "Kept the selected approach.", sourceTruncated: false)
        let client = GlanceStub(cards: [value], sources: [value.id: source]); let model = GlanceViewModel(client: client, workspaceId: "w", summarizer: FixtureGlanceSummarizer())
        await model.start(); XCTAssertEqual(model.unread.count, 1)
        for _ in 0..<30 { if await client.completionCount() > 0 { break }; try await Task.sleep(for: .milliseconds(10)) }
        let completionCount = await client.completionCount()
        XCTAssertEqual(completionCount, 1)
        guard case .onDeviceSummary(let headline, _, _)? = model.cards.first?.result else { return XCTFail("missing summary") }; XCTAssertEqual(headline, "Decision recorded")
        await model.openSource(value); XCTAssertEqual(model.openedSource?.card.sessionId, "old-session"); XCTAssertEqual(model.reviewedThrough, 0)
        await model.markCaughtUp(); XCTAssertTrue(model.unread.isEmpty)
    }
    func testTruncatedSourceUsesTruthfulFallback() async throws {
        let value = card(truncated: true); let client = GlanceStub(cards: [value], sources: [:]); let model = GlanceViewModel(client: client, workspaceId: "w", summarizer: FixtureGlanceSummarizer())
        await model.start(); for _ in 0..<30 { if await client.completionCount() > 0 { break }; try await Task.sleep(for: .milliseconds(10)) }
        guard case .excerptFallback(let excerpt, let reason)? = model.cards.first?.result else { return XCTFail("missing fallback") }; XCTAssertEqual(excerpt, value.preview); XCTAssertEqual(reason, "sourceTooLarge")
    }
    func testNativeCardLaysOutAtReaderWidths() {
        for width in [410.0, 720.0] {
            let view = AgentGlanceCardView(card: .init(id: "fixture", actor: "Halden", date: Date(), kind: .onDeviceSummary(headline: "Three files changed", bullets: ["Tests pass", "Review remains"])), expanded: .constant(true), onOpenSource: {}, onMarkReviewed: {}).frame(width: width)
            let host = NSHostingView(rootView: view); host.frame = NSRect(x: 0, y: 0, width: width, height: 300); host.layoutSubtreeIfNeeded(); XCTAssertGreaterThan(host.fittingSize.height, 80); XCTAssertGreaterThan(host.fittingSize.width, 300)
            XCTAssertLessThanOrEqual(host.fittingSize.width, width)
        }
    }
    func testFoundationModelsUnavailableIsHonestExcerpt() async {
        guard case .unavailable = SystemLanguageModel.default.availability else { return }
        let result = await FoundationModelsGlanceSummarizer().summarize("A concrete source message")
        guard case .excerptFallback(let excerpt, let reason) = result else { return XCTFail("must not claim generated output") }; XCTAssertEqual(excerpt, "A concrete source message"); XCTAssertEqual(reason, "unavailable")
    }

    func testCompletionNotificationDoesNotDiscardLoadedSecondPage() async {
        let result = GlanceResult.excerptFallback(excerpt: "saved", reason: "unavailable")
        let values = (1...101).map { card("g\($0)", seq: $0, result: result) }
        let client = GlanceStub(cards: values, sources: [:])
        let model = GlanceViewModel(client: client, workspaceId: "w", summarizer: FixtureGlanceSummarizer())
        await model.start()
        XCTAssertEqual(model.cards.count, 100)
        await model.loadMore()
        XCTAssertEqual(model.cards.count, 101)
        let updated = card("g1", seq: 1, result: .onDeviceSummary(headline: "Updated", bullets: [], schemaVersion: 1))
        await client.emit(.init(card: updated, workspaceId: nil, reviewedThroughGlanceSeq: nil))
        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(model.cards.count, 101)
        XCTAssertTrue(model.cards.contains { $0.id == "g101" })
    }

    func testFoundationModelChunksBoundUTF8AndRetainEveryScalar() {
        let source = String(repeating: " निर्णय🙂", count: 2_000)
        let chunks = FoundationModelsGlanceSummarizer.boundedChunks(source)
        XCTAssertEqual(chunks.joined(), source)
        XCTAssertTrue(chunks.allSatisfy { $0.utf8.count <= FoundationModelsGlanceSummarizer.promptByteBudget })
        let reduced = FoundationModelsGlanceSummarizer.reductionGroups(chunks.map { _ in String(repeating: "x", count: 200) })
        XCTAssertLessThan(reduced.count, chunks.count)
        XCTAssertTrue(reduced.allSatisfy { $0.joined(separator: "\n\n").utf8.count <= FoundationModelsGlanceSummarizer.promptByteBudget })
    }

	func testLiveCardDoesNotSkipPaginationGapOrReviewIt() async {
		let result = GlanceResult.excerptFallback(excerpt: "saved", reason: "unavailable")
		let values = (1...201).map { card("g\($0)", seq: $0, result: result) }
		let client = GlanceStub(cards: values, sources: [:])
		let model = GlanceViewModel(client: client, workspaceId: "w", summarizer: FixtureGlanceSummarizer())
		await model.start()
		await client.emit(.init(card: values[200], workspaceId: nil, reviewedThroughGlanceSeq: nil))
		try? await Task.sleep(for: .milliseconds(20))
		await model.mark(through: 201)
		let firstMarks = await client.marked()
		XCTAssertEqual(firstMarks, [100])
		await model.loadMore()
		XCTAssertTrue(model.cards.contains { $0.glanceSeq == 101 })
		XCTAssertTrue(model.cards.contains { $0.glanceSeq == 200 })
	}

	func testContiguousLiveCardCanBeReviewed() async {
		let result = GlanceResult.excerptFallback(excerpt: "saved", reason: "unavailable")
		let values = (1...100).map { card("g\($0)", seq: $0, result: result) }
		let client = GlanceStub(cards: values, sources: [:])
		let model = GlanceViewModel(client: client, workspaceId: "w", summarizer: FixtureGlanceSummarizer())
		await model.start()
		let live = card("g101", seq: 101, result: result)
		await client.emit(.init(card: live, workspaceId: nil, reviewedThroughGlanceSeq: nil))
		try? await Task.sleep(for: .milliseconds(20))
		await model.mark(through: 101)
		let marks = await client.marked()
		XCTAssertEqual(marks, [101])
	}

	func testStoppingPendingSummaryNeverCompletesFallback() async throws {
		let value = card()
		let source = GlanceSource(id: value.id, sourceHash: value.sourceHash, source: "slow", sourceTruncated: false)
		let client = GlanceStub(cards: [value], sources: [value.id: source])
		let model = GlanceViewModel(client: client, workspaceId: "w", summarizer: SlowGlanceSummarizer())
		await model.start()
		try await Task.sleep(for: .milliseconds(50))
		model.stop()
		try await Task.sleep(for: .milliseconds(100))
		let completions = await client.completionCount()
		XCTAssertEqual(completions, 0)
	}
}
