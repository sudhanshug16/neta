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
	calls: string[];
	sessions: CoordinationPorts["sessions"];
	settle(id: string, state: AgentState): void;
}

const SETTLED: readonly AgentState[] = ["blocked", "completed", "failed", "archived"];

function fixture(): Fixture {
	const agents = new Map<string, Agent>();
	const events: EventKind[] = [];
	const calls: string[] = [];
	const waiters: Array<{
		missionId: string;
		agentIds?: string[];
		resolve(changed: Agent[]): void;
	}> = [];

	function watched(missionId: string, agentIds?: string[]): Agent[] {
		return [...agents.values()].filter(
			(a) => a.missionId === missionId && (agentIds === undefined || agentIds.includes(a.id)),
		);
	}

	const sessions: CoordinationPorts["sessions"] = {
		cancel: async (sessionId) => {
			calls.push(`cancel:${sessionId}`);
		},
		prompt: async (sessionId, text) => {
			calls.push(`prompt:${sessionId}:${text}`);
		},
		wait: async (input) => {
			const settled = watched(input.missionId, input.agentIds).filter((a) => SETTLED.includes(a.state));
			if (settled.length > 0) {
				return { changed: settled, timedOut: false };
			}
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					const index = waiters.findIndex((w) => w.resolve === done);
					if (index >= 0) {
						waiters.splice(index, 1);
					}
					resolve({ changed: [], timedOut: true });
				}, input.timeoutMs);
				const done = (changed: Agent[]): void => {
					clearTimeout(timer);
					resolve({ changed, timedOut: false });
				};
				waiters.push({ missionId: input.missionId, agentIds: input.agentIds, resolve: done });
			});
		},
	};

	const store: NodeStore = {
		machine: () => ({ id: "m", name: "test", createdAt: new Date(0).toISOString() }),
		listWorkspaces: () => [],
		listLeaders: () => [LEADER],
		listMissions: () => [mission()],
		listAgents: (missionId) => [...agents.values()].filter((a) => a.missionId === missionId),
		getWorkspace: () => undefined,
		getLeader: () => LEADER,
		getMission: (id) => (id === MISSION ? mission() : undefined),
		getAgent: (id) => agents.get(id),
		putWorkspace: () => Promise.resolve(),
		putAgent: async (agent) => {
			agents.set(agent.id, agent);
		},
		putLeader: () => Promise.resolve(),
		compact: () => Promise.resolve(),
		appendEvent: async (event) => {
			events.push(event.kind);
			return { seq: events.length, at: new Date(0).toISOString(), ...event };
		},
		listEvents: () => Promise.reject(new Error("unused")),
		tailConversation: () => Promise.reject(new Error("unused")),
	};

	return {
		store,
		agents,
		events,
		calls,
		sessions,
		settle(id, state) {
			const agent = agents.get(id);
			if (agent === undefined) {
				throw new Error(`no such agent: ${id}`);
			}
			agents.set(id, { ...agent, state });
			for (let i = waiters.length - 1; i >= 0; i--) {
				const waiter = waiters[i];
				if (waiter === undefined) {
					continue;
				}
				const changed = watched(waiter.missionId, waiter.agentIds).filter((a) => SETTLED.includes(a.state));
				if (changed.length > 0) {
					waiters.splice(i, 1);
					waiter.resolve(changed);
				}
			}
		},
	};
}

function ctx(f: Fixture, actor: Actor): CoordinationToolContext {
	return { actor, deps: { store: f.store, sessions: f.sessions } };
}

function leadActor(agent: Agent): Actor {
	return { kind: "lead", workspaceId: WORKSPACE, missionId: MISSION, agentId: agent.id, sessionId: agent.sessionId };
}

describe("neta_wait", () => {
	test("returns immediately for an already blocked agent", async () => {
		const f = fixture();
		const blocked = makeAgent(ulid(), "blocked", { pendingQuestion: "which key?" });
		f.agents.set(blocked.id, blocked);
		const actor = leadActor(makeAgent(ulid(), "running"));
		const result = await coordinationHandlers.neta_wait(ctx(f, actor), { missionId: MISSION });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.timedOut).toBe(false);
			expect((result.data.changed as Agent[]).map((a) => a.id)).toEqual([blocked.id]);
		}
	});

	test("returns when a fake-agent session finishes", async () => {
		const f = fixture();
		const worker = makeAgent(ulid(), "running");
		f.agents.set(worker.id, worker);
		const actor = leadActor(makeAgent(ulid(), "running"));
		const waited = coordinationHandlers.neta_wait(ctx(f, actor), { missionId: MISSION, timeoutMs: 5000 });
		f.settle(worker.id, "completed");
		const result = await waited;
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.timedOut).toBe(false);
			expect((result.data.changed as Agent[]).map((a) => a.id)).toEqual([worker.id]);
		}
	});

	test("times out with timedOut: true and no error", async () => {
		const f = fixture();
		f.agents.set(ulid(), makeAgent(ulid(), "running"));
		const actor = leadActor(makeAgent(ulid(), "running"));
		const result = await coordinationHandlers.neta_wait(ctx(f, actor), { missionId: MISSION, timeoutMs: 20 });
		expect(result).toEqual({ ok: true, data: { changed: [], timedOut: true } });
	});
});

describe("neta_send", () => {
	test("to a blocked agent clears pendingQuestion and emits mission.unblocked", async () => {
		const f = fixture();
		const blocked = makeAgent(ulid(), "blocked", { pendingQuestion: "which key?" });
		f.agents.set(blocked.id, blocked);
		const actor = leadActor(makeAgent(ulid(), "running"));
		const result = await coordinationHandlers.neta_send(ctx(f, actor), { agentId: blocked.id, text: "staging" });
		expect(result).toEqual({ ok: true, data: { agentId: blocked.id, delivered: "answered" } });
		expect(f.agents.get(blocked.id)?.pendingQuestion).toBeUndefined();
		expect(f.agents.get(blocked.id)?.state).toBe("running");
		expect(f.events).toEqual(["mission.unblocked"]);
		expect(f.calls).toEqual([`prompt:${blocked.sessionId}:staging`]);
	});

	test("to a running agent cancels before prompting", async () => {
		const f = fixture();
		const worker = makeAgent(ulid(), "running");
		f.agents.set(worker.id, worker);
		const actor = leadActor(makeAgent(ulid(), "running"));
		const result = await coordinationHandlers.neta_send(ctx(f, actor), { agentId: worker.id, text: "pivot" });
		expect(result).toEqual({ ok: true, data: { agentId: worker.id, delivered: "resteered" } });
		expect(f.calls).toEqual([`cancel:${worker.sessionId}`, `prompt:${worker.sessionId}:pivot`]);
		expect(f.events).toEqual([]);
	});

	test("to a finished agent is refused", async () => {
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
