import SwiftUI

/// The chat composer: controls row, growing field, Stop/send (T11.6).
///
/// Above the field sits the controls row from PAPER-SPINE Revision 2: the
/// model picker (`10/500` secondary in a subtle pill) and, when the model
/// says so, the compact `Lead | Lead++` segmented control. The trailing
/// button follows `model.button`: the square Stop glyph while a turn is
/// open, the solid mint send arrow once the draft is non-empty. `Enter`
/// sends, `Shift-Enter` keeps its newline, `⌘.` stops (the shell command
/// menu binds the same chord as a backstop). Archived sessions render
/// `Read-only · archived` with no controls at all.
public struct ComposerView: View {
	@Bindable private var model: ComposerModel

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
				HStack(alignment: .bottom, spacing: 8) {
					field
					actionButton
				}
			}
		}
	}

	// MARK: - Controls row

	private var controlsRow: some View {
		HStack(spacing: 8) {
			Picker("Model", selection: Binding(
				get: { model.selectedModel },
				set: { id in Task { @MainActor in await model.setModel(id) } }
			)) {
				ForEach(modelOptions, id: \.id) { option in
					Text(option.label).tag(option.id)
				}
			}
			.pickerStyle(.menu)
			.font(Theme.text(10, .medium))
			.foregroundStyle(Theme.textSecondary)
			.padding(.horizontal, 10)
			.padding(.vertical, 4)
			.background(Theme.subtleSurface, in: Capsule())
			.disabled(!model.modelPickerEnabled)
			.accessibilityLabel("Model")
			if model.showsModeControl {
				Picker("Mode", selection: Binding(
					get: { model.mode },
					set: { mode in Task { @MainActor in await model.setMode(mode) } }
				)) {
					Text("Lead").tag(LeaderMode.lead)
					Text("Lead++").tag(LeaderMode.leadPlus)
				}
				.pickerStyle(.segmented)
				.frame(width: 150)
				.help("build access")
				.accessibilityLabel("Leader mode")
			}
		}
	}

	/// The picker's options, with the current selection standing in until
	/// `loadModels` returns the provider list.
	private var modelOptions: [(id: String, label: String)] {
		let options = model.models.map { info in
			(id: info.id, label: info.label.isEmpty ? info.id : info.label)
		}
		if options.isEmpty, !model.selectedModel.isEmpty {
			return [(id: model.selectedModel, label: model.selectedModel)]
		}
		return options
	}

	// MARK: - Field

	private var field: some View {
		ZStack(alignment: .topLeading) {
			TextEditor(text: $model.draft)
				.font(Theme.text(12.5, .regular))
				.foregroundStyle(Theme.textPrimary)
				.scrollContentBackground(.hidden)
				.frame(height: CGFloat(model.lineCount) * 16 + 14)
				.onKeyPress(keys: [.return], phases: .down) { press in
					guard press.modifiers.isEmpty else { return .ignored }
					Task { @MainActor in await model.send() }
					return .handled
				}
				.onKeyPress(keys: ["."], phases: .down) { press in
					guard press.modifiers == .command else { return .ignored }
					Task { @MainActor in await model.stop() }
					return .handled
				}
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
		.background(Color(.sRGB, white: 0, opacity: 0.22), in: RoundedRectangle(cornerRadius: 12))
		.overlay(
			RoundedRectangle(cornerRadius: 12)
				.stroke(Theme.nodeBorder, lineWidth: 1))
	}

	// MARK: - Stop / send

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
					.frame(width: 30, height: 30)
			}
			.buttonStyle(.plain)
			.background(Theme.subtleSurface, in: Circle())
			.accessibilityLabel("Stop")
		case .send:
			Button { Task { @MainActor in await model.send() } } label: {
				Image(systemName: "arrow.up")
					.font(Theme.text(14, .semibold))
					.foregroundStyle(Color(.sRGB, white: 0, opacity: 0.85))
					.padding(.horizontal, 12)
					.frame(height: 30)
			}
			.buttonStyle(.plain)
			.background(Theme.mint, in: Capsule())
			.accessibilityLabel("Send")
		case .sendDisabled:
			Image(systemName: "arrow.up")
				.font(Theme.text(14, .semibold))
				.foregroundStyle(Theme.textSecondary)
				.padding(.horizontal, 12)
				.frame(height: 30)
				.background(Theme.subtleSurface, in: Capsule())
				.accessibilityLabel("Send")
		}
	}
}
