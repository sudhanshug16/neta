import { expect, test } from "bun:test";
import type { Agent, Event, Mission } from "../src/core/types.ts";
import { createAgentModelChanger } from "../src/node/agent-model.ts";
import type { NodeStore } from "../src/node/server.ts";
import { createModelRouter } from "../src/routing/router.ts";
import type { Effort, RouteTask } from "../src/routing/types.ts";
import { type ModelToolContext, modelHandlers } from "../src/tools/handlers/model.ts";

function fixture() {
	let agent: Agent = {
		id: "cove",
		name: "Cove",
		missionId: "mission",
		workspaceId: "workspace",
		sessionId: "same-session",
		task: "Read local changes",
		access: "readOnly",
		skills: [],
		canSpawn: true,
		provider: "opencode",
		model: "test/small",
		state: "idle",
		startedAt: "2026-01-01T00:00:00Z",
		routing: {
			effort: 2,
			method: "fixed",
			selectedModel: "test/small",
			candidates: ["test/small"],
			reason: "configured",
			warnings: [],
		},
	};
	const mission: Mission = {
		id: "mission",
		number: 4,
		workspaceId: "workspace",
		machineId: "machine",
		name: "Change overview",
		objective: "Summarize local changes",
		changes: [],
		lead: { kind: "agent", agentId: "cove" },
		agentIds: ["cove"],
		access: "readOnly",
		state: "running",
		createdAt: agent.startedAt,
	};
	const routes: RouteTask[] = [];
	const applied: { session: string; model: string }[] = [];
	const events: Array<Omit<Event, "seq" | "at">> = [];
	const published: Agent[] = [];
	const store = {
		getAgent: (id: string) => (id === agent.id ? agent : undefined),
		getMission: (id: string) => (id === mission.id ? mission : undefined),
		listMissions: () => [mission],
		listAgents: () => [agent],
		putAgent: async (next: Agent) => {
			agent = next;
		},
		appendEvent: async (event: Omit<Event, "seq" | "at">) => {
			events.push(event);
			return { ...event, seq: 1, at: agent.startedAt };
		},
	} as unknown as NodeStore;
	const models = { 1: "test/tiny", 2: "test/small", 3: "test/medium", 4: "test/large", 5: "test/max" };
	const route = createModelRouter({
		catalog: {
			load: async () => {
				throw new Error("fixed routing must not fetch metadata");
			},
		},
	});
	const controls: {
		applyError?: string;
		routingError?: string;
		duringRouting?: () => void;
		duringApply?: () => void;
	} = {};
	const adjust = createAgentModelChanger({
		store,
		route: async (input) => {
			routes.push(input);
			controls.duringRouting?.();
			if (controls.routingError) throw new Error(controls.routingError);
			return route(
				input,
				Object.values(models).map((id) => ({ id })),
				{ mode: "fixed", models },
			);
		},
		apply: async (current, model) => {
			if (controls.applyError) throw new Error(controls.applyError);
			applied.push({ session: current.sessionId, model });
			controls.duringApply?.();
		},
		publish: (updated) => {
			published.push(updated);
		},
	});
	const context: ModelToolContext = {
		actor: { kind: "leader", workspaceId: "workspace", sessionId: "parent" },
		deps: { store, models: { adjust } },
	};
	return {
		agent: () => agent,
		patch: (patch: Partial<Agent>) => {
			agent = { ...agent, ...patch };
		},
		mission,
		store,
		context,
		models,
		controls,
		adjust,
		routes,
		applied,
		events,
		published,
	};
}

test("a mission upgrade and named-worker downgrade reroute without replacing the conversation", async () => {
	const f = fixture();
	const original = f.agent();
	const up = await modelHandlers.neta_model(f.context, { missionId: 4, change: "up" });
	expect(up.ok).toBe(true);
	expect(f.agent()).toMatchObject({
		id: original.id,
		sessionId: original.sessionId,
		state: original.state,
		model: "test/medium",
		routing: { effort: 3 },
	});
	expect(f.routes[0]).toMatchObject({
		task: original.task,
		objective: f.mission.objective,
		effort: 3,
		adjustment: { previousModel: "test/small", previousEffort: 2, direction: "up" },
	});
	expect(f.routes[0].model).toBeUndefined();
	const down = await modelHandlers.neta_model(f.context, { agentId: "cOvE", change: "down" });
	expect(down.ok).toBe(true);
	expect(f.agent().model).toBe("test/small");
	expect(f.agent().routing?.effort).toBe(2);
	expect(f.applied).toEqual([
		{ session: "same-session", model: "test/medium" },
		{ session: "same-session", model: "test/small" },
	]);
	expect(f.mission.agentIds).toEqual([original.id]);
	expect(f.events.map((event) => event.kind)).toEqual(["agent.modelChanged", "agent.modelChanged"]);
	expect(f.published).toHaveLength(2);
});

test("queued workers change their saved selection without starting a session", async () => {
	const f = fixture();
	f.patch({ state: "queued" });
	const result = await f.adjust("cove", { effort: 5 });
	expect(result.applies).toBe("on launch");
	expect(f.agent()).toMatchObject({
		state: "queued",
		sessionId: "same-session",
		model: "test/max",
		routing: { effort: 5 },
	});
	expect(f.applied).toEqual([]);
});

test("effort boundaries do not call the router, and an unchanged selected model is reported honestly", async () => {
	const f = fixture();
	const routing = f.agent().routing;
	if (!routing) throw new Error("Fixture requires a routing decision");
	f.patch({ routing: { ...routing, effort: 5 } });
	expect((await f.adjust("cove", { change: "up" })).changed).toBe(false);
	expect(f.routes).toEqual([]);
	f.patch({ routing: { ...routing, effort: 1 } });
	expect((await f.adjust("cove", { change: "down" })).changed).toBe(false);
	expect(f.routes).toEqual([]);
	f.models[3] = "test/small";
	const result = await f.adjust("cove", { effort: 3 });
	expect(result.changed).toBe(false);
	expect(result.message).toContain("same model");
	expect(f.agent().routing?.effort).toBe(3);
	expect(f.applied).toEqual([]);
});

test("routing and provider failures preserve the previous effort, model and session", async () => {
	for (const failure of ["routingError", "applyError"] as const) {
		const f = fixture();
		const original = f.agent();
		f.controls[failure] = "fixture unavailable";
		await expect(f.adjust("cove", { change: "up" })).rejects.toThrow("fixture unavailable");
		expect(f.agent()).toEqual(original);
		expect(f.events).toEqual([]);
		expect(f.published).toEqual([]);
		delete f.controls[failure];
		await f.adjust("cove", { change: "up" });
		expect(f.agent().routing?.effort).toBe(3);
	}
});

test("relative adjustments serialize, preserving concurrent completion updates", async () => {
	const f = fixture();
	f.controls.duringApply = () => f.patch({ state: "completed", outcome: "Read complete" });
	await Promise.all([f.adjust("cove", { change: "up" }), f.adjust("cove", { change: "up" })]);
	expect(f.routes.map((route) => route.effort)).toEqual([3, 4]);
	expect(f.agent()).toMatchObject({
		sessionId: "same-session",
		state: "completed",
		outcome: "Read complete",
		model: "test/large",
		routing: { effort: 4 },
	});
});

test("stale routing cannot overwrite a model chosen elsewhere", async () => {
	const f = fixture();
	f.controls.duringRouting = () => f.patch({ model: "test/elsewhere" });
	await expect(f.adjust("cove", { effort: 4 })).rejects.toThrow("agent changed during routing");
	expect(f.agent().model).toBe("test/elsewhere");
	expect(f.applied).toEqual([]);
});

test("unknown effort, archived agents and closed missions refuse changes", async () => {
	const f = fixture();
	f.patch({ routing: undefined });
	await expect(f.adjust("cove", { change: "up" })).rejects.toThrow("Set effort 1–5 explicitly");
	await f.adjust("cove", { effort: 3 });
	expect(f.agent().routing?.effort).toBe(3);
	for (const effort of [0, 6, 2.5, Number.NaN])
		await expect(f.adjust("cove", { effort: effort as Effort })).rejects.toThrow("integer from 1 to 5");
	f.patch({ state: "archived" });
	await expect(f.adjust("cove", { change: "up" })).rejects.toThrow("Archived");
	f.patch({ state: "idle" });
	f.mission.state = "closed";
	await expect(f.adjust("cove", { change: "up" })).rejects.toThrow("Archived");
});

test("mission leads can adjust themselves but cannot cross mission or workspace boundaries", async () => {
	const f = fixture();
	f.context.actor = {
		kind: "lead",
		agentId: "cove",
		workspaceId: "workspace",
		missionId: "mission",
		sessionId: "same-session",
	};
	expect((await modelHandlers.neta_model(f.context, { change: "up" })).ok).toBe(true);
	f.context.actor = { ...f.context.actor, missionId: "other-mission" };
	expect((await modelHandlers.neta_model(f.context, { missionId: 4, change: "down" })).ok).toBe(false);
	f.context.actor = { ...f.context.actor, kind: "agent" };
	expect((await modelHandlers.neta_model(f.context, { agentId: "cove", effort: 4 })).ok).toBe(false);
	f.context.actor = { kind: "leader", workspaceId: "other-workspace", sessionId: "other-session" };
	expect((await modelHandlers.neta_model(f.context, { agentId: "cove", effort: 4 })).ok).toBe(false);
	expect(f.routes).toHaveLength(1);
});

test("a worker can adjust itself on request but cannot target its lead or peers", async () => {
	const f = fixture();
	f.patch({ canSpawn: false });
	f.mission.lead = { kind: "agent", agentId: "mission-lead" };
	f.context.actor = {
		kind: "agent",
		agentId: "cove",
		workspaceId: "workspace",
		missionId: "mission",
		sessionId: "same-session",
	};
	for (const target of [{ agentId: "mission-lead" }, { agentId: "peer" }, { missionId: 4 }])
		expect((await modelHandlers.neta_model(f.context, { ...target, change: "up" })).ok).toBe(false);
	expect(f.routes).toEqual([]);
	expect((await modelHandlers.neta_model(f.context, { change: "up" })).ok).toBe(true);
	expect(f.agent()).toMatchObject({ sessionId: "same-session", model: "test/medium", routing: { effort: 3 } });
	expect(f.mission.lead).toEqual({ kind: "agent", agentId: "mission-lead" });
});
