import SwiftUI

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
	}

	public let options: [Option]
	public let selected: String

	/// The provider list, with the session's current model standing in until
	/// `loadModels` returns. A model with no label of its own shows its id.
	public init(selected: String, models: [ModelInfo]) {
		self.selected = selected
		let listed = models.map { info in
			Option(id: info.id, label: info.label.isEmpty ? info.id : info.label)
		}
		if listed.isEmpty, !selected.isEmpty {
			options = [Option(id: selected, label: selected)]
		} else {
			options = listed
		}
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
		}
	}

	// MARK: - Controls row

	private var controlsRow: some View {
		HStack(spacing: 8) {
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
		Menu {
			ForEach(picker.options) { option in
				Button(option.label) {
					Task { @MainActor in await model.setModel(option.id) }
				}
			}
		} label: {
			HStack(spacing: 4) {
				Text(picker.label)
					.font(Theme.text(10, .medium))
				Image(systemName: "chevron.down")
					.font(Theme.text(9, .semibold))
			}
			.foregroundStyle(Theme.textSecondary)
			.padding(.horizontal, 10)
			.frame(minHeight: Theme.Metric.minHitHeight)
		}
		.menuStyle(.button)
		.buttonStyle(.plain)
		.menuIndicator(.hidden)
		.fixedSize()
		.netaControlGlass(.capsule)
		.disabled(!model.modelPickerEnabled)
		.accessibilityLabel("Model")
	}

	/// Compact glass segments, never a stock segmented picker: both labels
	/// always show, the selected one on a white lozenge, `Lead++` selected on
	/// violet glass with violet text.
	private var modeControl: some View {
		HStack(spacing: 2) {
			ForEach(ModeSegments(selected: model.mode).segments, id: \.mode) { segment in
				modeSegment(segment)
			}
		}
		.padding(2)
		.netaControlGlass(.capsule)
		.help(ModeSegments.helpText)
		.accessibilityLabel("Leader mode")
	}

	private func modeSegment(_ segment: ModeSegments.Segment) -> some View {
		Button {
			Task { @MainActor in await model.setMode(segment.mode) }
		} label: {
			Text(segment.label)
				.font(Theme.text(11, .medium))
				.foregroundStyle(segmentText(segment))
				.padding(.horizontal, 10)
				.frame(minHeight: Theme.Metric.minHitHeight)
				.background(Capsule().fill(segmentFill(segment)))
		}
		.buttonStyle(.plain)
		.accessibilityLabel(segment.label)
		.accessibilityAddTraits(segment.isSelected ? [.isSelected] : [])
	}

	private func segmentFill(_ segment: ModeSegments.Segment) -> Color {
		guard segment.isSelected else { return .clear }
		return segment.mode == .leadPlus
			? Theme.Glass.leadPlusSegment : Theme.Glass.selectedSegment
	}

	private func segmentText(_ segment: ModeSegments.Segment) -> Color {
		guard segment.isSelected else { return Theme.textSecondary }
		return segment.mode == .leadPlus ? Theme.violet : Theme.textPrimary
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
		.background(
			RoundedRectangle(cornerRadius: fieldRadius, style: .continuous)
				.fill(Theme.Glass.fieldFill))
		.overlay(
			RoundedRectangle(cornerRadius: fieldRadius, style: .continuous)
				.strokeBorder(Theme.Glass.rim, lineWidth: Theme.Glass.rimWidth))
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
			.accessibilityValue("Nothing to send")
		}
	}
}
