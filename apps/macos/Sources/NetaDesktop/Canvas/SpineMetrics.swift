import CoreGraphics

/// Canvas geometry constants for the desktop spine (T10.2).
///
/// All `CGFloat` values are points. Layout is pure: no `Store`, no bare
/// `Date()`, no SwiftUI state.
public struct SpineMetrics: Sendable, Equatable {
	public static let standard = SpineMetrics()

	public var leadCardWidth: CGFloat = 210
	public var leadCardHeight: CGFloat = 74
	public var leadAttentionHeight: CGFloat = 104
	public var closedNodeWidth: CGFloat = 132
	public var closedNodeHeight: CGFloat = 34
	public var agentRowWidth: CGFloat = 220
	public var agentRowHeight: CGFloat = 40
	public var runningRowHeight: CGFloat = 52
	public var chipHeight: CGFloat = 26
	public var rowGap: CGFloat = 5
	public var columnGap: CGFloat = 16
	public var leadGap: CGFloat = 10
	public var spineOffset: CGFloat = 90
	public var minHitHeight: CGFloat = 26
	public var checkpointClusterGap: CGFloat = 24

	public var completedShown: Int = 8
	public var maxLiveColumns: Int = 60
	public var maxChainWalk: Int = 512

	public init(
		leadCardWidth: CGFloat = 210,
		leadCardHeight: CGFloat = 74,
		leadAttentionHeight: CGFloat = 104,
		closedNodeWidth: CGFloat = 132,
		closedNodeHeight: CGFloat = 34,
		agentRowWidth: CGFloat = 220,
		agentRowHeight: CGFloat = 40,
		runningRowHeight: CGFloat = 52,
		chipHeight: CGFloat = 26,
		rowGap: CGFloat = 5,
		columnGap: CGFloat = 16,
		leadGap: CGFloat = 10,
		spineOffset: CGFloat = 90,
		minHitHeight: CGFloat = 26,
		checkpointClusterGap: CGFloat = 24,
		completedShown: Int = 8,
		maxLiveColumns: Int = 60,
		maxChainWalk: Int = 512
	) {
		self.leadCardWidth = leadCardWidth
		self.leadCardHeight = leadCardHeight
		self.leadAttentionHeight = leadAttentionHeight
		self.closedNodeWidth = closedNodeWidth
		self.closedNodeHeight = closedNodeHeight
		self.agentRowWidth = agentRowWidth
		self.agentRowHeight = agentRowHeight
		self.runningRowHeight = runningRowHeight
		self.chipHeight = chipHeight
		self.rowGap = rowGap
		self.columnGap = columnGap
		self.leadGap = leadGap
		self.spineOffset = spineOffset
		self.minHitHeight = minHitHeight
		self.checkpointClusterGap = checkpointClusterGap
		self.completedShown = completedShown
		self.maxLiveColumns = maxLiveColumns
		self.maxChainWalk = maxChainWalk
	}
}
