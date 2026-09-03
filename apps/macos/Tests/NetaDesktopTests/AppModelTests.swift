import XCTest
@testable import NetaDesktop

@MainActor
final class AppModelTests: XCTestCase {
	func testLoadSelectsTheProjectLeaderByDefault() async {
		let model = AppModel(client: PreviewSessionClient())

		await model.load()

		XCTAssertEqual(model.selectedProject?.id, PreviewData.projectID)
		XCTAssertEqual(model.selectedAgent?.id, PreviewData.leaderID)
	}

	func testProjectSelectionMovesChatToThatLeader() async throws {
		let model = AppModel(client: PreviewSessionClient())
		await model.load()
		let secondProject = try XCTUnwrap(model.projects.dropFirst().first)
		let secondLeader = try XCTUnwrap(secondProject.agents.first(where: { $0.kind == .leader }))

		model.selectProject(secondProject.id)

		XCTAssertEqual(model.selectedAgentID, secondLeader.id)
	}

	func testSendingAppendsUserAndAgentMessages() async throws {
		let model = AppModel(client: PreviewSessionClient())
		await model.load()
		let originalCount = try XCTUnwrap(model.selectedAgent?.messages.count)
		model.draft = "Build the canvas"

		model.sendDraft()
		try await waitUntil { !model.isSending }

		XCTAssertEqual(model.selectedAgent?.messages.count, originalCount + 2)
		XCTAssertEqual(model.selectedAgent?.messages.suffix(2).first?.author, .user)
		XCTAssertEqual(model.selectedAgent?.messages.last?.author, .agent)
	}

	func testStopUpdatesTheSelectedAgent() async throws {
		let model = AppModel(client: PreviewSessionClient())
		await model.load()

		model.stopSelectedAgent()
		try await waitUntil { model.selectedAgent?.state == .paused }

		XCTAssertEqual(model.selectedAgent?.state, .paused)
	}

	func testArchiveLoadsReadOnlyTranscriptAndResumesIntoActiveSession() async throws {
		let client = ArchiveTestClient()
		let model = AppModel(client: client)

		await model.load()

		XCTAssertEqual(model.selectedProject?.lifecycle, .archived)
		XCTAssertEqual(model.selectedAgent?.messages.last?.text, "Saved worker output")
		model.resumeSelectedProject()
		try await waitUntil { model.selectedProject?.lifecycle == .active }
		XCTAssertEqual(model.selectedProjectID, "resumed-session")
	}

	private func waitUntil(
		timeout: Duration = .seconds(2),
		condition: @escaping @MainActor () -> Bool
	) async throws {
		let clock = ContinuousClock()
		let deadline = clock.now.advanced(by: timeout)
		while !condition() {
			if clock.now >= deadline {
				XCTFail("Timed out waiting for model state")
				return
			}
			try await Task.sleep(for: .milliseconds(20))
		}
	}
}

private actor ArchiveTestClient: AgentSessionClient {
	private var resumed = false

	func loadWorkspace() -> WorkspaceSnapshot {
		WorkspaceSnapshot(projects: resumed ? [Self.project(id: "resumed-session", lifecycle: .active)] : [])
	}

	func loadArchives() -> [NetaProject] {
		resumed ? [] : [Self.project(id: "archive:checkpoint", lifecycle: .archived)]
	}

	func loadMessages(projectID: String, agentID: String) -> [AgentMessage] {
		[AgentMessage(author: .agent, text: "Saved worker output")]
	}

	func send(_ text: String, projectID: String, agentID: String) {}
	func stop(projectID: String, agentID: String) {}
	func openProject(at path: String) {}

	func resumeProject(_ projectID: String) -> String {
		resumed = true
		return "resumed-session"
	}

	private static func project(id: String, lifecycle: ProjectLifecycle) -> NetaProject {
		NetaProject(
			id: id,
			name: "Archived Neta",
			path: "/workspace/neta",
			isOwned: lifecycle == .active,
			lifecycle: lifecycle,
			isResumable: lifecycle == .archived,
			agents: [
				NetaAgent(
					id: "leader",
					name: "Neta",
					role: "Leader",
					backend: "Codex",
					kind: .leader,
					state: lifecycle == .active ? .running : .done,
					position: CanvasPosition(x: 0, y: 0),
					messages: [],
					canChat: lifecycle == .active,
					canStop: lifecycle == .active
				),
			]
		)
	}
}
