import { describe, expect, test } from "bun:test";
import { ulid } from "../src/core/ids.ts";
import type { Agent, Leader, Mission } from "../src/core/types.ts";
import type { NodeStore } from "../src/node/server.ts";
import {
	createRouter,
	createTokenTable,
	type SessionToolBridge,
	type ToolHandlers,
	type ToolResult,
} from "../src/tools/router.ts";

const WORKSPACE = "w";

function leader(sessionId: string): Leader {
	return {
		workspaceId: WORKSPACE,
		machineId: "m",
		name: "Halden",
		sessionId,
		provider: "fake",
		model: "test-model",
		state: "running",
	};
}

function agent(id: string, canSpawn: boolean, missionId: string): Agent {
	return {
		id,
		missionId,
		workspaceId: WORKSPACE,
		name: "agent",
		task: "task",
		access: "readOnly",
		provider: "fake",
		model: "test-model",
		skills: [],
		sessionId: ulid(),
		canSpawn,
		state: "running",
		startedAt: "2026-01-01T00:00:00.000Z",
	};
}

function mission(number: number, state: Mission["state"]): Mission {
	return {
		id: ulid(),
		number,
		workspaceId: WORKSPACE,
		machineId: "m",
		name: `mission ${number}`,
		objective: "o",
		lead: { kind: "leader" },
		agentIds: [],
		access: "readOnly",
		state,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

function stubStore(leaders: Leader[], agents: Agent[], missions: Mission[]): NodeStore {
	return {
		machine: () => {
			throw new Error("unused");
		},
		listWorkspaces: () => [],
		listLeaders: () => leaders,
		listMissions: (workspaceId) =>
			workspaceId === undefined ? missions : missions.filter((m) => m.workspaceId === workspaceId),
		listAgents: () => agents,
		getWorkspace: () => undefined,
		getLeader: (id) => leaders.find((l) => l.workspaceId === id),
		getMission: () => undefined,
		getAgent: (id) => agents.find((a) => a.id === id),
		putWorkspace: () => Promise.resolve(),
		putAgent: () => Promise.resolve(),
		putLeader: () => Promise.resolve(),
		compact: () => Promise.resolve(),
		appendEvent: () => Promise.reject(new Error("unused")),
		listEvents: () => Promise.reject(new Error("unused")),
		tailConversation: () => Promise.reject(new Error("unused")),
	};
}

function stubHandlers(overrides?: Partial<ToolHandlers>): { handlers: ToolHandlers; calls: string[] } {
	const calls: string[] = [];
	const ok = async (name: string): Promise<ToolResult> => {
		calls.push(name);
		return { ok: true, data: { called: name } };
	};
	return {
		calls,
		handlers: {
			dispatch_mission: (_ctx, _args) => ok("dispatch_mission"),
			spawn_agent: (_ctx, _args) => ok("spawn_agent"),
			change_model: (_ctx, _args) => ok("change_model"),
			send_message: (_ctx, _args) => ok("send_message"),
			close: (_ctx, _args) => ok("close"),
			mission_state: (_ctx, _args) => ok("mission_state"),
			list_models: (_ctx, _args) => ok("list_models"),
			setup_diagnostic: (_ctx, _args) => ok("setup_diagnostic"),
			artifacts: (_ctx, _args) => ok("artifacts"),
			...overrides,
		},
	};
}

function setup() {
	const leaderId = ulid();
	const leadId = ulid();
	const agentId = ulid();
	const missionId = ulid();
	const leaders = [leader(leaderId)];
	const agents = [agent(leadId, true, missionId), agent(agentId, false, missionId)];
	const missions = [mission(14, "open"), mission(15, "open")];
	const tokens = createTokenTable();
	const leaderToken = tokens.mint(leaderId);
	const leadToken = tokens.mint(leadId);
	const agentToken = tokens.mint(agentId);
	const stub = stubHandlers();
	const router = createRouter({ store: stubStore(leaders, agents, missions) }, stub.handlers, tokens);
	return { router, tokens, stub, leaderId, leaderToken, leadId, leadToken, agentId, agentToken };
}

function textOf(response: { content: Array<{ text: string }> }): string {
	const first = response.content[0];
	if (first === undefined) {
		throw new Error("empty response");
	}
	return first.text;
}

describe("tool router authorisation", () => {
	test("mission leads see only own-mission arguments and cannot submit a mission selector", async () => {
		const { router, stub, leadId, leadToken, agentId, agentToken, leaderId, leaderToken } = setup();
		const leadTools = router.list(leadId, leadToken);
		if (!Array.isArray(leadTools)) throw new Error("lead tools were not listed");
		for (const name of ["mission_state", "spawn_agent", "change_model"]) {
			const tool = leadTools.find((item) => item.name === name);
			expect(tool?.inputSchema.properties?.missionId).toBeUndefined();
			expect(tool?.description).toContain("mission");
		}
		expect(leadTools.find((item) => item.name === "send_message")?.description).toContain("your mission");
		const workerTools = router.list(agentId, agentToken);
		if (!Array.isArray(workerTools)) throw new Error("worker tools were not listed");
		expect(
			workerTools.find((item) => item.name === "change_model")?.inputSchema.properties?.missionId,
		).toBeUndefined();
		expect(workerTools.find((item) => item.name === "change_model")?.inputSchema.properties?.agentId).toBeUndefined();
		const leaderTools = router.list(leaderId, leaderToken);
		if (!Array.isArray(leaderTools)) throw new Error("coordinator tools were not listed");
		expect(
			leaderTools.find((item) => item.name === "mission_state")?.inputSchema.properties?.missionId,
		).toBeDefined();

		const denied = await router.call(leadId, leadToken, "mission_state", { missionId: 65 });
		expect(textOf(denied)).toContain("unknown property 'params.missionId'");
		const deniedSpawn = await router.call(leadId, leadToken, "spawn_agent", {
			task: "Check it",
			access: "readOnly",
			missionId: 65,
		});
		expect(textOf(deniedSpawn)).toContain("unknown property 'params.missionId'");
		expect(stub.calls).toEqual([]);
		const own = await router.call(leadId, leadToken, "mission_state", {});
		expect(own.isError).toBe(false);
		expect(stub.calls).toEqual(["mission_state"]);
	});

	test("a wrong token gives notAuthorised and never reaches a handler", async () => {
		const { router, stub, leaderId } = setup();
		const response = await router.call(leaderId, "wrong", "mission_state", {});
		expect(response.isError).toBe(true);
		expect(textOf(response)).toStartWith("error notAuthorised:");
		expect(stub.calls).toEqual([]);
	});

	test("a stale token fails after a fresh mint", async () => {
		const { router, tokens, stub, leaderId, leaderToken } = setup();
		tokens.mint(leaderId);
		const response = await router.call(leaderId, leaderToken, "mission_state", {});
		expect(response.isError).toBe(true);
		expect(textOf(response)).toStartWith("error notAuthorised:");
		expect(stub.calls).toEqual([]);
	});

	test("an unknown actor fails closed", async () => {
		const { router, tokens, stub } = setup();
		const nobody = ulid();
		const response = await router.call(nobody, tokens.mint(nobody), "mission_state", {});
		expect(response.isError).toBe(true);
		expect(textOf(response)).toStartWith("error notAuthorised:");
		expect(stub.calls).toEqual([]);
	});

	test("bad params give badParams naming the failing property", async () => {
		const { router, leaderId, leaderToken } = setup();
		const response = await router.call(leaderId, leaderToken, "send_message", {});
		expect(response.isError).toBe(true);
		expect(textOf(response).startsWith("error badParams:")).toBe(true);
		expect(textOf(response)).toContain("agentId");
	});

	test("an unknown tool name is refused, not a bad-params error", async () => {
		const { router, stub, leaderId, leaderToken } = setup();
		const response = await router.call(leaderId, leaderToken, "neta_bogus", {});
		expect(response.isError).toBe(true);
		expect(textOf(response)).toStartWith("error notAuthorised:");
		expect(stub.calls).toEqual([]);
	});

	test("a handler failure becomes isError: true", async () => {
		const leaderId = ulid();
		const tokens = createTokenTable();
		const token = tokens.mint(leaderId);
		const stub = stubHandlers({
			mission_state: () => Promise.resolve({ ok: false, code: "refused", message: "no" }),
		});
		const router = createRouter({ store: stubStore([leader(leaderId)], [], []) }, stub.handlers, tokens);
		const response = await router.call(leaderId, token, "mission_state", {});
		expect(response.isError).toBe(true);
		expect(textOf(response).split("\n")[0]).toBe("error refused: no");
	});

	test("a throwing handler becomes an unavailable error, not a crash", async () => {
		const leaderId = ulid();
		const tokens = createTokenTable();
		const token = tokens.mint(leaderId);
		const stub = stubHandlers({
			mission_state: () => Promise.reject(new Error("boom")),
		});
		const router = createRouter({ store: stubStore([leader(leaderId)], [], []) }, stub.handlers, tokens);
		const response = await router.call(leaderId, token, "mission_state", {});
		expect(response.isError).toBe(true);
		expect(textOf(response).split("\n")[0]).toBe("error unavailable: boom");
	});
});

describe("tool router rendering", () => {
	test("workspace Neta bridges can register after the router starts", async () => {
		const tokens = createTokenTable();
		const bridges = new Map<string, SessionToolBridge>();
		const router = createRouter({ store: stubStore([], [], []) }, stubHandlers().handlers, tokens, (actorId) =>
			bridges.get(actorId),
		);
		const actorId = ulid();
		const token = tokens.mint(actorId);
		expect(router.list(actorId, token)).toMatchObject({ ok: false, code: "notAuthorised" });
		bridges.set(actorId, {
			actorId,
			tools: [{ name: "missions", description: "This workspace", inputSchema: { type: "object" } }],
			call: async () => ({ content: [{ type: "text", text: "scoped" }], isError: false }),
		});
		expect(router.list(actorId, token)).toMatchObject([{ name: "missions" }]);
		expect(textOf(await router.call(actorId, token, "missions", {}))).toBe("scoped");
	});

	test("revoke invalidates immediately", async () => {
		const { router, tokens, leaderId, leaderToken } = setup();
		tokens.revoke(leaderId);
		const response = await router.call(leaderId, leaderToken, "mission_state", {});
		expect(response.isError).toBe(true);
		expect(textOf(response)).toStartWith("error notAuthorised:");
	});
});

test("successful MCP results remain objects even when reminder text follows the JSON", async () => {
	const { router, leaderId, leaderToken } = setup();
	const response = await router.call(leaderId, leaderToken, "mission_state", {});
	expect(response.structuredContent).toEqual({ called: "mission_state" });
	expect(textOf(response)).toContain("[neta]");
	expect(() => JSON.parse(textOf(response))).toThrow();
	const denied = await router.call(leaderId, "invalid", "mission_state", {});
	expect(denied.structuredContent).toBeUndefined();
});
