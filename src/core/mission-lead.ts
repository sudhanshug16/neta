import type { Agent, Leader, Mission } from "./types.ts";

// Apply to assignments and active restoration, not historical registry reads.
export function distinctMissionLead(
	mission: Mission,
	leader: Pick<Leader, "sessionId"> | undefined,
	lead: Pick<Agent, "id" | "sessionId"> | undefined,
): boolean {
	if (mission.lead.kind !== "agent") return false;
	if (!leader) return true;
	return (
		mission.lead.agentId !== leader.sessionId &&
		(lead === undefined || (lead.id !== leader.sessionId && lead.sessionId !== leader.sessionId))
	);
}
