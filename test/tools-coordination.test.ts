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
		lead: { kind: "leader" },
		agentIds: [],
		access: "readWrite",
		state: "open",
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
	const sessions: CoordinationPorts["sessions"] = {};

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
	return { actor, deps: { store: f.store, sessions: f.sessions } };
}

function leadActor(agent: Agent): Actor {
	return { kind: "lead", workspaceId: WORKSPACE, missionId: MISSION, agentId: agent.id, sessionId: agent.sessionId };
}

describe("send_message", () => {
	test.each(["running", "idle", "idle"] as const)(
		"self-send from %s refuses before touching the session",
		async (state) => {
			const f = fixture();
			const self = makeAgent(ulid(), state, { canSpawn: true, name: "Britt" });
			f.agents.set(self.id, self);
			const result = await coordinationHandlers.send_message(ctx(f, leadActor(self)), {
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
		const done = makeAgent(ulid(), "idle");
		f.agents.set(done.id, done);
		const actor = leadActor(makeAgent(ulid(), "running"));
		const result = await coordinationHandlers.send_message(ctx(f, actor), { agentId: done.id, text: "late" });
		expect(result.ok).toBe(false);
		expect(f.calls).toEqual([]);
	});
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
		[1, 2].map(() =>
			coordinationHandlers.send_message(context, { agentId: worker.id, text: "Review the edge cases" }),
		),
	);
	expect(ids[0]).toBe(ids[1]);
	expect(ids[0]).toStartWith("followup:");
	expect(results[0]).toMatchObject({ ok: true, data: { status: "queued", messageId: ids[0] } });
	expect(f.calls).toEqual([]);
	expect(f.agents.get(worker.id)?.state).toBe("running");
});
