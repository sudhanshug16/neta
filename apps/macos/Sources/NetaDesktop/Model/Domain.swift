import Foundation

/// Swift mirrors of every `docs/plan/01-domain.md` type.
///
/// Field names are identical to the TypeScript contract and to the Node wire
/// format, so the default key mapping applies: no per-type key maps and no
/// snake-case key strategies anywhere in this file. Dates
/// are `Date`; `NetaJSON` converts both ways as ISO 8601 with fractional
/// seconds in UTC. `EventKind` maps any unrecognised raw value to
/// `.unknown` and never throws, so a newer Node cannot crash an older app.

// MARK: - Ids

public typealias Ulid = String
public typealias MachineId = Ulid
public typealias WorkspaceId = String
public typealias MissionId = Ulid
public typealias AgentId = Ulid
public typealias SessionId = Ulid
public typealias TurnId = Ulid

// MARK: - Workspaces and machines

public enum WorkspaceKind: String, Codable, Hashable, Sendable {
	case git
	case folder
}

public struct WorkspaceRoot: Codable, Hashable, Sendable {
	public let machineId: MachineId
	public let path: String
}

public struct Workspace: Codable, Hashable, Sendable, Identifiable {
	public let id: WorkspaceId
	public let kind: WorkspaceKind
	public let name: String
	public let remote: String?
	public let roots: [WorkspaceRoot]
	public let createdAt: Date
}

public struct Machine: Codable, Hashable, Sendable, Identifiable {
	public let id: MachineId
	public let name: String
	public let createdAt: Date
}

// MARK: - Leader

public enum LeaderMode: String, Codable, Hashable, Sendable {
	case lead
	case leadPlus
}

public enum LeaderState: String, Codable, Hashable, Sendable {
	case idle
	case running
	case failed
}

public struct Leader: Codable, Hashable, Sendable {
	public let workspaceId: WorkspaceId
	public let machineId: MachineId
	/// The leader's personal name, drawn from the name pool when the leader
	/// was created. It is not the workspace's name.
	public let name: String
	public let sessionId: SessionId
	public let provider: String
	public let model: String
	public let mode: LeaderMode
	public let modeSince: Date
	public let modeActiveMs: Int
	public let activeMissionId: MissionId?
	public let state: LeaderState
}

// The memberwise initialiser stays available: this lives in an extension.
extension Leader {
	/// A leader record written before `name` existed arrives without the
	/// field. The Node backfills it on `workspace.open`, but the desktop
	/// only ever asks for a snapshot, so tolerate the gap here too: one
	/// missing string would otherwise fail the whole snapshot decode and
	/// leave an empty window with nothing said. An empty name reads as
	/// "Leader". Every other field stays required, and the keys are the
	/// verbatim field names, so this is no per-type key map.
	public init(from decoder: any Decoder) throws {
		let values = try decoder.container(keyedBy: AnyKey.self)
		workspaceId = try values.decode(WorkspaceId.self, forKey: AnyKey("workspaceId"))
		machineId = try values.decode(MachineId.self, forKey: AnyKey("machineId"))
		name = try values.decodeIfPresent(String.self, forKey: AnyKey("name")) ?? ""
		sessionId = try values.decode(SessionId.self, forKey: AnyKey("sessionId"))
		provider = try values.decode(String.self, forKey: AnyKey("provider"))
		model = try values.decode(String.self, forKey: AnyKey("model"))
		mode = try values.decode(LeaderMode.self, forKey: AnyKey("mode"))
		modeSince = try values.decode(Date.self, forKey: AnyKey("modeSince"))
		modeActiveMs = try values.decode(Int.self, forKey: AnyKey("modeActiveMs"))
		activeMissionId = try values.decodeIfPresent(MissionId.self, forKey: AnyKey("activeMissionId"))
		state = try values.decode(LeaderState.self, forKey: AnyKey("state"))
	}
}

// MARK: - Missions

public enum Access: String, Codable, Hashable, Sendable {
	case readOnly
	case readWrite
}

public enum MissionState: String, Codable, Hashable, Sendable {
	case running
	case blocked
	case failed
	case readyToClose
	case mergedNotClosed
	case closed
}

public enum Disposition: String, Codable, Hashable, Sendable {
	case merged
	case abandoned
}

public struct MissionChange: Codable, Hashable, Sendable {
	public let at: Date
	public let text: String
	public let turnId: TurnId?
}

public struct Worktree: Codable, Hashable, Sendable {
	public let provider: String
	public let path: String
	public let branch: String
	public let base: String
}

public struct MissionIntegration: Codable, Hashable, Sendable {
	public let mergedAt: Date
	public let commit: String
	public let base: String
}

public enum MissionLead: Codable, Hashable, Sendable {
	case leader
	case agent(agentId: Ulid)

	public init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: AnyKey.self)
		switch try container.decode(String.self, forKey: AnyKey("kind")) {
		case "leader":
			self = .leader
		case "agent":
			self = .agent(agentId: try container.decode(Ulid.self, forKey: AnyKey("agentId")))
		case let kind:
			throw DecodingError.dataCorruptedError(
				forKey: AnyKey("kind"), in: container,
				debugDescription: "unknown MissionLead kind: \(kind)")
		}
	}

	public func encode(to encoder: Encoder) throws {
		var container = encoder.container(keyedBy: AnyKey.self)
		switch self {
		case .leader:
			try container.encode("leader", forKey: AnyKey("kind"))
		case .agent(let agentId):
			try container.encode("agent", forKey: AnyKey("kind"))
			try container.encode(agentId, forKey: AnyKey("agentId"))
		}
	}
}

public struct Mission: Codable, Hashable, Sendable, Identifiable {
	public let id: MissionId
	public let number: Int
	public let workspaceId: WorkspaceId
	public let machineId: MachineId
	public let name: String
	public let objective: String
	public let changes: [MissionChange]
	public let lead: MissionLead
	public let agentIds: [AgentId]
	public let access: Access
	public let worktree: Worktree?
	public let state: MissionState
	public let attention: String?
	public let createdAt: Date
	public let closedAt: Date?
	public let disposition: Disposition?
	public let closeReason: String?
	public let integration: MissionIntegration?
	public let continuesMissionId: MissionId?
}

extension Mission {
	/// The mission bar's inbox: `blocked | failed | readyToClose |
	/// mergedNotClosed`, per `needsPerson` in 01-domain.
	public var needsPerson: Bool {
		switch state {
		case .blocked, .failed, .readyToClose, .mergedNotClosed:
			return true
		case .running, .closed:
			return false
		}
	}
}

// MARK: - Agents

public enum AgentState: String, Codable, Hashable, Sendable {
	case queued
	case starting
	case running
	case blocked
	case failed
	case completed
	case interrupted
	case archived
}

public struct AgentActivity: Codable, Hashable, Sendable {
	public let text: String
	public let at: Date
}

public struct Agent: Codable, Hashable, Sendable, Identifiable {
	public let id: AgentId
	public let missionId: MissionId
	public let workspaceId: WorkspaceId
	public let name: String
	public let task: String
	public let access: Access
	public let provider: String
	public let model: String
	public let skills: [String]
	public let sessionId: SessionId
	public let canSpawn: Bool
	public let state: AgentState
	public let stateBefore: AgentState?
	public let activity: AgentActivity?
	public let pendingQuestion: String?
	public let startedAt: Date
	public let endedAt: Date?
	public let outcome: String?
}

public struct DecisionRecord: Codable, Hashable, Sendable {
	public let objective: String
	public let whyLeadInsufficient: String
	public let missionId: MissionId
	public let worktreePath: String?
	public let mutationKind: String
	public let estimatedFiles: Int
	public let validation: String
	public let estimatedMinutes: Int
	public let externalEffects: String
}

// MARK: - Events

public enum EventKind: Codable, Hashable, Sendable {
	case missionCreated
	case missionChanged
	case missionBlocked
	case missionUnblocked
	case missionFailed
	case missionReadyToClose
	case missionMerged
	case missionClosed
	case agentSpawned
	case agentFinished
	case agentArchived
	case leaderModeChanged
	case leaderModeReminder
	case baseIntegrated
	case charterChanged
	case nodeRestarted
	case userPinned
	case unknown(String)

	public init(rawValue: String) {
		switch rawValue {
		case "mission.created": self = .missionCreated
		case "mission.changed": self = .missionChanged
		case "mission.blocked": self = .missionBlocked
		case "mission.unblocked": self = .missionUnblocked
		case "mission.failed": self = .missionFailed
		case "mission.readyToClose": self = .missionReadyToClose
		case "mission.merged": self = .missionMerged
		case "mission.closed": self = .missionClosed
		case "agent.spawned": self = .agentSpawned
		case "agent.finished": self = .agentFinished
		case "agent.archived": self = .agentArchived
		case "leader.modeChanged": self = .leaderModeChanged
		case "leader.modeReminder": self = .leaderModeReminder
		case "base.integrated": self = .baseIntegrated
		case "charter.changed": self = .charterChanged
		case "node.restarted": self = .nodeRestarted
		case "user.pinned": self = .userPinned
		case let other: self = .unknown(other)
		}
	}

	public var rawValue: String {
		switch self {
		case .missionCreated: return "mission.created"
		case .missionChanged: return "mission.changed"
		case .missionBlocked: return "mission.blocked"
		case .missionUnblocked: return "mission.unblocked"
		case .missionFailed: return "mission.failed"
		case .missionReadyToClose: return "mission.readyToClose"
		case .missionMerged: return "mission.merged"
		case .missionClosed: return "mission.closed"
		case .agentSpawned: return "agent.spawned"
		case .agentFinished: return "agent.finished"
		case .agentArchived: return "agent.archived"
		case .leaderModeChanged: return "leader.modeChanged"
		case .leaderModeReminder: return "leader.modeReminder"
		case .baseIntegrated: return "base.integrated"
		case .charterChanged: return "charter.changed"
		case .nodeRestarted: return "node.restarted"
		case .userPinned: return "user.pinned"
		case .unknown(let raw): return raw
		}
	}

	public init(from decoder: Decoder) throws {
		self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
	}

	public func encode(to encoder: Encoder) throws {
		var container = encoder.singleValueContainer()
		try container.encode(rawValue)
	}
}

public enum DataValue: Codable, Hashable, Sendable {
	case string(String)
	case number(Double)
	case bool(Bool)
	case null

	public init(from decoder: Decoder) throws {
		let container = try decoder.singleValueContainer()
		if container.decodeNil() {
			self = .null
		} else if let value = try? container.decode(Bool.self) {
			self = .bool(value)
		} else if let value = try? container.decode(Double.self) {
			self = .number(value)
		} else {
			self = .string(try container.decode(String.self))
		}
	}

	public func encode(to encoder: Encoder) throws {
		var container = encoder.singleValueContainer()
		switch self {
		case .string(let value): try container.encode(value)
		case .number(let value): try container.encode(value)
		case .bool(let value): try container.encode(value)
		case .null: try container.encodeNil()
		}
	}
}

public struct Event: Codable, Hashable, Sendable {
	public let seq: Int
	public let at: Date
	public let workspaceId: WorkspaceId
	public let kind: EventKind
	public let missionId: MissionId?
	public let agentId: AgentId?
	public let sessionId: SessionId?
	public let turnId: TurnId?
	public let data: [String: DataValue]
}

// MARK: - Conversation

public enum Role: String, Codable, Hashable, Sendable {
	case user
	case agent
	case system
}

public enum BlockKind: String, Codable, Hashable, Sendable {
	case text
	case thought
	case tool
	case diff
	case status
	case plan
	case usage
}

public struct Block: Codable, Hashable, Sendable {
	public let turnId: TurnId
	public let seq: Int
	public let at: Date
	public let role: Role
	public let kind: BlockKind
	public let text: String
	public let data: [String: DataValue]?
}

public struct Turn: Codable, Hashable, Sendable, Identifiable {
	public let id: TurnId
	public let sessionId: SessionId
	public let startedAt: Date
	public let endedAt: Date?
	public let role: Role
	public let cancelled: Bool?
}

// MARK: - Snapshot

/// 04's `SnapshotResult`, field for field. One snapshot replaces the
/// client's whole cache; there is no revision protocol.
public struct Snapshot: Codable, Hashable, Sendable {
	public let machine: Machine
	public let workspaces: [Workspace]
	public let leaders: [Leader]
	public let missions: [Mission]
	public let hasOlder: Bool
	public let agents: [Agent]
	public let completedCounts: [Ulid: Int]
	public let events: [Event]
	public let attention: [Mission]
	public let windowDays: Int
	public let protocolVersion: Int
	public let at: Date
}

// MARK: - Notifications

/// Mirrors 04's `state` payload: `{kind, record}` where the record is the
/// mission, agent or leader named by `kind`.
public enum StateChangeKind: String, Codable, Hashable, Sendable {
	case mission
	case agent
	case leader
}

public enum StateRecord: Codable, Hashable, Sendable {
	case mission(Mission)
	case agent(Agent)
	case leader(Leader)
}

public struct StateChange: Codable, Hashable, Sendable {
	public let kind: StateChangeKind
	public let record: StateRecord

	public init(kind: StateChangeKind, record: StateRecord) {
		self.kind = kind
		self.record = record
	}

	public init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: AnyKey.self)
		let kind = try container.decode(StateChangeKind.self, forKey: AnyKey("kind"))
		self.kind = kind
		switch kind {
		case .mission:
			self.record = .mission(try container.decode(Mission.self, forKey: AnyKey("record")))
		case .agent:
			self.record = .agent(try container.decode(Agent.self, forKey: AnyKey("record")))
		case .leader:
			self.record = .leader(try container.decode(Leader.self, forKey: AnyKey("record")))
		}
	}

	public func encode(to encoder: Encoder) throws {
		var container = encoder.container(keyedBy: AnyKey.self)
		try container.encode(kind, forKey: AnyKey("kind"))
		switch record {
		case .mission(let mission):
			try container.encode(mission, forKey: AnyKey("record"))
		case .agent(let agent):
			try container.encode(agent, forKey: AnyKey("record"))
		case .leader(let leader):
			try container.encode(leader, forKey: AnyKey("record"))
		}
	}
}

/// Mirrors 04's `turn` payload: `{sessionId, turn?, block?}`.
public struct TurnChange: Codable, Hashable, Sendable {
	public let sessionId: SessionId
	public let turn: Turn?
	public let block: Block?
	public let inbox: InboxMessage?
	public init(sessionId: SessionId, turn: Turn? = nil, block: Block? = nil, inbox: InboxMessage? = nil) {
		self.sessionId = sessionId; self.turn = turn; self.block = block; self.inbox = inbox
	}
}

public struct InboxMessage: Codable, Hashable, Sendable {
	public let id: Ulid
	public let sessionId: SessionId
	public let createdAt: Date
	public let text: String
	public let attachments: [PromptAttachment]
	public let status: String
	public let deliveredAt: Date?
	public let turnId: TurnId?
}

/// Mirrors 04's `node` payload: `{phase}`.
public enum NodePhase: String, Codable, Hashable, Sendable {
	case restarting
	case stopping
}

public struct NodeLifecycle: Codable, Hashable, Sendable {
	public let phase: NodePhase
}

public enum NodeNotification: Sendable {
	case event(Event)
	case state(StateChange)
	case turn(TurnChange)
	case node(NodeLifecycle)
	case glance(GlanceChange)
	case terminalOutput(sessionId: SessionId, output: TerminalOutput)
	case terminalState(TerminalState)
}

// MARK: - JSON

/// The Node wire format: ISO 8601 with fractional seconds, UTC, both ways.
public enum NetaJSON {
	public static let decoder: JSONDecoder = {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .custom { decoder in
			let container = try decoder.singleValueContainer()
			let string = try container.decode(String.self)
			if let date = NetaJSON.date(from: string) {
				return date
			}
			throw DecodingError.dataCorruptedError(
				in: container, debugDescription: "invalid ISO 8601 date: \(string)")
		}
		return decoder
	}()

	public static let encoder: JSONEncoder = {
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .custom { date, encoder in
			var container = encoder.singleValueContainer()
			try container.encode(NetaJSON.string(from: date))
		}
		return encoder
	}()

	/// Parses what the encoder writes (fractional seconds, `Z`) and, for
	/// tolerance, the same shape without fractions.
	public static func date(from string: String) -> Date? {
		formatter(fractional: true).date(from: string)
			?? formatter(fractional: false).date(from: string)
	}

	public static func string(from date: Date) -> String {
		formatter(fractional: true).string(from: date)
	}

	private static func formatter(fractional: Bool) -> ISO8601DateFormatter {
		let formatter = ISO8601DateFormatter()
		formatter.timeZone = TimeZone(secondsFromGMT: 0)
		formatter.formatOptions =
			fractional
			? [.withInternetDateTime, .withFractionalSeconds]
			: [.withInternetDateTime]
		return formatter
	}
}

/// A coding key over the verbatim field names. Custom decoding goes through
/// here so this file never needs per-type key maps.
private struct AnyKey: CodingKey {
	var stringValue: String
	var intValue: Int?

	init(_ string: String) {
		self.stringValue = string
		self.intValue = nil
	}

	init(stringValue: String) {
		self.init(stringValue)
	}

	init(intValue: Int) {
		self.stringValue = String(intValue)
		self.intValue = intValue
	}
}
