import XCTest
@testable import NetaDesktop

final class PreviewSessionClientTests: XCTestCase {
	func testWorkspaceSelectsLeaderData() async throws {
		let client = PreviewSessionClient()
		let workspace = await client.loadWorkspace()
		let project = try XCTUnwrap(workspace.projects.first)
		let leader = try XCTUnwrap(project.agents.first(where: { $0.kind == .leader }))

		XCTAssertEqual(project.name, "Neta")
		XCTAssertEqual(leader.name, "Neta")
		XCTAssertEqual(leader.state, .running)
	}

	func testEveryAgentAcceptsMessages() async throws {
		let client = PreviewSessionClient()
		let workspace = await client.loadWorkspace()
		let project = try XCTUnwrap(workspace.projects.first)

		for agent in project.agents {
			try await client.send("Status?", projectID: project.id, agentID: agent.id)
			let messages = try await client.loadMessages(projectID: project.id, agentID: agent.id)
			XCTAssertEqual(messages.last?.author, .agent)
			XCTAssertFalse(messages.last?.text.isEmpty == true)
		}
	}

	func testStopUpdatesAgentState() async throws {
		let client = PreviewSessionClient()

		try await client.stop(projectID: PreviewData.projectID, agentID: PreviewData.leaderID)
		let workspace = await client.loadWorkspace()
		let leader = workspace.projects.first?.agents.first

		XCTAssertEqual(leader?.state, .paused)
	}
}
