import CoreGraphics

/// One row in a mission's per-mission agent stack.
///
/// `offset` runs from the lead card's far edge; `height` excludes the
/// trailing `rowGap`.
public struct StackItem: Sendable, Equatable, Identifiable {
	public enum Content: Sendable, Equatable {
		case agent(AgentId)
		case moreCompleted(Int)
	}

	public let id: String
	public let content: Content
	public let offset: CGFloat
	public let height: CGFloat

	public init(id: String, content: Content, offset: CGFloat, height: CGFloat) {
		self.id = id
		self.content = content
		self.offset = offset
		self.height = height
	}
}

/// The per-mission stack: live agents first, then up to
/// `metrics.completedShown` completed agents, then a `+N completed` chip.
/// Archived agents are dropped. Layout is pure.
public struct AgentStack: Sendable, Equatable {
	public static let empty = AgentStack(items: [], height: 0, liveCount: 0, hiddenCompleted: 0)

	public let items: [StackItem]
	public let height: CGFloat
	public let liveCount: Int
	public let hiddenCompleted: Int

	public init(items: [StackItem], height: CGFloat, liveCount: Int, hiddenCompleted: Int) {
		self.items = items
		self.height = height
		self.liveCount = liveCount
		self.hiddenCompleted = hiddenCompleted
	}

	/// Attention-first priority for live agents: blocked, failed, running,
	/// starting, interrupted.
	private static func livePriority(_ state: AgentState) -> Int {
		switch state {
		case .blocked: return 0
		case .failed: return 1
		case .running: return 2
		case .starting: return 3
		case .interrupted: return 4
		case .completed, .archived: return Int.max
		}
	}

	public static func build(
		agents: [Agent], expanded: Bool, metrics: SpineMetrics
	) -> AgentStack {
		let live = agents.filter { $0.state != .archived && $0.state != .completed }.sorted {
			let pa = livePriority($0.state)
			let pb = livePriority($1.state)
			if pa != pb { return pa < pb }
			if $0.startedAt != $1.startedAt { return $0.startedAt < $1.startedAt }
			return $0.id < $1.id
		}
		let completed = agents.filter { $0.state == .completed }.sorted {
			switch ($0.endedAt, $1.endedAt) {
			case let (a?, b?):
				if a != b { return a > b }
			case (_?, nil):
				return true
			case (nil, _?):
				return false
			case (nil, nil):
				break
			}
			return $0.id < $1.id
		}

		let shownCompleted: [Agent]
		let hiddenCompleted: Int
		if expanded {
			shownCompleted = completed
			hiddenCompleted = 0
		} else {
			shownCompleted = Array(completed.prefix(metrics.completedShown))
			hiddenCompleted = max(0, completed.count - shownCompleted.count)
		}

		var items: [StackItem] = []
		items.reserveCapacity(live.count + shownCompleted.count + (hiddenCompleted > 0 ? 1 : 0))
		var offset: CGFloat = 0
		func append(id: String, content: StackItem.Content, rowHeight: CGFloat) {
			items.append(StackItem(id: id, content: content, offset: offset, height: rowHeight))
			offset += rowHeight + metrics.rowGap
		}
		for agent in live {
			let rowHeight: CGFloat =
				agent.state == .running ? metrics.runningRowHeight : metrics.agentRowHeight
			append(id: agent.id, content: .agent(agent.id), rowHeight: rowHeight)
		}
		for agent in shownCompleted {
			append(id: agent.id, content: .agent(agent.id), rowHeight: metrics.agentRowHeight)
		}
		if hiddenCompleted > 0 {
			append(
				id: "moreCompleted", content: .moreCompleted(hiddenCompleted),
				rowHeight: metrics.chipHeight)
		}

		let height: CGFloat = items.isEmpty ? 0 : offset - metrics.rowGap
		return AgentStack(
			items: items, height: height, liveCount: live.count,
			hiddenCompleted: hiddenCompleted)
	}
}
