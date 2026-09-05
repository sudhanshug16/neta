import SwiftUI

/// What the chat header prints (11-desktop-chat T11.5).
///
/// One name line, and one only: the path from `ChatPath.segments`, whose last
/// segment *is* the selected identity. There is no second identity row, so a
/// name can never appear twice. `labels` is the header's text in reading
/// order, which is what the tests assert against.
public struct ChatHeaderModel: Equatable, Sendable {
	public static let leaderTag = "WORKSPACE LEADER"
	public static let detailsLabel = "Details"

	public let segments: [ChatPathSegment]
	public let subtitle: String
	public let showsLeaderTag: Bool

	@MainActor public static func make(
		selection: Selection, store: Store, isResponding: Bool = false
	) -> ChatHeaderModel {
		ChatHeaderModel(
			segments: ChatPath.segments(for: selection, store: store),
			subtitle: ChatPath.subtitle(for: selection, store: store, isResponding: isResponding),
			showsLeaderTag: ChatPath.showsLeaderTag(for: selection))
	}

	/// The violet crown avatar belongs to the workspace leader; an agent or
	/// mission is identified by its path alone (PAPER-SPINE artboard 2).
	public var showsAvatar: Bool { showsLeaderTag }

	/// The selected identity: the last path segment.
	public var name: String { segments.last?.label ?? "" }

	/// Every line the header prints, in order.
	public var labels: [String] {
		var out = segments.map(\.label)
		if showsLeaderTag { out.append(Self.leaderTag) }
		out.append(subtitle)
		out.append(Self.detailsLabel)
		return out
	}
}

/// The chat panel header (11-desktop-chat T11.5).
///
/// A 28 pt violet crown avatar for the leader, then the one name line — the
/// path, earlier segments secondary links back to their selections, the last
/// primary 14/600 — the `WORKSPACE LEADER` tag for the leader alone, the
/// `provider · model · State` subtitle, and a trailing `Details` glass
/// capsule. There is no Stop button and no mode control here: Stop lives on
/// the composer (T11.6) and PAPER-SPINE Revision 2 removed both from this
/// header.
public struct ChatHeaderView: View {
	private let selection: Selection
	private let store: Store
	private let onDetails: () -> Void
	private let onSelect: (Selection) -> Void
	private let isResponding: Bool

	public init(
		selection: Selection, store: Store,
		isResponding: Bool = false,
		onDetails: @escaping () -> Void, onSelect: @escaping (Selection) -> Void
	) {
		self.selection = selection
		self.store = store
		self.isResponding = isResponding
		self.onDetails = onDetails
		self.onSelect = onSelect
	}

	public var body: some View {
		let model = ChatHeaderModel.make(
			selection: selection, store: store, isResponding: isResponding)
		HStack(alignment: .center, spacing: 8) {
			if model.showsAvatar {
				avatar
			}
			VStack(alignment: .leading, spacing: 3) {
				nameLine(model)
				Text(model.subtitle)
					.font(Theme.text(10, .medium))
					.foregroundStyle(Theme.textSecondary)
					.lineLimit(1)
			}
			Spacer(minLength: 0)
			detailsButton
		}
	}

	// MARK: - Private

	private var avatar: some View {
		ZStack {
			Circle()
				.fill(Theme.violet)
				.frame(
					width: Theme.Metric.headerAvatar,
					height: Theme.Metric.headerAvatar)
			Image(systemName: "crown.fill")
				.font(Theme.text(13, .semibold))
				.foregroundStyle(Theme.textPrimary)
		}
		.accessibilityHidden(true)
	}

	private func nameLine(_ model: ChatHeaderModel) -> some View {
		HStack(spacing: 4) {
			ForEach(Array(model.segments.enumerated()), id: \.element.id) { index, segment in
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
			if model.showsLeaderTag {
				Text(ChatHeaderModel.leaderTag)
					.font(Theme.text(10, .semibold))
					.tracking(Theme.Metric.tagTracking)
					.foregroundStyle(Theme.textSecondary)
					.lineLimit(1)
			}
		}
	}

	private var detailsButton: some View {
		Button { onDetails() } label: {
			Text(ChatHeaderModel.detailsLabel)
				.font(Theme.text(12, .medium))
				.foregroundStyle(Theme.textPrimary)
				.padding(.horizontal, 12)
				.frame(minHeight: Theme.Metric.minHitHeight)
		}
		.buttonStyle(.plain)
		.netaControlGlass(.capsule)
		.accessibilityLabel("Show details")
	}
}
