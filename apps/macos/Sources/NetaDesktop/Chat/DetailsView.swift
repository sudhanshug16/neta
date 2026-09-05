import SwiftUI

/// The Details inspector view (11-desktop-chat T11.7).
///
/// The title and rows come from `DetailsModel`; this view only places them.
/// `.replacing` fills the panel with a back control to the transcript;
/// `.beside` sits beside it, so it shows no back control. There is no tab
/// bar here: Details is the one action on the header's Details button.
public struct DetailsView: View {
	private let selection: Selection
	private let store: Store
	private let client: any NodeClient
	private let decision: DecisionRecord?
	private let placement: DetailsPlacement
	private let onBack: () -> Void
	@State private var actionError: String?
	@State private var confirmingArchive = false
	@State private var confirmingReset = false

	public init(
		selection: Selection, store: Store, client: any NodeClient, decision: DecisionRecord?,
		placement: DetailsPlacement, onBack: @escaping () -> Void
	) {
		self.selection = selection
		self.store = store
		self.client = client
		self.decision = decision
		self.placement = placement
		self.onBack = onBack
	}

	public var body: some View {
		Form {
			Section {
				if placement == .replacing {
					Button("Back to chat", systemImage: "chevron.left", action: onBack)
						.buttonStyle(.glass)
				}
				Text(DetailsModel.title(for: selection, store: store)).font(.headline)
			}
			Section("Session") {
				ForEach(visibleFields) { field in
					LabeledContent(field.label) {
						Text(field.value).font(field.mono ? Theme.mono(12, .regular) : .body)
							.multilineTextAlignment(.trailing).textSelection(.enabled)
					}
				}
			}
			if !technicalFields.isEmpty {
				Section { DisclosureGroup("Technical details") {
					ForEach(technicalFields) { field in
						LabeledContent(field.label) { Text(field.value).font(Theme.mono(11, .regular)).textSelection(.enabled) }
					}
				} }
			}
			if let actionError {
				Section { Text(actionError).foregroundStyle(.red) }
			}
			if resetSessionId != nil, !isResetRestricted {
				Section("Chat") {
					Button("Reset Chat", role: .destructive) { confirmingReset = true }
						.accessibilityIdentifier("details-reset-chat")
				}
			}
			if case .mission(let id) = selection, store.missionsById[id] != nil {
				Section("Actions") {
					Button(isPinned(id) ? "Unpin mission" : "Pin mission") {
						Task { await setPinned(id, pinned: !isPinned(id)) }
					}
					.accessibilityIdentifier("details-mission-pin")
				}
			}
			if case .agent(let id) = selection, let agent = store.agentsById[id], agent.state != .archived {
				Section("Actions") {
					Button("Archive agent", role: .destructive) {
						if agent.state == .starting || agent.state == .running { confirmingArchive = true }
						else { Task { await archive(id, confirmRunning: false) } }
					}
					.accessibilityIdentifier("details-agent-archive")
				}
			}
		}
		.confirmationDialog(
			"Archive this running agent?", isPresented: $confirmingArchive,
			titleVisibility: .visible
		) {
			if case .agent(let id) = selection {
				Button("Archive Running Agent", role: .destructive) {
					Task { await archive(id, confirmRunning: true) }
				}
				.accessibilityIdentifier("details-agent-archive-confirm")
			}
			Button("Cancel", role: .cancel) {}
		} message: {
			Text("Its active provider session will stop and its current work may be interrupted.")
		}
		.confirmationDialog(
			"Reset this chat?", isPresented: $confirmingReset, titleVisibility: .visible
		) {
			Button("Reset Chat", role: .destructive) { Task { await resetChat() } }
				.accessibilityIdentifier("details-reset-chat-confirm")
			Button("Cancel", role: .cancel) {}
		} message: {
			Text("The current response and pending messages will stop. A new empty provider conversation starts with the same role, project, provider, model, and access. The old transcript remains stored.")
		}
	}

	// MARK: - Private

	private var fields: [DetailsField] { DetailsModel.fields(for: selection, store: store, decision: decision) }
	private var technicalFields: [DetailsField] { fields.filter { $0.mono && ($0.id.contains("path") || $0.id.contains("branch") || $0.id.contains("mission") || $0.id.contains("integration")) } }
	private var visibleFields: [DetailsField] { fields.filter { !technicalFields.contains($0) } }
	private var resetSessionId: SessionId? {
		switch selection {
		case .leader: return store.leader?.sessionId
		case .mission(let id):
			guard let mission = store.missionsById[id] else { return nil }
			switch mission.lead {
			case .leader: return store.leader?.sessionId
			case .agent(let agentId): return store.agentsById[agentId]?.sessionId
			}
		case .agent(let id): return store.agentsById[id]?.sessionId
		}
	}

	private var isResetRestricted: Bool {
		let agent: Agent?
		switch selection {
		case .agent(let id): agent = store.agentsById[id]
		case .mission(let id):
			if case .agent(let agentId) = store.missionsById[id]?.lead {
				agent = store.agentsById[agentId]
			} else { agent = nil }
		case .leader: agent = nil
		}
		return agent?.state == .queued || agent?.state == .archived
	}

	private func isPinned(_ missionId: MissionId) -> Bool {
		for event in store.currentEvents.reversed()
		where event.kind == .userPinned && event.missionId == missionId {
			if case .bool(let pinned) = event.data["pinned"] { return pinned }
		}
		return false
	}

	private func setPinned(_ missionId: MissionId, pinned: Bool) async {
		do {
			try await client.pin(missionId: missionId, pinned: pinned)
			actionError = nil
		} catch { actionError = error.localizedDescription }
	}

	private func archive(_ agentId: AgentId, confirmRunning: Bool) async {
		do {
			try await client.archiveAgent(agentId: agentId, confirmRunning: confirmRunning)
			actionError = nil
		} catch { actionError = error.localizedDescription }
	}

	private func resetChat() async {
		guard let sessionId = resetSessionId else { return }
		do {
			_ = try await client.resetChat(sessionId: sessionId)
			actionError = nil
		} catch { actionError = error.localizedDescription }
	}
}
