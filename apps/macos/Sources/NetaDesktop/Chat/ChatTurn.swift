import Foundation

/// One conversation turn with its streamed blocks (11-desktop-chat T11.1).
public struct ChatTurn: Identifiable, Equatable, Sendable {
	public let id: TurnId
	public let role: Role
	public let startedAt: Date
	public var endedAt: Date?
	public var cancelled: Bool
	public var blocks: [Block]

	public init(
		id: TurnId, role: Role, startedAt: Date,
		endedAt: Date? = nil, cancelled: Bool = false, blocks: [Block] = []
	) {
		self.id = id
		self.role = role
		self.startedAt = startedAt
		self.endedAt = endedAt
		self.cancelled = cancelled
		self.blocks = blocks
	}

	public var isOpen: Bool { endedAt == nil && !cancelled }
}

/// A one-shot request for the transcript to reveal a turn.
public struct ScrollRequest: Equatable, Sendable {
	public let turnId: TurnId
	public let flash: Bool

	public init(turnId: TurnId, flash: Bool) {
		self.turnId = turnId
		self.flash = flash
	}
}
