import SwiftUI

/// Per-kind transcript styling (11-desktop-chat T11.4).
///
/// The body face is BRIEF's chat body (12.5/400); `status` is the centred
/// 10/500 secondary line. `role` currently leaves every kind unchanged —
/// user turns read through the violet glass bubble and agent turns through
/// the subtle surface, so the text itself needs no per-role restyle — but
/// it stays in the signature so a future per-role tint has a home.
public struct BlockStyle: Equatable, Sendable {
	public let size: CGFloat
	public let weight: Font.Weight
	public let mono: Bool
	public let secondary: Bool
	public let alignment: HorizontalAlignment

	public init(
		size: CGFloat, weight: Font.Weight, mono: Bool,
		secondary: Bool, alignment: HorizontalAlignment
	) {
		self.size = size
		self.weight = weight
		self.mono = mono
		self.secondary = secondary
		self.alignment = alignment
	}

	public static func of(kind: BlockKind, role: Role) -> BlockStyle {
		let _ = role
		switch kind {
		case .text:
			return BlockStyle(size: 12.5, weight: .regular, mono: false, secondary: false, alignment: .leading)
		case .thought:
			return BlockStyle(size: 12.5, weight: .regular, mono: false, secondary: true, alignment: .leading)
		case .tool:
			return BlockStyle(size: 12.5, weight: .medium, mono: false, secondary: false, alignment: .leading)
		case .diff:
			return BlockStyle(size: 11.5, weight: .regular, mono: true, secondary: false, alignment: .leading)
		case .status:
			return BlockStyle(size: 10, weight: .medium, mono: false, secondary: true, alignment: .center)
		case .plan:
			return BlockStyle(size: 12.5, weight: .regular, mono: false, secondary: false, alignment: .leading)
		case .usage:
			return BlockStyle(size: 10, weight: .regular, mono: false, secondary: true, alignment: .center)
		}
	}
}

/// One classified diff line (11-desktop-chat T11.4).
public struct DiffLine: Equatable, Sendable {
	public enum Kind: Equatable, Sendable {
		case added
		case removed
		case context
		case meta
	}

	public let kind: Kind
	public let text: String

	public init(kind: Kind, text: String) {
		self.kind = kind
		self.text = text
	}
}

/// The pure, testable transcript helpers behind `BlockView`.
public enum BlockText {
	/// The dimmed one-line preview of a `thought` block: whitespace
	/// collapsed to a single line, cut at the last word boundary at or
	/// before `limit` with an ellipsis. Short text returns unchanged.
	public static func thoughtSummary(_ t: String, limit: Int = 120) -> String {
		let single = t.split(whereSeparator: \.isWhitespace).joined(separator: " ")
		guard single.count > limit else {
			return single
		}
		let prefix = String(single.prefix(limit))
		if let cut = prefix.lastIndex(of: " ") {
			return String(single[..<cut]) + "…"
		}
		return prefix + "…"
	}

	/// The `tool` block's title row: the `name` datum when present, else
	/// the first non-blank text line, else a fixed fallback.
	public static func toolTitle(_ b: Block) -> String {
		if let data = b.data, case .string(let name) = data["name"],
			!name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		{
			return name
		}
		let first = b.text.split(separator: "\n", omittingEmptySubsequences: true)
			.map { $0.trimmingCharacters(in: .whitespaces) }
			.first(where: { !$0.isEmpty }) ?? ""
		return first.isEmpty ? "Tool call" : first
	}

	/// The `tool` block's disclosed detail: the block's `data` as sorted
	/// `key: value` lines. Nil when there is no data to show.
	public static func toolDetail(_ b: Block) -> String? {
		guard let data = b.data, !data.isEmpty else {
			return nil
		}
		return data.keys.sorted().map { "\($0): \(stringValue(data[$0]!))" }.joined(separator: "\n")
	}

	/// Classifies each diff line: `+` added, `-` removed, `@@` and
	/// `+++`/`---` meta, everything else context.
	public static func diffLines(_ text: String) -> [DiffLine] {
		guard !text.isEmpty else {
			return []
		}
		let normalized = text
			.replacingOccurrences(of: "\r\n", with: "\n")
			.replacingOccurrences(of: "\r", with: "\n")
		return normalized.split(separator: "\n", omittingEmptySubsequences: false).map { raw in
			let line = String(raw)
			let kind: DiffLine.Kind
			if line.hasPrefix("@@") || line.hasPrefix("+++") || line.hasPrefix("---") {
				kind = .meta
			} else if line.hasPrefix("+") {
				kind = .added
			} else if line.hasPrefix("-") {
				kind = .removed
			} else {
				kind = .context
			}
			return DiffLine(kind: kind, text: line)
		}
	}

	static func stringValue(_ value: DataValue) -> String {
		switch value {
		case .string(let s):
			return s
		case .number(let d):
			return d.truncatingRemainder(dividingBy: 1) == 0 && d.isFinite
				? String(format: "%.0f", d) : String(d)
		case .bool(let b):
			return b ? "true" : "false"
		case .null:
			return "null"
		}
	}
}

/// One transcript block (11-desktop-chat T11.4).
///
/// `text` renders `MarkdownLite.parse`; `thought` shows the dimmed
/// `thoughtSummary` on one line and expands to the full text; `tool` shows
/// `toolTitle` with a chevron disclosing `toolDetail`; `diff` renders
/// `diffLines` in mono with added/removed tinting; `status` is the centred
/// 10/500 secondary line. Expansion is owned by the parent (`TurnView`);
/// this view only reports the toggle.
public struct BlockView: View {
	private let block: Block
	private let expanded: Bool
	private let onToggle: () -> Void

	public init(block: Block, expanded: Bool, onToggle: @escaping () -> Void) {
		self.block = block
		self.expanded = expanded
		self.onToggle = onToggle
	}

	public var body: some View {
		switch block.kind {
		case .text:
			textBody
		case .thought:
			thoughtBody
		case .tool:
			toolBody
		case .diff:
			diffBody
		case .status:
			statusBody
		case .plan:
			textBody
		case .usage:
			statusBody
		}
	}

	private func font(for style: BlockStyle) -> Font {
		style.mono ? Theme.mono(style.size, style.weight) : Theme.text(style.size, style.weight)
	}

	private func ink(for style: BlockStyle) -> Color {
		style.secondary ? Theme.textSecondary : Theme.textPrimary
	}

	// MARK: - text

	private var textBody: some View {
		let style = BlockStyle.of(kind: .text, role: block.role)
		return VStack(alignment: .leading, spacing: 6) {
			ForEach(Array(MarkdownLite.parse(block.text).enumerated()), id: \.offset) { _, parsed in
				markdownBody(parsed, style: style)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func markdownBody(_ parsed: MarkdownBlock, style: BlockStyle) -> some View {
		Group {
			switch parsed {
			case .paragraph(let spans):
				spanText(spans, style: style)
					.font(font(for: style))
					.foregroundStyle(ink(for: style))
			case .code(let language, let text):
				VStack(alignment: .leading, spacing: 4) {
					if let language, !language.isEmpty {
						Text(language)
							.font(Theme.mono(10, .medium))
							.foregroundStyle(Theme.textSecondary)
					}
					Text(text)
						.font(Theme.mono(style.size, .regular))
						.foregroundStyle(Theme.textPrimary)
						.frame(maxWidth: .infinity, alignment: .leading)
				}
				.padding(8)
				.background(Theme.subtleSurface, in: RoundedRectangle(cornerRadius: 8))
			case .list(let ordered, let items):
				VStack(alignment: .leading, spacing: 2) {
					ForEach(Array(items.enumerated()), id: \.offset) { index, spans in
						HStack(alignment: .top, spacing: 6) {
							Text(ordered ? "\(index + 1)." : "•")
								.font(font(for: style))
								.foregroundStyle(Theme.textSecondary)
							spanText(spans, style: style)
								.font(font(for: style))
								.foregroundStyle(ink(for: style))
						}
					}
				}
			}
		}
	}

	private func spanText(_ spans: [MarkdownSpan], style: BlockStyle) -> Text {
		spans.reduce(Text("")) { acc, span in
			switch span {
			case .text(let s):
				return Text("\(acc)\(s)")
			case .code(let s):
				return Text("\(acc)\(Text(s).font(Theme.mono(style.size, style.weight)))")
			}
		}
	}

	// MARK: - thought

	private var thoughtBody: some View {
		let style = BlockStyle.of(kind: .thought, role: block.role)
		return HStack(alignment: .top, spacing: 6) {
			Text(expanded ? block.text : BlockText.thoughtSummary(block.text))
				.font(font(for: style))
				.foregroundStyle(ink(for: style))
				.lineLimit(expanded ? nil : 1)
				.frame(maxWidth: .infinity, alignment: .leading)
			Button(action: onToggle) {
				Image(systemName: expanded ? "chevron.down" : "chevron.right")
					.font(Theme.text(11, .medium))
					.foregroundStyle(Theme.textSecondary)
			}
			.buttonStyle(.plain)
			.accessibilityLabel(expanded ? "Collapse thought" : "Expand thought")
		}
	}

	// MARK: - tool

	private var toolBody: some View {
		let style = BlockStyle.of(kind: .tool, role: block.role)
		let detail = BlockText.toolDetail(block)
		return VStack(alignment: .leading, spacing: 4) {
			HStack(spacing: 6) {
				Text(BlockText.toolTitle(block))
					.font(font(for: style))
					.foregroundStyle(ink(for: style))
					.frame(maxWidth: .infinity, alignment: .leading)
				if detail != nil {
					Button(action: onToggle) {
						Image(systemName: expanded ? "chevron.down" : "chevron.right")
							.font(Theme.text(11, .medium))
							.foregroundStyle(Theme.textSecondary)
					}
					.buttonStyle(.plain)
					.accessibilityLabel(expanded ? "Collapse tool detail" : "Expand tool detail")
				}
			}
			if expanded, let detail {
				Text(detail)
					.font(Theme.mono(11, .regular))
					.foregroundStyle(Theme.textSecondary)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
		}
	}

	// MARK: - diff

	private var diffBody: some View {
		VStack(alignment: .leading, spacing: 0) {
			ForEach(Array(BlockText.diffLines(block.text).enumerated()), id: \.offset) { _, line in
				Text(line.text.isEmpty ? " " : line.text)
					.font(Theme.mono(11.5, .regular))
					.foregroundStyle(diffInk(line.kind))
					.frame(maxWidth: .infinity, alignment: .leading)
					.background(diffWash(line.kind))
			}
		}
		.padding(6)
		.background(Theme.subtleSurface, in: RoundedRectangle(cornerRadius: 8))
	}

	private func diffInk(_ kind: DiffLine.Kind) -> Color {
		switch kind {
		case .added:
			return Theme.green
		case .removed:
			return Theme.red
		case .meta:
			return Theme.textSecondary
		case .context:
			return Theme.textPrimary
		}
	}

	private func diffWash(_ kind: DiffLine.Kind) -> Color {
		switch kind {
		case .added:
			return Theme.green.opacity(0.10)
		case .removed:
			return Theme.red.opacity(0.10)
		case .meta, .context:
			return .clear
		}
	}

	// MARK: - status

	private var statusBody: some View {
		let style = BlockStyle.of(kind: .status, role: block.role)
		return Text(block.text)
			.font(font(for: style))
			.foregroundStyle(ink(for: style))
			.multilineTextAlignment(.center)
			.frame(maxWidth: .infinity, alignment: .center)
	}
}
