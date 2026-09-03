// The one payload that replaces a client's cache. Pure selection over the
// `NodeStore`/`NodeAcp` ports: missions (every open one plus closed ones
// inside the window), agents (all live ones plus the 8 most recently ended
// completed per mission), the last 200 events per workspace, and the
// attention inbox newest first.
import { needsPerson } from "../core/state.ts";
import { nowIso } from "../core/time.ts";
import type { Agent, Leader, Mission, MissionId, Workspace, WorkspaceId } from "../core/types.ts";
import { NodeError, PROTOCOL_VERSION, type SnapshotResult } from "./protocol.ts";
import type { NodeContext, NodeHandlers } from "./server.ts";

export const DEFAULT_WINDOW_DAYS = 14;
export const COMPLETED_PER_MISSION = 8;
export const EVENTS_PER_WORKSPACE = 200;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function buildSnapshot(
	ctx: NodeContext,
	params: { workspaceId?: WorkspaceId; windowDays?: number },
): Promise<SnapshotResult> {
	const windowDays = params.windowDays ?? DEFAULT_WINDOW_DAYS;
	const cutoff = new Date(Date.now() - windowDays * MS_PER_DAY).toISOString();
	const missions = ctx.store.listMissions(params.workspaceId);
	const selected: Mission[] = [];
	let hasOlder = false;
	for (const mission of missions) {
		if (mission.state !== "closed" || mission.closedAt === undefined || mission.closedAt >= cutoff) {
			selected.push(mission);
		} else {
			hasOlder = true;
		}
	}
	const workspaces: Workspace[] =
		params.workspaceId === undefined
			? ctx.store.listWorkspaces()
			: [ctx.store.getWorkspace(params.workspaceId)].filter((w): w is Workspace => w !== undefined);
	const leaders =
		params.workspaceId === undefined
			? ctx.store.listLeaders()
			: [ctx.store.getLeader(params.workspaceId)].filter((l): l is Leader => l !== undefined);
	const agents: Agent[] = [];
	const completedCounts: Record<MissionId, number> = {};
	for (const mission of selected) {
		const completed: Agent[] = [];
		for (const agent of ctx.store.listAgents(mission.id)) {
			if (agent.state === "archived") {
				continue;
			}
			if (agent.state === "completed") {
				completed.push(agent);
			} else {
				agents.push(agent);
			}
		}
		if (completed.length > 0) {
			completedCounts[mission.id] = completed.length;
			completed.sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
			agents.push(...completed.slice(0, COMPLETED_PER_MISSION));
		}
	}
	const events: SnapshotResult["events"] = [];
	for (const workspace of workspaces) {
		// No cursor: the port returns the most recent page in chronological
		// order, so the first page is the last 200 events.
		const page = await ctx.store.listEvents({ workspaceId: workspace.id, limit: EVENTS_PER_WORKSPACE });
		events.push(...page.events);
	}
	const attention = selected.filter((mission) => needsPerson(mission));
	attention.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return {
		machine: ctx.store.machine(),
		workspaces,
		leaders,
		missions: selected,
		hasOlder,
		agents,
		completedCounts,
		events,
		attention,
		windowDays,
		protocolVersion: PROTOCOL_VERSION,
		at: nowIso(),
	};
}

function parseSnapshotParams(params: unknown): { workspaceId?: WorkspaceId; windowDays?: number } {
	if (params === undefined) {
		return {};
	}
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		throw new NodeError("INVALID_PARAMS", "snapshot takes { workspaceId?, windowDays? }");
	}
	const { workspaceId, windowDays } = params as { workspaceId?: unknown; windowDays?: unknown };
	if (workspaceId !== undefined && typeof workspaceId !== "string") {
		throw new NodeError("INVALID_PARAMS", "snapshot workspaceId is a string");
	}
	if (windowDays !== undefined && (typeof windowDays !== "number" || !Number.isFinite(windowDays) || windowDays < 0)) {
		throw new NodeError("INVALID_PARAMS", "snapshot windowDays is a non-negative number");
	}
	return { workspaceId, windowDays };
}

export const snapshotHandlers: NodeHandlers = {
	snapshot: (ctx, params) => buildSnapshot(ctx, parseSnapshotParams(params)),
};
