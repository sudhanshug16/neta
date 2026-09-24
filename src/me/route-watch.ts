import type { NodeRuntime, NodeStore } from "../node/server.ts";
import { type MeStore, meSourceId } from "./store.ts";

const ROUTE_PROGRESS_MS = 120_000;
const ACTIVE_GRACE_MS = 600_000;

/** Evaluate pending routes once and return the next event-driven wake deadline. */
export async function watchStalledRoutes(input: {
	store: Pick<MeStore, "unprocessedRoutes" | "getSource" | "capture">;
	node: Pick<NodeStore, "getWorkspace" | "machine">;
	runtime: Pick<NodeRuntime, "isTurnActive">;
	now?: number;
}): Promise<{ captured: string[]; nextAt?: number }> {
	const now = input.now ?? Date.now();
	const captured: string[] = [];
	let nextAt: number | undefined;
	for (const route of await input.store.unprocessedRoutes()) {
		const workspaceId = route.workspaceId;
		const leaderSessionId = route.destinationSessionIds[0];
		if (!workspaceId || !leaderSessionId) continue;
		const workspace = input.node.getWorkspace(workspaceId);
		if (!workspace) continue;
		const eventId = `route-stalled:${route.id}`;
		const sourceId = meSourceId({ workspaceId, sessionId: leaderSessionId, kind: "failure", eventId });
		if (await input.store.getSource(sourceId)) continue;
		const startedAt = Date.parse(route.createdAt);
		const due = startedAt + ROUTE_PROGRESS_MS;
		const activeUntil = startedAt + ACTIVE_GRACE_MS;
		const active = input.runtime.isTurnActive?.(leaderSessionId) === true;
		if (due > now || (active && now < activeUntil)) {
			const candidate = due > now ? due : Math.min(now + ROUTE_PROGRESS_MS, activeUntil);
			nextAt = nextAt === undefined ? candidate : Math.min(nextAt, candidate);
			continue;
		}
		const source = await input.store.capture({
			id: "",
			workspaceId,
			machineId: input.node.machine().id,
			workspaceName: workspace.name,
			sessionId: leaderSessionId,
			actorKind: "leader",
			kind: "failure",
			at: new Date(now).toISOString(),
			text: `Neta route ${route.id} has no completed leader turn after ${ROUTE_PROGRESS_MS / 1000} seconds. Delivery status: ${route.status}. Leader turn active: ${active}. Work outcome is unknown.`,
			eventId,
			explicit: true,
			forceVisible: true,
			destinationSessionIds: [leaderSessionId],
		});
		captured.push(source.id);
	}
	return { captured, ...(nextAt === undefined ? {} : { nextAt }) };
}

/** Questions travel through parents; surface one if its next hop stops. */
export async function watchStalledQuestions(input: {
	store: Pick<MeStore, "hasEscalatedQuestion" | "getSource" | "capture">;
	node: Pick<NodeStore, "listAgents" | "getMission" | "getLeader" | "getWorkspace" | "machine">;
	runtime: Pick<NodeRuntime, "isTurnActive">;
	now?: number;
}): Promise<{ captured: string[]; nextAt?: number }> {
	const now = input.now ?? Date.now();
	const captured: string[] = [];
	let nextAt: number | undefined;
	const agents = input.node.listAgents();
	const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
	for (const agent of agents) {
		if (!agent.pendingQuestionId || !agent.pendingQuestion) continue;
		const mission = input.node.getMission(agent.missionId);
		const workspace = input.node.getWorkspace(agent.workspaceId);
		if (!mission || !workspace || mission.state === "closed") continue;
		if (await input.store.hasEscalatedQuestion(agent.workspaceId, agent.pendingQuestionId)) continue;
		const leader = input.node.getLeader(agent.workspaceId);
		const parentLead =
			!agent.canSpawn && mission.lead.kind === "agent" ? agentsById.get(mission.lead.agentId) : undefined;
		if (parentLead?.pendingQuestionId === agent.pendingQuestionId) continue;
		const parent = parentLead ?? leader;
		const sessionId = parent?.sessionId ?? agent.sessionId;
		const eventId = `question-stalled:${agent.id}:${agent.pendingQuestionId}`;
		const sourceId = meSourceId({ workspaceId: agent.workspaceId, sessionId, kind: "failure", eventId });
		if (await input.store.getSource(sourceId)) continue;
		const askedAt = Date.parse(agent.pendingQuestionAt ?? agent.startedAt);
		const startedAt = Number.isFinite(askedAt) ? askedAt : now;
		const due = startedAt + ROUTE_PROGRESS_MS;
		const activeUntil = startedAt + ACTIVE_GRACE_MS;
		const active = parent ? input.runtime.isTurnActive?.(parent.sessionId) === true : false;
		if (due > now || (active && now < activeUntil)) {
			const candidate = due > now ? due : Math.min(now + ROUTE_PROGRESS_MS, activeUntil);
			nextAt = nextAt === undefined ? candidate : Math.min(nextAt, candidate);
			continue;
		}
		const source = await input.store.capture({
			id: "",
			workspaceId: agent.workspaceId,
			machineId: input.node.machine().id,
			workspaceName: workspace.name,
			sessionId,
			actorKind: parentLead ? "missionLead" : leader ? "leader" : agent.canSpawn ? "missionLead" : "agent",
			kind: "failure",
			at: new Date(now).toISOString(),
			text: `Question ${agent.pendingQuestionId} from mission #${mission.number} ${agent.canSpawn ? "lead" : "worker"} ${agent.name} was not escalated by the ${parentLead ? "mission lead" : "workspace leader"} after ${ROUTE_PROGRESS_MS / 1000} seconds. Parent turn active: ${active}. Question: ${agent.pendingQuestion.slice(0, 1_200)}. The answer and work outcome are unknown.`,
			eventId,
			explicit: true,
			forceVisible: true,
			questionId: agent.pendingQuestionId,
			missionId: mission.id,
			destinationSessionIds: [
				...new Set(
					[agent.sessionId, parent?.sessionId, leader?.sessionId].filter((id): id is string => id !== undefined),
				),
			],
		});
		captured.push(source.id);
	}
	return { captured, ...(nextAt === undefined ? {} : { nextAt }) };
}
