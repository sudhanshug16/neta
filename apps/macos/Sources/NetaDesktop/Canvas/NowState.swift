import CoreGraphics
import Foundation
import Observation
import SwiftUI

/// Now state for the spine canvas (T10.8).
///
/// Two states per the manifesto: lit when the view is at the live edge, and
/// showing how far back the view is when it is not. `leaderOffScreen` drives
/// `OffScreenLeaderMarker`. The 09 `MissionBarView` renders the Now control
/// from this state; `jumpToNow` only stages a `jumpRequest` that T10.9
/// applies via `consumeJump()`. Pure reads of `TimeLens`: no `Store`, no
/// bare `Date()`.
@Observable @MainActor public final class NowState {
	public private(set) var isLive = true
	public private(set) var leaderOffScreen = false
	public private(set) var label = "Now"
	public private(set) var jumpRequest: TimeLens?

	public init() {}

	/// `isLive` when the live edge — wall-clock `now` mapped through the
	/// lens — sits at or inside the viewport's right edge (half a point of
	/// grace); otherwise `label` is `Now · <n> back` with `n` the coarsest
	/// of days, hours, minutes between `lens.t(viewport.maxX)` and `now`.
	/// On a synced lens (`options.now == now`) this equals comparing
	/// `lens.x(lens.options.now)`; using wall time keeps the control
	/// correct after a pan, which stages `options.now` behind wall time.
	/// `leaderOffScreen` is true exactly when `leader` does not intersect
	/// `viewport`.
	public func update(
		lens: TimeLens, viewport: CGRect, leader: CGRect, now: Date
	) {
		let nowMs = now.timeIntervalSince1970 * 1000
		isLive = lens.x(nowMs) <= viewport.maxX + 0.5
		if isLive {
			label = "Now"
		} else {
			label = "Now · \(Self.backText(nowMs - lens.t(Double(viewport.maxX)))) back"
		}
		leaderOffScreen = !leader.intersects(viewport)
	}

	/// Stages a lens re-anchored so the live edge sits at `viewport.maxX`,
	/// keeping the focus duration: the focus window shifts forward by
	/// `now - lens.t(viewport.maxX)` and `now` becomes the lens's `now`.
	public func jumpToNow(lens: TimeLens, viewport: CGRect, now: Date) {
		let nowMs = now.timeIntervalSince1970 * 1000
		let shift = nowMs - lens.t(Double(viewport.maxX))
		var options = lens.options
		options.now = nowMs
		options.focusStart += shift
		options.focusEnd += shift
		jumpRequest = TimeLens(options)
	}

	/// Returns the staged jump and clears it.
	public func consumeJump() -> TimeLens? {
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

/// The small marker inside the canvas for an off-screen leader (T10.8).
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
