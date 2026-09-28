import { describe, expect, test } from "bun:test";
import { ulid } from "../src/core/ids.ts";
import type { Agent, Event, Leader, Mission, Workspace } from "../src/core/types.ts";
import { asOptionalString, asString, parseParams, registryHandlers } from "../src/node/handlers-registry.ts";
import { NodeError } from "../src/node/protocol.ts";
import type { NodeContext, NodeRuntime, NodeStore } from "../src/node/server.ts";

const W1 = ulid();
const W2 = ulid();

function workspace(id: string): Workspace {
	return { id, kind: "folder", name: id.slice(0, 8), roots: [], createdAt: "2026-01-01T00:00:00.000Z" };
}

function leader(workspaceId: string): Leader {
	return {
		workspaceId,
		machineId: ulid(),
		name: "Halden",
		sessionId: ulid(),
		provider: "test",
		model: "m",
		state: "idle",
	};
}

function mission(id: string, workspaceId: string, createdAt: string, state: Mission["state"] = "open"): Mission {
	return {
		id,
		number: 1,
		workspaceId,
		machineId: ulid(),
		name: "m",
		objective: "o",
		lead: { kind: "leader" },
		agentIds: [],
		access: "readOnly",
		state,
		createdAt,
	};
}

function agent(id: string, missionId: string, state: Agent["state"]): Agent {
	return {
		id,
		missionId,
		workspaceId: W1,
		name: "a",
		task: "t",
		access: "readOnly",
		provider: "test",
		model: "m",
		skills: [],
		sessionId: ulid(),
		canSpawn: false,
		state,
		startedAt: "2026-01-01T00:00:00.000Z",
	};
}

const M1 = mission(ulid(), W1, "2026-02-01T00:00:00.000Z");
const M2 = mission(ulid(), W1, "2026-02-02T00:00:00.000Z", "open");
const M3 = mission(ulid(), W1, "2026-02-03T00:00:00.000Z");
const M4 = mission(ulid(), W1, "2026-02-04T00:00:00.000Z", "closed");
const M5 = mission(ulid(), W1, "2026-02-05T00:00:00.000Z");
const M6 = mission(ulid(), W2, "2026-02-06T00:00:00.000Z");
const MISSIONS = [M1, M2, M3, M4, M5, M6];

const RUNNER = agent(ulid(), M1.id, "running");
const STARTER = agent(ulid(), M1.id, "starting");
const DONE = agent(ulid(), M1.id, "idle");
const AGENTS = [RUNNER, STARTER, DONE];

interface World {
	events: Array<Omit<Event, "seq" | "at">>;
	broadcasts: Array<{ method: string; params: unknown }>;
	closedSessions: string[];
	ops: string[];
	agents: Map<string, Agent>;
	leaders: Map<string, Leader>;
	eventQueries: unknown[];
	nextCursor?: string;
}

function testCtx(world: World): NodeContext {
	const store: NodeStore = {
		machine: () => ({ id: ulid(), name: "test", createdAt: "2026-01-01T00:00:00.000Z" }),
		listWorkspaces: () => [workspace(W1), workspace(W2)],
		listLeaders: () => [leader(W1), leader(W2)],
		listMissions: (workspaceId) =>
			workspaceId === undefined ? MISSIONS : MISSIONS.filter((m) => m.workspaceId === workspaceId),
		listAgents: (missionId) => [...world.agents.values()].filter((a) => a.missionId === missionId),
		getWorkspace: (id) => (id === W1 || id === W2 ? workspace(id) : undefined),
		getLeader: (id) => world.leaders.get(id),
		getMission: (id) => MISSIONS.find((m) => m.id === id),
		getAgent: (id) => world.agents.get(id),
		putWorkspace: () => Promise.reject(new Error("not implemented in this test")),
		putAgent: (a) => {
			world.ops.push("store.putAgent");
			world.agents.set(a.id, a);
			return Promise.resolve();
		},
		putLeader: (l) => {
			world.ops.push("store.putLeader");
			world.leaders.set(l.workspaceId, l);
			return Promise.resolve();
		},
		compact: () => Promise.reject(new Error("not implemented in this test")),
		appendEvent: (e) => {
			world.ops.push("store.appendEvent");
			world.events.push(e);
			return Promise.resolve({ ...e, seq: world.events.length, at: "2026-03-01T00:00:00.000Z" });
		},
		listEvents: (query) => {
			world.eventQueries.push(query);
			const log = [
				{
					seq: 1,
					at: "2026-02-01T00:00:00.000Z",
					workspaceId: query.workspaceId,
					kind: "mission.created" as const,
					data: {},
				},
			];
			return Promise.resolve(
				world.nextCursor === undefined ? { events: log } : { events: log, nextCursor: world.nextCursor },
			);
		},
		tailConversation: () => Promise.reject(new Error("not implemented in this test")),
	};
	const acp: NodeRuntime = {
		createSession: () => Promise.reject(new Error("not implemented in this test")),
		ensureSession: () => Promise.reject(new Error("not implemented in this test")),
		prompt: () => Promise.reject(new Error("not implemented in this test")),
		setModel: () => Promise.reject(new Error("not implemented in this test")),
		listModels: () => Promise.reject(new Error("not implemented in this test")),
		cancel: () => Promise.reject(new Error("not implemented in this test")),
		close: (id) => {
			world.ops.push("acp.close");
			world.closedSessions.push(id);
			return Promise.resolve();
		},
		closeAll: () => Promise.reject(new Error("not implemented in this test")),
		onTurn: () => {
			throw new Error("not implemented in this test");
		},
	};
	return {
		store,
		runtime: acp,
		hub: {
			broadcast: (method, params) => {
				world.ops.push(`hub.${method}`);
				world.broadcasts.push({ method, params });
			},
			toTail: () => undefined,
			connections: () => [],
		},
		nodeVersion: "0.0.0-test",
		stop: () => Promise.resolve(),
	};
}

function freshWorld(): World {
	return {
		events: [],
		broadcasts: [],
		closedSessions: [],
		ops: [],
		agents: new Map(AGENTS.map((a) => [a.id, { ...a }])),
		leaders: new Map([[W1, leader(W1)]]),
		eventQueries: [],
	};
}

async function call(world: World, method: string, params: unknown): Promise<unknown> {
	const handler = registryHandlers[method];
	if (handler === undefined) {
		throw new Error(`no handler for ${method}`);
	}
	return handler(testCtx(world), params, undefined as never);
}

async function failsWith(params: Promise<unknown>): Promise<NodeError> {
	let thrown: unknown;
	try {
		await params;
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(NodeError);
	return thrown as NodeError;
}

describe("parseParams", () => {
	test("bad shapes give -32602", () => {
		const shape = { workspaceId: asString, cursor: asOptionalString };
		expect(parseParams(shape, { workspaceId: "w" })).toEqual({ workspaceId: "w", cursor: undefined });
		for (const params of [undefined, null, "x", 42, [], {}, { workspaceId: 42 }, { workspaceId: "w", cursor: 7 }]) {
			let thrown: unknown;
			try {
				parseParams(shape, params);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(NodeError);
			expect((thrown as NodeError).symbol).toBe("INVALID_PARAMS");
		}
	});
});

describe("missions.list", () => {
	test("pages resume after the cursor, verbatim", async () => {
		const world = freshWorld();
		const first = (await call(world, "missions.list", { workspaceId: W1, limit: 2 })) as {
			missions: Mission[];
			nextCursor?: string;
		};
		expect(first.missions.map((m) => m.id)).toEqual([M1.id, M2.id]);
		expect(typeof first.nextCursor).toBe("string");
		const second = (await call(world, "missions.list", { workspaceId: W1, limit: 2, cursor: first.nextCursor })) as {
			missions: Mission[];
			nextCursor?: string;
		};
		expect(second.missions.map((m) => m.id)).toEqual([M3.id, M4.id]);
		const third = (await call(world, "missions.list", { workspaceId: W1, limit: 2, cursor: second.nextCursor })) as {
			missions: Mission[];
			nextCursor?: string;
		};
		expect(third.missions.map((m) => m.id)).toEqual([M5.id]);
		expect(third.nextCursor).toBeUndefined();
	});

	test("state and time filters narrow, unknown cursors fail", async () => {
		const world = freshWorld();
		const closed = (await call(world, "missions.list", { workspaceId: W1, state: "closed" })) as {
			missions: Mission[];
		};
		expect(closed.missions.map((m) => m.id)).toEqual([M4.id]);
		const ranged = (await call(world, "missions.list", {
			workspaceId: W1,
			from: "2026-02-02T00:00:00.000Z",
			to: "2026-02-03T00:00:00.000Z",
		})) as { missions: Mission[] };
		expect(ranged.missions.map((m) => m.id)).toEqual([M2.id, M3.id]);
		const error = await failsWith(call(world, "missions.list", { workspaceId: W1, cursor: "nope" }));
		expect(error.symbol).toBe("INVALID_PARAMS");
	});
});

describe("missions.get and events.list", () => {
	test("get returns the mission and its agents, unknown ids give NOT_FOUND", async () => {
		const world = freshWorld();
		const found = (await call(world, "missions.get", { missionId: M1.id })) as { mission: Mission; agents: Agent[] };
		expect(found.mission.id).toBe(M1.id);
		expect(found.agents).toHaveLength(3);
		expect((await failsWith(call(world, "missions.get", { missionId: ulid() }))).symbol).toBe("NOT_FOUND");
	});

	test("events.list passes cursor and limit through and returns nextCursor verbatim", async () => {
		const world = freshWorld();
		world.nextCursor = "cursor-from-store";
		const page = (await call(world, "events.list", { workspaceId: W1, limit: 10, cursor: "c0" })) as {
			events: Event[];
			nextCursor?: string;
		};
		expect(world.eventQueries).toEqual([
			{ workspaceId: W1, from: undefined, to: undefined, limit: 10, cursor: "c0" },
		]);
		expect(page.nextCursor).toBe("cursor-from-store");
		const world2 = freshWorld();
		const first = (await call(world2, "events.list", { workspaceId: W1 })) as {
			events: Event[];
			nextCursor?: string;
		};
		expect(world2.eventQueries).toEqual([
			{ workspaceId: W1, from: undefined, to: undefined, limit: 200, cursor: undefined },
		]);
		expect(first.nextCursor).toBeUndefined();
	});
});

describe("agent.archive", () => {
	test("a running agent without confirm fails and touches nothing", async () => {
		const world = freshWorld();
		const error = await failsWith(call(world, "agent.archive", { agentId: RUNNER.id }));
		expect(error.symbol).toBe("CONFIRMATION_REQUIRED");
		expect(world.ops).toEqual([]);
		expect(world.agents.get(RUNNER.id)?.state).toBe("running");
		const starting = await failsWith(call(world, "agent.archive", { agentId: STARTER.id, confirm: false }));
		expect(starting.symbol).toBe("CONFIRMATION_REQUIRED");
		expect(world.ops).toEqual([]);
	});

	test("with confirm the session closes first, then one event and one state", async () => {
		const world = freshWorld();
		const result = (await call(world, "agent.archive", { agentId: RUNNER.id, confirm: true })) as { agent: Agent };
		expect(result.agent.state).toBe("archived");
		expect(world.closedSessions).toEqual([RUNNER.sessionId]);
		expect(world.ops).toEqual(["acp.close", "store.putAgent", "store.appendEvent", "hub.state"]);
		expect(world.events).toHaveLength(1);
		expect(world.events[0]).toMatchObject({ kind: "agent.archived", agentId: RUNNER.id, missionId: M1.id });
		expect(world.broadcasts).toEqual([{ method: "state", params: { kind: "agent", record: result.agent } }]);
	});

	test("other states archive at once, unknown ids give NOT_FOUND", async () => {
		const world = freshWorld();
		const result = (await call(world, "agent.archive", { agentId: DONE.id })) as { agent: Agent };
		expect(result.agent.state).toBe("archived");
		expect(world.closedSessions).toEqual([DONE.sessionId]);
		expect((await failsWith(call(world, "agent.archive", { agentId: ulid() }))).symbol).toBe("NOT_FOUND");
	});
});
