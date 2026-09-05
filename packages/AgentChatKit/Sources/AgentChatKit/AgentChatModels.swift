import Foundation

public enum AgentChatRole: String, Sendable, Hashable {
	case user, agent, system
}

public enum AgentChatBlockKind: String, Sendable, Hashable {
	case markdown, thought, tool, diff, status, plan, usage, attachment
}

public enum AgentToolState: String, Sendable, Hashable {
	case pending, running, succeeded, failed

	public var label: String {
		switch self {
		case .pending: "Waiting"
		case .running: "Running"
		case .succeeded: "Complete"
		case .failed: "Failed"
		}
	}

	public var symbol: String {
		switch self {
		case .pending: "clock"
		case .running: "progress.indicator"
		case .succeeded: "checkmark.circle"
		case .failed: "exclamationmark.triangle"
		}
	}
}

public struct AgentUsage: Sendable, Hashable {
	public let inputTokens: Int?
	public let outputTokens: Int?
	public let cachedTokens: Int?
	public let usedTokens: Int?
	public let contextSize: Int?
	public let cost: Decimal?
	public let costCurrency: String?

	public init(inputTokens: Int? = nil, outputTokens: Int? = nil, cachedTokens: Int? = nil, usedTokens: Int? = nil, contextSize: Int? = nil, cost: Decimal? = nil, costCurrency: String? = nil) {
		self.inputTokens = inputTokens
		self.outputTokens = outputTokens
		self.cachedTokens = cachedTokens
		self.usedTokens = usedTokens
		self.contextSize = contextSize
		self.cost = cost
		self.costCurrency = costCurrency
	}

	public var summary: String {
		var parts: [String] = []
		if let inputTokens { parts.append("\(Self.compact(inputTokens)) in") }
		if let outputTokens { parts.append("\(Self.compact(outputTokens)) out") }
		if let cachedTokens, cachedTokens > 0 { parts.append("\(Self.compact(cachedTokens)) cached") }
		if let usedTokens, let contextSize { parts.append("\(Self.compact(usedTokens)) / \(Self.compact(contextSize)) context") }
		else if let usedTokens { parts.append("\(Self.compact(usedTokens)) used") }
		if let cost, let costCurrency { parts.append(cost.formatted(.currency(code: costCurrency).precision(.fractionLength(2...4)))) }
		return parts.joined(separator: " · ")
	}

	private static func compact(_ value: Int) -> String {
		value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)))
	}
}

public struct AgentChatBlock: Identifiable, Sendable, Hashable {
	public let id: String
	public let role: AgentChatRole
	public let kind: AgentChatBlockKind
	public let text: String
	public let title: String?
	public let detail: String?
	public let toolState: AgentToolState?
	public let usage: AgentUsage?
	public let attachment: AgentAttachment?

	public init(id: String, role: AgentChatRole, kind: AgentChatBlockKind, text: String = "", title: String? = nil, detail: String? = nil, toolState: AgentToolState? = nil, usage: AgentUsage? = nil, attachment: AgentAttachment? = nil) {
		self.id = id
		self.role = role
		self.kind = kind
		self.text = text
		self.title = title
		self.detail = detail
		self.toolState = toolState
		self.usage = usage
		self.attachment = attachment
	}
}

public struct AgentAttachment: Sendable, Hashable {
	public let name: String
	public let mimeType: String
	public let size: Int?
	public let imageData: Data?
	public init(name: String, mimeType: String, size: Int? = nil, imageData: Data? = nil) {
		self.name = name; self.mimeType = mimeType; self.size = size; self.imageData = imageData
	}
}

public enum AgentResponseProgress: Sendable, Hashable {
	case idle
	case preparing
	case streaming
	case stopping

	public var label: String? {
		switch self {
		case .idle: nil
		case .preparing: "Preparing…"
		case .streaming: "Responding…"
		case .stopping: "Stopping…"
		}
	}
}

public enum AgentGlanceKind: Sendable, Hashable {
	case onDeviceSummary(headline: String, bullets: [String])
	case excerpt(text: String, unavailableReason: String)
}

public struct AgentGlanceCard: Identifiable, Sendable, Hashable {
	public let id: String
	public let actor: String
	public let date: Date
	public let interrupted: Bool
	public let reviewed: Bool
	public let kind: AgentGlanceKind
	public init(id: String, actor: String, date: Date, interrupted: Bool = false, reviewed: Bool = false, kind: AgentGlanceKind) {
		self.id = id; self.actor = actor; self.date = date; self.interrupted = interrupted; self.reviewed = reviewed; self.kind = kind
	}
	public var headline: String {
		switch kind { case .onDeviceSummary(let value, _): value; case .excerpt: "Update from \(actor)" }
	}
}
