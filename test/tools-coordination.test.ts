import { describe, expect, test } from "bun:test";
import { ulid } from "../src/core/ids.ts";
import type { Agent, AgentState, EventKind, Leader, Mission } from "../src/core/types.ts";
import type { NodeStore } from "../src/node/server.ts";
import {
	type CoordinationPorts,
	type CoordinationToolContext,
	coordinationHandlers,
} from "../src/tools/handlers/coordination.ts";
import type { Actor } from "../src/tools/router.ts";

const WORKSPACE = "w";
const MISSION = ulid();

function mission(): Mission {
	return {
		id: MISSION,
		number: 1,
		workspaceId: WORKSPACE,
		machineId: "m",
		name: "host mission",
		objective: "o",
		changes: [],
		lead: { kind: "leader" },
		agentIds: [],
		access: "readWrite",
		state: "running",
		createdAt: new Date(0).toISOString(),
	};
}

function makeAgent(id: string, state: AgentState, extra?: Partial<Agent>): Agent {
	return {
		id,
		missionId: MISSION,
		workspaceId: WORKSPACE,
		name: `agent-${id.slice(-4)}`,
		task: "task",
		access: "readOnly",
		provider: "fake",
		model: "test-model",
		skills: [],
		sessionId: ulid(),
		canSpawn: false,
		state,
		startedAt: new Date(0).toISOString(),
		...extra,
	};
}

const LEADER: Leader = {
	workspaceId: WORKSPACE,
	machineId: "m",
	name: "Halden",
	sessionId: ulid(),
	provider: "fake",
	model: "test-model",
	mode: "lead",
	modeSince: new Date(0).toISOString(),
	modeActiveMs: 0,
	activeMissionId: MISSION,
	state: "running",
};

interface Fixture {
	store: NodeStore;
	agents: Map<string, Agent>;
	events: EventKind[];
	eventData: unknown[];
	calls: string[];
	sessions: CoordinationPorts["sessions"];
	missions: { save(mission: Mission): Promise<void> };
}

function fixture(): Fixture {
	let currentMission = mission();
	const missions = {
		save: async (value: Mission) => {
			currentMission = value;
		},
	};
	const agents = new Map<string, Agent>();
	const events: EventKind[] = [];
	const eventData: unknown[] = [];
	const calls: string[] = [];
	const sessions: CoordinationPorts["sessions"] = {
		cancel: async (sessionId) => {
			calls.push(`cancel:${sessionId}`);
		},
		prompt: async (sessionId, text) => {
			calls.push(`prompt:${sessionId}:${text}`);
		},
	};

	const store: NodeStore = {
		machine: () => ({ id: "m", name: "test", createdAt: new Date(0).toISOString() }),
		listWorkspaces: () => [],
		listLeaders: () => [LEADER],
		listMissions: () => [currentMission],
		listAgents: (missionId) => [...agents.values()].filter((a) => a.missionId === missionId),
		getWorkspace: () => undefined,
		getLeader: () => LEADER,
		getMission: (id) => (id === MISSION ? currentMission : undefined),
		getAgent: (id) => agents.get(id),
		putWorkspace: () => Promise.resolve(),
		putAgent: async (agent) => {
			agents.set(agent.id, agent);
		},
		putLeader: () => Promise.resolve(),
		compact: () => Promise.resolve(),
		appendEvent: async (event) => {
			events.push(event.kind);
			eventData.push(event.data);
			return { seq: events.length, at: new Date(0).toISOString(), ...event };
		},
		listEvents: () => Promise.reject(new Error("unused")),
		tailConversation: () => Promise.reject(new Error("unused")),
	};

	return {
		store,
		agents,
		events,
		eventData,
		calls,
		sessions,
		missions,
	};
}

function ctx(f: Fixture, actor: Actor): CoordinationToolContext {
	return { actor, deps: { store: f.store, sessions: f.sessions, missions: f.missions } };
}

function leadActor(agent: Agent): Actor {
	return { kind: "lead", workspaceId: WORKSPACE, missionId: MISSION, agentId: agent.id, sessionId: agent.sessionId };
}

describe("neta_send", () => {
	test.each(["running", "idle", "completed"] as const)(
		"self-send from %s refuses before touching the session",
		async (state) => {
			const f = fixture();
			const self = makeAgent(ulid(), state, { canSpawn: true, name: "Britt" });
			f.agents.set(self.id, self);
			const result = await coordinationHandlers.neta_send(ctx(f, leadActor(self)), {
				agentId: self.id,
				text: "Continue the implementation",
			});
			expect(result).toMatchObject({ ok: false, code: "refused" });
			if (!result.ok) expect(result.message).toContain(`You are Britt (${self.id})`);
			expect(f.calls).toEqual([]);
			expect(f.events).toEqual([]);
			expect(f.agents.get(self.id)).toEqual(self);
		},
	);

	test("completed follow-up requires a runtime resume port", async () => {
		const f = fixture();
		const done = makeAgent(ulid(), "completed");
		f.agents.set(done.id, done);
		const actor = leadActor(makeAgent(ulid(), "running"));
		const result = await coordinationHandlers.neta_send(ctx(f, actor), { agentId: done.id, text: "late" });
		expect(result.ok).toBe(false);
		expect(f.calls).toEqual([]);
	});
});

describe("neta_progress and neta_ask", () => {
	test("progress writes activity", async () => {
		const f = fixture();
		const worker = makeAgent(ulid(), "running");
		f.agents.set(worker.id, worker);
		const result = await coordinationHandlers.neta_progress(ctx(f, leadActor(worker)), { text: "started" });
		expect(result).toEqual({ ok: true, data: { agentId: worker.id } });
		expect(f.agents.get(worker.id)?.activity?.text).toBe("started");
	});

	test("ask sets pendingQuestion, blocks the actor and emits mission.blocked", async () => {
		const f = fixture();
		const lead = makeAgent(ulid(), "running", { canSpawn: true });
		f.agents.set(lead.id, lead);
		const result = await coordinationHandlers.neta_ask(ctx(f, leadActor(lead)), { question: "ship it?" });
		expect(result).toEqual({ ok: true, data: {} });
		expect(f.agents.get(lead.id)?.pendingQuestion).toBe("ship it?");
		expect(f.agents.get(lead.id)?.state).toBe("blocked");
		expect(f.events).toEqual(["mission.blocked"]);
	});
});

describe("neta_done", () => {
	test("records the outcome, completes, emits agent.finished, leaves the mission open", async () => {
		const f = fixture();
		const worker = makeAgent(ulid(), "running");
		f.agents.set(worker.id, worker);
		const result = await coordinationHandlers.neta_done(ctx(f, leadActor(worker)), { outcome: "ported" });
		expect(result).toEqual({ ok: true, data: { agentId: worker.id, state: "completed" } });
		expect(f.agents.get(worker.id)?.outcome).toBe("ported");
		expect(f.events).toEqual(["agent.finished"]);
		expect(f.store.listMissions()[0]?.state).toBe("running");
	});

	test("done twice is refused", async () => {
		const f = fixture();
		const worker = makeAgent(ulid(), "running");
		f.agents.set(worker.id, worker);
		const actor = leadActor(worker);
		await coordinationHandlers.neta_done(ctx(f, actor), { outcome: "ported" });
		const again = await coordinationHandlers.neta_done(ctx(f, actor), { outcome: "ported again" });
		expect(again.ok).toBe(false);
		expect(f.agents.get(worker.id)?.outcome).toBe("ported");
		expect(f.events).toEqual(["agent.finished"]);
	});
});

test("the workspace leader can ask for a delegated mission without activeMissionId", async () => {
	const f = fixture();
	const lead = makeAgent(ulid(), "idle", { canSpawn: true });
	f.agents.set(lead.id, lead);
	await f.missions.save({ ...mission(), lead: { kind: "agent", agentId: lead.id } });
	f.store.getLeader = () => ({ ...LEADER, activeMissionId: undefined });
	const actor: Actor = { kind: "leader", workspaceId: WORKSPACE, sessionId: LEADER.sessionId };
	const result = await coordinationHandlers.neta_ask(ctx(f, actor), {
		missionId: 1,
		question: "Apply to production?",
	});
	expect(result).toEqual({ ok: true, data: { missionId: 1 } });
	expect(f.agents.get(lead.id)?.pendingQuestion).toBe("Apply to production?");
	expect(f.agents.get(lead.id)?.state).toBe("blocked");
	expect(f.eventData).toContainEqual({ question: "Apply to production?", userEscalation: true, needsReply: true });
});
test("asking about an invalid or another mission cannot redirect a lead's question", async () => {
	const f = fixture();
	const lead = makeAgent(ulid(), "running", { canSpawn: true });
	f.agents.set(lead.id, lead);
	expect((await coordinationHandlers.neta_ask(ctx(f, leadActor(lead)), { missionId: 99, question: "ship?" })).ok).toBe(
		false,
	);
	expect(f.agents.get(lead.id)?.state).toBe("running");
});
test("durable follow-ups return receipts, deduplicate retries, and never cancel busy recipients", async () => {
	const f = fixture();
	const worker = makeAgent(ulid(), "running");
	f.agents.set(worker.id, worker);
	const ids: string[] = [];
	f.sessions.send = async (agent, text, sourceId) => {
		ids.push(sourceId);
		return {
			id: sourceId,
			sessionId: agent.sessionId,
			createdAt: new Date(0).toISOString(),
			text,
			attachments: [],
			status: "queued",
		};
	};
	const context = ctx(f, leadActor(makeAgent(ulid(), "running")));
	const results = await Promise.all(
		[1, 2].map(() => coordinationHandlers.neta_send(context, { agentId: worker.id, text: "Review the edge cases" })),
	);
	expect(ids[0]).toBe(ids[1]);
	expect(ids[0]).toStartWith("followup:");
	expect(results[0]).toMatchObject({ ok: true, data: { status: "queued", messageId: ids[0] } });
	expect(f.calls).toEqual([]);
	expect(f.agents.get(worker.id)?.state).toBe("running");
});
