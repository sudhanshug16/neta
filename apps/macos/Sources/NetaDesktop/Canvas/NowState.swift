import CoreGraphics
import Foundation
import Observation
import SwiftUI

/// Now state for the spine canvas (T10.9).
///
/// Two states per the manifesto: lit when the view is at the live edge, and
/// showing how far back the view is when it is not. `leaderOffScreen` drives
/// `OffScreenLeaderMarker`. The 09 `MissionBarView` renders the Now control
/// from this state; `jumpToNow` only stages a `jumpRequest` that T10.10
/// applies via `consumeJump()`. Pure reads of `SpineIndex`: no `Store`, no
/// bare `Date()`.
@Observable @MainActor public final class NowState {
	public private(set) var isLive = true
	public private(set) var leaderOffScreen = false
	public private(set) var label = "Now"
	public private(set) var jumpRequest: CGFloat?
	/// The `scrollX` that last put the live edge at the usable right edge,
	/// `nil` until the canvas has resolved a frame. The mission bar's Now
	/// control jumps here without rebuilding the index; before the canvas
	/// has recorded an edge the control has nowhere to jump to and does
	/// nothing, rather than staging a jump to content x 0.
	public private(set) var liveScrollX: CGFloat?

	public init() {}

	/// Live means the leader card sits exactly at the live edge: its far
	/// edge on the canvas's usable right edge
	/// (`viewport.maxX - trailingInset`, half a point of grace either way).
	/// The test is two-sided on purpose — a leader pushed right is scrolled
	/// back in time, a leader left of the edge is the un-anchored far-left
	/// placement — and neither is Now.
	///
	/// It is a test on the time axis alone. Whether the leader card happens
	/// to be scrolled off vertically is the other signal, `leaderOffScreen`,
	/// which drives `OffScreenLeaderMarker`; a Now jump never touches
	/// `scrollY`, so folding it in here would report `Now · <n> back` for a
	/// view that has not moved in time and leave the control dead.
	///
	/// Off the edge, `label` is `Now · <n> back` with `n` the coarsest of
	/// days, hours, minutes from the time under the usable right edge back
	/// to `now`. An empty index has no time to be back from: with the leader
	/// in view it is live and reads `Now`.
	public func update(
		index: SpineIndex, scrollX: CGFloat, viewport: CGRect,
		leader: CGRect, now: Date, trailingInset: CGFloat = 0
	) {
		let offScreen = !leader.intersects(viewport)
		let rightEdge = viewport.maxX - trailingInset
		let live = abs(leader.maxX - rightEdge) <= 0.5
		let text: String
		if live || index.count == 0 {
			text = "Now"
		} else {
			let nowMs = now.timeIntervalSince1970 * 1000
			let at = SpineTicks.time(
				index: index, x: scrollX + (rightEdge - viewport.minX),
				now: nowMs)
			text = "Now · \(Self.backText(max(0, nowMs - at))) back"
		}
		set(isLive: live, label: text, offScreen: offScreen)
		let edge = SpinePlacement.liveScrollX(
			index: index, viewport: viewport, trailingInset: trailingInset)
		if liveScrollX != edge { liveScrollX = edge }
	}

	/// Stages the `scrollX` putting the live edge at the usable right edge.
	public func jumpToNow(
		index: SpineIndex, viewport: CGRect, trailingInset: CGFloat = 0
	) {
		jumpRequest = SpinePlacement.liveScrollX(
			index: index, viewport: viewport, trailingInset: trailingInset)
	}

	/// Stages a jump to the live edge recorded by the last `update`. The
	/// mission bar's Now control taps this; the canvas applies it. Before
	/// the canvas has recorded an edge there is no Now to jump to, so this
	/// does nothing.
	public func jumpToNow() {
		guard let liveScrollX else { return }
		jumpRequest = liveScrollX
	}

	/// Returns the staged jump and clears it.
	public func consumeJump() -> CGFloat? {
		let request = jumpRequest
		jumpRequest = nil
		return request
	}

	// MARK: - Private

	/// Writes only what changed: the canvas recomputes inside a layout pass,
	/// so an unconditional write would invalidate the view every frame.
	private func set(isLive live: Bool, label text: String, offScreen: Bool) {
		if isLive != live { isLive = live }
		if label != text { label = text }
		if leaderOffScreen != offScreen { leaderOffScreen = offScreen }
	}

	/// Coarsest whole unit of days, hours, minutes; at least one minute.
	static func backText(_ backMs: Double) -> String {
		if backMs >= 86_400_000 {
			return "\(max(1, Int(backMs / 86_400_000)))d"
		}
		if backMs >= 3_600_000 {
			return "\(max(1, Int(backMs / 3_600_000)))h"
		}
		return "\(max(1, Int(backMs / 60_000)))m"
	}
}

/// The small marker inside the canvas for an off-screen leader (T10.9).
///
/// Rendered only while `state.leaderOffScreen` is true. The parent overlays
/// this full-canvas; the pill hugs the trailing edge at
/// `viewport.maxX - trailingInset`, left of the chat surface, and `action`
/// jumps to Now. Hit target is 26 pt or taller.
public struct OffScreenLeaderMarker: View {
	private let state: NowState
	private let trailingInset: CGFloat
	private let action: () -> Void

	public init(
		state: NowState, trailingInset: CGFloat,
		action: @escaping () -> Void
	) {
		self.state = state
		self.trailingInset = trailingInset
		self.action = action
	}

	public var body: some View {
		if state.leaderOffScreen {
			HStack {
				Spacer(minLength: 0)
				Button(action: action) {
					HStack(spacing: 6) {
						Circle()
							.fill(Theme.violet)
							.frame(width: 8, height: 8)
						Text(state.label)
							.font(Theme.text(12, .medium))
							.foregroundStyle(Theme.textPrimary)
					}
					.padding(.horizontal, 10)
					.padding(.vertical, 5)
					.frame(minHeight: 26)
				}
				.buttonStyle(.plain)
				.netaGlass(.rounded(13))
				.accessibilityLabel("Jump to Now")
				.padding(.trailing, trailingInset)
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity)
		}
	}
}
