import { expect, test } from "bun:test";
import { distinctMissionLead } from "../src/core/mission-lead.ts";
import type { Agent, Leader, Mission } from "../src/core/types.ts";

test("mission lead assignment rejects actor and session aliases without changing historical records", () => {
	const leader = { sessionId: "workspace-session" } as Leader;
	const lead = { id: "mission-actor", sessionId: "mission-session" } as Agent;
	const mission = { lead: { kind: "agent", agentId: lead.id } } as Mission;
	expect(distinctMissionLead(mission, leader, lead)).toBe(true);
	expect(
		distinctMissionLead({ ...mission, lead: { kind: "agent", agentId: leader.sessionId } }, leader, undefined),
	).toBe(false);
	expect(distinctMissionLead(mission, leader, { ...lead, sessionId: leader.sessionId })).toBe(false);
	expect(distinctMissionLead({ ...mission, lead: { kind: "leader" } }, leader, undefined)).toBe(false);
});
