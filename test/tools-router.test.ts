import { describe, expect, test } from "bun:test";
import { ulid } from "../src/core/ids.ts";
import type { Agent, Leader, Mission } from "../src/core/types.ts";
import type { NodeStore } from "../src/node/server.ts";
import { createRouter, createTokenTable, type ToolHandlers, type ToolResult } from "../src/tools/router.ts";

const WORKSPACE = "w";

function leader(sessionId: string): Leader {
	return {
		workspaceId: WORKSPACE,
		machineId: "m",
		name: "Halden",
		sessionId,
		provider: "fake",
		model: "test-model",
		mode: "lead",
		modeSince: "2026-01-01T00:00:00.000Z",
		modeActiveMs: 0,
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
		changes: [],
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
			neta_mission: (_ctx, _args) => ok("neta_mission"),
			neta_agent: (_ctx, _args) => ok("neta_agent"),
			neta_wait: (_ctx, _args) => ok("neta_wait"),
			neta_send: (_ctx, _args) => ok("neta_send"),
			neta_scope: (_ctx, _args) => ok("neta_scope"),
			neta_ready: (_ctx, _args) => ok("neta_ready"),
			neta_close: (_ctx, _args) => ok("neta_close"),
			neta_mode: (_ctx, _args) => ok("neta_mode"),
			neta_pin: (_ctx, _args) => ok("neta_pin"),
			neta_status: (_ctx, _args) => ok("neta_status"),
			neta_history: (_ctx, _args) => ok("neta_history"),
			neta_progress: (_ctx, _args) => ok("neta_progress"),
			neta_ask: (_ctx, _args) => ok("neta_ask"),
			neta_done: (_ctx, _args) => ok("neta_done"),
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
	const missions = [mission(14, "blocked"), mission(15, "running")];
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
	test("a wrong token gives notAuthorised and never reaches a handler", async () => {
		const { router, stub, leaderId } = setup();
		const response = await router.call(leaderId, "wrong", "neta_status", {});
		expect(response.isError).toBe(true);
		expect(textOf(response)).toStartWith("error notAuthorised:");
		expect(stub.calls).toEqual([]);
	});

	test("a stale token fails after a fresh mint", async () => {
		const { router, tokens, stub, leaderId, leaderToken } = setup();
		tokens.mint(leaderId);
		const response = await router.call(leaderId, leaderToken, "neta_status", {});
		expect(response.isError).toBe(true);
		expect(textOf(response)).toStartWith("error notAuthorised:");
		expect(stub.calls).toEqual([]);
	});

	test("an unknown actor fails closed", async () => {
		const { router, tokens, stub } = setup();
		const nobody = ulid();
		const response = await router.call(nobody, tokens.mint(nobody), "neta_status", {});
		expect(response.isError).toBe(true);
		expect(textOf(response)).toStartWith("error notAuthorised:");
		expect(stub.calls).toEqual([]);
	});

	test("an ordinary agent calling neta_agent or neta_ask is refused", async () => {
		const { router, stub, agentId, agentToken } = setup();
		for (const name of ["neta_agent", "neta_ask"]) {
			const response = await router.call(agentId, agentToken, name, { task: "t", access: "readOnly" });
			expect(response.isError).toBe(true);
			expect(textOf(response)).toStartWith("error notAuthorised:");
		}
		expect(stub.calls).toEqual([]);
		// A lead may call neta_agent.
		const { router: leadRouter, tokens: leadTokens, leadId: lead, leadToken: leadTok } = setup();
		const allowed = await leadRouter.call(lead, leadTok, "neta_agent", { task: "t", access: "readOnly" });
		expect(allowed.isError).toBe(false);
		void leadTokens;
	});

	test("bad params give badParams naming the failing property", async () => {
		const { router, leaderId, leaderToken } = setup();
		const response = await router.call(leaderId, leaderToken, "neta_send", {});
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
			neta_status: () => Promise.resolve({ ok: false, code: "refused", message: "no" }),
		});
		const router = createRouter({ store: stubStore([leader(leaderId)], [], []) }, stub.handlers, tokens);
		const response = await router.call(leaderId, token, "neta_status", {});
		expect(response.isError).toBe(true);
		expect(textOf(response).split("\n")[0]).toBe("error refused: no");
	});

	test("a throwing handler becomes an unavailable error, not a crash", async () => {
		const leaderId = ulid();
		const tokens = createTokenTable();
		const token = tokens.mint(leaderId);
		const stub = stubHandlers({
			neta_status: () => Promise.reject(new Error("boom")),
		});
		const router = createRouter({ store: stubStore([leader(leaderId)], [], []) }, stub.handlers, tokens);
		const response = await router.call(leaderId, token, "neta_status", {});
		expect(response.isError).toBe(true);
		expect(textOf(response).split("\n")[0]).toBe("error unavailable: boom");
	});
});

describe("tool router rendering", () => {
	test("leader and lead responses carry the reminder, an agent's does not", async () => {
		const { router, leaderId, leaderToken, leadId, leadToken, agentId, agentToken } = setup();
		const leadCall = await router.call(leadId, leadToken, "neta_status", {});
		const leaderCall = await router.call(leaderId, leaderToken, "neta_status", {});
		const agentCall = await router.call(agentId, agentToken, "neta_progress", { text: "started" });
		expect(leadCall.isError).toBe(false);
		expect(textOf(leadCall)).toContain("[neta] needs you: #14 mission 14 — blocked");
		expect(textOf(leadCall).split("\n")[0]).toBe(JSON.stringify({ called: "neta_status" }));
		expect(textOf(leaderCall)).toContain("[neta] running: #15 mission 15");
		expect(textOf(agentCall)).toBe(JSON.stringify({ called: "neta_progress" }));
	});

	test("revoke invalidates immediately", async () => {
		const { router, tokens, leaderId, leaderToken } = setup();
		tokens.revoke(leaderId);
		const response = await router.call(leaderId, leaderToken, "neta_status", {});
		expect(response.isError).toBe(true);
		expect(textOf(response)).toStartWith("error notAuthorised:");
	});

	test("list returns the caller's tool set and refuses a bad token", () => {
		const { router, leaderToken, leaderId, agentId, agentToken } = setup();
		const leaderTools = router.list(leaderId, leaderToken);
		const agentTools = router.list(agentId, agentToken);
		const refused = router.list(leaderId, "wrong");
		if (!Array.isArray(leaderTools) || !Array.isArray(agentTools)) {
			throw new Error("expected tool lists");
		}
		const leaderNames = leaderTools.map((t) => t.name).sort();
		expect(leaderNames).toEqual([
			"neta_agent",
			"neta_ask",
			"neta_close",
			"neta_history",
			"neta_mission",
			"neta_mode",
			"neta_pin",
			"neta_ready",
			"neta_scope",
			"neta_send",
			"neta_status",
			"neta_wait",
		]);
		expect(agentTools.map((t) => t.name).sort()).toEqual(["neta_done", "neta_history", "neta_progress"]);
		expect(refused).toEqual({ ok: false, code: "notAuthorised", message: "bad token or unknown actor" });
	});
});
