import Foundation
import Observation

/// What the person is looking at (09-desktop-shell T9.6).
///
/// `Selection` names a chat destination; `ShellState` holds the person's view
/// of it. The app never owns a session: `sessionId(in:)` resolves the
/// selection against the `Store` into the Node-owned ACP session the chat
/// surface must open. Views own nothing.
public enum Selection: Hashable, Sendable {
	case leader
	case mission(Ulid)
	case agent(Ulid)
}

/// The person's view: selection, overlays, focus and time zoom.
///
/// `Store` holds Node data; this holds the view. Selecting only changes
/// `selection` — the chat surface switches content via `sessionId(in:)` and
/// `chatVisible` moves only under the person's own toggle, never under
/// `select`.
///
/// Escape handling lives here (`dismissOverlay`) but is wired in the root
/// view, which lands in T9.7: `RootView` must add
/// `.onExitCommand { shell.dismissOverlay() }` (`dismissOverlay` is
/// `@discardableResult` so it fits the `() -> Void` slot with `_ =`).
@Observable @MainActor public final class ShellState {
	/// Time-zoom bounds and step: 0.25...4.0 in x1.25 steps.
	public static let minZoom = 0.25
	public static let maxZoom = 4.0
	public static let zoomStep = 1.25

	public var selection: Selection = .leader
	public var chatVisible = true
	public var navigatorVisible = false
	public var composerFocused = false
	/// Always within `minZoom...maxZoom`: `zoomIn`, `zoomOut` and `fit` are
	/// the only movers and each clamps. (No `didSet` clamp: assigning the
	/// property inside its own observer re-enters the `@Observable` setter
	/// and overflows the stack.)
	public var timeZoom: Double = 1.0
	/// Bumped by every `fit()`; the spine canvas (10) observes it.
	public private(set) var fitRequested = 0

	public init() {}

	/// Selects a destination. Never touches `chatVisible`: selecting opens
	/// that session's chat by content (via `sessionId(in:)`), and only the
	/// person's toggle hides the surface.
	public func select(_ selection: Selection) {
		self.selection = selection
	}

	/// Resolves the selection to the ACP session the chat must open:
	/// `.leader` to the leader's session, `.mission(id)` to that mission's
	/// lead session (the leader's session when the lead is the leader),
	/// `.agent(id)` to that agent's session. An unknown id returns nil and
	/// falls the selection back to `.leader`.
	public func sessionId(in store: Store) -> Ulid? {
		switch selection {
		case .leader:
			return store.leader?.sessionId
		case .mission(let id):
			guard let mission = store.missionsById[id] else {
				selection = .leader
				return nil
			}
			switch mission.lead {
			case .leader:
				return store.leader?.sessionId
			case .agent(let agentId):
				guard let agent = store.agentsById[agentId] else {
					selection = .leader
					return nil
				}
				return agent.sessionId
			}
		case .agent(let id):
			guard let agent = store.agentsById[id] else {
				selection = .leader
				return nil
			}
			return agent.sessionId
		}
	}

	public func toggleNavigator() {
		navigatorVisible.toggle()
	}

	/// Escape: closes the navigator, else releases composer focus. Returns
	/// false when nothing was open.
	@discardableResult
	public func dismissOverlay() -> Bool {
		if navigatorVisible {
			navigatorVisible = false
			return true
		}
		if composerFocused {
			composerFocused = false
			return true
		}
		return false
	}

	/// Resets zoom to 1.0 and tells the canvas to fit its time window.
	public func fit() {
		timeZoom = 1.0
		fitRequested += 1
	}

	public func zoomIn() {
		timeZoom = Self.clampZoom(timeZoom * Self.zoomStep)
	}

	public func zoomOut() {
		timeZoom = Self.clampZoom(timeZoom / Self.zoomStep)
	}

	/// Whole percent for the toolbar (`100` at 1.0), in mono tabular digits.
	public var zoomPercent: Int {
		Int((timeZoom * 100).rounded())
	}

	// MARK: - Private

	private static func clampZoom(_ value: Double) -> Double {
		min(max(value, minZoom), maxZoom)
	}
}
