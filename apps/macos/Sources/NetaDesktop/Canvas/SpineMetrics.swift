import CoreGraphics

/// Canvas geometry constants for the desktop spine (T10.2).
///
/// All `CGFloat` values are points. Layout is pure: no `Store`, no bare
/// `Date()`, no SwiftUI state.
public struct SpineMetrics: Sendable, Equatable {
	public static let standard = SpineMetrics()

	public var leadCardWidth: CGFloat = 210
	/// Node heights are the rendered heights of the node views, measured
	/// with `NSHostingView.fittingSize` for the worst case each view can
	/// draw (a two-line mission name, a two-line attention note, a two-line
	/// task, an activity line) and asserted in `NodeViewTests`. A rect
	/// smaller than its view is not a smaller node: `.position` centres, so
	/// the view simply paints over its neighbours, which is what put an
	/// agent row across its own lead card.
	public var leadCardHeight: CGFloat = 112
	public var leadAttentionHeight: CGFloat = 148
	/// The workspace leader's card, which carries one line of name and one
	/// of subtitle and never grows.
	public var leaderCardHeight: CGFloat = 74
	/// The workspace leader's card is wider than a mission's: PAPER-SPINE
	/// item 11 draws `Halden` and `Workspace leader` as one line each beside
	/// a 44 pt avatar and the LEAD++ chip, and "Workspace leader" measures
	/// 89 pt at 10/500. At `leadCardWidth` the text column is 61 pt and the
	/// subtitle wrapped onto two lines.
	public var leaderCardWidth: CGFloat = 240
	/// A closed mission's faded remnant: "Closed missions: lead node only,
	/// 180 px wide" (PAPER-SPINE Revision 4), widened by 20 pt.
	///
	/// `LeadCardView.collapsedBody` draws two lines inside it — number and
	/// name, then the closing line — because the artboard's single line
	/// (`#296 Slack digest bot · Merged · closed 10d`) spends 157 pt of 180
	/// on everything but the name. Two lines fix that for every closed name
	/// in the design's dataset but one: `Password reset rate limits`
	/// (artboard 1 item 3) measures 188 pt with its number and padding. The
	/// BRIEF.md MUST that nodes "show their FULL task name" outranks the
	/// round number, so the node takes 200 — still visibly narrower and a
	/// third the height of the 210 pt live lead card, so the remnant still
	/// reads as subordinate. Beyond 200 the name truncates and the permanent
	/// number carries the identity.
	public var closedNodeWidth: CGFloat = 200
	public var closedNodeHeight: CGFloat = 34
	public var agentRowWidth: CGFloat = 220
	public var agentRowHeight: CGFloat = 68
	public var runningRowHeight: CGFloat = 84
	public var chipHeight: CGFloat = 26
	public var rowGap: CGFloat = 10
	public var leadGap: CGFloat = 10
	public var spineOffset: CGFloat = 90
	public var minHitHeight: CGFloat = 26

	public var completedShown: Int = 8
	public var maxLiveColumns: Int = 60

	/// One agent row's height: running rows carry the mono activity line, so
	/// they are the taller ones. The single rule `AgentStack` places rows by
	/// and `AgentRowView` draws to, so a row can never overflow its rect.
	public func rowHeight(running: Bool) -> CGFloat {
		running ? runningRowHeight : agentRowHeight
	}

	/// One lead card's height: an attention note makes it the taller one.
	/// `SpinePlacement.cardRect` and `LeadCardView` both read this.
	public func cardHeight(attention: Bool) -> CGFloat {
		attention ? leadAttentionHeight : leadCardHeight
	}

	public init(
		leadCardWidth: CGFloat = 210,
		leadCardHeight: CGFloat = 112,
		leadAttentionHeight: CGFloat = 148,
		leaderCardHeight: CGFloat = 74,
		leaderCardWidth: CGFloat = 240,
		closedNodeWidth: CGFloat = 200,
		closedNodeHeight: CGFloat = 34,
		agentRowWidth: CGFloat = 220,
		agentRowHeight: CGFloat = 68,
		runningRowHeight: CGFloat = 84,
		chipHeight: CGFloat = 26,
		rowGap: CGFloat = 10,
		leadGap: CGFloat = 10,
		spineOffset: CGFloat = 90,
		minHitHeight: CGFloat = 26,
		completedShown: Int = 8,
		maxLiveColumns: Int = 60
	) {
		self.leadCardWidth = leadCardWidth
		self.leadCardHeight = leadCardHeight
		self.leadAttentionHeight = leadAttentionHeight
		self.leaderCardHeight = leaderCardHeight
		self.leaderCardWidth = leaderCardWidth
		self.closedNodeWidth = closedNodeWidth
		self.closedNodeHeight = closedNodeHeight
		self.agentRowWidth = agentRowWidth
		self.agentRowHeight = agentRowHeight
		self.runningRowHeight = runningRowHeight
		self.chipHeight = chipHeight
		self.rowGap = rowGap
		self.leadGap = leadGap
		self.spineOffset = spineOffset
		self.minHitHeight = minHitHeight
		self.completedShown = completedShown
		self.maxLiveColumns = maxLiveColumns
	}
}
