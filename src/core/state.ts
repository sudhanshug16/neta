import type { Agent, AgentState, Mission, MissionState } from "./types.ts";

// Derives the mission state from the stored record, its agents and the latest
// observed integration. Precedence: closed beats merged beats failed beats
// blocked beats ready beats running.
//
// The marked-ready flag is the stored `mission.state`: the lead's ready tool
// call (workstream 05) writes `readyToClose`, and this function keeps it until
// a higher-precedence condition, closeout or merge moves the mission on.
export function deriveMissionState(
	mission: Mission,
	agents: Agent[],
	integration?: Mission["integration"],
): MissionState {
	if (mission.state === "closed" || mission.closedAt !== undefined) {
		return "closed";
	}
	if (mission.state === "mergedNotClosed" || (integration ?? mission.integration) !== undefined) {
		return "mergedNotClosed";
	}
	if (
		mission.state === "failed" ||
		(agents.some((a) => a.state === "failed") && !agents.some((a) => a.state === "running"))
	) {
		return "failed";
	}
	if (mission.state === "blocked" || agents.some((a) => a.state === "blocked" || a.pendingQuestion !== undefined)) {
		return "blocked";
	}
	if (mission.state === "readyToClose" || allDone(mission, agents)) {
		return "readyToClose";
	}
	return "running";
}

function allDone(mission: Mission, agents: Agent[]): boolean {
	if (agents.length === 0) {
		return false;
	}
	if (!agents.every((a) => a.state === "completed")) {
		return false;
	}
	const lead = mission.lead;
	if (lead.kind === "agent") {
		return agents.some((a) => a.id === lead.agentId && a.state === "completed");
	}
	return true;
}

const AGENT_TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
	queued: ["starting", "archived"],
	idle: ["running", "blocked", "completed", "failed", "interrupted", "archived"],
	starting: ["running", "idle", "failed", "interrupted"],
	running: ["idle", "blocked", "failed", "completed", "interrupted"],
	blocked: ["running", "failed", "interrupted", "archived"],
	failed: ["idle", "archived"],
	completed: ["idle", "archived"],
	interrupted: ["running", "archived"],
	archived: [],
};

export function canTransitionAgent(from: AgentState, to: AgentState): boolean {
	return AGENT_TRANSITIONS[from].includes(to);
}

// True for the states the mission bar shows first: they wait on a person.
export function needsPerson(mission: Mission): boolean {
	return (
		mission.state === "blocked" ||
		mission.state === "failed" ||
		mission.state === "readyToClose" ||
		mission.state === "mergedNotClosed"
	);
}

export function isWaiting(mission: Mission): boolean {
	return needsPerson(mission);
}
