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

	/// Shell geometry from PAPER-SPINE Revision 3, in points.
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

		/// Nested-control radius: the outer radius minus the padding, floored
		/// so glass never takes a hard corner.
		public static func concentric(outer: CGFloat, padding: CGFloat) -> CGFloat {
			max(outer - padding, 6)
		}
	}
}
