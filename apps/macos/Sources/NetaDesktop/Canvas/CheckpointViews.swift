import SwiftUI

/// Checkpoint presentation (T10.8): icons on the axis, one glass tooltip.
///
/// Icons are 14 pt stroke symbols sitting on the axis with no permanent
/// labels; hovering one shows a single glass tooltip with the label, the
/// relative time and a 6 pt caret to the icon. Tapping an icon routes
/// through `CheckpointRouter` and opens no surface. Nodes never scale:
/// there is no `scaleEffect` here.
public struct CheckpointLayer: View {
	private let points: [Checkpoint]
	private let spineY: CGFloat
	private let router: CheckpointRouter
	@State private var hoveredId: String?

	public init(
		points: [Checkpoint],
		spineY: CGFloat, router: CheckpointRouter
	) {
		self.points = points
		self.spineY = spineY
		self.router = router
	}

	public var body: some View {
		ZStack {
			ForEach(points) { checkpoint in
				checkpointButton(checkpoint)
					.position(x: checkpoint.x, y: spineY)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}

	// MARK: - Points

	private func checkpointButton(_ checkpoint: Checkpoint) -> some View {
		Button { router.open(checkpoint) } label: {
			Image(systemName: checkpoint.icon.systemImage)
				.font(.system(size: 14, weight: .regular))
				.foregroundStyle(checkpoint.icon.color)
				.frame(minWidth: 26, minHeight: 26)
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("\(checkpoint.label), \(checkpoint.relative)")
		.onHover { hovering in
			if hovering {
				hoveredId = checkpoint.id
			} else if hoveredId == checkpoint.id {
				hoveredId = nil
			}
		}
		.overlay(alignment: .top) {
			if hoveredId == checkpoint.id {
				VStack(spacing: 0) {
					caretUp
					VStack(alignment: .leading, spacing: 2) {
						Text(checkpoint.label)
							.font(Theme.text(12, .semibold))
							.foregroundStyle(Theme.textPrimary)
						Text(checkpoint.relative)
							.font(Theme.mono(11, .regular))
							.foregroundStyle(Theme.textSecondary)
					}
					.padding(.horizontal, 10)
					.padding(.vertical, 6)
					.netaGlass(.rounded(10))
				}
				.offset(y: 32)
			}
		}
	}

	/// The 6 pt caret between the icon and its tooltip, pointing up at the
	/// icon while the tooltip floats beneath the axis.
	private var caretUp: some View {
		Path { path in
			path.move(to: CGPoint(x: 0, y: 6))
			path.addLine(to: CGPoint(x: 6, y: 0))
			path.addLine(to: CGPoint(x: 12, y: 6))
			path.closeSubpath()
		}
		.fill(Theme.nodeFill)
		.frame(width: 12, height: 6)
		.accessibilityHidden(true)
	}

}

/// View mapping for `CheckpointIcon`: the SF Symbol and the state colour
/// behind each kind. Blocked rides on amber and failed on red with their
/// text labels in the tooltip, never on colour alone.
extension CheckpointIcon {
	var systemImage: String {
		switch self {
		case .bolt: "bolt"
		case .merge: "arrow.triangle.merge"
		case .diamond: "diamond"
		case .x: "xmark"
		case .document: "doc"
		case .power: "power"
		case .check: "checkmark"
		case .question: "questionmark"
		}
	}

	var color: Color {
		switch self {
		case .bolt: Theme.violet
		case .merge: Theme.blue
		case .diamond: Theme.textPrimary
		case .x: Theme.red
		case .document: Theme.textSecondary
		case .power: Theme.textSecondary
		case .check: Theme.green
		case .question: Theme.amber
		}
	}
}
