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

	public init() {}

	/// `isLive` when the newest item's x sits at or inside the viewport's
	/// right edge (half a point of grace); otherwise `label` is
	/// `Now · <n> back` with `n` the coarsest of days, hours, minutes from
	/// the newest item back to `now`. `leaderOffScreen` is true exactly when
	/// `leader` does not intersect `viewport`.
	public func update(
		index: SpineIndex, scrollX: CGFloat, viewport: CGRect,
		leader: CGRect, now: Date
	) {
		guard index.count > 0 else {
			isLive = true
			label = "Now"
			leaderOffScreen = !leader.intersects(viewport)
			return
		}
		let newestX = index.x(index.count - 1) - scrollX + viewport.minX
		isLive = newestX <= viewport.maxX + 0.5
		if isLive {
			label = "Now"
		} else {
			let backMs =
				now.timeIntervalSince1970 * 1000 - index[index.count - 1].at
			label = "Now · \(Self.backText(max(0, backMs))) back"
		}
		leaderOffScreen = !leader.intersects(viewport)
	}

	/// Stages the `scrollX` putting the live edge at the viewport's right.
	public func jumpToNow(index: SpineIndex, viewport: CGRect) {
		jumpRequest = max(0, index.contentWidth - viewport.width)
	}

	/// Returns the staged jump and clears it.
	public func consumeJump() -> CGFloat? {
		let request = jumpRequest
		jumpRequest = nil
		return request
	}

	// MARK: - Private

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
