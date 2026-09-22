import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Mission } from "../src/core/types.ts";
import { recordAgentRuntime } from "../src/node/agent-runtime.ts";
import { recoverActorResults } from "../src/node/result-recovery.ts";
import { openStore } from "../src/store/index.ts";
import { openParentReportStore } from "../src/store/parent-reports.ts";

let directory = "";
let original: string | undefined;
afterEach(async () => {
	if (original === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = original;
	if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
	original = process.env.NETA_DIR;
	directory = await mkdtemp(join(tmpdir(), "neta-result-recovery-"));
	process.env.NETA_DIR = directory;
	const real = await openStore();
	const reports = openParentReportStore(directory);
	let actor: Agent = {
		id: "a",
		sessionId: "s",
		missionId: "m",
		workspaceId: "w",
		name: "Worker",
		task: "inspect",
		access: "readOnly",
		provider: "fake",
		model: "old/model",
		skills: [],
		canSpawn: false,
		state: "interrupted",
		stateBefore: "running",
		startedAt: "2026-01-01",
		currentTurnId: "t",
		bindingGeneration: "generation",
	};
	const mission: Mission = {
		id: "m",
		number: 1,
		workspaceId: "w",
		machineId: "host",
		name: "Review",
		objective: "inspect",
		changes: [],
		lead: { kind: "leader" },
		agentIds: ["a"],
		access: "readOnly",
		state: "running",
		createdAt: "2026-01-01",
	};
	await real.conversations.create({
		sessionId: "s",
		provider: "fake",
		model: "old/model",
		bindingGeneration: "generation",
		createdAt: "2026-01-01",
	});
	const store = {
		listAgents: () => [actor],
		getAgent: () => actor,
		putAgent: async (value: Agent) => {
			actor = value;
		},
		getMission: () => mission,
		getLeader: () => undefined,
		recentConversation: async () => (await real.conversations.tail({ sessionId: "s", limit: 100 })).blocks,
	};
	const record = async (notification: Parameters<typeof recordAgentRuntime>[0]) => {
		await recordAgentRuntime(notification, {
			store,
			reports,
			send: async () => {
				throw new Error("recovery must not dispatch");
			},
			changed: () => {},
		});
	};
	return {
		real,
		reports,
		store,
		record,
		mission,
		setActor: (value: Partial<Agent>) => {
			actor = { ...actor, ...value };
		},
	};
}
test("restart recovers a journaled end whose outbox insertion was missing", async () => {
	const f = await fixture();
	await f.real.conversations.appendTurn({
		id: "t",
		sessionId: "s",
		role: "user",
		startedAt: "2026-01-01",
		endedAt: "2026-01-02",
		model: "executed/model",
		bindingGeneration: "generation",
	});
	f.setActor({ model: "new/model" });
	await recoverActorResults(f.store, f.real.conversations, f.record);
	expect((await f.reports.pending()).map((r) => [r.turnId, r.model])).toEqual([["t", "executed/model"]]);
	await recoverActorResults(f.store, f.real.conversations, f.record);
	expect(await f.reports.pending()).toHaveLength(1);
});
test("a process lost mid-turn produces one interrupted result before closing its journal", async () => {
	const f = await fixture();
	await f.real.conversations.appendTurn({
		id: "t",
		sessionId: "s",
		role: "user",
		startedAt: "2026-01-01",
		model: "old/model",
		bindingGeneration: "generation",
	});
	await recoverActorResults(f.store, f.real.conversations, f.record);
	expect((await f.real.conversations.turnRange("s", "t"))?.turn.cancelled).toBe(true);
	expect((await f.reports.pending())[0]?.text).toContain("interrupted or failed");
	await recoverActorResults(f.store, f.real.conversations, f.record);
	expect(await f.reports.pending()).toHaveLength(1);
});
test("archived missions do not produce recovery continuations", async () => {
	const f = await fixture();
	f.mission.state = "closed";
	await recoverActorResults(f.store, f.real.conversations, f.record);
	expect(await f.reports.pending()).toHaveLength(0);
});
