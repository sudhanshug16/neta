import type { Agent, Event, Leader, Mission, Workspace } from "../core/types.ts";
import type { MeSource, MeStore } from "./store.ts";

export interface MeEventSourceContext {
	workspaces: readonly Workspace[];
	leaders: readonly Leader[];
	agents: readonly Agent[];
	missions: readonly Mission[];
}

const relevantKinds = new Set<Event["kind"]>([
	"mission.blocked",
	"mission.failed",
	"mission.readyToClose",
	"mission.merged",
	"agent.finished",
	"routing.failed",
	"node.restarted",
]);

/** Capture only attention-relevant Neta lifecycle events; Luna makes the fallible feed decision later. */
export async function captureMeEvent(store: MeStore, event: Event, context: MeEventSourceContext): Promise<void> {
	if (!relevantKinds.has(event.kind)) return;
	const workspace = context.workspaces.find((item) => item.id === event.workspaceId);
	const leader = context.leaders.find((item) => item.workspaceId === event.workspaceId);
	if (!workspace || !leader) return;
	const agent = event.agentId ? context.agents.find((item) => item.id === event.agentId) : undefined;
	const mission = event.missionId ? context.missions.find((item) => item.id === event.missionId) : undefined;
	const sessionId = event.sessionId ?? agent?.sessionId ?? leader.sessionId;
	const actorKind = sessionId === leader.sessionId ? "leader" : agent?.canSpawn ? "missionLead" : "agent";
	const explicit = event.data.userEscalation === true || event.data.needsReply === true;
	const kind: MeSource["kind"] =
		event.kind === "mission.failed" || event.kind === "routing.failed" ? "failure" : "event";
	const text = [
		event.kind,
		mission ? `Mission #${mission.number}: ${mission.name}` : undefined,
		agent ? `Agent: ${agent.name}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	if (!text) return;
	const destinations = [...new Set([sessionId, leader.sessionId])];
	await store.capture({
		id: "",
		workspaceId: event.workspaceId,
		workspaceName: workspace.name,
		sessionId,
		actorKind,
		kind,
		at: event.at,
		text,
		eventId: `${event.workspaceId}:${event.seq}`,
		explicit,
		destinationSessionIds: destinations,
		...(event.missionId ? { missionId: event.missionId } : {}),
	});
}

/** Replay strictly after the durable high-water mark and checkpoint only after capture succeeds. */
export async function replayMeEvents(input: {
	store: MeStore;
	workspaceId: string;
	read: (sinceSeq: number, limit: number) => Promise<Event[]>;
	context: () => MeEventSourceContext;
}): Promise<number> {
	const checkpoint = (await input.store.getCheckpoint()).workspaces.find(
		(item) => item.workspaceId === input.workspaceId,
	);
	let sequence = checkpoint?.eventSeq ?? 0;
	let captured = 0;
	for (;;) {
		const events = await input.read(sequence, 200);
		if (!events.length) return captured;
		for (const event of events) {
			if (event.workspaceId !== input.workspaceId || event.seq <= sequence) continue;
			await captureMeEvent(input.store, event, input.context());
			sequence = event.seq;
			await input.store.setCheckpoint({
				workspaces: [{ workspaceId: input.workspaceId, eventSeq: sequence, turns: [] }],
			});
			if (relevantKinds.has(event.kind)) captured++;
		}
		if (events.length < 200) return captured;
	}
}
