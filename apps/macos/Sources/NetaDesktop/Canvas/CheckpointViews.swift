import SwiftUI

/// Checkpoint presentation (T10.7): icons on the axis, one glass tooltip,
/// `N more` chips for coalesced history.
///
/// Icons are 14 pt symbols sitting on the axis with no permanent labels;
/// hovering one shows a single glass tooltip with the label, the relative
/// time and a 6 pt caret to the icon. Clusters render as `N more` chips at
/// their mean x. Tapping an icon routes through `CheckpointRouter` and
/// opens no surface. Nodes never scale: there is no `scaleEffect` here.
public struct CheckpointLayer: View {
	private let points: [Checkpoint]
	private let clusters: [CheckpointCluster]
	private let spineY: CGFloat
	private let router: CheckpointRouter
	@State private var hoveredId: String?

	public init(
		points: [Checkpoint], clusters: [CheckpointCluster],
		spineY: CGFloat, router: CheckpointRouter
	) {
		self.points = points
		self.clusters = clusters
		self.spineY = spineY
		self.router = router
	}

	public var body: some View {
		ZStack {
			ForEach(points) { checkpoint in
				checkpointButton(checkpoint)
					.position(x: checkpoint.x, y: spineY)
			}
			ForEach(clusters) { cluster in
				clusterChip(cluster)
					.position(x: cluster.x, y: spineY)
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

	// MARK: - Clusters

	private func clusterChip(_ cluster: CheckpointCluster) -> some View {
		Text("\(cluster.members.count) more")
			.font(Theme.text(11, .medium))
			.foregroundStyle(Theme.textSecondary)
			.padding(.horizontal, 10)
			.padding(.vertical, 5)
			.frame(minHeight: 26)
			.background(Capsule().fill(Theme.subtleSurface))
			.overlay(Capsule().stroke(Theme.nodeBorder))
			.accessibilityLabel("\(cluster.members.count) more checkpoints")
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
