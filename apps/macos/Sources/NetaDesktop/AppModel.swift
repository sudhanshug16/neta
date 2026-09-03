import Foundation

@MainActor
final class AppModel: ObservableObject {
	@Published private(set) var projects: [NetaProject] = []
	@Published private(set) var archivedProjects: [NetaProject] = []
	@Published var selectedProjectID: String?
	@Published var selectedAgentID: String?
	@Published var draft = ""
	@Published private(set) var isLoading = false
	@Published private(set) var isSending = false
	@Published private(set) var isResuming = false
	@Published var errorMessage: String?

	private let client: any AgentSessionClient

	init(client: any AgentSessionClient) {
		self.client = client
	}

	var selectedProject: NetaProject? {
		projects.first(where: { $0.id == selectedProjectID }) ?? archivedProjects.first(where: { $0.id == selectedProjectID })
	}

	var selectedAgent: NetaAgent? {
		selectedProject?.agents.first(where: { $0.id == selectedAgentID })
	}

	func load() async {
		guard projects.isEmpty else { return }
		isLoading = true
		defer { isLoading = false }
		do {
			async let active = client.loadWorkspace().projects
			async let archives = client.loadArchives()
			projects = try await active
			archivedProjects = try await archives
			selectProject(projects.first?.id ?? archivedProjects.first?.id)
			await refreshMessages()
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func monitor() async {
		await load()
		while !Task.isCancelled {
			try? await Task.sleep(for: .seconds(5))
			guard !Task.isCancelled else { return }
			await refreshWorkspace()
			await refreshMessages()
		}
	}

	func selectProject(_ id: String?) {
		selectedProjectID = id
		selectedAgentID = (projects + archivedProjects)
			.first(where: { $0.id == id })?
			.agents.first(where: { $0.kind == .leader })?.id
	}

	func selectAgent(_ id: String) {
		selectedAgentID = id
		Task { await refreshMessages() }
	}

	func sendDraft() {
		let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty, !isSending, selectedAgent?.canChat == true,
			let projectID = selectedProjectID,
			let agentID = selectedAgentID
		else { return }

		draft = ""
		isSending = true
		Task {
			defer { isSending = false }
			do {
				try await client.send(text, projectID: projectID, agentID: agentID)
				await refreshWorkspace()
				await refreshMessages()
			} catch {
				errorMessage = error.localizedDescription
			}
		}
	}

	func stopSelectedAgent() {
		guard let projectID = selectedProjectID, let agent = selectedAgent, agent.canStop else { return }
		Task {
			do {
				try await client.stop(projectID: projectID, agentID: agent.id)
				await refreshWorkspace()
				await refreshMessages()
			} catch {
				errorMessage = error.localizedDescription
			}
		}
	}

	func openProject(at path: String) {
		isLoading = true
		Task {
			defer { isLoading = false }
			do {
				try await client.openProject(at: path)
				await refreshWorkspace(selectPath: path)
				await refreshArchives()
			} catch {
				errorMessage = error.localizedDescription
			}
		}
	}

	func resumeSelectedProject() {
		guard let project = selectedProject, project.lifecycle == .archived, project.isResumable, !isResuming else { return }
		isResuming = true
		Task {
			defer { isResuming = false }
			do {
				let sessionID = try await client.resumeProject(project.id)
				await refreshWorkspace()
				await refreshArchives()
				selectProject(sessionID)
				await refreshMessages()
			} catch {
				errorMessage = error.localizedDescription
			}
		}
	}

	func refreshWorkspace(selectPath: String? = nil) async {
		do {
			let previousProject = selectedProjectID
			let previousAgent = selectedAgentID
			let previousActiveIDs = Set(projects.map(\.id))
			let snapshot = try await client.loadWorkspace()
			if projects != snapshot.projects { projects = snapshot.projects }
			if !previousActiveIDs.subtracting(Set(projects.map(\.id))).isEmpty {
				await refreshArchives()
			}
			if let selectPath, let project = projects.first(where: { $0.path == selectPath }) {
				selectProject(project.id)
			} else if let previousProject, projects.contains(where: { $0.id == previousProject }) {
				let nextAgent = projects.first(where: { $0.id == previousProject })?.agents.contains(where: { $0.id == previousAgent }) == true
					? previousAgent
					: projects.first(where: { $0.id == previousProject })?.agents.first?.id
				if selectedAgentID != nextAgent { selectedAgentID = nextAgent }
			} else if let previousProject, archivedProjects.contains(where: { $0.id == previousProject }) {
				let archived = archivedProjects.first(where: { $0.id == previousProject })
				let nextAgent = archived?.agents.contains(where: { $0.id == previousAgent }) == true
					? previousAgent
					: archived?.agents.first?.id
				if selectedAgentID != nextAgent { selectedAgentID = nextAgent }
			} else if let firstProject = projects.first ?? archivedProjects.first {
				selectProject(firstProject.id)
			} else if selectedProjectID != nil || selectedAgentID != nil {
				selectedProjectID = nil
				selectedAgentID = nil
			}
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func refreshArchives() async {
		do {
			let archives = try await client.loadArchives()
			if archivedProjects != archives { archivedProjects = archives }
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	func refreshMessages() async {
		guard let projectID = selectedProjectID, let agentID = selectedAgentID else { return }
		do {
			let messages = try await client.loadMessages(projectID: projectID, agentID: agentID)
			if selectedAgent?.messages != messages {
				updateAgent(agentID, in: projectID) { $0.messages = messages }
			}
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	private func updateAgent(_ agentID: String, in projectID: String, change: (inout NetaAgent) -> Void) {
		if let projectIndex = projects.firstIndex(where: { $0.id == projectID }),
			let agentIndex = projects[projectIndex].agents.firstIndex(where: { $0.id == agentID })
		{
			change(&projects[projectIndex].agents[agentIndex])
			return
		}
		guard let projectIndex = archivedProjects.firstIndex(where: { $0.id == projectID }),
			let agentIndex = archivedProjects[projectIndex].agents.firstIndex(where: { $0.id == agentID })
		else { return }
		change(&archivedProjects[projectIndex].agents[agentIndex])
	}
}
