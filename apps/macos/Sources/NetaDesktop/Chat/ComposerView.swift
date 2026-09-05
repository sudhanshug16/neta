import AgentChatKit
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// The compact `Lead | Lead++` control's pure model (PAPER-SPINE Revision 3).
///
/// Two glass segments, each carrying its text label so the mode is never
/// signalled by colour alone; the selected one is a brighter glass lozenge,
/// and `Lead++` selected is violet glass with violet text. The help text is
/// "build access", the wording BRIEF.md fixes for Lead++.
public struct ModeSegments: Equatable, Sendable {
	public struct Segment: Equatable, Sendable {
		public let mode: LeaderMode
		public let label: String
		public let isSelected: Bool
	}

	public static let helpText = "build access"

	public let segments: [Segment]

	public init(selected: LeaderMode) {
		segments = [
			Segment(mode: .lead, label: "Lead", isSelected: selected == .lead),
			Segment(mode: .leadPlus, label: "Lead++", isSelected: selected == .leadPlus),
		]
	}

	public var labels: [String] { segments.map(\.label) }

	public var selectedLabel: String {
		segments.first(where: \.isSelected)?.label ?? ""
	}
}

/// The model picker's pure model: what the compact glass pill reads and what
/// its menu offers.
public struct ModelPicker: Equatable, Sendable {
	public struct Option: Equatable, Sendable, Identifiable {
		public let id: String
		public let label: String
		public let detail: String?
	}

	public let options: [Option]
	public let selected: String

	/// The provider list, with the session's current model standing in until
	/// `loadModels` returns. A model with no label of its own shows its id.
	public init(selected: String, models: [ModelInfo]) {
		self.selected = selected
		var listed = models.map { info in
			Option(id: info.id, label: info.label.isEmpty ? info.id : info.label, detail: info.description)
		}
		if !selected.isEmpty, !listed.contains(where: { $0.id == selected }) {
			listed.append(Option(id: selected, label: selected, detail: nil))
		}
		options = listed
	}

	/// The pill's label: the selected model's label, or its id when the
	/// provider list has not arrived (or does not name it).
	public var label: String {
		options.first(where: { $0.id == selected })?.label ?? selected
	}
}

/// The chat composer: controls row, growing field, Stop/send (T11.6).
///
/// Above the field sits the controls row from PAPER-SPINE Revision 2 in
/// Revision 3's material: the model picker as a compact glass pill (10/500
/// secondary with a chevron, opening a menu of the provider's models) and,
/// when the model says so, the compact `Lead | Lead++` glass segments. The
/// trailing button follows `model.button`: the square Stop glyph on a round
/// glass control while a turn is open, the solid mint send arrow once the
/// draft is non-empty, and glass again while the draft is empty. `Enter`
/// sends, `Shift-Enter` keeps its newline, `⌘.` stops (the shell command menu
/// binds the same chord as a backstop). Archived sessions render
/// `Read-only · archived` with no controls at all.
public struct ComposerView: View {
	@Bindable private var model: ComposerModel
	@Environment(ShellState.self) private var shell: ShellState?
	@State private var pendingProvider: ProviderInfo?
	@State private var handoffMarkdown = ""
	@State private var choosingFiles = false

	public init(model: ComposerModel) {
		self.model = model
	}

	public var body: some View {
		if model.isArchived {
			Text("Read-only · archived")
				.font(Theme.text(12, .regular))
				.foregroundStyle(Theme.textSecondary)
				.frame(maxWidth: .infinity, alignment: .center)
				.padding(.vertical, 10)
				.accessibilityLabel("Read-only · archived")
		} else {
			VStack(alignment: .leading, spacing: 8) {
				controlsRow
				AgentProgressView(model.responseProgress)
				if let error = model.attachmentError ?? model.providerError {
					Text(error)
						.font(Theme.text(10, .medium))
						.foregroundStyle(.red)
						.accessibilityLabel("Provider error: \(error)")
				}
				HStack(alignment: .bottom, spacing: 8) {
					Button("Attach", systemImage: "paperclip") { choosingFiles = true }
						.labelStyle(.iconOnly).buttonStyle(.glass).controlSize(.regular)
						.help("Attach images or files")
						.disabled(!model.attachmentsEnabled)
					field
					if model.canSendDuringTurn { activeSendButton }
					actionButton
				}
				if model.queuedMessageCount > 0 {
					Text("Queued · \(model.queuedMessageCount)").font(Theme.text(10, .medium)).foregroundStyle(Theme.textSecondary)
				}
				ScrollView {
					VStack(alignment: .leading, spacing: 5) {
						ForEach(model.pendingInboxMessages, id: \.id) { message in
							HStack(alignment: .firstTextBaseline, spacing: 7) {
								Text(message.status == "uncertain" ? "Delivery uncertain" : message.status.capitalized)
									.font(Theme.text(10, .semibold))
								Text(message.text.isEmpty ? "Attachment" : message.text)
									.font(Theme.text(10, .regular)).lineLimit(2)
								if message.status == "uncertain", !message.text.isEmpty {
									Button("Copy message") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(message.text, forType: .string) }
										.buttonStyle(.glass).controlSize(.small)
										.accessibilityIdentifier("inbox-copy-\(message.id)")
								}
							}
							.foregroundStyle(message.status == "uncertain" ? .orange : Theme.textSecondary)
							.accessibilityLabel("\(message.status): \(message.text)")
						}
					}
				}.frame(maxHeight: model.pendingInboxMessages.isEmpty ? 0 : 120)
				attachmentPreviews
			}
			// Without this the provider list never arrives and `ModelPicker`
			// falls back to the one model already selected, so the pill opens
			// a menu of exactly one item.
			//
			// Keyed to the composer instance, the session AND the provider:
			// not bare, not to the session alone. `ChatPanelModel.select`
			// builds a brand-new `ComposerModel` whose `models` is empty, but
			// this view keeps its place in `ChatPanel`'s body and so its
			// identity, so an unkeyed `.task` would not re-run — and neither
			// would a session-keyed one when the new selection opens the same
			// session, which every leader-led mission does. And `loadModels`
			// returns early until the store has a provider, which arrives with
			// the snapshot rather than with the selection: keyed on the
			// session alone the load no-ops at launch and never runs again,
			// leaving the menu with the one model already selected.
			.task(id: model.modelLoadKey) { await model.loadModels() }
			.task(id: model.modelLoadKey) { await model.loadProviders() }
			.task(id: model.modelLoadKey) { await model.loadCapabilities() }
			.task(id: model.modelLoadKey) { await model.loadInbox() }
			.fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
				if case .success(let urls) = result { model.addFiles(urls) }
			}
			.sheet(item: $pendingProvider) { provider in
				handoffSheet(provider)
			}
		}
	}

	// MARK: - Controls row

	private var controlsRow: some View {
		HStack(spacing: 8) {
			providerPicker
			modelPicker
			if model.showsModeControl {
				modeControl
			}
		}
	}

	private var picker: ModelPicker {
		ModelPicker(selected: model.selectedModel, models: model.models)
	}

	private var modelPicker: some View {
		AgentSelector(picker.label.isEmpty ? model.modelLabel : picker.label, enabled: model.modelPickerEnabled) {
			ForEach(picker.options) { option in
				Button {
					Task { @MainActor in await model.setModel(option.id) }
				} label: {
					VStack(alignment: .leading) {
						Text(option.label)
						Text(option.detail.map { "\($0) · \(option.id)" } ?? option.id)
							.font(Theme.text(10, .regular))
							.foregroundStyle(Theme.textSecondary)
					}
				}
					.accessibilityIdentifier("model-option-\(option.id)")
			}
		}
		.accessibilityLabel("Model")
		.accessibilityIdentifier("composer-model")
	}

	private var providerPicker: some View {
		AgentSelector(model.providerLabel, enabled: model.providerPickerEnabled) {
			ForEach(model.providers) { provider in
				Button {
					Task { @MainActor in
						if let handoff = await model.handoff() {
							handoffMarkdown = handoff
							pendingProvider = provider
						}
					}
				} label: {
					VStack(alignment: .leading) {
						Text(provider.label)
						if let reason = provider.unavailableReason ?? provider.note { Text(reason) }
					}
				}
				.disabled(!provider.available)
				.accessibilityIdentifier("provider-option-\(provider.id)")
			}
		}
		.accessibilityLabel("Provider")
		.accessibilityIdentifier("composer-provider")
	}

	private func handoffSheet(_ provider: ProviderInfo) -> some View {
		VStack(alignment: .leading, spacing: 9) {
			Text("Switch to \(provider.label)").font(Theme.text(14, .semibold))
			Text("Review Markdown").font(Theme.text(10, .semibold)).foregroundStyle(Theme.textSecondary)
			TextEditor(text: $handoffMarkdown).font(Theme.mono(11, .regular)).frame(minHeight: 190)
			if let error = model.providerError {
				Text(error).font(Theme.text(10, .medium)).foregroundStyle(.red)
					.accessibilityLabel("Provider error: \(error)")
			}
			HStack {
				Button("Cancel") { pendingProvider = nil }
					.disabled(model.isSwitchingProvider)
				Spacer()
				Button("Switch Provider") {
					Task { @MainActor in
						if await model.setProvider(provider, handoff: handoffMarkdown) { pendingProvider = nil }
					}
				}
				.disabled(model.isSwitchingProvider)
			}
		}
		.padding(14).frame(width: 300)
	}

	/// Compact glass segments, never a stock segmented picker: both labels
	/// always show, the selected one on a white lozenge, `Lead++` selected on
	/// violet glass with violet text.
	private var modeControl: some View {
		Picker("Mode", selection: Binding(get: { model.mode }, set: { mode in
			Task { @MainActor in await model.setMode(mode) }
		})) {
			Text("Lead").tag(LeaderMode.lead).accessibilityIdentifier("mode-lead")
			Text("Lead++").tag(LeaderMode.leadPlus).accessibilityIdentifier("mode-lead-plus")
		}
		.pickerStyle(.segmented)
		.controlSize(.small)
		.fixedSize()
		.labelsHidden()
		.help(ModeSegments.helpText)
		.accessibilityLabel("Leader mode")
		.accessibilityIdentifier("composer-mode")
	}

	// MARK: - Field

	/// The field is inset glass inside the chat panel, so its radius is
	/// concentric with the panel's.
	private var fieldRadius: CGFloat {
		Theme.Metric.concentric(
			outer: Theme.Metric.panelRadius, padding: Theme.Metric.chatPadding)
	}

	private var field: some View {
		ZStack(alignment: .topLeading) {
			ComposerTextInput(
				text: $model.draft,
				onSend: { text in
					model.draft = text
					Task { @MainActor in await model.send() }
				},
				onStop: { Task { @MainActor in await model.stop() } },
				onPaste: pasteAttachments,
				focusRequested: shell?.composerFocused == true,
				debugState: { model.debugState }, debugInbox: { model.inboxMessages })
				.id(model.modelLoadKey)
				.frame(height: CGFloat(model.lineCount) * 16 + 14)
				.accessibilityLabel("Message")
			if model.draft.isEmpty {
				Text(model.placeholder)
					.font(Theme.text(12.5, .regular))
					.foregroundStyle(Theme.textSecondary)
					.padding(.top, 8)
					.padding(.leading, 5)
					.allowsHitTesting(false)
			}
		}
		.padding(8)
		.background(
			RoundedRectangle(cornerRadius: fieldRadius, style: .continuous)
				.fill(Theme.Glass.fieldFill))
		.overlay(
			RoundedRectangle(cornerRadius: fieldRadius, style: .continuous)
				.strokeBorder(Theme.Glass.rim, lineWidth: Theme.Glass.rimWidth))
	}

	private var attachmentPreviews: some View {
		ScrollView(.horizontal) {
			HStack(spacing: 8) {
				ForEach(model.attachments) { attachment in
					HStack(spacing: 6) {
						if attachment.kind == .image, let image = NSImage(data: attachment.data) { Image(nsImage: image).resizable().scaledToFill().frame(width: 34, height: 34).clipShape(.rect(cornerRadius: 6)) }
						else { Image(systemName: "doc") }
						Text(attachment.name).lineLimit(1)
						Button("Remove", systemImage: "xmark.circle.fill") { model.removeAttachment(id: attachment.id) }.labelStyle(.iconOnly).buttonStyle(.borderless)
					}.padding(6).background(.quaternary, in: .rect(cornerRadius: 8))
				}
			}
		}
		.frame(maxHeight: model.attachments.isEmpty ? 0 : 52)
	}

	private func pasteAttachments(_ board: NSPasteboard) -> Bool {
		ComposerPasteboard.paste(board, into: model)
	}

	// MARK: - Stop / send

	/// The one trailing control's size: Stop, send and disabled send are the
	/// same round 30 pt footprint (PAPER-SPINE Revision 2).
	static let actionSize: CGFloat = 30

	@ViewBuilder
	private var actionButton: some View {
		switch model.button {
		case .none:
			EmptyView()
		case .stop:
			Button { Task { @MainActor in await model.stop() } } label: {
				Image(systemName: "stop.fill")
					.font(Theme.text(13, .semibold))
					.foregroundStyle(Theme.textPrimary)
					.frame(width: Self.actionSize, height: Self.actionSize)
			}
			.buttonStyle(.plain)
			.netaControlGlass(.capsule)
			.accessibilityLabel("Stop")
			.accessibilityIdentifier("composer-stop")
		case .send:
			// PAPER-SPINE Revision 2: ONE trailing round 30 pt control that
			// becomes the mint send arrow when a person types. The silhouette
			// does not change between Stop and send, only the fill and the
			// glyph, so the button does not jump under the hand.
			Button { Task { @MainActor in await model.send() } } label: {
				Image(systemName: "arrow.up")
					.font(Theme.text(14, .semibold))
					.foregroundStyle(Theme.ground)
					.frame(width: Self.actionSize, height: Self.actionSize)
			}
			.buttonStyle(.plain)
			.background(Theme.mint, in: Capsule())
			.accessibilityLabel("Send")
			.accessibilityIdentifier("composer-send")
		case .sendDisabled:
			// A real disabled Button, not a bare image: VoiceOver has to
			// announce an unavailable control, and "nothing to send" must
			// not be inferred from the grey tint alone.
			Button {} label: {
				Image(systemName: "arrow.up")
					.font(Theme.text(14, .semibold))
					.foregroundStyle(Theme.textSecondary)
					.frame(width: Self.actionSize, height: Self.actionSize)
			}
			.buttonStyle(.plain)
			.disabled(true)
			.netaControlGlass(.capsule)
			.accessibilityLabel("Send")
			.accessibilityIdentifier("composer-send")
			.accessibilityValue("Nothing to send")
		}
	}

	private var activeSendButton: some View {
		Button { Task { @MainActor in await model.send() } } label: {
			Image(systemName: "arrow.up").font(Theme.text(14, .semibold)).foregroundStyle(Theme.ground)
				.frame(width: Self.actionSize, height: Self.actionSize)
		}.buttonStyle(.plain).background(Theme.mint, in: Capsule())
			.accessibilityLabel("Send while working").accessibilityIdentifier("composer-send")
	}
}

@MainActor enum ComposerPasteboard {
	static func paste(_ board: NSPasteboard, into model: ComposerModel) -> Bool {
		if let urls = board.readObjects(forClasses: [NSURL.self]) as? [URL], !urls.isEmpty {
			model.addFiles(urls)
			return true
		}
		guard let raw = board.data(forType: .png) ?? board.data(forType: .tiff),
			let image = NSImage(data: raw), let tiff = image.tiffRepresentation,
			let bitmap = NSBitmapImageRep(data: tiff),
			let png = bitmap.representation(using: .png, properties: [:]) else { return false }
		model.addImagePNG(png)
		if let text = board.string(forType: .string), !text.isEmpty { model.draft += text }
		return true
	}
}
