import Foundation

public enum AgentMarkdownListMarker: Sendable, Hashable {
	case unordered
	case ordered(Int)
}

public struct AgentMarkdownListItem: Sendable, Hashable {
	public let depth: Int
	public let marker: AgentMarkdownListMarker
	public let text: String

	public init(depth: Int, marker: AgentMarkdownListMarker, text: String) {
		self.depth = depth
		self.marker = marker
		self.text = text
	}
}

public enum AgentMarkdownBlock: Sendable, Hashable {
	case heading(Int, String), paragraph(String), list([AgentMarkdownListItem]), quote(String)
	case table([String], [[String]]), code(String?, String)
}

public enum AgentMarkdownParser {
	public static func parse(_ source: String) -> [AgentMarkdownBlock] {
		let lines = source.replacingOccurrences(of: "\r\n", with: "\n")
			.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
		var output: [AgentMarkdownBlock] = []
		var index = 0
		while index < lines.count {
			let trimmed = lines[index].trimmingCharacters(in: .whitespaces)
			if trimmed.isEmpty { index += 1; continue }
			if let fence = openingFence(lines[index]) {
				index += 1
				var body: [String] = []
				while index < lines.count, !isClosingFence(lines[index], for: fence) {
					body.append(lines[index])
					index += 1
				}
				if index < lines.count { index += 1 }
				output.append(.code(fence.info.isEmpty ? nil : fence.info, body.joined(separator: "\n")))
				continue
			}
			let hashes = trimmed.prefix(while: { $0 == "#" }).count
			if (1...6).contains(hashes), trimmed.dropFirst(hashes).hasPrefix(" ") {
				output.append(.heading(hashes, String(trimmed.dropFirst(hashes + 1))))
				index += 1
				continue
			}
			if trimmed.hasPrefix("> ") {
				var value: [String] = []
				while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("> ") {
					value.append(String(lines[index].trimmingCharacters(in: .whitespaces).dropFirst(2)))
					index += 1
				}
				output.append(.quote(value.joined(separator: "\n")))
				continue
			}
			if marker(lines[index]) != nil {
				var items: [AgentMarkdownListItem] = []
				while index < lines.count {
					if lines[index].trimmingCharacters(in: .whitespaces).isEmpty { break }
					if let parsed = marker(lines[index]) {
						items.append(AgentMarkdownListItem(
							depth: parsed.indent / 2, marker: parsed.marker, text: parsed.text))
						index += 1
						continue
					}
					guard !items.isEmpty, indentation(of: lines[index]) > 0 else { break }
					let previous = items.removeLast()
					items.append(AgentMarkdownListItem(
						depth: previous.depth, marker: previous.marker,
						text: previous.text + "\n" + lines[index].trimmingCharacters(in: .whitespaces)))
					index += 1
				}
				output.append(.list(items))
				continue
			}
			if index + 1 < lines.count, trimmed.contains("|"), tableRule(lines[index + 1]) {
				let headers = cells(lines[index])
				index += 2
				var rows: [[String]] = []
				while index < lines.count, lines[index].contains("|"), !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
					let raw = cells(lines[index])
					rows.append(Array(raw.prefix(headers.count)) + Array(repeating: "", count: max(0, headers.count - raw.count)))
					index += 1
				}
				output.append(.table(headers, rows))
				continue
			}
			var paragraph = [lines[index]]
			index += 1
			while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
				!startsBlock(lines[index])
			{
				paragraph.append(lines[index])
				index += 1
			}
			output.append(.paragraph(paragraph.joined(separator: "\n")))
		}
		return output
	}

	private struct Fence {
		let character: Character
		let count: Int
		let info: String
	}

	private struct ParsedMarker {
		let indent: Int
		let marker: AgentMarkdownListMarker
		let text: String
	}

	private static func openingFence(_ line: String) -> Fence? {
		let indent = line.prefix(while: { $0 == " " }).count
		guard indent <= 3 else { return nil }
		let content = line.dropFirst(indent)
		guard let character = content.first, character == "`" || character == "~" else { return nil }
		let count = content.prefix(while: { $0 == character }).count
		guard count >= 3 else { return nil }
		let info = content.dropFirst(count).trimmingCharacters(in: .whitespaces)
		if character == "`", info.contains("`") { return nil }
		return Fence(character: character, count: count, info: info)
	}

	private static func isClosingFence(_ line: String, for fence: Fence) -> Bool {
		let indent = line.prefix(while: { $0 == " " }).count
		guard indent <= 3 else { return false }
		let content = line.dropFirst(indent)
		let count = content.prefix(while: { $0 == fence.character }).count
		guard count >= fence.count else { return false }
		return content.dropFirst(count).trimmingCharacters(in: .whitespaces).isEmpty
	}

	private static func indentation(of line: String) -> Int {
		var width = 0
		for character in line {
			if character == " " { width += 1 }
			else if character == "\t" { width += 2 }
			else { break }
		}
		return width
	}

	private static func marker(_ line: String) -> ParsedMarker? {
		let indent = indentation(of: line)
		let content = line.drop(while: { $0 == " " || $0 == "\t" })
		if let first = content.first, ["-", "+", "*"].contains(first), content.dropFirst().hasPrefix(" ") {
			return ParsedMarker(indent: indent, marker: .unordered, text: String(content.dropFirst(2)))
		}
		let digits = content.prefix(while: { $0.isNumber })
		guard let start = Int(digits), !digits.isEmpty,
			content.dropFirst(digits.count).hasPrefix(". ")
		else { return nil }
		return ParsedMarker(indent: indent, marker: .ordered(start), text: String(content.dropFirst(digits.count + 2)))
	}

	private static func cells(_ line: String) -> [String] {
		let trimmed = line.trimmingCharacters(in: .whitespaces)
		let content = trimmed.hasPrefix("|") && trimmed.hasSuffix("|") ? String(trimmed.dropFirst().dropLast()) : trimmed
		var result: [String] = [], cell = "", escaped = false
		for character in content {
			if escaped {
				if character == "|" || character == "\\" { cell.append(character) }
				else { cell.append("\\"); cell.append(character) }
				escaped = false
			} else if character == "\\" { escaped = true }
			else if character == "|" { result.append(cell.trimmingCharacters(in: .whitespaces)); cell = "" }
			else { cell.append(character) }
		}
		if escaped { cell.append("\\") }
		result.append(cell.trimmingCharacters(in: .whitespaces))
		return result
	}

	private static func tableRule(_ line: String) -> Bool {
		let rule = cells(line)
		return !rule.isEmpty && rule.allSatisfy { cell in
			let body = cell.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ":", with: "")
			return body.count >= 3 && body.allSatisfy { $0 == "-" }
		}
	}

	private static func startsBlock(_ line: String) -> Bool {
		let trimmed = line.trimmingCharacters(in: .whitespaces)
		let hashes = trimmed.prefix(while: { $0 == "#" }).count
		return openingFence(line) != nil
			|| ((1...6).contains(hashes) && trimmed.dropFirst(hashes).hasPrefix(" "))
			|| trimmed.hasPrefix("> ") || marker(line) != nil
	}
}
