import AppKit
import SwiftUI

/// State colour, Product-language labels, mission emphasis and the WCAG
/// contrast floor.
///
/// Colours are the BRIEF.md semantic mapping via `Theme`; nothing here
/// invents a token. Status is never colour alone: every colour has a label.
public enum CanvasStyle {
	public static let contrastFloor: Double = 4.5

	// MARK: - State colour

	public static func color(for state: MissionState) -> Color {
		switch state {
		case .running: Theme.mint
		case .blocked: Theme.amber
		case .failed: Theme.red
		case .readyToClose, .mergedNotClosed: Theme.blue
		case .closed: Theme.textSecondary
		}
	}

	public static func color(for state: AgentState) -> Color {
		switch state {
		case .running: Theme.mint
		case .blocked: Theme.amber
		case .failed: Theme.red
		case .completed: Theme.green
		case .queued, .starting, .interrupted, .archived: Theme.textSecondary
		}
	}

	// MARK: - Product-language labels

	public static func label(for state: MissionState) -> String {
		switch state {
		case .running: "Running"
		case .blocked: "Blocked"
		case .failed: "Failed"
		case .readyToClose: "Ready to close"
		case .mergedNotClosed: "Merged · not closed"
		case .closed: "Closed"
		}
	}

	/// A closed mission's recorded disposition, as the word the closed node
	/// and the navigator's archive rows both print. `Archived` when the Node
	/// recorded none.
	public static func label(for disposition: Disposition?) -> String {
		switch disposition {
		case .merged: "Merged"
		case .abandoned: "Abandoned"
		case nil: "Archived"
		}
	}

	public static func label(for state: AgentState) -> String {
		switch state {
		case .starting: "Starting"
		case .queued: "Queued"
		case .running: "Running"
		case .blocked: "Blocked"
		case .failed: "Failed"
		case .completed: "Completed"
		case .interrupted: "Interrupted"
		case .archived: "Archived"
		}
	}

	// MARK: - Emphasis

	/// PAPER-SPINE item 4: blocked and failed stay at full emphasis at any
	/// age; closed fades to 0.55; ready-to-close, merged-not-closed and any
	/// mission with no running or starting agent sit at 0.70; a mission with
	/// live work is full.
	public static func emphasis(mission: Mission, agents: [Agent]) -> Double {
		switch mission.state {
		case .blocked, .failed:
			return 1.0
		case .closed:
			return 0.55
		case .readyToClose, .mergedNotClosed:
			return 0.70
		case .running:
			let hasLive = agents.contains {
				$0.state == .running || $0.state == .starting || $0.state == .queued
			}
			return hasLive ? 1.0 : 0.70
		}
	}

	// MARK: - Faded text and contrast

	/// Paint `base` at `emphasis` opacity over `bg` (opaque result),
	/// raising the effective alpha until the result meets `contrastFloor`
	/// against `bg`, so faded text never drops below the WCAG floor.
	public static func text(
		_ base: Color, emphasis: Double, over bg: Color
	) -> Color {
		let own = rgba(base)
		var alpha = min(max(emphasis, 0), 1) * own.a
		while alpha < 1 {
			if contrastRatio(opaque(composite(base: own, alpha: alpha, over: bg)), over: bg)
				>= contrastFloor
			{
				break
			}
			alpha = min(1, alpha + 0.01)
		}
		return opaque(composite(base: own, alpha: alpha, over: bg))
	}

	/// WCAG contrast ratio of `fg` flattened over `bg` (translucent layers
	/// composite down onto `Theme.ground` first).
	public static func contrastRatio(_ fg: Color, over bg: Color) -> Double {
		let back = flattened(rgba(bg), over: rgba(Theme.ground))
		let front = flattened(rgba(fg), over: back)
		let hi = max(luminance(front), luminance(back))
		let lo = min(luminance(front), luminance(back))
		return (hi + 0.05) / (lo + 0.05)
	}

	// MARK: - Colour math (sRGB tuples)

	private struct RGBA {
		var r, g, b, a: Double
	}

	private static func rgba(_ color: Color) -> RGBA {
		let ns = NSColor(color).usingColorSpace(.sRGB) ?? NSColor(color)
		var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
		ns.getRed(&r, green: &g, blue: &b, alpha: &a)
		return RGBA(r: Double(r), g: Double(g), b: Double(b), a: Double(a))
	}

	private static func flattened(_ fg: RGBA, over bg: RGBA) -> RGBA {
		let a = fg.a + bg.a * (1 - fg.a)
		guard a > 0 else { return RGBA(r: 0, g: 0, b: 0, a: 0) }
		return RGBA(
			r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
			g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
			b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
			a: a)
	}

	private static func composite(base: RGBA, alpha: Double, over bg: Color) -> RGBA {
		var layered = base
		layered.a = alpha
		return flattened(layered, over: rgba(bg))
	}

	private static func opaque(_ c: RGBA) -> Color {
		Color(.sRGB, red: c.r, green: c.g, blue: c.b, opacity: 1)
	}

	/// WCAG relative luminance of an (effectively opaque) colour.
	private static func luminance(_ c: RGBA) -> Double {
		func linear(_ v: Double) -> Double {
			v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
		}
		return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
	}
}
