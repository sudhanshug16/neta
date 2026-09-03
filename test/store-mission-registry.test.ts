import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import type { Mission } from "../src/core/types.ts";
import { appendLine, readText } from "../src/store/files.ts";
import { openMissionRegistry } from "../src/store/mission-registry.ts";
import { paths } from "../src/store/paths.ts";

const prev = process.env.NETA_DIR;

afterEach(() => {
	if (prev === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = prev;
	}
});

function useTempDir(): void {
	process.env.NETA_DIR = mkdtempSync(join(tmpdir(), "neta-registry-"));
}

function mission(workspaceId: string, number: number, state: Mission["state"] = "running"): Mission {
	return {
		id: ulid(),
		number,
		workspaceId,
		machineId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		name: `mission ${number}`,
		objective: "Do it.",
		changes: [],
		lead: { kind: "leader" },
		agentIds: [],
		access: "readOnly",
		state,
		createdAt: new Date(Date.parse("2026-09-03T17:00:00.000Z") + number * 1000).toISOString(),
	};
}

describe("mission registry", () => {
	test("create then reopen returns the mission with the same number", async () => {
		useTempDir();
		const ws = "git:github.com/org/repo";
		const registry = openMissionRegistry();
		const number = await registry.allocateNumber(ws);
		expect(number).toBe(1);
		await registry.create(mission(ws, number));
		const reopened = openMissionRegistry();
		const back = await reopened.byNumber(ws, 1);
		expect(back?.number).toBe(1);
		expect(back?.state).toBe("running");
	});

	test("allocateNumber gives 1, 2, 3 across a reopen and 100 distinct numbers", async () => {
		useTempDir();
		const ws = "git:github.com/org/repo";
		const registry = openMissionRegistry();
		expect(await registry.allocateNumber(ws)).toBe(1);
		expect(await registry.allocateNumber(ws)).toBe(2);
		const reopened = openMissionRegistry();
		expect(await reopened.allocateNumber(ws)).toBe(3);
		const batch = await Promise.all(Array.from({ length: 100 }, () => reopened.allocateNumber(ws)));
		expect(new Set(batch).size).toBe(100);
		expect(Math.min(...batch)).toBe(4);
		expect(Math.max(...batch)).toBe(103);
	});

	test("a closed update replaces the running record after reload", async () => {
		useTempDir();
		const ws = "git:github.com/org/repo";
		const registry = openMissionRegistry();
		const m = mission(ws, await registry.allocateNumber(ws));
		await registry.create(m);
		const closed: Mission = {
			...m,
			state: "closed",
			closedAt: "2026-09-03T18:00:00.000Z",
			disposition: "merged",
			closeReason: "done",
		};
		await registry.update(closed);
		const reopened = openMissionRegistry();
		expect((await reopened.get(ws, m.id))?.state).toBe("closed");
	});

	test("compaction empties the log and replay stays idempotent", async () => {
		useTempDir();
		const ws = "git:github.com/org/repo";
		const registry = openMissionRegistry();
		const m = mission(ws, await registry.allocateNumber(ws));
		await registry.create(m);
		const before = await registry.list(ws, {});
		await registry.compact(ws);
		const p = paths();
		expect(await readText(p.registryLog(ws))).toBe("");
		const snapshot = await readText(p.registrySnapshot(ws));
		expect(JSON.parse(snapshot as string).missions).toHaveLength(1);
		expect(await registry.list(ws, {})).toEqual(before);
		// Replaying a stale pre-compaction line yields one copy, not two.
		await appendLine(p.registryLog(ws), { op: "create", at: m.createdAt, mission: m });
		const replayed = openMissionRegistry();
		expect((await replayed.list(ws, {})).missions).toHaveLength(1);
	});
});
