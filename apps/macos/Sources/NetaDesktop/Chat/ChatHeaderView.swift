import SwiftUI

/// The chat panel header (11-desktop-chat T11.5).
///
/// The path breadcrumb (`ChatPath.segments`), the identity row (avatar, name,
/// `WORKSPACE LEADER` tag for the leader), the subtitle, and the trailing
/// `Details` capsule. Earlier path segments are secondary links back to
/// their selections; only the last is primary 14/600. There is no Stop
/// button and no mode control here: Stop lives on the composer (T11.6) and
/// PAPER-SPINE Revision 2 removed both from this header.
public struct ChatHeaderView: View {
	private let selection: Selection
	private let store: Store
	private let onDetails: () -> Void
	private let onSelect: (Selection) -> Void

	public init(
		selection: Selection, store: Store,
		onDetails: @escaping () -> Void, onSelect: @escaping (Selection) -> Void
	) {
		self.selection = selection
		self.store = store
		self.onDetails = onDetails
		self.onSelect = onSelect
	}

	public var body: some View {
		HStack(alignment: .top, spacing: 8) {
			VStack(alignment: .leading, spacing: 4) {
				pathRow
				identityRow
				Text(ChatPath.subtitle(for: selection, store: store))
					.font(Theme.text(10, .medium))
					.foregroundStyle(Theme.textSecondary)
					.lineLimit(1)
			}
			Spacer(minLength: 0)
			Button { onDetails() } label: {
				Text("Details")
					.font(Theme.text(12, .medium))
					.foregroundStyle(Theme.textPrimary)
					.padding(.horizontal, 12)
					.padding(.vertical, 6)
			}
			.buttonStyle(.plain)
			.netaGlass(.capsule)
			.accessibilityLabel("Show details")
		}
	}

	// MARK: - Private

	private var segments: [ChatPathSegment] {
		ChatPath.segments(for: selection, store: store)
	}

	private var pathRow: some View {
		HStack(spacing: 4) {
			ForEach(Array(segments.enumerated()), id: \.element.id) { index, segment in
				if index > 0 {
					Text("›")
						.font(Theme.text(14, .regular))
						.foregroundStyle(Theme.textSecondary)
				}
				if segment.isLast {
					Text(segment.label)
						.font(Theme.text(14, .semibold))
						.foregroundStyle(Theme.textPrimary)
						.lineLimit(1)
				} else {
					Button { onSelect(segment.selection) } label: {
						Text(segment.label)
							.font(Theme.text(14, .regular))
							.foregroundStyle(Theme.textSecondary)
							.lineLimit(1)
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Open \(segment.label)")
				}
			}
		}
	}

	private var identityRow: some View {
		HStack(spacing: 8) {
			Text(monogram(for: displayName))
				.font(Theme.text(12, .semibold))
				.foregroundStyle(Theme.textPrimary)
				.frame(width: 22, height: 22)
				.background(Theme.subtleSurface)
				.clipShape(Circle())
			Text(displayName)
				.font(Theme.text(13, .semibold))
				.foregroundStyle(Theme.textPrimary)
				.lineLimit(1)
			if ChatPath.showsLeaderTag(for: selection) {
				Text("WORKSPACE LEADER")
					.font(Theme.text(10, .semibold))
					.foregroundStyle(Theme.textSecondary)
			}
		}
	}

	/// The identity name is the head of the path: the leader, the mission's
	/// `#<number> <name>`, or the agent's name.
	private var displayName: String {
		segments.last?.label ?? "Leader"
	}

	private func monogram(for name: String) -> String {
		guard let first = name.first else { return "·" }
		return String(first).uppercased()
	}
}
