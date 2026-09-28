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

function fixture(opts?: { close?: (input: CloseMissionInput) => Promise<CloseOutcome>; seed?: Mission[] }): Fixture {
	const missions = new Map<string, Mission>();
	for (const m of opts?.seed ?? [mission(1, "open")]) {
		missions.set(m.id, m);
	}
	const events: EventKind[] = [];
	const closes: CloseMissionInput[] = [];
	const modes: Array<{ subject: unknown; mode: unknown }> = [];

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

describe("close", () => {
	test("merged without evidence is refused", async () => {
		const f = fixture();
		const id = onlyMission(f).id;
		const result = await lifecycleHandlers.close(ctx(f), {
			missionId: id,
			disposition: "merged",
			reason: "done",
		});
		expect(result).toEqual({ ok: false, code: "refused", message: "merged needs evidence" });
		expect(onlyMission(f).state).toBe("open");
	});

	test("merged with evidence closes and emits mission.closed", async () => {
		const f = fixture();
		const id = onlyMission(f).id;
		const result = await lifecycleHandlers.close(ctx(f), {
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
		const result = await lifecycleHandlers.close(ctx(f), {
			missionId: id,
			disposition: "abandoned",
			reason: "wrong direction",
		});
		expect(result.ok).toBe(true);
		expect(onlyMission(f).state).toBe("closed");
	});

	test("abandoned forwards an explicit discard confirmation", async () => {
		const seen: CloseMissionInput[] = [];
		const f = fixture({
			close: async (input) => {
				seen.push(input);
				return { ok: true, mission: { ...input.mission, state: "closed" as const } };
			},
		});
		const id = onlyMission(f).id;
		const result = await lifecycleHandlers.close(ctx(f), {
			missionId: id,
			disposition: "abandoned",
			reason: "superseded",
			discardUncommitted: true,
		});
		expect(result.ok).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ disposition: "abandoned", discardUncommitted: true });
	});

	test("repeating the same close is idempotent but a different disposition is refused", async () => {
		const f = fixture();
		const id = onlyMission(f).id;
		await lifecycleHandlers.close(ctx(f), { missionId: id, disposition: "abandoned", reason: "x" });
		const again = await lifecycleHandlers.close(ctx(f), {
			missionId: id,
			disposition: "abandoned",
			reason: "x",
		});
		expect(again).toEqual({ ok: true, data: { missionId: 1, disposition: "abandoned", alreadyClosed: true } });
		expect(f.events).toEqual(["mission.closed"]);
		expect(
			await lifecycleHandlers.close(ctx(f), { missionId: 1, disposition: "completed", reason: "x" }),
		).toMatchObject({ ok: false, code: "refused" });
	});

	test("a lead closing at all is refused", async () => {
		const f = fixture();
		const id = onlyMission(f).id;
		const agentId = ulid();
		const result = await lifecycleHandlers.close(
			ctx(f, { kind: "lead", workspaceId: WORKSPACE, missionId: id, agentId, sessionId: ulid() }),
			{ missionId: id, disposition: "abandoned", reason: "x" },
		);
		expect(result).toEqual({ ok: false, code: "notAuthorised", message: "only the leader closes missions" });
		expect(onlyMission(f).state).toBe("open");
	});

	test("a dirty worktree refusal keeps the mission open with its attention", async () => {
		const f = fixture({
			close: async (input) => ({ ok: false, attention: "worktree is dirty", mission: input.mission }),
		});
		const id = onlyMission(f).id;
		const result = await lifecycleHandlers.close(ctx(f), {
			missionId: id,
			disposition: "abandoned",
			reason: "x",
		});
		expect(result).toEqual({ ok: false, code: "refused", message: "worktree is dirty" });
		expect(onlyMission(f).state).toBe("open");
	});
});

test("status exposes connected model choices for deliberate staffing", async () => {
	const f = fixture();
	f.ports.modelCatalog = async () => [{ provider: "opencode", id: "openai/small", name: "Small" }];
	const result = await lifecycleHandlers.list_models(ctx(f), {});
	expect(result).toMatchObject({ ok: true, data: { models: [{ id: "openai/small" }] } });
});

test("large status and model catalogs page completely within 4 KiB", async () => {
	const f = fixture({ seed: Array.from({ length: 75 }, (_, index) => mission(index + 1, "open")) });
	const numbers: number[] = [];
	let cursor: string | undefined;
	do {
		const page = await lifecycleHandlers.mission_state(ctx(f), { cursor });
		if (!page.ok) throw new Error(page.message);
		expect(Buffer.byteLength(JSON.stringify(page.data))).toBeLessThanOrEqual(4096);
		const data = page.data as { missions: Array<{ number: number }>; nextCursor?: string };
		numbers.push(...data.missions.map((item) => item.number));
		cursor = data.nextCursor;
	} while (cursor);
	expect(numbers).toEqual(Array.from({ length: 75 }, (_, index) => 75 - index));
	f.ports.modelCatalog = async () =>
		Array.from({ length: 135 }, (_, index) => ({
			provider: "opencode",
			id: `openai/model-${String(index).padStart(3, "0")}`,
			name: `Model ${index}`,
		}));
	const ids: string[] = [];
	cursor = undefined;
	do {
		const page = await lifecycleHandlers.list_models(ctx(f), { cursor });
		if (!page.ok) throw new Error(page.message);
		expect(Buffer.byteLength(JSON.stringify(page.data))).toBeLessThanOrEqual(4096);
		const data = page.data as { models: Array<{ id: string }>; nextCursor?: string };
		ids.push(...data.models.map((item) => item.id));
		cursor = data.nextCursor;
	} while (cursor);
	expect(new Set(ids).size).toBe(135);
	const filtered = await lifecycleHandlers.list_models(ctx(f), { query: "model-010" });
	expect(filtered).toMatchObject({ ok: true, data: { total: 1, models: [{ id: "openai/model-010" }] } });
	const foreign = await lifecycleHandlers.list_models(ctx(f), {
		query: "model-010",
		cursor: JSON.stringify(["", "opencode/openai/model-010"]),
	});
	expect(foreign).toMatchObject({ ok: false });
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
	const result = await lifecycleHandlers.mission_state(ctx(f), { missionId: 1 });
	expect(result.ok).toBe(true);
	if (result.ok)
		expect(result.data.agentDetails).toMatchObject([
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
	const result = await lifecycleHandlers.mission_state(ctx(f, actor), { missionId: 1 });
	expect(result).toMatchObject({
		ok: true,
		data: {
			self: { role: "lead", actorId: "britt", name: "Britt" },
			mission: { number: 1, state: "open" },
			agentDetails: [{ agentId: "britt", role: "lead", isSelf: true, state: "idle" }],
		},
	});
	lead.state = "running";
	expect(await lifecycleHandlers.mission_state(ctx(f, actor), {})).toMatchObject({
		ok: true,
		data: { mission: { number: 1 }, agentDetails: [{ agentId: "britt", state: "running" }] },
	});
});
