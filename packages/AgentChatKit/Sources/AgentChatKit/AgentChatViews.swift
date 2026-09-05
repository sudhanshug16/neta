import AppKit
import SwiftUI

public struct AgentSelector<Content: View>: View {
	private let label: String
	private let enabled: Bool
	private let content: Content

	public init(_ label: String, enabled: Bool = true, @ViewBuilder content: () -> Content) {
		self.label = label
		self.enabled = enabled
		self.content = content()
	}

	public var body: some View {
		Menu { content } label: { Text(label).font(.caption.weight(.medium)).lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, minHeight: 28, alignment: .leading) }
			.menuStyle(.button)
			.buttonStyle(.glass)
			.controlSize(.small)
			.menuIndicator(.visible)
			.frame(maxWidth: 180)
			.disabled(!enabled)
	}
}

public struct AgentMarkdownView: View {
	private let source: String
	public init(_ source: String) { self.source = source }
	public var body: some View { VStack(alignment: .leading, spacing: 10) { ForEach(Array(AgentMarkdownParser.parse(source).enumerated()), id: \.offset) { _, block in content(block) } }.font(.body).frame(maxWidth: .infinity, alignment: .leading) }
	@ViewBuilder private func content(_ block: AgentMarkdownBlock) -> some View {
		switch block {
		case .heading(let level, let text): Text(inline(text)).font(level <= 2 ? .title3.weight(.semibold) : .headline).textSelection(.enabled)
		case .paragraph(let text): Text(inline(text)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
		case .quote(let text): HStack { Rectangle().fill(.tertiary).frame(width: 3); Text(inline(text)).foregroundStyle(.secondary).textSelection(.enabled) }
		case .list(let items):
			VStack(alignment: .leading, spacing: 5) {
				ForEach(Array(items.enumerated()), id: \.offset) { _, item in
					let checklist = checklistItem(item.text)
					HStack(alignment: .firstTextBaseline) {
						switch item.marker {
						case .ordered(let number):
							Text("\(number).")
								.foregroundStyle(.secondary)
								.frame(minWidth: 18, alignment: .trailing)
						case .unordered:
							Image(systemName: checklist.checked ? "checkmark.circle.fill" : checklist.isChecklist ? "circle" : item.depth == 0 ? "circle.fill" : "circle")
								.foregroundStyle(.secondary)
								.frame(minWidth: 18)
						}
						Text(inline(checklist.text)).textSelection(.enabled)
					}
					.padding(.leading, CGFloat(item.depth) * 20)
				}
			}
		case .table(let headers, let rows): ScrollView(.horizontal) { Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) { GridRow { ForEach(Array(headers.enumerated()), id: \.offset) { _, cell in Text(inline(cell)).fontWeight(.semibold).textSelection(.enabled) } }; Divider(); ForEach(Array(rows.enumerated()), id: \.offset) { _, row in GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, cell in Text(inline(cell)).textSelection(.enabled) } } } }.fixedSize(horizontal: true, vertical: false).padding(9) }.background(.quaternary, in: .rect(cornerRadius: 8))
		case .code(let language, let text): CodePanel(language: language, content: text)
		}
	}
	private func inline(_ value: String) -> AttributedString { (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value) }
	private func checklistItem(_ item: String) -> (text: String, isChecklist: Bool, checked: Bool) {
		if item.hasPrefix("[x] ") || item.hasPrefix("[X] ") { return (String(item.dropFirst(4)), true, true) }
		if item.hasPrefix("[ ] ") { return (String(item.dropFirst(4)), true, false) }
		return (item, false, false)
	}
}

public struct CodePanel: View {
	private let language: String?; private let content: String
	public init(language: String? = nil, content: String) { self.language = language; self.content = content }
	public var body: some View { VStack(alignment: .leading, spacing: 6) { HStack { if let language { Text(language).font(.caption).foregroundStyle(.secondary) }; Spacer(); Button("Copy", systemImage: "doc.on.doc") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(content, forType: .string) }.labelStyle(.iconOnly).buttonStyle(.borderless).frame(minWidth: 26, minHeight: 26).help("Copy code") }; ScrollView(.horizontal) { Text(content.isEmpty ? " " : content).font(.system(.body, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: true, vertical: false).frame(minHeight: 18, alignment: .leading) } }.padding(10).background(.quaternary, in: .rect(cornerRadius: 9)) }
}

public struct AgentMessageBlockView: View {
	private let block: AgentChatBlock; @Binding private var expanded: Bool
	public init(block: AgentChatBlock, expanded: Binding<Bool>) { self.block = block; self._expanded = expanded }
	public var body: some View {
		switch block.kind {
		case .markdown: AgentMarkdownView(block.text)
		case .thought: DisclosureGroup("Reasoning", isExpanded: $expanded) { Text(block.text).textSelection(.enabled) }
		case .tool: tool
		case .diff: diff
		case .status: status(block.text, "info.circle")
		case .plan: Label { AgentMarkdownView(block.text) } icon: { Image(systemName: "checklist") }
		case .usage: if let s = block.usage?.summary, !s.isEmpty { status(s, "gauge.with.dots.needle.33percent") }
		case .attachment: attachment
		}
	}
	private var attachment: some View {
		HStack(spacing: 8) {
			if let data = block.attachment?.imageData, let image = NSImage(data: data) {
				Image(nsImage: image).resizable().scaledToFill().frame(width: 48, height: 48).clipShape(.rect(cornerRadius: 7))
			} else { Image(systemName: "doc").frame(width: 28, height: 28) }
			VStack(alignment: .leading) {
				Text(block.attachment?.name ?? "Attachment").lineLimit(1).truncationMode(.middle)
				if let size = block.attachment?.size { Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.caption).foregroundStyle(.secondary) }
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(8).background(.quaternary, in: .rect(cornerRadius: 9))
	}
	private var tool: some View { let state = block.toolState ?? .succeeded; return DisclosureGroup(isExpanded: $expanded) { if let d = block.detail, !d.isEmpty { CodePanel(content: d).padding(.top, 6) } } label: { HStack { if state == .running { ProgressView().controlSize(.small) } else { Image(systemName: state.symbol) }; Text(block.title ?? "Tool call"); Spacer(); Text(state.label).font(.caption).foregroundStyle(.secondary) } }.padding(10).background(.quaternary, in: .rect(cornerRadius: 10)) }
	private var diff: some View { ScrollView(.horizontal) { VStack(alignment: .leading, spacing: 0) { ForEach(Array(block.text.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, raw in let line = String(raw); let added = line.hasPrefix("+") && !line.hasPrefix("+++"); let removed = line.hasPrefix("-") && !line.hasPrefix("---"); Text(line.isEmpty ? " " : line).font(.system(.callout, design: .monospaced)).textSelection(.enabled).foregroundStyle(added ? Color.green : removed ? Color.red : Color.primary).fixedSize(horizontal: true, vertical: false).background(added ? Color.green.opacity(0.08) : removed ? Color.red.opacity(0.08) : Color.clear) } }.padding(9) }.background(.quaternary, in: .rect(cornerRadius: 8)) }
	private func status(_ text: String, _ symbol: String) -> some View { Label(text, systemImage: symbol).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .center) }
}

public struct AgentProgressView: View { private let progress: AgentResponseProgress; public init(_ progress: AgentResponseProgress) { self.progress = progress }; public var body: some View { if let label = progress.label { HStack(spacing: 7) { ProgressView().controlSize(.small); Text(label) }.font(.callout).foregroundStyle(.secondary) } } }

public struct AgentGlanceCardView: View {
	private let card: AgentGlanceCard
	@Binding private var expanded: Bool
	private let openSource: () -> Void
	private let markReviewed: () -> Void
	public init(card: AgentGlanceCard, expanded: Binding<Bool>, onOpenSource: @escaping () -> Void, onMarkReviewed: @escaping () -> Void) {
		self.card = card
		self._expanded = expanded
		self.openSource = onOpenSource
		self.markReviewed = onMarkReviewed
	}
	public var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			HStack {
				Text(card.headline).font(.headline)
				Spacer()
				if card.interrupted {
					Text("Interrupted").font(.caption).foregroundStyle(.secondary)
				}
			}
			switch card.kind {
			case .onDeviceSummary(_, let bullets):
				VStack(alignment: .leading, spacing: 6) {
					ForEach(Array(bullets.enumerated()), id: \.offset) { _, item in
						HStack(alignment: .firstTextBaseline) {
							Text("•")
							Text(item).textSelection(.enabled)
						}
					}
				}
			case .excerpt(let text, let reason):
				Text("Excerpt — summary unavailable").font(.caption).foregroundStyle(.secondary)
				Text(text).lineLimit(expanded ? nil : 6).textSelection(.enabled)
				Text(reason).font(.caption).foregroundStyle(.secondary)
				Button(expanded ? "Show less" : "Show more") { expanded.toggle() }.buttonStyle(.link).frame(minHeight: 26)
			}
			HStack {
				Text(card.actor).font(.caption).foregroundStyle(.secondary)
				Text(card.date, style: .relative).font(.caption).foregroundStyle(.secondary)
				Spacer()
				Button("Open message", action: openSource)
					.buttonStyle(.borderless)
					.accessibilityIdentifier("glance-open-\(card.id)")
				Button(card.reviewed ? "Caught up" : "Caught up to here", action: markReviewed)
					.buttonStyle(.borderless)
					.disabled(card.reviewed)
					.accessibilityIdentifier("glance-review-\(card.id)")
			}
		}
		.padding(16).background(.quaternary, in: .rect(cornerRadius: 14)).overlay { RoundedRectangle(cornerRadius: 14).stroke(.separator, lineWidth: 1) }
		.accessibilityElement(children: .contain).accessibilityIdentifier("glance-card-\(card.id)")
	}
}
