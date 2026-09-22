import { describe, expect, test } from "bun:test";
import { ulid } from "../src/core/ids.ts";
import type { Agent, EventKind, Leader, Mission, MissionState } from "../src/core/types.ts";
import type { NodeStore } from "../src/node/server.ts";
import {
	type CloseMissionInput,
	type CloseOutcome,
	type LifecyclePorts,
	type LifecycleToolContext,
	lifecycleHandlers,
	type ModeApproval,
} from "../src/tools/handlers/lifecycle.ts";
import type { Actor } from "../src/tools/router.ts";

const WORKSPACE = "w";

function mission(number: number, state: MissionState, extra?: Partial<Mission>): Mission {
	return {
		id: ulid(),
		number,
		workspaceId: WORKSPACE,
		machineId: "m",
		name: `mission ${number}`,
		objective: "original objective",
		changes: [],
		lead: { kind: "leader" },
		agentIds: [],
		access: "readOnly",
		state,
		createdAt: new Date(0).toISOString(),
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
	modeActiveMs: 12000,
	state: "running",
};

const LEADER_ACTOR: Actor = { kind: "leader", workspaceId: WORKSPACE, sessionId: LEADER.sessionId };

interface Fixture {
	store: NodeStore;
	missions: Map<string, Mission>;
	events: EventKind[];
	closes: CloseMissionInput[];
	modes: Array<{ subject: unknown; mode: unknown }>;
	ports: LifecyclePorts;
}

function fixture(opts?: {
	close?: (input: CloseMissionInput) => Promise<CloseOutcome>;
	approval?: ModeApproval;
	seed?: Mission[];
}): Fixture {
	const missions = new Map<string, Mission>();
	for (const m of opts?.seed ?? [mission(1, "running")]) {
		missions.set(m.id, m);
	}
	const events: EventKind[] = [];
	const closes: CloseMissionInput[] = [];
	const modes: Array<{ subject: unknown; mode: unknown }> = [];
	const approval: ModeApproval = opts?.approval ?? { approved: true };

	async function emit(kind: EventKind): Promise<void> {
		events.push(kind);
	}

	const store: NodeStore = {
		machine: () => ({ id: "m", name: "test", createdAt: new Date(0).toISOString() }),
		listWorkspaces: () => [],
		listLeaders: () => [LEADER],
		listMissions: () => [...missions.values()],
		listAgents: () => [] as Agent[],
		getWorkspace: () => undefined,
		getLeader: () => LEADER,
		getMission: (id) => missions.get(id),
		getAgent: () => undefined,
		putWorkspace: () => Promise.resolve(),
		putAgent: () => Promise.resolve(),
		putLeader: () => Promise.resolve(),
		compact: () => Promise.resolve(),
		appendEvent: async (event) => {
			events.push(event.kind);
			return { seq: events.length, at: new Date(0).toISOString(), ...event };
		},
		listEvents: () => Promise.reject(new Error("unused")),
		tailConversation: () => Promise.reject(new Error("unused")),
	};
	const ports: LifecyclePorts = {
		missions: {
			save: async (m) => {
				missions.set(m.id, m);
			},
		},
		worktrees: {
			close:
				opts?.close ??
				(async (input) => {
					await emit("mission.closed");
					return {
						ok: true,
						mission: {
							...input.mission,
							state: "closed" as const,
							closedAt: new Date(0).toISOString(),
							disposition: input.disposition,
							closeReason: input.reason,
						},
					};
				}),
		},
		modes: {
			requestMode: async (input) => {
				modes.push({ subject: input.subject, mode: input.mode });
				return approval;
			},
			// 07 keys a mission lead's mode by its own agentId, so the
			// snapshot answers for the subject that asked, not for the
			// workspace leader.
			snapshot: async (subject) =>
				subject.kind === "lead"
					? { mode: "leadPlus" as const, modeActiveMs: 660_000 }
					: { mode: LEADER.mode, modeActiveMs: LEADER.modeActiveMs },
		},
	};
	return { store, missions, events, closes, modes, ports };
}

function ctx(f: Fixture, actor: Actor = LEADER_ACTOR): LifecycleToolContext {
	return { actor, deps: { store: f.store, ...f.ports } };
}

function onlyMission(f: Fixture): Mission {
	const [first] = [...f.missions.values()];
	if (first === undefined) {
		throw new Error("no mission");
	}
	return first;
}

describe("neta_scope", () => {
	test("scope is append-only: objective unchanged after two calls, order kept", async () => {
		const f = fixture();
		const id = onlyMission(f).id;
		await lifecycleHandlers.neta_scope(ctx(f), { missionId: id, text: "first" });
		const result = await lifecycleHandlers.neta_scope(ctx(f), { missionId: id, text: "second" });
		expect(result).toEqual({ ok: true, data: { missionId: 1 } });
		const updated = onlyMission(f);
		expect(updated.objective).toBe("original objective");
		expect(updated.changes.map((c) => c.text)).toEqual(["first", "second"]);
		expect(f.events).toEqual(["mission.changed", "mission.changed"]);
	});
});

describe("neta_ready", () => {
	test("sets readyToClose with the summary and emits mission.readyToClose", async () => {
		const f = fixture();
		const id = onlyMission(f).id;
		const result = await lifecycleHandlers.neta_ready(ctx(f), { missionId: id, summary: "all done" });
		expect(result).toEqual({ ok: true, data: { missionId: 1, state: "readyToClose" } });
		expect(onlyMission(f).attention).toBe("all done");
		expect(f.events).toEqual(["mission.readyToClose"]);
	});
});

describe("neta_close", () => {
	test("merged without evidence is refused", async () => {
		const f = fixture();
		const id = onlyMission(f).id;
		const result = await lifecycleHandlers.neta_close(ctx(f), {
			missionId: id,
			disposition: "merged",
			reason: "done",
		});
		expect(result).toEqual({ ok: false, code: "refused", message: "merged needs evidence" });
		expect(onlyMission(f).state).toBe("running");
	});

	test("merged with evidence closes and emits mission.closed", async () => {
		const f = fixture();
		const id = onlyMission(f).id;
		const result = await lifecycleHandlers.neta_close(ctx(f), {
			missionId: id,
			disposition: "merged",
			evidence: "abc1234",
			reason: "done",
		});
		expect(result).toEqual({ ok: true, data: { missionId: 1, disposition: "merged" } });
		expect(onlyMission(f).state).toBe("closed");
		expect(f.events).toEqual(["mission.closed"]);
	});

	test("abandoned needs no evidence", async () => {
		const f = fixture();
		const id = onlyMission(f).id;
		const result = await lifecycleHandlers.neta_close(ctx(f), {
			missionId: id,
			disposition: "abandoned",
			reason: "wrong direction",
		});
		expect(result.ok).toBe(true);
		expect(onlyMission(f).state).toBe("closed");
	});

	test("repeating the same close is idempotent but a different disposition is refused", async () => {
		const f = fixture();
		const id = onlyMission(f).id;
		await lifecycleHandlers.neta_close(ctx(f), { missionId: id, disposition: "abandoned", reason: "x" });
		const again = await lifecycleHandlers.neta_close(ctx(f), {
			missionId: id,
			disposition: "abandoned",
			reason: "x",
		});
		expect(again).toEqual({ ok: true, data: { missionId: 1, disposition: "abandoned", alreadyClosed: true } });
		expect(f.events).toEqual(["mission.closed"]);
		expect(
			await lifecycleHandlers.neta_close(ctx(f), { missionId: 1, disposition: "completed", reason: "x" }),
		).toMatchObject({ ok: false, code: "refused" });
	});

	test("a lead closing at all is refused", async () => {
		const f = fixture();
		const id = onlyMission(f).id;
		const agentId = ulid();
		const result = await lifecycleHandlers.neta_close(
			ctx(f, { kind: "lead", workspaceId: WORKSPACE, missionId: id, agentId, sessionId: ulid() }),
			{ missionId: id, disposition: "abandoned", reason: "x" },
		);
		expect(result).toEqual({ ok: false, code: "notAuthorised", message: "only the leader closes missions" });
		expect(onlyMission(f).state).toBe("running");
	});

	test("a dirty worktree refusal keeps the mission open with its attention", async () => {
		const f = fixture({
			close: async (input) => ({ ok: false, attention: "worktree is dirty", mission: input.mission }),
		});
		const id = onlyMission(f).id;
		const result = await lifecycleHandlers.neta_close(ctx(f), {
			missionId: id,
			disposition: "abandoned",
			reason: "x",
		});
		expect(result).toEqual({ ok: false, code: "refused", message: "worktree is dirty" });
		expect(onlyMission(f).state).toBe("running");
	});
});

describe("neta_pin and neta_status", () => {
	test("pin emits user.pinned", async () => {
		const f = fixture();
		const turnId = ulid();
		const result = await lifecycleHandlers.neta_pin(ctx(f), { turnId, text: "keep" });
		expect(result).toEqual({ ok: true, data: { turnId, pinned: true } });
		expect(f.events).toEqual(["user.pinned"]);
	});

	test("status lists open missions only, needs-person first", async () => {
		const f = fixture({
			seed: [mission(1, "blocked", { attention: "staging key" }), mission(2, "running"), mission(3, "closed")],
		});
		const result = await lifecycleHandlers.neta_status(ctx(f), {});
		expect(result).toEqual({
			ok: true,
			data: {
				self: { role: "leader", actorId: LEADER.sessionId, name: LEADER.name },
				missions: [
					{
						number: 1,
						missionId: 1,
						name: "mission 1",
						state: "blocked",
						attention: "staging key",
						agents: 0,
						executingAgents: 0,
						queuedAgents: 0,
					},
					{
						number: 2,
						missionId: 2,
						name: "mission 2",
						state: "running",
						agents: 0,
						executingAgents: 0,
						queuedAgents: 0,
					},
				],
				agentDetails: [],
				mode: "lead",
				modeActiveMs: 12000,
			},
		});
	});

	// The lead's own mode, from its own record: reading the workspace
	// leader's would tell a mission lead in Lead++ that it is in Lead.
	test("status reports the calling lead's own mode, not the leader's", async () => {
		const f = fixture({ seed: [mission(1, "running")] });
		const lead: Actor = {
			kind: "lead",
			workspaceId: WORKSPACE,
			missionId: onlyMission(f).id,
			agentId: "a1",
			sessionId: ulid(),
		};
		const result = await lifecycleHandlers.neta_status(ctx(f, lead), {});
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error("expected a status");
		}
		expect(result.data.mode).toBe("leadPlus");
		expect(result.data.modeActiveMs).toBe(660_000);
	});
});

describe("neta_mode", () => {
	test("returns the approval verbatim", async () => {
		const denial: ModeApproval = { approved: false, reason: "reservedByCharter", detail: "charter reserves deploys" };
		const f = fixture({ approval: denial });
		const result = await lifecycleHandlers.neta_mode(ctx(f), { mode: "leadPlus" });
		expect(result).toEqual({ ok: true, data: denial });
		expect(f.modes).toEqual([{ subject: { kind: "leader", workspaceId: WORKSPACE }, mode: "leadPlus" }]);
	});
});

test("status exposes connected model choices for deliberate staffing", async () => {
	const f = fixture();
	f.ports.modelCatalog = async () => [{ provider: "opencode", id: "openai/small", name: "Small" }];
	const result = await lifecycleHandlers.neta_status(ctx(f), {});
	expect(result).toMatchObject({ ok: true, data: { modelCatalog: [{ id: "openai/small" }] } });
});

test("status exposes actual and routed model separately with effort and warnings", async () => {
	const f = fixture();
	const agent: Agent = {
		id: "worker",
		missionId: onlyMission(f).id,
		workspaceId: WORKSPACE,
		name: "Test",
		task: "check",
		access: "readOnly",
		provider: "opencode",
		model: "openai/actual",
		requestedModel: "openai/luna",
		skills: [],
		sessionId: "session",
		canSpawn: false,
		state: "running",
		startedAt: new Date(0).toISOString(),
		routing: {
			effort: 1,
			method: "fixed",
			selectedModel: "openai/luna",
			candidates: ["openai/luna"],
			reason: "Configured effort 1",
			warnings: ["Reference price only"],
		},
	};
	f.store.listAgents = () => [agent];
	const result = await lifecycleHandlers.neta_status(ctx(f), {});
	expect(result.ok).toBe(true);
	if (result.ok)
		expect(result.data.agentDetails).toEqual([
			{
				agentId: "worker",
				role: "agent",
				isSelf: false,
				name: "Test",
				mission: 1,
				state: "running",
				model: "openai/actual",
				requestedModel: "openai/luna",
				routing: {
					effort: 1,
					method: "fixed",
					selectedModel: "openai/luna",
					reason: "Configured effort 1",
					warnings: ["Reference price only"],
				},
			},
		]);
});

test("status distinguishes the caller from workers and open missions from executing agents", async () => {
	const f = fixture();
	const m = onlyMission(f);
	const lead: Agent = {
		id: "britt",
		name: "Britt",
		sessionId: "britt-session",
		missionId: m.id,
		workspaceId: WORKSPACE,
		task: "fix",
		access: "readOnly",
		provider: "fake",
		model: "small",
		skills: [],
		canSpawn: true,
		state: "idle",
		startedAt: new Date(0).toISOString(),
	};
	f.store.listAgents = () => [lead];
	f.store.getAgent = (id) => (id === lead.id ? lead : undefined);
	const actor: Actor = {
		kind: "lead",
		workspaceId: WORKSPACE,
		missionId: m.id,
		agentId: lead.id,
		sessionId: lead.sessionId,
	};
	const result = await lifecycleHandlers.neta_status(ctx(f, actor), {});
	expect(result).toMatchObject({
		ok: true,
		data: {
			self: { role: "lead", actorId: "britt", name: "Britt" },
			missions: [{ missionId: 1, state: "running", executingAgents: 0, queuedAgents: 0 }],
			agentDetails: [{ agentId: "britt", role: "lead", isSelf: true, state: "idle" }],
		},
	});
	lead.state = "running";
	expect(await lifecycleHandlers.neta_status(ctx(f, actor), {})).toMatchObject({
		ok: true,
		data: { missions: [{ executingAgents: 1 }] },
	});
});

test("mission numbers resolve only inside the caller's workspace, including legacy IDs", async () => {
	const own = mission(12, "running");
	const foreign = mission(12, "running", { workspaceId: "elsewhere" });
	const f = fixture({ seed: [foreign, own] });
	expect(await lifecycleHandlers.neta_scope(ctx(f), { missionId: 12, text: "local" })).toEqual({
		ok: true,
		data: { missionId: 12 },
	});
	expect(f.missions.get(own.id)?.changes).toHaveLength(1);
	expect(f.missions.get(foreign.id)?.changes).toHaveLength(0);
	expect(await lifecycleHandlers.neta_ready(ctx(f), { missionId: foreign.id, summary: "no" })).toMatchObject({
		ok: false,
		code: "notFound",
	});
});

test("mission lead can hand off without an ID; active workers prevent premature completion", async () => {
	const f = fixture();
	const m = onlyMission(f);
	const lead: Agent = {
		id: "lead",
		missionId: m.id,
		workspaceId: WORKSPACE,
		sessionId: "lead-session",
		name: "Lead",
		task: "check",
		provider: "fake",
		model: "small",
		access: "readOnly",
		skills: [],
		canSpawn: true,
		state: "running",
		startedAt: new Date(0).toISOString(),
	};
	const agents = new Map([
		[lead.id, lead],
		["worker", { ...lead, id: "worker", canSpawn: false }],
	]);
	f.missions.set(m.id, { ...m, lead: { kind: "agent", agentId: lead.id }, agentIds: [...agents.keys()] });
	f.store.getAgent = (id) => agents.get(id);
	f.store.listAgents = () => [...agents.values()];
	f.store.putAgent = async (agent) => {
		agents.set(agent.id, agent);
	};
	const released: string[] = [];
	f.ports.sessions = {
		release: async (agent) => {
			released.push(agent.id);
		},
	};
	const actor: Actor = {
		kind: "lead",
		workspaceId: WORKSPACE,
		missionId: m.id,
		agentId: lead.id,
		sessionId: lead.sessionId,
	};
	expect(await lifecycleHandlers.neta_ready(ctx(f, actor), { summary: "done" })).toMatchObject({
		ok: false,
		code: "refused",
	});
	expect(
		await lifecycleHandlers.neta_close(ctx(f), { missionId: m.number, disposition: "completed", reason: "done" }),
	).toMatchObject({ ok: false, code: "refused" });
	agents.set("worker", { ...lead, id: "worker", canSpawn: false, state: "completed" });
	expect(await lifecycleHandlers.neta_ready(ctx(f, actor), { summary: "checked" })).toEqual({
		ok: true,
		data: { missionId: m.number, state: "readyToClose" },
	});
	expect(agents.get(lead.id)).toMatchObject({ state: "completed", outcome: "checked" });
	expect(released).toEqual([lead.id]);
	expect(
		await lifecycleHandlers.neta_close(ctx(f), { missionId: m.number, disposition: "completed", reason: "checked" }),
	).toMatchObject({ ok: true, data: { disposition: "completed" } });
});
