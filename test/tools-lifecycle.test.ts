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
		expect(result).toEqual({ ok: true, data: { missionId: id } });
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
		expect(result).toEqual({ ok: true, data: { missionId: id, state: "readyToClose" } });
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
		expect(result).toEqual({ ok: true, data: { missionId: id, disposition: "merged" } });
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

	test("closing twice is refused", async () => {
		const f = fixture();
		const id = onlyMission(f).id;
		await lifecycleHandlers.neta_close(ctx(f), { missionId: id, disposition: "abandoned", reason: "x" });
		const again = await lifecycleHandlers.neta_close(ctx(f), {
			missionId: id,
			disposition: "abandoned",
			reason: "x",
		});
		expect(again).toEqual({ ok: false, code: "refused", message: "the mission is already closed" });
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
				missions: [
					{ number: 1, name: "mission 1", state: "blocked", attention: "staging key", agents: 0 },
					{ number: 2, name: "mission 2", state: "running", agents: 0 },
				],
				mode: "lead",
				modeActiveMs: 12000,
			},
		});
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
