// Registry handlers: paging over history and the small mutations. Every
// handler parses with `parseParams`, so bad params always give -32602.
// Mutations append one event and broadcast one `state`, and nothing else.
import { nowIso } from "../core/time.ts";
import type { LeaderMode, Mission, MissionState } from "../core/types.ts";
import { NodeError } from "./protocol.ts";
import type { NodeHandlers } from "./server.ts";

export type Validator<T> = (value: unknown, name: string) => T;

function invalid(name: string, want: string): NodeError {
	return new NodeError("INVALID_PARAMS", `${name} must be ${want}`);
}

export const asString: Validator<string> = (value, name) => {
	if (typeof value !== "string") {
		throw invalid(name, "a string");
	}
	return value;
};

export const asOptionalString: Validator<string | undefined> = (value, name) => {
	if (value === undefined) {
		return undefined;
	}
	return asString(value, name);
};

export const asNumber: Validator<number> = (value, name) => {
	if (typeof value !== "number") {
		throw invalid(name, "a number");
	}
	return value;
};

export const asOptionalNumber: Validator<number | undefined> = (value, name) => {
	if (value === undefined) {
		return undefined;
	}
	return asNumber(value, name);
};

export const asBoolean: Validator<boolean> = (value, name) => {
	if (typeof value !== "boolean") {
		throw invalid(name, "a boolean");
	}
	return value;
};

export const asOptionalBoolean: Validator<boolean | undefined> = (value, name) => {
	if (value === undefined) {
		return undefined;
	}
	return asBoolean(value, name);
};

// Every field goes through its validator; unknown fields are ignored. A
// missing required field fails its validator, so bad params give -32602.
export function parseParams<T extends Record<string, unknown>>(
	shape: { [K in keyof T]: Validator<T[K]> },
	params: unknown,
): T {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		throw new NodeError("INVALID_PARAMS", "params must be an object");
	}
	const record = params as Record<string, unknown>;
	const out = {} as T;
	for (const key of Object.keys(shape) as (keyof T)[]) {
		out[key] = shape[key](record[key as string], String(key));
	}
	return out;
}

const MISSION_STATES: readonly MissionState[] = [
	"running",
	"blocked",
	"failed",
	"readyToClose",
	"mergedNotClosed",
	"closed",
];

function asLimit(value: number | undefined, fallback: number, name: string): number {
	const limit = value ?? fallback;
	if (!Number.isInteger(limit) || limit < 1) {
		throw new NodeError("INVALID_PARAMS", `${name} is a positive integer`);
	}
	return limit;
}

// The `listMissions` port returns the whole registry slice, so the handler
// pages over it: filter, then resume after the mission id in `cursor`. The
// cursor is that id, passed back verbatim.
function pageMissions(
	missions: Mission[],
	o: { state?: string; from?: string; to?: string; limit: number; cursor?: string },
	method: string,
): { missions: Mission[]; nextCursor?: string } {
	if (o.state !== undefined && !(MISSION_STATES as readonly string[]).includes(o.state)) {
		throw new NodeError("INVALID_PARAMS", `${method} state is a MissionState`);
	}
	for (const [name, value] of [
		["from", o.from],
		["to", o.to],
	] as const) {
		if (value !== undefined && Number.isNaN(Date.parse(value))) {
			throw new NodeError("INVALID_PARAMS", `${method} ${name} is an ISO time`);
		}
	}
	const filtered = missions.filter(
		(mission) =>
			(o.state === undefined || mission.state === o.state) &&
			(o.from === undefined || mission.createdAt >= o.from) &&
			(o.to === undefined || mission.createdAt <= o.to),
	);
	let start = 0;
	if (o.cursor !== undefined) {
		const at = filtered.findIndex((mission) => mission.id === o.cursor);
		if (at < 0) {
			throw new NodeError("INVALID_PARAMS", `${method} cursor is unknown`);
		}
		start = at + 1;
	}
	const page = filtered.slice(start, start + o.limit);
	if (start + o.limit >= filtered.length) {
		return { missions: page };
	}
	const last = page[page.length - 1];
	if (last === undefined) {
		return { missions: page };
	}
	return { missions: page, nextCursor: last.id };
}

export const registryHandlers: NodeHandlers = {
	"workspace.list": (ctx) => {
		return Promise.resolve({ workspaces: ctx.store.listWorkspaces(), leaders: ctx.store.listLeaders() });
	},

	"missions.list": (ctx, params) => {
		const parsed = parseParams(
			{
				workspaceId: asString,
				state: asOptionalString,
				from: asOptionalString,
				to: asOptionalString,
				limit: asOptionalNumber,
				cursor: asOptionalString,
			},
			params,
		);
		return Promise.resolve(
			pageMissions(
				ctx.store.listMissions(parsed.workspaceId),
				{ ...parsed, limit: asLimit(parsed.limit, 50, "missions.list limit") },
				"missions.list",
			),
		);
	},

	"missions.get": (ctx, params) => {
		const parsed = parseParams({ missionId: asString }, params);
		const mission = ctx.store.getMission(parsed.missionId);
		if (mission === undefined) {
			throw new NodeError("NOT_FOUND", `no such mission: ${parsed.missionId}`);
		}
		return Promise.resolve({ mission, agents: ctx.store.listAgents(mission.id) });
	},

	"events.list": async (ctx, params) => {
		const parsed = parseParams(
			{
				workspaceId: asString,
				from: asOptionalString,
				to: asOptionalString,
				limit: asOptionalNumber,
				cursor: asOptionalString,
			},
			params,
		);
		const page = await ctx.store.listEvents({
			workspaceId: parsed.workspaceId,
			from: parsed.from,
			to: parsed.to,
			limit: asLimit(parsed.limit, 200, "events.list limit"),
			cursor: parsed.cursor,
		});
		return page.nextCursor === undefined
			? { events: page.events }
			: { events: page.events, nextCursor: page.nextCursor };
	},

	"mission.pin": async (ctx, params) => {
		const parsed = parseParams({ missionId: asString, pinned: asBoolean }, params);
		const mission = ctx.store.getMission(parsed.missionId);
		if (mission === undefined) {
			throw new NodeError("NOT_FOUND", `no such mission: ${parsed.missionId}`);
		}
		// Pinning changes no Mission field: the event is the whole mutation.
		await ctx.store.appendEvent({
			workspaceId: mission.workspaceId,
			kind: "user.pinned",
			missionId: mission.id,
			data: { pinned: parsed.pinned },
		});
		ctx.hub.broadcast("state", { kind: "mission", record: mission });
		return { missionId: mission.id, pinned: parsed.pinned };
	},

	"agent.archive": async (ctx, params) => {
		const parsed = parseParams({ agentId: asString, confirm: asOptionalBoolean }, params);
		const agent = ctx.store.getAgent(parsed.agentId);
		if (agent === undefined) {
			throw new NodeError("NOT_FOUND", `no such agent: ${parsed.agentId}`);
		}
		if ((agent.state === "starting" || agent.state === "running") && parsed.confirm !== true) {
			throw new NodeError("CONFIRMATION_REQUIRED", "archiving a live agent needs confirm: true");
		}
		// The ACP session closes before the agent is archived.
		await ctx.acp.close(agent.sessionId);
		const archived = { ...agent, state: "archived" as const };
		await ctx.store.putAgent(archived);
		await ctx.store.appendEvent({
			workspaceId: agent.workspaceId,
			kind: "agent.archived",
			missionId: agent.missionId,
			agentId: agent.id,
			data: {},
		});
		ctx.hub.broadcast("state", { kind: "agent", record: archived });
		return { agent: archived };
	},

	"leader.setMode": async (ctx, params) => {
		const parsed = parseParams({ workspaceId: asString, mode: asString, missionId: asOptionalString }, params);
		const mode = parsed.mode as LeaderMode;
		if (mode !== "lead" && mode !== "leadPlus") {
			throw new NodeError("INVALID_PARAMS", "leader.setMode mode is lead or leadPlus");
		}
		const leader = ctx.store.getLeader(parsed.workspaceId);
		if (leader === undefined) {
			throw new NodeError("NOT_FOUND", `no leader for workspace: ${parsed.workspaceId}`);
		}
		// 07 replaces this body for the Lead++ clock; its `missionId` targets
		// that mission's lead instead, so 04 accepts and ignores it here.
		const updated = { ...leader, mode, modeSince: nowIso() };
		await ctx.store.putLeader(updated);
		await ctx.store.appendEvent({ workspaceId: leader.workspaceId, kind: "leader.modeChanged", data: { mode } });
		ctx.hub.broadcast("state", { kind: "leader", record: updated });
		return { leader: updated };
	},

	"node.stop": (ctx) => {
		// The server sends the reply when this resolves, so stop only after:
		// a macrotask runs strictly after the reply write. Stopping here
		// would destroy the caller's connection before it answers.
		setTimeout(() => {
			void ctx.stop().catch(() => undefined);
		}, 0);
		return Promise.resolve({ stopping: true as const });
	},
};
