import Foundation
import SwiftUI

/// Node-view models (T10.6): the lead card's mission summary and the agent
/// row's full-fidelity copy. Layout is pure: no `Store`, no bare `Date()`.
public struct LeadCardModel: Sendable, Equatable {
	public let numberText, name, stateLabel, ageText: String
	public let stateColor: Color
	public let ledBy, attention: String?
	public let crown: Bool
	/// What a closed mission is remembered by: `Merged · closed 10d`, the
	/// recorded disposition and how long ago it closed. PAPER-SPINE
	/// artboard 1 item 3 draws the closed node as
	/// `#296 Slack digest bot · Merged · closed 10d`, so the word is the
	/// disposition (`Merged`, `Abandoned`, or `Archived` when the Node
	/// recorded none), never the state label `Closed`, and the age is
	/// measured from `closedAt`, not from when the mission started. Just the
	/// word when the Node stamped no `closedAt`; nil while the mission is
	/// open.
	public let closedText: String?

	public init(mission: Mission, lead: Agent?, leaderName: String, now: Date) {
		numberText = "#\(mission.number)"
		name = mission.name
		stateLabel = CanvasStyle.label(for: mission.state)
		ageText = Self.ageText(createdAt: mission.createdAt, now: now)
		stateColor = CanvasStyle.color(for: mission.state)
		attention = mission.attention
		if mission.state == .closed {
			let disposition = CanvasStyle.label(for: mission.disposition)
			closedText = mission.closedAt.map {
				"\(disposition) · closed \(Self.closedAgeText(closedAt: $0, now: now))"
			} ?? disposition
		} else {
			closedText = nil
		}
		if case .leader = mission.lead {
			crown = true
			ledBy = "led by \(leaderName)"
		} else {
			crown = false
			ledBy = lead.map { "led by \($0.name)" }
		}
	}

	/// Coarsest age bucket: minutes under an hour, hours under a day, days
	/// under a week, whole weeks beyond ("25m", "2h", "3d", "2w").
	/// How long ago a mission closed: minutes, hours, then days, and days
	/// all the way out — PAPER-SPINE artboard 1 item 3 and Revision 2 read
	/// `closed 10d`, `closed 11d`, `closed 12d`, never `closed 1w`. A
	/// closed mission is remembered by the day it closed on; only a live
	/// mission's own age coarsens to whole weeks.
	private static func closedAgeText(closedAt: Date, now: Date) -> String {
		let seconds = max(0, now.timeIntervalSince(closedAt))
		let minutes = Int(seconds / 60)
		if minutes < 60 { return "\(minutes)m" }
		let hours = Int(seconds / 3600)
		if hours < 24 { return "\(hours)h" }
		return "\(Int(seconds / 86400))d"
	}

	private static func ageText(createdAt: Date, now: Date) -> String {
		let seconds = max(0, now.timeIntervalSince(createdAt))
		let minutes = Int(seconds / 60)
		if minutes < 60 { return "\(minutes)m" }
		let hours = Int(seconds / 3600)
		if hours < 24 { return "\(hours)h" }
		let days = Int(seconds / 86400)
		if days < 7 { return "\(days)d" }
		return "\(days / 7)w"
	}
}

public struct AgentRowModel: Sendable, Equatable {
	public init(agent: Agent) {
		sigil = Sigil(name: agent.name)
		stateColor = CanvasStyle.color(for: agent.state)
		name = agent.name
		task = agent.task
		stateLabel = CanvasStyle.label(for: agent.state)
		model = agent.model
		accessGlyph = agent.access == .readOnly ? "eye" : "pencil"
		activity = agent.state == .running ? agent.activity?.text : nil
		isRunning = agent.state == .running
	}

	public let sigil: Sigil
	public let stateColor: Color
	public let name, task, stateLabel, model, accessGlyph: String
	public let activity: String?
	/// Running rows are the taller ones (they carry the activity line), so
	/// the row view and `AgentStack` size them the same way through
	/// `SpineMetrics.rowHeight(running:)`.
	public let isRunning: Bool
}
