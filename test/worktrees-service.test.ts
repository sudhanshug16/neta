import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import type { AgentId, EventKind, Mission, MissionId, Workspace } from "../src/core/types.ts";
import { WorktrunkDriver } from "../src/worktrees/driver.ts";
import { createWorktreeService, type WorktreeServiceDeps } from "../src/worktrees/index.ts";
import { runGit } from "../src/worktrees/integration.ts";
import { LeaseManager, type LeaseState } from "../src/worktrees/leases.ts";
import { fakeWtEnv, makeRepo } from "./helpers/git-repo.ts";

let savedWtBin: string | undefined;
beforeEach(() => {
	savedWtBin = process.env.NETA_WT_BIN;
	process.env.NETA_WT_BIN = fakeWtEnv().NETA_WT_BIN;
});
afterEach(() => {
	if (savedWtBin === undefined) {
		delete process.env.NETA_WT_BIN;
	} else {
		process.env.NETA_WT_BIN = savedWtBin;
		savedWtBin = undefined;
	}
});

const NOW = "2026-01-02T00:00:00.000Z";

function workspace(kind: Workspace["kind"], root: string): Workspace {
	return { id: "w", kind, name: "w", roots: [{ machineId: "m", path: root }], createdAt: new Date(0).toISOString() };
}

function mission(extra?: Partial<Mission>): Mission {
	return {
		id: ulid(),
		number: 1,
		workspaceId: "w",
		machineId: "m",
		name: "lens port",
		objective: "port the lens",
		changes: [],
		lead: { kind: "leader" },
		agentIds: [],
		access: "readOnly",
		state: "running",
		createdAt: new Date(0).toISOString(),
		...extra,
	};
}

interface Fixture {
	deps: WorktreeServiceDeps;
	saved: Mission[];
	emitted: Array<{ kind: EventKind; missionId: MissionId }>;
}

function fixture(): Fixture {
	const saved: Mission[] = [];
	const emitted: Array<{ kind: EventKind; missionId: MissionId }> = [];
	const states = new Map<string, LeaseState>();
	return {
		saved,
		emitted,
		deps: {
			driver: new WorktrunkDriver(),
			leases: new LeaseManager({
				read: (w) => Promise.resolve(states.get(w) ?? { workspaceId: w, leases: {} }),
				write: (s) => {
					states.set(s.workspaceId, JSON.parse(JSON.stringify(s)) as LeaseState);
					return Promise.resolve();
				},
			}),
			netaDir: tmpdir(),
			now: () => NOW,
			emit: (kind, missionId) => {
				emitted.push({ kind, missionId });
			},
			saveMission: (m) => {
				saved.push(m);
				return Promise.resolve();
			},
			onMissionClosed: () => Promise.resolve(),
		},
	};
}

describe("worktree service", () => {
	test("prepare creates a worktree for a read-only git mission and none for a folder workspace", async () => {
		const repo = await makeRepo();
		try {
			const f = fixture();
			const service = createWorktreeService(f.deps);
			const prepared = await service.prepare(mission(), workspace("git", repo.root));
			expect(prepared.worktree?.branch).toBe("mission/1-lens-port");
			expect(typeof prepared.worktree?.path).toBe("string");
			expect(f.saved).toHaveLength(1);
			const folder = await service.prepare(mission(), workspace("folder", repo.root));
			expect(folder.worktree).toBeUndefined();
			expect(f.saved).toHaveLength(1);
		} finally {
			await repo.cleanup();
		}
	});

	test("refreshIntegration after a real merge sets integration and emits mission.merged once across two calls", async () => {
		const f = fixture();
		const service = createWorktreeService(f.deps);
		const repo = await makeRepo();
		let sibling = "";
		try {
			const worktree = await f.deps.driver.create({ repoRoot: repo.root, number: 2, slug: "lens" });
			sibling = worktree.path;
			await writeFile(join(worktree.path, "lens.txt"), "lens\n");
			expect((await runGit(["add", "lens.txt"], worktree.path)).code).toBe(0);
			expect((await runGit(["commit", "-m", "lens"], worktree.path)).code).toBe(0);
			expect((await runGit(["merge", "--no-ff", worktree.branch, "-m", "merge"], repo.root)).code).toBe(0);
			const start = mission({ number: 2, worktree });
			const first = await service.refreshIntegration(start);
			expect(first.integration?.commit).toBe(
				(await runGit(["rev-parse", worktree.branch], repo.root)).stdout.trim(),
			);
			expect(first.integration?.base).toBe(worktree.base);
			const second = await service.refreshIntegration(first);
			expect(second).toEqual(first);
			expect(f.saved).toHaveLength(1);
			expect(f.emitted).toEqual([{ kind: "mission.merged", missionId: start.id }]);
		} finally {
			if (sibling !== "") {
				await rm(sibling, { recursive: true, force: true });
			}
			await repo.cleanup();
		}
	});

	test("a second writer gets queued", async () => {
		const f = fixture();
		const service = createWorktreeService(f.deps);
		const m = mission({
			access: "readWrite",
			worktree: { provider: "worktrunk", path: "/wt-1", branch: "mission/1-x", base: "main" },
		});
		const w = workspace("git", "/repo");
		expect(await service.acquireWriter(m, w, "a1" as AgentId)).toBe("active");
		expect(await service.acquireWriter(m, w, "a2" as AgentId)).toBe("queued");
		await service.releaseWriter("w", "a1" as AgentId);
	});

	test("no setInterval or setTimeout reaches merge detection", () => {
		const dir = new URL("../src/worktrees/", import.meta.url).pathname;
		const offenders: string[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".ts")) {
				continue;
			}
			const text = readFileSync(join(dir, file), "utf8");
			if (/setInterval|setTimeout/.test(text)) {
				offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});
});
