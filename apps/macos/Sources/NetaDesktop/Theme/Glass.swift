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

public extension GlassShape {
	/// Whether this silhouette is a surface that floats over the ground and
	/// so takes Revision 3's outer shadow. See the elevation rule on
	/// `netaGlass`; `ThemeTests.testElevationFollowsTheSilhouette` pins it.
	///
	/// `.panel` and `.capsule` are the two silhouettes Revision 3 gives a
	/// floating surface — panels 22 px (chat, navigator), capsules 999 px
	/// (toolbar, mission bar). `.rounded(_)` is the concentric radius
	/// Revision 3 reserves for "nested controls (outer radius minus
	/// padding)", so it never floats.
	var floats: Bool {
		switch self {
		case .panel, .capsule: true
		case .rounded: false
		}
	}
}

public extension View {
	/// The full Revision 3 Liquid Glass material: the glass effect, the fill
	/// (`tint` replaces it — pass `Theme.Glass.chatFill` and friends), the
	/// 135° sheen, the 1 pt rim, the two inset edges, and — for a floating
	/// silhouette — the outer shadow.
	///
	/// Revision 3 specifies ONE fill over the blur, so the colour is applied
	/// once: the fill layer carries it and the material stays untinted. A
	/// `tint` handed to `glassEffect` as well would land twice and drive a
	/// 0.66 surface to roughly 0.88, which is how the chat panel went nearly
	/// opaque.
	///
	/// # Elevation rule
	///
	/// Revision 3's outer shadow (`0 18px 40px rgba(0,0,0,0.38)`) belongs to
	/// a surface that floats over the ground, not to a control drawn on top
	/// of one: a 40 pt shadow under a mission chip smears across the bar that
	/// hosts it. **Elevation follows the silhouette** — `GlassShape.floats`
	/// is the whole rule, and every branch of `netaGlass` routes through it:
	///
	/// - `.panel` (22 px) and `.capsule` (999 px) are the silhouettes
	///   Revision 3 gives its floating surfaces — "Surfaces to convert" lists
	///   the toolbar capsule, the chat panel, the mission bar capsule and the
	///   navigator panel, and those four are exactly the `.panel`/`.capsule`
	///   surfaces in the app. They take the shadow.
	/// - `.rounded(_)` is the concentric radius Revision 3 reserves for
	///   nested controls. It never takes the shadow: the mission chips, the
	///   navigator search field, the Now pill, the toolbar's own segments,
	///   the chat bubbles and the Lead++ strip all use it.
	///
	/// Two escape hatches exist for the cases where the silhouette and the
	/// role disagree, and they are named rather than inferred:
	///
	/// - `netaControlGlass` — a control whose silhouette is a capsule or a
	///   panel but which is not a floating surface. Revision 3's "Controls on
	///   glass" list: the model picker, `Lead | Lead++`, Details, Stop/send
	///   and the `+N completed` chip. They get "capsule glass with the same
	///   rim" and no shadow.
	/// - `netaFloatingGlass` — a floating surface whose silhouette is
	///   `.rounded(_)`. (Naming it on a `.panel` or `.capsule` is redundant
	///   rather than wrong: the silhouette already floats.) **The Lead++
	///   tooltip is the one such surface** (Revision 3 "Surfaces to convert"
	///   item 5): it floats over the canvas on the nested radius and takes
	///   the shadow through this modifier, at
	///   `Canvas/CheckpointViews.swift`.
	///
	/// Canvas nodes, edges and the spine are content and never take the
	/// material; the leader card borrows the rim and sheen alone through
	/// `netaSpecular`. These three modifiers are the only `glassEffect` call
	/// sites in the app.
	@ViewBuilder
	func netaGlass(_ s: GlassShape = .panel, tint: Color? = nil) -> some View {
		switch s {
		case .panel:
			glassBody(panelShape, tint: tint).netaOuterShadow(panelShape, when: s.floats)
		case .capsule:
			glassBody(Capsule(), tint: tint).netaOuterShadow(Capsule(), when: s.floats)
		case .rounded(let radius):
			glassBody(roundedShape(radius), tint: tint)
				.netaOuterShadow(roundedShape(radius), when: s.floats)
		}
	}

	/// The material without the outer shadow, whatever the silhouette: a
	/// control that sits ON another glass surface (or, for the
	/// `+N completed` chip, inside a mission stack on the canvas). Revision 3
	/// gives these "capsule glass with the same rim" — the rim, not the
	/// `0 18 40`. See the elevation rule on `netaGlass`.
	@ViewBuilder
	func netaControlGlass(_ s: GlassShape = .capsule, tint: Color? = nil) -> some View {
		switch s {
		case .panel:
			glassBody(panelShape, tint: tint)
		case .capsule:
			glassBody(Capsule(), tint: tint)
		case .rounded(let radius):
			glassBody(roundedShape(radius), tint: tint)
		}
	}

	/// The material with the outer shadow, whatever the silhouette: a
	/// floating surface drawn on a nested radius. The Lead++ tooltip is the
	/// only one. See the elevation rule on `netaGlass`.
	@ViewBuilder
	func netaFloatingGlass(_ s: GlassShape = .panel, tint: Color? = nil) -> some View {
		switch s {
		case .panel:
			glassBody(panelShape, tint: tint).netaOuterShadow(panelShape, when: true)
		case .capsule:
			glassBody(Capsule(), tint: tint).netaOuterShadow(Capsule(), when: true)
		case .rounded(let radius):
			glassBody(roundedShape(radius), tint: tint)
				.netaOuterShadow(roundedShape(radius), when: true)
		}
	}

	/// The Revision 3 specular layer without the material: the 135° sheen,
	/// the specular top edge and the faint bottom edge, clipped to the shape
	/// and never hit-testable. `netaGlass` builds on it; the leader card at
	/// Now (content, not glass) borrows it so the focal node reads as lifted.
	@ViewBuilder
	func netaSpecular(_ s: GlassShape) -> some View {
		switch s {
		case .panel:
			specularBody(panelShape)
		case .capsule:
			specularBody(Capsule())
		case .rounded(let radius):
			specularBody(roundedShape(radius))
		}
	}
}

extension View {
	/// Revision 3's `0 18px 40px rgba(0,0,0,0.38)`, drawn OUTSIDE the shape
	/// only, as CSS `box-shadow` is: the spec clips a drop shadow to the
	/// outside of the border box, so it never touches the interior. Applied
	/// only `when` the caller's elevation rule says the surface floats.
	///
	/// SwiftUI's `.shadow` does the opposite. It derives the shadow from the
	/// layer's alpha and composites it behind that layer, so a translucent
	/// glass fill lets the whole silhouette show through and the surface
	/// renders far darker than its token (a 300x200 panel measured about 15%
	/// darker at its centre). The shadow is therefore drawn from a separate,
	/// fully opaque silhouette and the shape is punched back out of it with
	/// `destinationOut` inside a `compositingGroup`, leaving the ring around
	/// the shape and nothing under it. Opaque also means the shadow lands at
	/// its stated 0.38 rather than 0.38 x the fill's alpha.
	func netaOuterShadow(_ shape: some InsettableShape, when floats: Bool) -> some View {
		background {
			if floats {
				ZStack {
					shape
						.fill(Color.black)
						.shadow(
							color: Theme.Glass.shadow,
							radius: Theme.Glass.shadowRadius, x: 0, y: Theme.Glass.shadowY)
					shape
						.fill(Color.black)
						.blendMode(.destinationOut)
				}
				.compositingGroup()
				.allowsHitTesting(false)
			}
		}
	}
}

private extension View {
	var panelShape: RoundedRectangle {
		RoundedRectangle(cornerRadius: Theme.Metric.panelRadius, style: .continuous)
	}

	func roundedShape(_ radius: CGFloat) -> RoundedRectangle {
		RoundedRectangle(cornerRadius: radius, style: .continuous)
	}

	/// Fill behind the content, sheen and inset edges over it, the rim on
	/// top, and the untinted glass effect behind the lot: the fill is the one
	/// place the surface colour is applied. Elevation is not here — see the
	/// elevation rule on `netaGlass`.
	func glassBody(_ shape: some InsettableShape, tint: Color?) -> some View {
		background {
			shape
				.fill(tint ?? Theme.Glass.fill)
				.allowsHitTesting(false)
		}
		.specularBody(shape)
		.overlay {
			shape
				.strokeBorder(Theme.Glass.rim, lineWidth: Theme.Glass.rimWidth)
				.allowsHitTesting(false)
		}
		.glassEffect(.regular, in: shape)
	}

	/// The sheen and the two inset edges. The sheen's axis is computed from
	/// the rendered size so it stays 135° in screen space on any aspect.
	func specularBody(_ shape: some InsettableShape) -> some View {
		overlay {
			GeometryReader { proxy in
				shape
					.fill(Theme.Glass.sheen(for: proxy.size))
					.overlay { insetEdges(shape) }
			}
			.allowsHitTesting(false)
		}
	}

	/// Revision 3's `inset 0 1px 0 rgba(255,255,255,0.22)` and
	/// `inset 0 -1px 0 rgba(255,255,255,0.04)`: two 1 pt rows just inside the
	/// rim, top and bottom only. CSS draws no such edge down the sides, and
	/// stroking the whole perimeter would also composite the top edge into
	/// the rim's own band.
	func insetEdges(_ shape: some InsettableShape) -> some View {
		VStack(spacing: 0) {
			Rectangle()
				.fill(Theme.Glass.specularTop)
				.frame(height: Theme.Glass.rimWidth)
			Spacer(minLength: 0)
			Rectangle()
				.fill(Theme.Glass.specularBottom)
				.frame(height: Theme.Glass.rimWidth)
		}
		.padding(Theme.Glass.rimWidth)
		.clipShape(shape)
	}
}
