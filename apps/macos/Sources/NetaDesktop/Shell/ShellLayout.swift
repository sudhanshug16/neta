import Foundation

/// Every floating surface's frame, from a pure function (09-desktop-shell T9.7).
///
/// The canvas fills the window and nothing narrows or pushes it: overlays are
/// positioned above the canvas from this layout, and the canvas is told which
/// rects are covered (see `covered`) so no floating surface steals trackpad
/// panning. Geometry follows PAPER-SPINE Revision 3 through `Theme.Metric`:
/// the toolbar capsule sits top centre 12 down, the chat is 410 wide on the
/// right (16 inset, top 48) and hidden only by the person, the mission bar is
/// a 52-tall capsule 16 inset along the bottom, the navigator a 300-wide
/// overlay 12 inset in the chat's band.
public struct ShellLayout: Equatable, Sendable {
	/// Always the full window.
	public let canvas: CGRect
	/// Nil when the person hid the chat.
	public let chat: CGRect?
	public let missionBar: CGRect
	/// Nil when the navigator is closed.
	public let navigator: CGRect?

	public init(canvas: CGRect, chat: CGRect?, missionBar: CGRect, navigator: CGRect?) {
		self.canvas = canvas
		self.chat = chat
		self.missionBar = missionBar
		self.navigator = navigator
	}

	/// The rects floating surfaces cover, in window coordinates: navigator,
	/// chat, then the mission bar. The canvas (10) must treat panning that
	/// starts inside these as glass interaction, never canvas panning.
	public var covered: [CGRect] {
		[navigator, chat, missionBar].compactMap { $0 }
	}

	/// Frames every surface for `size`:
	/// - mission bar: `x = 16`, `width = size.width - 32`, `height = 52`,
	///   `maxY = size.height - 16`.
	/// - chat: `width = min(410, size.width - 360)`,
	///   `x = size.width - 16 - width`, `y = 48`,
	///   `maxY = missionBar.minY - 12`.
	/// - navigator: `x = 12`, `width = 300`, the chat's vertical band.
	/// - canvas: the full window.
	public static func compute(size: CGSize, chatVisible: Bool, navigatorVisible: Bool) -> ShellLayout {
		let edge = Theme.Metric.edgeInset
		let missionBar = CGRect(
			x: edge,
			y: size.height - edge - Theme.Metric.missionBarHeight,
			width: size.width - edge * 2,
			height: Theme.Metric.missionBarHeight)
		let bandMinY = Theme.Metric.surfaceTop
		let bandHeight = max(0, missionBar.minY - Theme.Metric.barGap - bandMinY)
		let chatWidth = max(0, min(Theme.Metric.chatWidth, size.width - 360))
		let chat: CGRect? =
			chatVisible
			? CGRect(
				x: size.width - edge - chatWidth,
				y: bandMinY,
				width: chatWidth,
				height: bandHeight)
			: nil
		let navigator: CGRect? =
			navigatorVisible
			? CGRect(
				x: Theme.Metric.navigatorInset,
				y: bandMinY,
				width: Theme.Metric.navigatorWidth,
				height: bandHeight)
			: nil
		return ShellLayout(
			canvas: CGRect(origin: .zero, size: size),
			chat: chat,
			missionBar: missionBar,
			navigator: navigator)
	}
}
