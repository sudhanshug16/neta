import AgentChatKit
import Foundation
import FoundationModels
import Observation

public protocol GlanceSummarizer: Sendable {
    func summarize(_ source: String) async -> GlanceResult
}

@Generable(description: "A concise, faithful recap of one assistant response.")
private struct GeneratedGlanceSummary {
    @Guide(description: "A factual headline under 12 words.")
    var headline: String
    @Guide(description: "Zero to three concise factual bullets. Preserve uncertainty and pending status.")
    var bullets: [String]
}

public actor FoundationModelsGlanceSummarizer: GlanceSummarizer {
    // Foundation Models does not expose its tokenizer. A token cannot contain
    // less than one UTF-8 byte, so this byte ceiling is a conservative upper
    // bound on tokens, including emoji and multilingual text.
    static let promptByteBudget = 2_800
    private static let maximumChunks = 128
    private static let maximumReductionPasses = 8

    public init() {}

    public func summarize(_ source: String) async -> GlanceResult {
        guard case .available = SystemLanguageModel.default.availability else {
            return .excerptFallback(excerpt: Self.excerpt(source), reason: "unavailable")
        }
        do {
            var inputs = Self.boundedChunks(source)
            guard !inputs.isEmpty, inputs.count <= Self.maximumChunks else { throw SummaryError.sourceTooLarge }
            if inputs.count > 1 {
                var summarized: [String] = []
                for input in inputs {
                    try Task.checkCancellation()
                    summarized.append(Self.normalizedText(try await generated(for: input)))
                    try Task.checkCancellation()
                }
                inputs = summarized
            }
            var passes = 0
            while inputs.count > 1 {
                guard passes < Self.maximumReductionPasses else { throw SummaryError.sourceTooLarge }
                passes += 1
                var next: [String] = []
                for group in Self.reductionGroups(inputs) {
                    try Task.checkCancellation()
                    if group.count == 1 { next.append(group[0]) }
                    else { next.append(Self.normalizedText(try await generated(for: group.joined(separator: "\n\n")))) }
                    try Task.checkCancellation()
                }
                guard next.count < inputs.count else { throw SummaryError.invalid }
                inputs = next
            }
            let summary = try await generated(for: inputs[0])
            return .onDeviceSummary(
                headline: Self.byteClipped(summary.headline, limit: 160),
                bullets: Array(summary.bullets.prefix(3)).map { Self.byteClipped($0, limit: 300) },
                schemaVersion: 1
            )
        } catch SummaryError.sourceTooLarge {
            return .excerptFallback(excerpt: Self.excerpt(source), reason: "sourceTooLarge")
        } catch {
            return .excerptFallback(excerpt: Self.excerpt(source), reason: "generationFailed")
        }
    }

    private func generated(for source: String) async throws -> (headline: String, bullets: [String]) {
        let session = LanguageModelSession(
            instructions: "Summarize only facts in the supplied assistant response. Never infer completion, status, decisions, or urgency. Preserve proposals, uncertainty, and interruptions."
        )
        let response = try await session.respond(to: source, generating: GeneratedGlanceSummary.self)
        let headline = response.content.headline.trimmingCharacters(in: .whitespacesAndNewlines)
        let bullets = response.content.bullets.prefix(3).map {
			Self.byteClipped($0, limit: 300)
        }.filter { !$0.isEmpty }
        guard !headline.isEmpty else { throw SummaryError.invalid }
        return (Self.byteClipped(headline, limit: 160), bullets)
    }

    private static func normalizedText(_ value: (headline: String, bullets: [String])) -> String {
        return ([value.headline] + value.bullets.map { "• \($0)" }).joined(separator: "\n")
    }

    static func byteClipped(_ value: String, limit: Int) -> String {
        var result = ""
        var bytes = 0
        for scalar in value.unicodeScalars {
            let part = String(scalar)
            guard bytes + part.utf8.count <= limit else { break }
            result.append(part); bytes += part.utf8.count
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func boundedChunks(_ source: String) -> [String] {
        var chunks: [String] = []
        var current = ""
        var bytes = 0
        for scalar in source.unicodeScalars {
            let text = String(scalar)
            let size = text.utf8.count
            if bytes + size > promptByteBudget, !current.isEmpty {
                chunks.append(current)
                current = ""
                bytes = 0
            }
            current.append(text)
            bytes += size
        }
        if !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { chunks.append(current) }
        return chunks
    }

    static func reductionGroups(_ inputs: [String]) -> [[String]] {
        var result: [[String]] = []
        var group: [String] = []
        var count = 0
        for input in inputs {
            let size = input.utf8.count + 2
            if !group.isEmpty && count + size > promptByteBudget {
                result.append(group)
                group = []
                count = 0
            }
            group.append(input)
            count += size
        }
        if !group.isEmpty { result.append(group) }
        return result
    }

    private static func excerpt(_ source: String) -> String {
		byteClipped(source.trimmingCharacters(in: .whitespacesAndNewlines), limit: 1_200)
    }

    private enum SummaryError: Error { case invalid, sourceTooLarge }
}

public struct OpenedGlanceSource: Identifiable, Sendable {
    public let card: GlanceCard
    public let source: GlanceSource
    public var id: String { card.id }
}

@MainActor @Observable public final class GlanceViewModel {
    private let client: any NodeClient
    public let workspaceId: String
    private let summarizer: any GlanceSummarizer
    private var streamTask: Task<Void, Never>?
    private var summaryTask: Task<Void, Never>?
    private var summaryRequested = false
    private var nextCursor = 0
    private var changeGeneration = 0

    public private(set) var cards: [GlanceCard] = []
    public private(set) var reviewedThrough = 0
    public private(set) var hasMore = false
    public private(set) var error: String?
    public private(set) var openedSource: OpenedGlanceSource?

    public init(
        client: any NodeClient,
        workspaceId: String,
        summarizer: any GlanceSummarizer = FoundationModelsGlanceSummarizer()
    ) {
        self.client = client
        self.workspaceId = workspaceId
        self.summarizer = summarizer
    }

    public var unread: [GlanceCard] {
        cards.filter { $0.glanceSeq > reviewedThrough }.sorted { $0.glanceSeq < $1.glanceSeq }
    }

    public func start() async {
        guard !workspaceId.isEmpty else { return }
        streamTask?.cancel()
        let notifications = client.notifications
        streamTask = Task { [weak self] in
            for await note in notifications {
                guard let self else { return }
                guard case .glance(let change) = note else { continue }
                let changedWorkspace = change.card?.workspaceId ?? change.workspaceId
                if changedWorkspace == nil || changedWorkspace == self.workspaceId {
                    self.apply(change)
                }
            }
        }
        await reload()
    }

    public func stop() {
        streamTask?.cancel()
        summaryTask?.cancel()
    }

    public func reload() async {
        let requestedAt = changeGeneration
        do {
            let page = try await client.glanceList(workspaceId: workspaceId, after: 0, limit: 100)
            if requestedAt == changeGeneration {
                cards = page.cards
            } else {
                merge(page.cards)
            }
            reviewedThrough = max(reviewedThrough, page.reviewedThroughGlanceSeq)
            cards.removeAll { $0.glanceSeq <= reviewedThrough }
            cards.sort { $0.glanceSeq < $1.glanceSeq }
            hasMore = page.hasMore
            nextCursor = page.cards.last?.glanceSeq ?? reviewedThrough
            error = nil
            requestSummaries()
        } catch {
            self.error = error.localizedDescription
        }
    }

    public func loadMore() async {
        guard hasMore else { return }
        do {
            let page = try await client.glanceList(workspaceId: workspaceId, after: nextCursor, limit: 100)
            merge(page.cards)
            cards.sort { $0.glanceSeq < $1.glanceSeq }
            reviewedThrough = max(reviewedThrough, page.reviewedThroughGlanceSeq)
            hasMore = page.hasMore
            nextCursor = page.cards.last?.glanceSeq ?? nextCursor
            error = nil
            requestSummaries()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func apply(_ change: GlanceChange) {
        changeGeneration += 1
        if let card = change.card {
            merge([card])
            if card.glanceSeq > nextCursor + 1 { hasMore = true }
            while cards.contains(where: { $0.glanceSeq == nextCursor + 1 }) { nextCursor += 1 }
        }
        if let cursor = change.reviewedThroughGlanceSeq {
            reviewedThrough = max(reviewedThrough, cursor)
            cards.removeAll { $0.glanceSeq <= reviewedThrough }
        }
        cards.sort { $0.glanceSeq < $1.glanceSeq }
        requestSummaries()
    }

    private func merge(_ incoming: [GlanceCard]) {
        var byId = Dictionary(uniqueKeysWithValues: cards.map { ($0.id, $0) })
        for card in incoming where card.glanceSeq > reviewedThrough { byId[card.id] = card }
        cards = Array(byId.values)
    }

    private func requestSummaries() {
        summaryRequested = true
        guard summaryTask == nil else { return }
        summaryTask = Task { [weak self] in
            guard let self else { return }
            while self.summaryRequested && !Task.isCancelled {
                self.summaryRequested = false
                await self.summarizePending()
            }
            self.summaryTask = nil
        }
    }

    private func summarizePending() async {
        for card in cards.filter({ $0.result == nil }) {
            guard !Task.isCancelled else { return }
            do {
                let result: GlanceResult
                if card.sourceTruncated == true {
                    result = .excerptFallback(excerpt: card.preview, reason: "sourceTooLarge")
                } else {
                    let full = try await client.glanceSource(workspaceId: workspaceId, id: card.id)
                    try Task.checkCancellation()
                    result = await summarizer.summarize(full.source)
                }
                try Task.checkCancellation()
                let updated = try await client.glanceComplete(
                    workspaceId: workspaceId, id: card.id, sourceHash: card.sourceHash, result: result)
                if let index = cards.firstIndex(where: { $0.id == card.id }) { cards[index] = updated }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    public func mark(through: Int) async {
        do {
			let safeThrough = min(through, nextCursor)
			guard safeThrough > reviewedThrough else { return }
			reviewedThrough = try await client.glanceMarkReviewed(workspaceId: workspaceId, through: safeThrough)
            cards.removeAll { $0.glanceSeq <= reviewedThrough }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    public func markCaughtUp() async {
        let through = min(unread.last?.glanceSeq ?? 0, nextCursor)
        if through > reviewedThrough { await mark(through: through) }
    }

    public func openSource(_ card: GlanceCard) async {
        do {
            let value = try await client.glanceSource(workspaceId: workspaceId, id: card.id)
            openedSource = OpenedGlanceSource(card: card, source: value)
            error = nil
        } catch {
            self.error = "The original message could not be opened: \(error.localizedDescription)"
        }
    }

    public func closeSource() { openedSource = nil }

    public func rendered(_ card: GlanceCard) -> AgentGlanceCard {
        let kind: AgentGlanceKind
        switch card.result {
        case .onDeviceSummary(let headline, let bullets, _):
            kind = .onDeviceSummary(headline: headline, bullets: bullets)
        case .excerptFallback(let excerpt, let reason):
            kind = .excerpt(text: excerpt, unavailableReason: reason)
        case nil:
            kind = .excerpt(text: card.preview, unavailableReason: "Preparing on-device summary…")
        }
        return AgentGlanceCard(
            id: card.id,
            actor: card.agentLabel ?? (card.actorKind == "leader" ? "Leader" : "Agent"),
            date: card.at,
            interrupted: card.interrupted,
            reviewed: card.glanceSeq <= reviewedThrough,
            kind: kind
        )
    }
}
