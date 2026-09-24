import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Leader, Mission, Workspace } from "../src/core/types.ts";
import { watchStalledQuestions, watchStalledRoutes } from "../src/me/route-watch.ts";
import { openMeStore } from "../src/me/store.ts";

const previousDir = process.env.NETA_DIR;
let directory = "";
afterEach(async () => {
	if (previousDir === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = previousDir;
	if (directory) await rm(directory, { recursive: true, force: true });
});

test("a delivered route with no leader turn becomes a durable attention source", async () => {
	directory = await mkdtemp(join(tmpdir(), "neta-route-watch-"));
	process.env.NETA_DIR = directory;
	const store = openMeStore();
	await store.solIdentity("workspace-A");
	const turn = await store.appendSolTurn({
		workspaceId: "workspace-A",
		idempotencyKey: "user-1",
		author: "user",
		text: "Audit Jev",
	});
	const route = await store.queueRoute({
		idempotencyKey: "route-1",
		solTurnId: turn.id,
		instruction: turn.text,
		destinationSessionIds: ["leader-A"],
		provenanceSourceIds: [],
	});
	await store.updateRoute(route.id, "delivering");
	await store.updateRoute(route.id, "delivered", "inbox-1");
	const node = {
		machine: () => ({ id: "machine-A", name: "Machine A", createdAt: new Date(0).toISOString() }),
		getWorkspace: (id: string) =>
			id === "workspace-A"
				? {
						id,
						kind: "folder" as const,
						name: "Workspace A",
						roots: [],
						createdAt: new Date(0).toISOString(),
					}
				: undefined,
	};
	const due = Date.parse(route.createdAt) + 120_001;
	const active = await watchStalledRoutes({ store, node, runtime: { isTurnActive: () => true }, now: due });
	expect(active.captured).toEqual([]);
	expect(active.nextAt).toBeGreaterThan(due);
	const stopped = await watchStalledRoutes({ store, node, runtime: { isTurnActive: () => false }, now: due });
	expect(stopped.captured).toHaveLength(1);
	expect((await store.pendingSources())[0]).toMatchObject({ kind: "failure", forceVisible: true });
	expect((await store.pendingSources())[0]?.text).toContain("Work outcome is unknown");
	expect((await watchStalledRoutes({ store, node, runtime: {}, now: due })).captured).toEqual([]);
	const laterTurn = await store.appendSolTurn({
		workspaceId: "workspace-A",
		idempotencyKey: "user-2",
		author: "user",
		text: "Audit Alba",
	});
	const laterRoute = await store.queueRoute({
		idempotencyKey: "route-2",
		solTurnId: laterTurn.id,
		instruction: laterTurn.text,
		destinationSessionIds: ["leader-A"],
		provenanceSourceIds: [],
	});
	await store.updateRoute(laterRoute.id, "delivering");
	await store.updateRoute(laterRoute.id, "delivered", "inbox-2");
	const activeStalled = await watchStalledRoutes({
		store,
		node,
		runtime: { isTurnActive: () => true },
		now: Date.parse(laterRoute.createdAt) + 600_001,
	});
	expect(activeStalled.captured).toHaveLength(1);
	expect((await store.getSource(activeStalled.captured[0] ?? ""))?.text).toContain("Leader turn active: true");
});

test("a lead question surfaces after an idle leader fails to escalate it", async () => {
	directory = await mkdtemp(join(tmpdir(), "neta-question-watch-"));
	process.env.NETA_DIR = directory;
	const store = openMeStore();
	const startedAt = "2026-09-24T10:00:00.000Z";
	const questionId = "01M3AMZ5N1BD9TEKVG66NXX2TM";
	const workspace: Workspace = {
		id: "workspace-A",
		kind: "folder",
		name: "Workspace A",
		roots: [],
		createdAt: startedAt,
	};
	const leader: Leader = {
		workspaceId: workspace.id,
		machineId: "machine-A",
		name: "Leader",
		sessionId: "leader-A",
		provider: "opencode",
		model: "fixture",
		mode: "lead",
		modeSince: startedAt,
		modeActiveMs: 0,
		state: "idle",
	};
	const mission: Mission = {
		id: "mission-A",
		number: 12,
		workspaceId: workspace.id,
		machineId: "machine-A",
		name: "Release gate",
		objective: "Check the release",
		changes: [],
		lead: { kind: "agent", agentId: "lead-A" },
		agentIds: ["lead-A"],
		access: "readOnly",
		state: "blocked",
		createdAt: startedAt,
	};
	const lead: Agent = {
		id: "lead-A",
		missionId: mission.id,
		workspaceId: workspace.id,
		name: "Cedar",
		task: "Check release",
		access: "readOnly",
		provider: "opencode",
		model: "fixture",
		skills: [],
		sessionId: "lead-A",
		canSpawn: true,
		state: "blocked",
		startedAt,
		pendingQuestionAt: startedAt,
		pendingQuestionId: questionId,
		pendingQuestion: "Which version should ship?",
	};
	const node = {
		machine: () => ({ id: "machine-A", name: "Machine A", createdAt: startedAt }),
		listAgents: () => [lead],
		getMission: (id: string) => (id === mission.id ? mission : undefined),
		getLeader: (id: string) => (id === workspace.id ? leader : undefined),
		getWorkspace: (id: string) => (id === workspace.id ? workspace : undefined),
	};
	const due = Date.parse(startedAt) + 120_001;
	expect((await watchStalledQuestions({ store, node, runtime: {}, now: due - 2 })).captured).toEqual([]);
	expect(
		(await watchStalledQuestions({ store, node, runtime: { isTurnActive: () => true }, now: due })).captured,
	).toEqual([]);
	const stalled = await watchStalledQuestions({ store, node, runtime: { isTurnActive: () => false }, now: due });
	expect(stalled.captured).toHaveLength(1);
	expect((await store.pendingSources())[0]).toMatchObject({
		questionId,
		missionId: mission.id,
		machineId: "machine-A",
		forceVisible: true,
	});
	expect((await store.pendingSources())[0]?.text).toContain("not escalated by the workspace leader");
	expect((await watchStalledQuestions({ store, node, runtime: {}, now: due })).captured).toEqual([]);

	const newQuestion = { ...lead, pendingQuestionId: "01M3AMZ5N1BD9TEKVG66NXX2TN" };
	await store.capture({
		id: "",
		workspaceId: workspace.id,
		workspaceName: workspace.name,
		sessionId: leader.sessionId,
		actorKind: "leader",
		kind: "event",
		at: startedAt,
		text: "mission.blocked",
		eventId: "leader-escalated",
		explicit: true,
		forceVisible: true,
		questionId: newQuestion.pendingQuestionId,
		destinationSessionIds: [leader.sessionId],
	});
	expect(
		(
			await watchStalledQuestions({
				store,
				node: { ...node, listAgents: () => [newQuestion] },
				runtime: {},
				now: due,
			})
		).captured,
	).toEqual([]);

	const workerQuestionId = "01M3AMZ5N1BD9TEKVG66NXX2TP";
	const worker: Agent = {
		...lead,
		id: "worker-A",
		name: "Pine",
		sessionId: "worker-A",
		canSpawn: false,
		pendingQuestionId: workerQuestionId,
		pendingQuestion: "Which branch?",
	};
	const workerStalled = await watchStalledQuestions({
		store,
		node: { ...node, listAgents: () => [lead, worker] },
		runtime: {},
		now: due,
	});
	expect(workerStalled.captured).toHaveLength(1);
	expect((await store.getSource(workerStalled.captured[0] ?? ""))?.text).toContain(
		"not escalated by the mission lead",
	);
	const forwardedLead: Agent = {
		...lead,
		pendingQuestionId: workerQuestionId,
		pendingQuestion: worker.pendingQuestion,
		pendingQuestionAt: new Date(due).toISOString(),
	};
	expect(
		(
			await watchStalledQuestions({
				store,
				node: { ...node, listAgents: () => [forwardedLead, worker] },
				runtime: {},
				now: due + 1,
			})
		).captured,
	).toEqual([]);
	const leaderStalled = await watchStalledQuestions({
		store,
		node: { ...node, listAgents: () => [forwardedLead, worker] },
		runtime: {},
		now: due + 120_001,
	});
	expect(leaderStalled.captured).toHaveLength(1);
	expect((await store.getSource(leaderStalled.captured[0] ?? ""))?.text).toContain(
		"not escalated by the workspace leader",
	);
	const longRunning: Agent = { ...lead, pendingQuestionId: "01M3AMZ5N1BD9TEKVG66NXX2TQ" };
	const activeParentStalled = await watchStalledQuestions({
		store,
		node: { ...node, listAgents: () => [longRunning] },
		runtime: { isTurnActive: () => true },
		now: Date.parse(startedAt) + 600_001,
	});
	expect(activeParentStalled.captured).toHaveLength(1);
	expect((await store.getSource(activeParentStalled.captured[0] ?? ""))?.text).toContain("Parent turn active: true");
});
