import AgentChatKit
import Foundation

enum AgentChatAdapter {
	/// Coalesces streaming tool updates by ACP tool-call identity. The first
	/// call keeps its transcript position while the latest update supplies
	/// status and detail.
	static func displayBlocks(_ blocks: [Block]) -> [Block] {
		var result: [Block] = []
		var indexByToolId: [String: Int] = [:]
		for block in blocks {
			guard block.kind == .tool, let toolId = stringValue(block.data?["toolCallId"]), !toolId.isEmpty else {
				result.append(block); continue
			}
			if let index = indexByToolId[toolId] {
				let prior = result[index]
				result[index] = Block(
					turnId: prior.turnId, seq: prior.seq, at: prior.at,
					role: block.role, kind: .tool,
					text: block.text.isEmpty ? prior.text : block.text,
					data: (prior.data ?? [:]).merging(block.data ?? [:]) { _, latest in latest })
			}
			else { indexByToolId[toolId] = result.count; result.append(block) }
		}
		return result
	}

	static func block(_ block: Block) -> AgentChatBlock {
		if let attachment = attachment(block.data) {
			return AgentChatBlock(id: id(block), role: role(block.role), kind: .attachment, attachment: attachment)
		}
		let detail = block.data.map { data in
			data.keys.sorted().filter { $0 != "name" && $0 != "status" }.map {
				"\($0): \(string(data[$0]!))"
			}.joined(separator: "\n")
		}
		if block.kind == .usage, let usage = usage(block.data) {
			return AgentChatBlock(id: id(block), role: role(block.role), kind: .usage, usage: usage)
		}
		return AgentChatBlock(
			id: id(block), role: role(block.role), kind: kind(block.kind), text: block.text,
			title: stringValue(block.data?["name"]) ?? firstLine(block.text),
			detail: detail?.isEmpty == false ? detail : nil,
			toolState: toolState(block.data), usage: nil, attachment: nil)
	}

	private static func id(_ block: Block) -> String { "\(block.turnId):\(block.seq)" }
	private static func role(_ value: Role) -> AgentChatRole {
		switch value { case .user: .user; case .agent: .agent; case .system: .system }
	}
	private static func kind(_ value: BlockKind) -> AgentChatBlockKind {
		switch value { case .text: .markdown; case .thought: .thought; case .tool: .tool; case .diff: .diff; case .status: .status; case .plan: .plan; case .usage: .usage }
	}
	private static func firstLine(_ text: String) -> String? {
		text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
	}
	private static func toolState(_ data: [String: DataValue]?) -> AgentToolState? {
		guard let raw = stringValue(data?["status"])?.lowercased() else { return nil }
		switch raw {
		case "pending", "waiting": return AgentToolState.pending
		case "running", "in_progress": return AgentToolState.running
		case "failed", "error": return AgentToolState.failed
		default: return AgentToolState.succeeded
		}
	}
	private static func usage(_ data: [String: DataValue]?) -> AgentUsage? {
		guard let data else { return nil }
		let input = integer(data["inputTokens"] ?? data["input_tokens"])
		let output = integer(data["outputTokens"] ?? data["output_tokens"])
		let cached = integer(data["cachedTokens"] ?? data["cached_tokens"])
			?? [integer(data["cachedReadTokens"]), integer(data["cachedWriteTokens"])].compactMap { $0 }.reduce(nil) { total, value in (total ?? 0) + value }
		let used = integer(data["usedTokens"])
		let context = integer(data["contextSize"])
		let cost: Decimal? = {
			guard case .number(let value) = data["costAmount"], value.isFinite, value >= 0 else { return nil }
			return Decimal(value)
		}()
		guard input != nil || output != nil || cached != nil || used != nil || context != nil || cost != nil else { return nil }
		return AgentUsage(inputTokens: input, outputTokens: output, cachedTokens: cached, usedTokens: used, contextSize: context, cost: cost, costCurrency: stringValue(data["costCurrency"]))
	}
	private static func integer(_ value: DataValue?) -> Int? {
		guard case .number(let number) = value else { return nil }
		guard number.isFinite else { return nil }
		return Int(exactly: number)
	}
	private static func attachment(_ data: [String: DataValue]?) -> AgentAttachment? {
		guard let name = stringValue(data?["name"]), stringValue(data?["attachmentId"]) != nil else { return nil }
		let imageData = stringValue(data?["previewBase64"]).flatMap { Data(base64Encoded: $0) }
		return AgentAttachment(name: name, mimeType: stringValue(data?["mimeType"]) ?? "application/octet-stream", size: integer(data?["size"]), imageData: imageData)
	}
	private static func stringValue(_ value: DataValue?) -> String? {
		guard case .string(let string) = value else { return nil }
		return string
	}
	private static func string(_ value: DataValue) -> String {
		switch value { case .string(let v): v; case .number(let v): v.formatted(); case .bool(let v): v ? "true" : "false"; case .null: "null" }
	}
}
