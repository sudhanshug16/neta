import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId, DecisionRecord, Leader } from "../src/core/types.ts";
import { type LeadMode, modeEventData, snapshotOf, subjectKey } from "../src/modes/records.ts";
import { openLeaderStore } from "../src/store/records.ts";

const prev = process.env.NETA_DIR;

afterEach(() => {
	if (prev === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = prev;
	}
});

function useTempDir(): void {
	process.env.NETA_DIR = mkdtempSync(join(tmpdir(), "neta-modes-"));
}

function leader(id: string): Leader {
	return {
		workspaceId: id,
		machineId: "m",
		sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		provider: "fake",
		model: "test-model",
		mode: "lead",
		modeSince: new Date(0).toISOString(),
		modeActiveMs: 5000,
		state: "running",
	};
}

function leadMode(agentId: string): LeadMode {
	return {
		agentId: agentId as AgentId,
		missionId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
		mode: "leadPlus",
		modeSince: new Date(1).toISOString(),
		modeActiveMs: 60000,
	};
}

function record(): DecisionRecord {
	return {
		objective: "ship it",
		whyLeadInsufficient: "needs a writer",
		missionId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
		mutationKind: "code",
		estimatedFiles: 3,
		validation: "tests pass",
		estimatedMinutes: 30,
		externalEffects: "none",
	};
}

describe("mode records and the store field", () => {
	test("a file without leadModes reads back as an empty map and a lead snapshot", async () => {
		useTempDir();
		const store = openLeaderStore();
		const id = "w";
		await store.save(leader(id));
		const back = await store.load(id, () => leader("other"));
		expect("leadModes" in back).toBe(false);
		const snapshot = snapshotOf(back, {}, { kind: "lead", workspaceId: id, agentId: "a1" as AgentId });
		expect(snapshot.mode).toBe("lead");
		expect(snapshot.modeActiveMs).toBe(0);
		expect(snapshot.missionId).toBeUndefined();
	});

	test("two lead modes round-trip through the real store, empty omitted", async () => {
		useTempDir();
		const store = openLeaderStore();
		const id = "w";
		await store.save({ ...leader(id), leadModes: { a1: leadMode("a1"), a2: leadMode("a2") } });
		const back = await store.load(id, () => leader("other"));
		expect(back.leadModes).toEqual({ a1: leadMode("a1"), a2: leadMode("a2") });
		await store.save({ ...leader(id), leadModes: {} });
		const emptied = await store.load(id, () => leader("other"));
		expect("leadModes" in emptied).toBe(false);
	});

	test("deleting one mode leaves the leader untouched", async () => {
		useTempDir();
		const store = openLeaderStore();
		const id = "w";
		const saved = { ...leader(id), leadModes: { a1: leadMode("a1"), a2: leadMode("a2") } };
		await store.save(saved);
		const { a1: _dropped, ...rest } = saved.leadModes ?? {};
		await store.save({ ...saved, leadModes: rest });
		const back = await store.load(id, () => leader("other"));
		expect(Object.keys(back.leadModes ?? {})).toEqual(["a2"]);
		const { leadModes: _modes, ...leaderFields } = back;
		expect(leaderFields).toEqual(leader(id));
	});

	test("subject keys separate leaders from leads", () => {
		expect(subjectKey({ kind: "leader", workspaceId: "w" })).toBe("leader:w");
		expect(subjectKey({ kind: "lead", workspaceId: "w", agentId: "a1" as AgentId })).toBe("lead:w:a1");
	});

	test("snapshots come from the leader and the stored lead mode", () => {
		const l = leader("w");
		expect(snapshotOf(l, {}, { kind: "leader", workspaceId: "w" })).toEqual({
			subject: { kind: "leader", workspaceId: "w" },
			mode: "lead",
			modeSince: l.modeSince,
			modeActiveMs: 5000,
		});
		expect(
			snapshotOf(l, { a1: leadMode("a1") }, { kind: "lead", workspaceId: "w", agentId: "a1" as AgentId }),
		).toEqual({
			subject: { kind: "lead", workspaceId: "w", agentId: "a1" },
			mode: "leadPlus",
			modeSince: new Date(1).toISOString(),
			modeActiveMs: 60000,
			missionId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
		});
	});

	test("event data is flat", () => {
		expect(modeEventData({ from: "lead", to: "leadPlus", cause: "tool" })).toEqual({
			from: "lead",
			to: "leadPlus",
			cause: "tool",
		});
		const flat = modeEventData({ from: "lead", to: "leadPlus", cause: "tool", record: record() });
		expect(flat.record).toBeUndefined();
		expect(flat).toEqual({
			from: "lead",
			to: "leadPlus",
			cause: "tool",
			objective: "ship it",
			whyLeadInsufficient: "needs a writer",
			missionId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
			mutationKind: "code",
			estimatedFiles: 3,
			validation: "tests pass",
			estimatedMinutes: 30,
			externalEffects: "none",
		});
	});
});
