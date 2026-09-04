import SwiftUI

/// Design tokens for the Neta desktop shell.
///
/// Every color, font and metric in one place. Colors are literals from
/// `design/canvas-directions/BRIEF.md`; no color is defined elsewhere in
/// the app. Text tones follow PAPER-SPINE Revision 3 (raised for vibrancy
/// legibility on glass): primary white at 0.96, secondary at 0.64.
public enum Theme {
	public static let ground: Color = Color(.sRGB, red: 14.0 / 255.0, green: 15.0 / 255.0, blue: 19.0 / 255.0, opacity: 1)
	public static let violet: Color = Color(.sRGB, red: 153.0 / 255.0, green: 133.0 / 255.0, blue: 245.0 / 255.0, opacity: 1)
	public static let mint: Color = Color(.sRGB, red: 115.0 / 255.0, green: 209.0 / 255.0, blue: 184.0 / 255.0, opacity: 1)
	public static let blue: Color = Color(.sRGB, red: 138.0 / 255.0, green: 179.0 / 255.0, blue: 255.0 / 255.0, opacity: 1)
	public static let amber: Color = Color(.sRGB, red: 245.0 / 255.0, green: 173.0 / 255.0, blue: 71.0 / 255.0, opacity: 1)
	public static let green: Color = Color(.sRGB, red: 125.0 / 255.0, green: 217.0 / 255.0, blue: 140.0 / 255.0, opacity: 1)
	public static let red: Color = Color(.sRGB, red: 255.0 / 255.0, green: 97.0 / 255.0, blue: 97.0 / 255.0, opacity: 1)

	/// Six agent identity hues, in BRIEF order.
	public static let agentHues: [Color] = [
		Color(.sRGB, red: 82.0 / 255.0, green: 179.0 / 255.0, blue: 242.0 / 255.0, opacity: 1),
		Color(.sRGB, red: 242.0 / 255.0, green: 135.0 / 255.0, blue: 117.0 / 255.0, opacity: 1),
		Color(.sRGB, red: 199.0 / 255.0, green: 163.0 / 255.0, blue: 79.0 / 255.0, opacity: 1),
		Color(.sRGB, red: 112.0 / 255.0, green: 204.0 / 255.0, blue: 153.0 / 255.0, opacity: 1),
		Color(.sRGB, red: 227.0 / 255.0, green: 155.0 / 255.0, blue: 199.0 / 255.0, opacity: 1),
		Color(.sRGB, red: 127.0 / 255.0, green: 200.0 / 255.0, blue: 217.0 / 255.0, opacity: 1),
	]

	public static let textPrimary: Color = Color(.sRGB, white: 1, opacity: 0.96)
	public static let textSecondary: Color = Color(.sRGB, white: 1, opacity: 0.64)

	public static let nodeFill: Color = Color(.sRGB, red: 20.0 / 255.0, green: 23.0 / 255.0, blue: 25.0 / 255.0, opacity: 0.96)
	public static let nodeBorder: Color = Color(.sRGB, white: 1, opacity: 0.10)
	public static let divider: Color = Color(.sRGB, white: 1, opacity: 0.06)
	public static let subtleSurface: Color = Color(.sRGB, white: 1, opacity: 0.045)

	/// SF Pro text font.
	public static func text(_ s: CGFloat, _ w: Font.Weight) -> Font {
		.system(size: s, weight: w, design: .default)
	}

	/// SF Mono font with tabular numerals, for activity lines and tick labels.
	public static func mono(_ s: CGFloat, _ w: Font.Weight) -> Font {
		.system(size: s, weight: w, design: .monospaced).monospacedDigit()
	}

	/// Tabular numerals on any font. Used on every ordinal, age and percentage.
	public static func digits(_ font: Font) -> Font {
		font.monospacedDigit()
	}

	/// The Liquid Glass material, PAPER-SPINE Revision 3, dark mode.
	///
	/// Every number of the material lives here: `netaGlass` is the only
	/// place they are assembled and no view repeats one. The CSS the
	/// revision states is quoted beside each token.
	public enum Glass {
		/// Panel fill over the blur: `rgba(28,30,38,0.55)`.
		public static let fill: Color = Color(
			.sRGB, red: 28.0 / 255.0, green: 30.0 / 255.0, blue: 38.0 / 255.0, opacity: 0.55)
		/// Rim: `1px solid rgba(255,255,255,0.14)`.
		public static let rim: Color = Color(.sRGB, white: 1, opacity: 0.14)
		public static let rimWidth: CGFloat = 1
		/// Specular top edge: `inset 0 1px 0 rgba(255,255,255,0.22)`.
		public static let specularTop: Color = Color(.sRGB, white: 1, opacity: 0.22)
		/// Faint bottom inner edge: `inset 0 -1px 0 rgba(255,255,255,0.04)`.
		public static let specularBottom: Color = Color(.sRGB, white: 1, opacity: 0.04)
		/// Outer shadow: `0 18px 40px rgba(0,0,0,0.38)`.
		public static let shadow: Color = Color(.sRGB, white: 0, opacity: 0.38)
		public static let shadowY: CGFloat = 18
		public static let shadowBlur: CGFloat = 40
		/// SwiftUI's shadow radius is half the CSS blur length.
		public static var shadowRadius: CGFloat { shadowBlur / 2 }
		/// Sheen: `linear-gradient(135deg, rgba(255,255,255,0.10) 0%,
		/// rgba(255,255,255,0) 38%)`. CSS 135° points down and to the right,
		/// so the gradient line starts at the top-left corner.
		public static let sheenStart: Color = Color(.sRGB, white: 1, opacity: 0.10)
		public static let sheenEnd: CGFloat = 0.38

		/// The 135° sheen for a surface of `size`, clipped by the caller to
		/// the surface shape.
		///
		/// `UnitPoint` space is normalised to the view's bounds, so a fixed
		/// end point tilts with the aspect ratio: `UnitPoint(0.38, 0.38)` on
		/// the 410x880 chat panel is about 65° from horizontal, not 45°.
		/// Only a square surface would render the revision's angle. The end
		/// point is therefore computed in points and converted back: the CSS
		/// gradient line for 135° runs corner to corner along (1,1)/√2 and is
		/// `(w + h)/√2` long, so the colour reaches clear after
		/// `0.38 x (w + h)/2` points on each axis.
		public static func sheen(for size: CGSize) -> LinearGradient {
			LinearGradient(
				colors: [sheenStart, .clear],
				startPoint: .topLeading,
				endPoint: sheenEndPoint(for: size))
		}

		/// Where the sheen reaches clear, in unit space. Separate from
		/// `sheen` because `LinearGradient` does not read back its points, so
		/// this is the only place the angle can be asserted.
		public static func sheenEndPoint(for size: CGSize) -> UnitPoint {
			let width = max(size.width, 1)
			let height = max(size.height, 1)
			let reach = sheenEnd * (width + height) / 2
			return UnitPoint(x: reach / width, y: reach / height)
		}

		/// Controls on glass, Revision 3: the selected segment is a brighter
		/// glass lozenge, `Lead++` selected is violet glass with violet text.
		public static let selectedSegment: Color = Color(.sRGB, white: 1, opacity: 0.14)
		public static let leadPlusSegment: Color = Theme.violet.opacity(0.30)
		/// The composer field is inset glass: `rgba(0,0,0,0.22)` with the rim.
		public static let fieldFill: Color = Color(.sRGB, white: 0, opacity: 0.22)
		/// The chat panel reads at `0.66` (Revision 3 surface 2). Call site:
		/// `Shell/RootView.swift`, which must pass this rather than restate
		/// the literal.
		public static let chatFill: Color = Color(
			.sRGB, red: 28.0 / 255.0, green: 30.0 / 255.0, blue: 38.0 / 255.0, opacity: 0.66)
		/// The leader card's violet tint (Revision 3 surface 6).
		public static let leaderTint: Color = Theme.violet.opacity(0.16)
		/// The leader card's violet rim, PAPER-SPINE item 11 "violet border
		/// 60%". The card is content, so the rim is a border, not the glass
		/// `rim`.
		public static let leaderBorder: Color = Theme.violet.opacity(0.6)
		/// Transcript bubbles (Revision 3 surface 2). Call site:
		/// `Chat/TurnView.swift`.
		public static let userBubble: Color = Theme.violet.opacity(0.35)
		public static let agentBubble: Color = Color(.sRGB, white: 1, opacity: 0.06)
		/// The Lead++ strip (Revision 3 surface 2). Call site:
		/// `Chat/LeadPlusStrip.swift`.
		public static let leadPlusStrip: Color = Theme.violet.opacity(0.18)
	}

	/// Shell geometry from PAPER-SPINE Revision 3, in points.
	///
	/// Revision 3's radii are panels 22, capsules 999 and nested controls
	/// concentric. There is no capsule token: a capsule is drawn with
	/// `Capsule()`, which is the same shape without the magic number.
	public enum Metric {
		public static let panelRadius: CGFloat = 22
		public static let barRadius: CGFloat = 26
		public static let edgeInset: CGFloat = 16
		public static let navigatorInset: CGFloat = 12
		public static let chatWidth: CGFloat = 410
		public static let navigatorWidth: CGFloat = 300
		public static let surfaceTop: CGFloat = 48
		public static let missionBarHeight: CGFloat = 52
		public static let barGap: CGFloat = 12
		public static let hoverEdge: CGFloat = 6
		/// A divider rule, 1 pt. Distinct from `Theme.Glass.rimWidth`: the
		/// glass rim is part of the material and a rule is not, so changing
		/// one must never change the other.
		public static let ruleWidth: CGFloat = 1
		/// The shell's hit floor, matching `SpineMetrics.standard.minHitHeight`.
		public static let minHitHeight: CGFloat = 26
		/// The chat header's leader avatar.
		public static let headerAvatar: CGFloat = 28
		/// Uppercase tag tracking: BRIEF's 0.08em at 10 pt.
		public static let tagTracking: CGFloat = 0.8
		/// Canvas node radii (content, not glass).
		public static let leaderCardRadius: CGFloat = 12
		public static let leadCardRadius: CGFloat = 10
		public static let agentRowRadius: CGFloat = 8
		/// Padding inside the chat panel, which sets its nested radii.
		public static let chatPadding: CGFloat = 12

		/// Nested-control radius: the outer radius minus the padding, floored
		/// so glass never takes a hard corner.
		public static func concentric(outer: CGFloat, padding: CGFloat) -> CGFloat {
			max(outer - padding, 6)
		}
	}
}
