import SwiftUI

public enum GlassShape: Sendable { case panel, capsule, rounded(CGFloat) }

/// Native Liquid Glass only. The system supplies its lighting, rim and pointer response.
public extension GlassShape {
	var floats: Bool { if case .rounded = self { return false }; return true }
}

public extension View {
	@ViewBuilder func netaGlass(_ shape: GlassShape = .panel, tint: Color? = nil) -> some View {
		let glass = tint.map { Glass.regular.tint($0) } ?? .regular
		switch shape {
		case .panel: glassEffect(glass, in: .rect(cornerRadius: Theme.Metric.panelRadius))
		case .capsule: glassEffect(glass, in: Capsule())
		case .rounded(let radius): glassEffect(glass, in: .rect(cornerRadius: radius))
		}
	}
	func netaControlGlass(_ shape: GlassShape = .capsule, tint: Color? = nil) -> some View { netaGlass(shape, tint: tint) }
	func netaFloatingGlass(_ shape: GlassShape = .panel, tint: Color? = nil) -> some View { netaGlass(shape, tint: tint) }
	func netaSpecular(_ shape: GlassShape) -> some View { self }
	func netaOuterShadow(_ shape: some InsettableShape, when floats: Bool) -> some View { self }
}
