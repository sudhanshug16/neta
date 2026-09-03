import SwiftUI

/// Floating-surface silhouettes for the Liquid Glass layer.
///
/// Panels use `Theme.Metric.panelRadius`, capsules the pill shape, and nested
/// controls a concentric radius via `Theme.Metric.concentric`.
public enum GlassShape: Sendable {
	case panel
	case capsule
	case rounded(CGFloat)
}

public extension View {
	/// Liquid Glass for floating shell surfaces: toolbar, chat, mission bar,
	/// navigator, tooltip. Canvas nodes, edges and the spine never use this.
	/// Pass `tint: Theme.violet` for the leader rim. This is the only
	/// Liquid Glass call site in the app; every floating surface goes
	/// through here and the canvas never does.
	@ViewBuilder
	func netaGlass(_ s: GlassShape = .panel, tint: Color? = nil) -> some View {
		switch s {
		case .panel:
			glassEffect(.regular.tint(tint), in: RoundedRectangle(cornerRadius: Theme.Metric.panelRadius))
		case .capsule:
			glassEffect(.regular.tint(tint), in: Capsule())
		case .rounded(let radius):
			glassEffect(.regular.tint(tint), in: RoundedRectangle(cornerRadius: radius))
		}
	}
}
