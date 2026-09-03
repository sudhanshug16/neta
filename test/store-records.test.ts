import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Leader, Workspace } from "../src/core/types.ts";
import { openLeaderStore, openMachineStore, openWorkspaceStore } from "../src/store/records.ts";

const prev = process.env.NETA_DIR;

afterEach(() => {
	if (prev === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = prev;
	}
});

function useTempDir(): void {
	process.env.NETA_DIR = mkdtempSync(join(tmpdir(), "neta-records-"));
}

function workspace(id: string, createdAt: string): Workspace {
	return {
		id,
		kind: "git",
		name: "repo",
		remote: "github.com/org/repo",
		roots: [],
		createdAt,
	};
}

function leader(id: string): Leader {
	return {
		workspaceId: id,
		machineId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		provider: "claude",
		model: "sonnet",
		mode: "leadPlus",
		modeSince: "2026-09-03T17:00:00.000Z",
		modeActiveMs: 74000,
		activeMissionId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
		state: "running",
	};
}

describe("machine store", () => {
	test("the first load creates the file, the second returns it", async () => {
		useTempDir();
		const store = openMachineStore();
		const first = await store.load();
		expect(first.id).toHaveLength(26);
		const second = await store.load();
		expect(second).toEqual(first);
	});

	test("two concurrent first loads agree on one machine id", async () => {
		useTempDir();
		const store = openMachineStore();
		const [a, b] = await Promise.all([store.load(), store.load()]);
		expect(a.id).toBe(b.id);
	});
});

describe("workspace store", () => {
	test("load creates then returns the identical record", async () => {
		useTempDir();
		const store = openWorkspaceStore();
		const id = "git:github.com/org/repo";
		const created = await store.load(id, () => workspace(id, "2026-09-03T17:00:00.000Z"));
		const again = await store.load(id, () => workspace(id, "2027-01-01T00:00:00.000Z"));
		expect(again).toEqual(created);
	});

	test("list is in createdAt order", async () => {
		useTempDir();
		const store = openWorkspaceStore();
		await store.save(workspace("git:github.com/org/b", "2026-09-03T18:00:00.000Z"));
		await store.save(workspace("git:github.com/org/a", "2026-09-03T17:00:00.000Z"));
		const list = await store.list();
		expect(list.map((w) => w.id)).toEqual(["git:github.com/org/a", "git:github.com/org/b"]);
	});
});

describe("leader store", () => {
	test("a leader round-trips every field", async () => {
		useTempDir();
		const store = openLeaderStore();
		const id = "git:github.com/org/repo";
		await store.save(leader(id));
		const back = await store.load(id, () => leader("other"));
		expect(back).toEqual(leader(id));
		expect(back.modeActiveMs).toBe(74000);
		expect(back.activeMissionId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAW");
	});
});
