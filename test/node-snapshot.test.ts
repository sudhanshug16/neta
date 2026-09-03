import { describe, expect, test } from "bun:test";
import { ulid } from "../src/core/ids.ts";
import type { Agent, AgentState, Event, IsoTime, Leader, Mission, MissionState, Workspace } from "../src/core/types.ts";
import { NodeError } from "../src/node/protocol.ts";
import type { NodeAcp, NodeContext, NodeStore } from "../src/node/server.ts";
import { buildSnapshot, snapshotHandlers } from "../src/node/snapshot.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MACHINE_ID = ulid();

function daysAgo(days: number): IsoTime {
	return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

function hoursAgo(hours: number): IsoTime {
	return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function workspace(id: string, name: string): Workspace {
	return { id, kind: "folder", name, roots: [{ machineId: MACHINE_ID, path: `/${name}` }], createdAt: daysAgo(60) };
}

function leader(workspaceId: string): Leader {
	return {
		workspaceId,
		machineId: MACHINE_ID,
		sessionId: ulid(),
		provider: "test",
		model: "m",
		mode: "lead",
		modeSince: daysAgo(60),
		modeActiveMs: 0,
		state: "idle",
	};
}

let missionNumber = 0;

function mission(workspaceId: string, state: MissionState, createdDaysAgo: number, extra?: Partial<Mission>): Mission {
	missionNumber += 1;
	return {
		id: ulid(),
		number: missionNumber,
		workspaceId,
		machineId: MACHINE_ID,
		name: `mission ${missionNumber}`,
		objective: "test",
		changes: [],
		lead: { kind: "leader" },
		agentIds: [],
		access: "readOnly",
		state,
		createdAt: daysAgo(createdDaysAgo),
		...extra,
	};
}

function agent(missionId: string, workspaceId: string, state: AgentState, extra?: Partial<Agent>): Agent {
	return {
		id: ulid(),
		missionId,
		workspaceId,
		name: "agent",
		task: "test task",
		access: "readOnly",
		provider: "test",
		model: "m",
		skills: [],
		sessionId: ulid(),
		canSpawn: false,
		state,
		startedAt: daysAgo(9),
		...extra,
	};
}

const W1 = ulid();
const W2 = ulid();
const W3 = ulid();

// The world: 3 workspaces, 20 missions, 40 agents.
const M1 = mission(W1, "running", 10);
const M2 = mission(W1, "blocked", 1);
const M3 = mission(W1, "readyToClose", 2);
const M4 = mission(W1, "failed", 3);
const M5 = mission(W1, "mergedNotClosed", 4);
const M6 = mission(W1, "closed", 20, { closedAt: daysAgo(5) });
const M7 = mission(W1, "closed", 20, { closedAt: daysAgo(13.99) });
const M8 = mission(W1, "closed", 20, { closedAt: daysAgo(14.01) });
const M9 = mission(W1, "running", 6);
const M10 = mission(W2, "running", 11);
const M11 = mission(W2, "blocked", 5);
const M12 = mission(W2, "closed", 12, { closedAt: daysAgo(2) });
const M13 = mission(W2, "running", 12);
const M14 = mission(W2, "running", 12);
const M15 = mission(W2, "failed", 7);
const M16 = mission(W3, "running", 13);
const M17 = mission(W3, "running", 13);
const M18 = mission(W3, "blocked", 8);
const M19 = mission(W3, "closed", 14, { closedAt: daysAgo(1) });
const M20 = mission(W3, "closed", 50, { closedAt: daysAgo(40) });

const MISSIONS = [M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M12, M13, M14, M15, M16, M17, M18, M19, M20];

// Twelve completed agents with distinct end times, plus one archived
// completed and one live runner, all on M9.
const BIG_COMPLETED = Array.from({ length: 12 }, (_, i) =>
	agent(M9.id, W1, "completed", { endedAt: hoursAgo(12 - i) }),
);
const BIG_ARCHIVED = agent(M9.id, W1, "archived", { endedAt: hoursAgo(1) });
const BIG_RUNNER = agent(M9.id, W1, "running");

const AGENTS: Agent[] = [
	...BIG_COMPLETED,
	BIG_ARCHIVED,
	BIG_RUNNER,
	agent(M2.id, W1, "blocked"),
	agent(M2.id, W1, "running"),
	agent(M4.id, W1, "failed"),
	agent(M4.id, W1, "archived"),
	agent(M5.id, W1, "running"),
	agent(M3.id, W1, "completed", { endedAt: daysAgo(1) }),
	agent(M11.id, W2, "blocked"),
	agent(M11.id, W2, "starting"),
	agent(M15.id, W2, "failed"),
	agent(M15.id, W2, "completed", { endedAt: daysAgo(2) }),
	agent(M15.id, W2, "archived"),
	agent(M18.id, W3, "blocked"),
	agent(M1.id, W1, "running"),
	agent(M1.id, W1, "running"),
	agent(M6.id, W1, "completed", { endedAt: daysAgo(4) }),
	agent(M7.id, W1, "completed", { endedAt: daysAgo(13) }),
	agent(M8.id, W1, "running"),
	agent(M8.id, W1, "running"),
	agent(M20.id, W3, "running"),
	agent(M10.id, W2, "running"),
	agent(M12.id, W2, "completed", { endedAt: daysAgo(1) }),
	agent(M13.id, W2, "running"),
	agent(M14.id, W2, "interrupted", { stateBefore: "running" }),
	agent(M16.id, W3, "running"),
	agent(M17.id, W3, "running"),
	agent(M19.id, W3, "completed", { endedAt: hoursAgo(20) }),
];

function event(workspaceId: string, seq: number): Event {
	return { seq, at: daysAgo(1), workspaceId, kind: "mission.created", data: {} };
}

const LOGS = new Map<string, Event[]>([
	[W1, Array.from({ length: 250 }, (_, i) => event(W1, i + 1))],
	[W2, Array.from({ length: 5 }, (_, i) => event(W2, i + 1))],
	[W3, Array.from({ length: 3 }, (_, i) => event(W3, i + 1))],
]);

const seenLimits: Array<{ workspaceId: string; limit?: number }> = [];

function stubStore(): NodeStore {
	return {
		machine: () => ({ id: MACHINE_ID, name: "test", createdAt: daysAgo(60) }),
		listWorkspaces: () => [workspace(W1, "w1"), workspace(W2, "w2"), workspace(W3, "w3")],
		listLeaders: () => [leader(W1), leader(W2), leader(W3)],
		listMissions: (workspaceId) =>
			workspaceId === undefined ? MISSIONS : MISSIONS.filter((m) => m.workspaceId === workspaceId),
		listAgents: (missionId) => AGENTS.filter((a) => a.missionId === missionId),
		getWorkspace: (id) => [workspace(W1, "w1"), workspace(W2, "w2"), workspace(W3, "w3")].find((w) => w.id === id),
		getLeader: (id) => [leader(W1), leader(W2), leader(W3)].find((l) => l.workspaceId === id),
		getMission: (id) => MISSIONS.find((m) => m.id === id),
		getAgent: (id) => AGENTS.find((a) => a.id === id),
		putWorkspace: () => Promise.reject(new Error("not implemented in this test")),
		putAgent: () => Promise.reject(new Error("not implemented in this test")),
		putLeader: () => Promise.reject(new Error("not implemented in this test")),
		compact: () => Promise.reject(new Error("not implemented in this test")),
		appendEvent: () => Promise.reject(new Error("not implemented in this test")),
		// The port contract: no cursor means the most recent page first...
		// chronological within the page, so the first page is the last 200.
		listEvents: (query) => {
			seenLimits.push({ workspaceId: query.workspaceId, limit: query.limit });
			const log = LOGS.get(query.workspaceId) ?? [];
			const limit = query.limit ?? 200;
			return Promise.resolve({ events: log.slice(Math.max(0, log.length - limit)) });
		},
		tailConversation: () => Promise.reject(new Error("not implemented in this test")),
	};
}

function deadAcp(): NodeAcp {
	return {
		createSession: () => Promise.reject(new Error("not implemented in this test")),
		prompt: () => Promise.reject(new Error("not implemented in this test")),
		setModel: () => Promise.reject(new Error("not implemented in this test")),
		listModels: () => Promise.reject(new Error("not implemented in this test")),
		cancel: () => Promise.reject(new Error("not implemented in this test")),
		close: () => Promise.reject(new Error("not implemented in this test")),
		closeAll: () => Promise.reject(new Error("not implemented in this test")),
		onTurn: () => {
			throw new Error("not implemented in this test");
		},
	};
}

function testCtx(): NodeContext {
	return {
		store: stubStore(),
		acp: deadAcp(),
		hub: {
			broadcast: () => undefined,
			toTail: () => undefined,
			connections: () => [],
		},
		nodeVersion: "0.0.0-test",
		stop: () => Promise.resolve(),
	};
}

describe("buildSnapshot", () => {
	test("the window boundary includes and excludes the right closed missions and sets hasOlder", async () => {
		const snapshot = await buildSnapshot(testCtx(), {});
		const ids = new Set(snapshot.missions.map((m) => m.id));
		expect(ids.has(M6.id)).toBe(true);
		expect(ids.has(M7.id)).toBe(true);
		expect(ids.has(M8.id)).toBe(false);
		expect(ids.has(M20.id)).toBe(false);
		expect(snapshot.missions).toHaveLength(18);
		expect(snapshot.hasOlder).toBe(true);
		expect(snapshot.windowDays).toBe(14);
		expect(snapshot.protocolVersion).toBe(1);
		expect(typeof snapshot.at).toBe("string");
	});

	test("a wider window takes every mission and clears hasOlder", async () => {
		const snapshot = await buildSnapshot(testCtx(), { windowDays: 45 });
		expect(snapshot.missions).toHaveLength(20);
		expect(snapshot.hasOlder).toBe(false);
		expect(snapshot.windowDays).toBe(45);
	});

	test("a mission with 12 completed agents yields 8 and completedCounts 12", async () => {
		const snapshot = await buildSnapshot(testCtx(), {});
		const ids = new Set(snapshot.agents.map((a) => a.id));
		const newestEight = BIG_COMPLETED.slice(4).map((a) => a.id);
		const oldestFour = BIG_COMPLETED.slice(0, 4).map((a) => a.id);
		for (const id of newestEight) {
			expect(ids.has(id)).toBe(true);
		}
		for (const id of oldestFour) {
			expect(ids.has(id)).toBe(false);
		}
		expect(ids.has(BIG_RUNNER.id)).toBe(true);
		expect(snapshot.completedCounts[M9.id]).toBe(12);
	});

	test("archived agents never appear, anywhere", async () => {
		const snapshot = await buildSnapshot(testCtx(), {});
		const ids = new Set(snapshot.agents.map((a) => a.id));
		expect(ids.has(BIG_ARCHIVED.id)).toBe(false);
		for (const agentRecord of AGENTS.filter((a) => a.state === "archived")) {
			expect(ids.has(agentRecord.id)).toBe(false);
		}
		for (const agentRecord of snapshot.agents) {
			expect(agentRecord.state === "archived").toBe(false);
		}
		// Archived completed agents do not count either.
		expect(snapshot.completedCounts[M9.id]).toBe(12);
		expect(Object.values(snapshot.completedCounts).reduce((sum, n) => sum + n, 0)).toBe(18);
	});

	test("agents of missions outside the window do not leak in", async () => {
		const snapshot = await buildSnapshot(testCtx(), {});
		const missionIds = new Set(snapshot.agents.map((a) => a.missionId));
		expect(missionIds.has(M8.id)).toBe(false);
		expect(missionIds.has(M20.id)).toBe(false);
	});

	test("attention is exact and newest first", async () => {
		const snapshot = await buildSnapshot(testCtx(), {});
		expect(snapshot.attention.map((m) => m.id)).toEqual([M2.id, M3.id, M4.id, M5.id, M11.id, M15.id, M18.id]);
	});

	test("events carry the last 200 per workspace", async () => {
		seenLimits.length = 0;
		const snapshot = await buildSnapshot(testCtx(), {});
		expect(seenLimits).toEqual([
			{ workspaceId: W1, limit: 200 },
			{ workspaceId: W2, limit: 200 },
			{ workspaceId: W3, limit: 200 },
		]);
		expect(snapshot.events).toHaveLength(208);
		const w1Events = snapshot.events.filter((e) => e.workspaceId === W1);
		expect(w1Events).toHaveLength(200);
		expect(w1Events[0]?.seq).toBe(51);
		expect(w1Events[199]?.seq).toBe(250);
	});

	test("workspaceId narrows every array", async () => {
		const snapshot = await buildSnapshot(testCtx(), { workspaceId: W2 });
		expect(snapshot.workspaces.map((w) => w.id)).toEqual([W2]);
		expect(snapshot.leaders.map((l) => l.workspaceId)).toEqual([W2]);
		expect(snapshot.missions.map((m) => m.id).sort()).toEqual(
			[M10.id, M11.id, M12.id, M13.id, M14.id, M15.id].sort(),
		);
		for (const agentRecord of snapshot.agents) {
			expect(agentRecord.workspaceId).toBe(W2);
		}
		for (const e of snapshot.events) {
			expect(e.workspaceId).toBe(W2);
		}
		expect(snapshot.attention.map((m) => m.id)).toEqual([M11.id, M15.id]);
		expect(snapshot.hasOlder).toBe(false);
	});
});

describe("snapshotHandlers", () => {
	test("bad params give INVALID_PARAMS", async () => {
		const ctx = testCtx();
		const handler = snapshotHandlers["snapshot"];
		if (handler === undefined) {
			throw new Error("snapshot handler is missing");
		}
		const bad = ["x", 42, { windowDays: -1 }, { windowDays: Number.NaN }, { workspaceId: 42 }];
		for (const params of bad) {
			let thrown: unknown;
			try {
				await handler(ctx, params, undefined as never);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(NodeError);
			expect((thrown as NodeError).symbol).toBe("INVALID_PARAMS");
		}
		const snapshot = (await handler(ctx, {}, undefined as never)) as { windowDays: number };
		expect(snapshot.windowDays).toBe(14);
	});
});
