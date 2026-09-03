import Foundation

/// The Markdown subset the transcript renders (11-desktop-chat T11.3).
public enum MarkdownSpan: Equatable, Sendable {
	case text(String)
	case code(String)
}

public enum MarkdownBlock: Equatable, Sendable {
	case paragraph([MarkdownSpan])
	case code(language: String?, text: String)
	case list(ordered: Bool, items: [[MarkdownSpan]])
}

public enum MarkdownLite {
	public static func parse(_ text: String) -> [MarkdownBlock] {
		let normalized = text
			.replacingOccurrences(of: "\r\n", with: "\n")
			.replacingOccurrences(of: "\r", with: "\n")
		let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
		var blocks: [MarkdownBlock] = []
		var index = 0
		while index < lines.count {
			if isBlank(lines[index]) {
				index += 1
				continue
			}
			if let language = fenceLanguage(lines[index]) {
				index += 1
				var body: [String] = []
				while index < lines.count, fenceLanguage(lines[index]) == nil {
					body.append(lines[index])
					index += 1
				}
				// Skip the closing fence when present; an unclosed fence
				// runs to the end of input.
				if index < lines.count {
					index += 1
				}
				blocks.append(.code(language: language, text: body.joined(separator: "\n")))
				continue
			}
			var chunk: [String] = []
			while index < lines.count, !isBlank(lines[index]), fenceLanguage(lines[index]) == nil {
				chunk.append(lines[index])
				index += 1
			}
			guard !chunk.isEmpty else {
				continue
			}
			if chunk.allSatisfy({ isListItem($0) }) {
				let ordered = chunk.allSatisfy({ orderedMarkerLength($0) != nil })
				blocks.append(.list(ordered: ordered, items: chunk.map { spans(stripMarker($0)) }))
			} else {
				blocks.append(.paragraph(spans(chunk.joined(separator: "\n"))))
			}
		}
		return blocks
	}

	private static func isBlank(_ line: String) -> Bool {
		line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
	}

	/// The language word after an opening fence, or nil when the line is not
	/// a fence. A bare fence yields `.some(nil)` via the optional wrapping.
	private static func fenceLanguage(_ line: String) -> String?? {
		var stripped = line
		while stripped.hasPrefix(" ") || stripped.hasPrefix("\t") {
			stripped.removeFirst()
		}
		guard stripped.hasPrefix("```") else {
			return nil
		}
		let info = stripped.dropFirst(3).trimmingCharacters(in: .whitespaces)
		guard !info.isEmpty else {
			return .some(nil)
		}
		let word = info.split(whereSeparator: \.isWhitespace).first.map(String.init)
		return .some(word)
	}

	private static func unorderedMarkerLength(_ line: String) -> Int? {
		if line.hasPrefix("- ") || line.hasPrefix("* ") {
			return 2
		}
		return nil
	}

	private static func orderedMarkerLength(_ line: String) -> Int? {
		var end = line.startIndex
		var digits = 0
		while end < line.endIndex, line[end].isASCII, line[end].isNumber {
			digits += 1
			end = line.index(after: end)
		}
		guard digits > 0 else {
			return nil
		}
		guard line[end...].hasPrefix(". ") else {
			return nil
		}
		return line.distance(from: line.startIndex, to: end) + 2
	}

	private static func isListItem(_ line: String) -> Bool {
		unorderedMarkerLength(line) != nil || orderedMarkerLength(line) != nil
	}

	private static func stripMarker(_ line: String) -> String {
		if let length = orderedMarkerLength(line) ?? unorderedMarkerLength(line) {
			return String(line.dropFirst(length))
		}
		return line
	}

	/// A matched backtick pair makes a code span; an unmatched backtick stays
	/// literal. Everything else stays literal text.
	private static func spans(_ text: String) -> [MarkdownSpan] {
		guard !text.isEmpty else {
			return []
		}
		var out: [MarkdownSpan] = []
		var pending = ""
		func flush() {
			if !pending.isEmpty {
				out.append(.text(pending))
				pending = ""
			}
		}
		var index = text.startIndex
		while index < text.endIndex {
			if text[index] == "`" {
				let from = text.index(after: index)
				if let close = text[from...].firstIndex(of: "`") {
					flush()
					out.append(.code(String(text[from ..< close])))
					index = text.index(after: close)
				} else {
					pending.append("`")
					index = from
				}
			} else {
				pending.append(text[index])
				index = text.index(after: index)
			}
		}
		flush()
		return out
	}
}
