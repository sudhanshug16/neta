import Foundation

protocol AgentSessionClient: Sendable {
	func loadWorkspace() async throws -> WorkspaceSnapshot
	func loadArchives() async throws -> [NetaProject]
	func loadMessages(projectID: String, agentID: String) async throws -> [AgentMessage]
	func send(_ text: String, projectID: String, agentID: String) async throws
	func stop(projectID: String, agentID: String) async throws
	func openProject(at path: String) async throws
	func resumeProject(_ projectID: String) async throws -> String
}

actor PreviewSessionClient: AgentSessionClient {
	private var workspace = PreviewData.workspace

	func loadWorkspace() -> WorkspaceSnapshot {
		workspace
	}

	func loadArchives() -> [NetaProject] {
		[]
	}

	func loadMessages(projectID: String, agentID: String) throws -> [AgentMessage] {
		guard let agent = workspace.projects.first(where: { $0.id == projectID })?.agents.first(where: { $0.id == agentID })
		else { throw SessionClientError.agentNotFound }
		return agent.messages
	}

	func send(_ text: String, projectID: String, agentID: String) async throws {
		try await Task.sleep(for: .milliseconds(260))
		guard let projectIndex = workspace.projects.firstIndex(where: { $0.id == projectID }),
			let agentIndex = workspace.projects[projectIndex].agents.firstIndex(where: { $0.id == agentID })
		else {
			throw SessionClientError.agentNotFound
		}
		workspace.projects[projectIndex].agents[agentIndex].messages.append(AgentMessage(author: .user, text: text))
		let agent = workspace.projects[projectIndex].agents[agentIndex]
		let response: String
		if agent.kind == .leader {
			response = "I have the brief. I’ll break it into bounded work and keep this canvas current as agents join."
		} else {
			response = "Understood. I’ll continue this work and report the next useful milestone here."
		}
		workspace.projects[projectIndex].agents[agentIndex].messages.append(AgentMessage(author: .agent, text: response))
	}

	func stop(projectID: String, agentID: String) throws {
		guard let projectIndex = workspace.projects.firstIndex(where: { $0.id == projectID }),
			let agentIndex = workspace.projects[projectIndex].agents.firstIndex(where: { $0.id == agentID })
		else {
			throw SessionClientError.agentNotFound
		}
		workspace.projects[projectIndex].agents[agentIndex].state = .paused
	}

	func openProject(at path: String) {
		let id = UUID().uuidString
		workspace.projects.append(NetaProject(
			id: id,
			name: URL(fileURLWithPath: path).lastPathComponent,
			path: path,
			isOwned: true,
			agents: [NetaAgent(
				id: "leader",
				name: "Neta",
				role: "Leader",
				backend: "Preview",
				kind: .leader,
				state: .running,
				position: CanvasPosition(x: 0, y: 0),
				messages: [],
				canChat: true,
				canStop: true
			)]
		))
	}

	func resumeProject(_ projectID: String) throws -> String {
		guard workspace.projects.contains(where: { $0.id == projectID }) else {
			throw SessionClientError.agentNotFound
		}
		return projectID
	}
}

enum SessionClientError: LocalizedError {
	case agentNotFound

	var errorDescription: String? {
		"The selected agent is no longer available."
	}
}

enum PreviewData {
	static let projectID = "preview-neta"
	static let leaderID = "leader"
	static let scoutID = "ro1"
	static let builderID = "rw2"
	static let reviewerID = "ro3"

	static let workspace = WorkspaceSnapshot(projects: [
		NetaProject(
			id: projectID,
			name: "Neta",
			path: "~/workspace/neta",
			isOwned: true,
			agents: [
				NetaAgent(
					id: leaderID,
					name: "Neta",
					role: "Leader",
					backend: "Codex",
					kind: .leader,
					state: .running,
					position: CanvasPosition(x: -0.16, y: -0.02),
					messages: [
						AgentMessage(
							author: .agent,
							text: "The project is ready. Tell me what outcome you want, and I’ll assemble the right team."
						),
					],
					canChat: true,
					canStop: true
				),
				NetaAgent(
					id: scoutID,
					name: "Mira",
					role: "Architecture scout",
					backend: "Claude",
					kind: .worker,
					state: .done,
					position: CanvasPosition(x: 0.34, y: -0.28),
					messages: [
						AgentMessage(author: .system, text: "Delegated by Neta"),
						AgentMessage(author: .agent, text: "I mapped the current ACP and session boundaries. The worker channel is ready for a native client adapter."),
					],
					canChat: true,
					canStop: false
				),
				NetaAgent(
					id: builderID,
					name: "Kite",
					role: "SwiftUI builder",
					backend: "Codex",
					kind: .worker,
					state: .thinking,
					position: CanvasPosition(x: 0.43, y: 0.18),
					messages: [
						AgentMessage(author: .system, text: "Delegated by Neta"),
						AgentMessage(author: .agent, text: "The canvas shell is in progress. I’m keeping rendering static between user events."),
					],
					canChat: true,
					canStop: true
				),
				NetaAgent(
					id: reviewerID,
					name: "Vale",
					role: "Performance reviewer",
					backend: "OpenCode",
					kind: .worker,
					state: .waiting,
					position: CanvasPosition(x: 0.20, y: 0.50),
					messages: [
						AgentMessage(author: .system, text: "Queued behind the first build"),
					],
					canChat: true,
					canStop: true
				),
			]
		),
		NetaProject(
			id: "preview-agent-bahi",
			name: "Agent Bahi",
			path: "~/workspace/agent-bahi",
			isOwned: true,
			agents: [
				NetaAgent(
					id: "leader",
					name: "Neta",
					role: "Leader",
					backend: "Codex",
					kind: .leader,
					state: .paused,
					position: CanvasPosition(x: -0.1, y: 0),
					messages: [AgentMessage(author: .system, text: "Session paused")],
					canChat: true,
					canStop: false
				),
			]
		),
	])
}
