import Foundation

enum AgentKind: String, Codable, Sendable {
	case leader
	case worker
}

enum AgentState: String, Codable, Sendable {
	case running
	case thinking
	case waiting
	case paused
	case done
	case failed

	var label: String {
		switch self {
		case .running: "Running"
		case .thinking: "Thinking"
		case .waiting: "Waiting"
		case .paused: "Paused"
		case .done: "Done"
		case .failed: "Failed"
		}
	}
}

enum MessageAuthor: String, Codable, Sendable {
	case user
	case agent
	case system
}

enum ProjectLifecycle: String, Codable, Sendable {
	case active
	case archived
}

enum WorkspaceAvailability: String, Codable, Sendable {
	case available
	case restorable
	case missing
}

struct ProjectWorkspace: Codable, Equatable, Sendable {
	var provider: String
	var branch: String?
	var availability: WorkspaceAvailability
}

struct AgentMessage: Identifiable, Codable, Equatable, Sendable {
	let id: UUID
	let author: MessageAuthor
	let text: String
	let createdAt: Date

	init(id: UUID = UUID(), author: MessageAuthor, text: String, createdAt: Date = Date()) {
		self.id = id
		self.author = author
		self.text = text
		self.createdAt = createdAt
	}
}

struct CanvasPosition: Codable, Equatable, Sendable {
	var x: Double
	var y: Double
}

struct NetaAgent: Identifiable, Codable, Equatable, Sendable {
	let id: String
	var name: String
	var role: String
	var backend: String
	var kind: AgentKind
	var state: AgentState
	var position: CanvasPosition
	var messages: [AgentMessage]
	var canChat: Bool
	var canStop: Bool
}

struct NetaProject: Identifiable, Codable, Equatable, Sendable {
	let id: String
	var name: String
	var path: String
	var isOwned: Bool
	var lifecycle: ProjectLifecycle = .active
	var updatedAt: Date = Date()
	var isResumable: Bool = false
	var workspace: ProjectWorkspace?
	var errorMessage: String?
	var agents: [NetaAgent]
}

struct WorkspaceSnapshot: Codable, Equatable, Sendable {
	var projects: [NetaProject]
}
