import SwiftUI

/// The Details inspector view (11-desktop-chat T11.7).
///
/// The title and rows come from `DetailsModel`; this view only places them.
/// `.replacing` fills the panel with a back control to the transcript;
/// `.beside` sits beside it, so it shows no back control. There is no tab
/// bar here: Details is the one action on the header's Details button.
public struct DetailsView: View {
	private let selection: Selection
	private let store: Store
	private let decision: DecisionRecord?
	private let placement: DetailsPlacement
	private let onBack: () -> Void

	public init(
		selection: Selection, store: Store, decision: DecisionRecord?,
		placement: DetailsPlacement, onBack: @escaping () -> Void
	) {
		self.selection = selection
		self.store = store
		self.decision = decision
		self.placement = placement
		self.onBack = onBack
	}

	public var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			if placement == .replacing {
				Button { onBack() } label: {
					Label("Back", systemImage: "chevron.left")
						.font(Theme.text(12, .medium))
						.foregroundStyle(Theme.textSecondary)
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Back to chat")
			}
			Text(DetailsModel.title(for: selection, store: store))
				.font(Theme.text(14, .semibold))
				.foregroundStyle(Theme.textPrimary)
				.lineLimit(1)
			ForEach(fields) { field in
				VStack(alignment: .leading, spacing: 2) {
					Text(field.label)
						.font(Theme.text(10, .medium))
						.foregroundStyle(Theme.textSecondary)
					Text(field.value)
						.font(field.mono
							? Theme.mono(12, .regular)
							: Theme.text(13, .regular))
						.foregroundStyle(Theme.textPrimary)
						.textSelection(.enabled)
				}
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
	}

	// MARK: - Private

	private var fields: [DetailsField] {
		DetailsModel.fields(for: selection, store: store, decision: decision)
	}
}
