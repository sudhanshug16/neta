import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import type { AgentId, EventKind, Mission, MissionId } from "../src/core/types.ts";
import { type CloseoutDeps, closeMission } from "../src/worktrees/closeout.ts";
import type { RemoveInput, RemoveResult, WorktreeDriver } from "../src/worktrees/driver.ts";
import { isIntegrated, runGit } from "../src/worktrees/integration.ts";
import { LeaseManager, type LeaseStore } from "../src/worktrees/leases.ts";
import { makeRepo } from "./helpers/git-repo.ts";

const NOW = "2026-01-02T00:00:00.000Z";

function mission(worktree?: Mission["worktree"], extra?: Partial<Mission>): Mission {
	return {
		id: ulid(),
		number: 1,
		workspaceId: "w",
		machineId: "m",
		name: "lens port",
		objective: "port the lens",
		changes: [],
		lead: { kind: "leader" },
		agentIds: [ulid(), ulid()],
		access: "readWrite",
		worktree,
		state: "running",
		createdAt: new Date(0).toISOString(),
		...extra,
	};
}

function memoryStore() {
	const states = new Map<
		string,
		{ workspaceId: string; leases: Record<string, { key: string; holder?: string; queue: string[] }> }
	>();
	const store: LeaseStore = {
		read: (w) => Promise.resolve(states.get(w) ?? { workspaceId: w, leases: {} }),
		write: (s) => {
			states.set(s.workspaceId, JSON.parse(JSON.stringify(s)) as never);
			return Promise.resolve();
		},
	};
	return store;
}

interface Fixture {
	deps: CloseoutDeps;
	removes: RemoveInput[];
	emitted: Array<{ kind: EventKind; missionId: MissionId }>;
	closed: Mission[];
	leases: LeaseManager;
}

function fixture(remove?: (input: RemoveInput) => Promise<RemoveResult>): Fixture {
	const removes: RemoveInput[] = [];
	const emitted: Array<{ kind: EventKind; missionId: MissionId }> = [];
	const closed: Mission[] = [];
	const leases = new LeaseManager(memoryStore());
	const driver: WorktreeDriver = {
		create: () => Promise.reject(new Error("unused")),
		remove: (input) => {
			removes.push(input);
			return remove === undefined
				? Promise.resolve({ ok: true, branchOutcome: "deleted", path: input.path })
				: remove(input);
		},
		list: () => Promise.reject(new Error("unused")),
		verify: () => Promise.reject(new Error("unused")),
		defaultBase: () => Promise.reject(new Error("unused")),
	};
	return {
		removes,
		emitted,
		closed,
		leases,
		deps: {
			driver,
			leases,
			isIntegrated,
			now: () => NOW,
			emit: (kind, missionId) => {
				emitted.push({ kind, missionId });
			},
			onMissionClosed: (m) => {
				closed.push(m);
				return Promise.resolve();
			},
		},
	};
}

describe("mission closeout", () => {
	test("merged with integration already set closes and emits mission.closed", async () => {
		const f = fixture();
		const start = mission(
			{ provider: "worktrunk", path: "/wt-1", branch: "mission/1-x", base: "main" },
			{ integration: { mergedAt: NOW, commit: "abc1234", base: "main" } },
		);
		const outcome = await closeMission(
			{ mission: start, disposition: "merged", evidence: "abc1234", reason: "done" },
			{
				...f.deps,
				isIntegrated: () => Promise.reject(new Error("must not run when integration is set")),
			},
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			throw new Error("expected close");
		}
		expect(outcome.mission.state).toBe("closed");
		expect(outcome.mission.closedAt).toBe(NOW);
		expect(outcome.mission.disposition).toBe("merged");
		expect(outcome.mission.closeReason).toBe("done");
		expect(outcome.mission.attention).toBeUndefined();
		expect(outcome.mission.worktree).toBeUndefined();
		expect(f.emitted).toEqual([{ kind: "mission.closed", missionId: start.id }]);
		expect(f.closed).toHaveLength(1);
		expect(f.removes).toHaveLength(1);
		expect(f.removes[0]?.abandon).not.toBe(true);
		// Every lease freed, including BASE_LEASE.
		expect(await f.leases.holder("w", "base")).toBeUndefined();
		for (const agentId of start.agentIds) {
			expect(await f.leases.queuePosition("w", agentId as AgentId)).toBeUndefined();
		}
	});

	test("merged with only a confirmed evidence SHA closes and records integration", async () => {
		const repo = await makeRepo();
		try {
			const f = fixture();
			await runGit(["checkout", "-b", "mission/1-lens"], repo.root);
			await writeFile(join(repo.root, "lens.txt"), "lens\n");
			await runGit(["add", "lens.txt"], repo.root);
			await runGit(["commit", "-m", "lens"], repo.root);
			const tip = (await runGit(["rev-parse", "mission/1-lens"], repo.root)).stdout.trim();
			await runGit(["checkout", "main"], repo.root);
			await runGit(["merge", "--no-ff", "mission/1-lens", "-m", "merge"], repo.root);
			const start = mission({ provider: "worktrunk", path: repo.root, branch: "mission/1-lens", base: "main" });
			const outcome = await closeMission(
				{ mission: start, disposition: "merged", evidence: `landed as ${tip}`, reason: "done" },
				f.deps,
			);
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) {
				throw new Error("expected close");
			}
			expect(outcome.mission.integration).toEqual({ mergedAt: NOW, commit: tip, base: "main" });
			expect(f.emitted.map((event) => event.kind)).toEqual(["mission.closed"]);
		} finally {
			await repo.cleanup();
		}
	});

	test("merged with a non-ancestor SHA, merged with neither, and abandoned with an empty reason each refuse", async () => {
		const repo = await makeRepo();
		try {
			const f = fixture();
			await runGit(["checkout", "-b", "mission/1-lens"], repo.root);
			await writeFile(join(repo.root, "lens.txt"), "lens\n");
			await runGit(["add", "lens.txt"], repo.root);
			await runGit(["commit", "-m", "lens"], repo.root);
			const tip = (await runGit(["rev-parse", "mission/1-lens"], repo.root)).stdout.trim();
			const git = mission({ provider: "worktrunk", path: repo.root, branch: "mission/1-lens", base: "main" });
			const stray = await closeMission(
				{ mission: git, disposition: "merged", evidence: `landed as ${tip}`, reason: "done" },
				f.deps,
			);
			expect(stray.ok).toBe(false);
			if (stray.ok) {
				throw new Error("expected refusal");
			}
			expect(stray.attention).toContain("not merged");
			expect(stray.mission.state).toBe("running");
			expect(stray.mission.closedAt).toBeUndefined();
			expect(stray.mission.attention).toBe(stray.attention);

			const bare = await closeMission({ mission: git, disposition: "merged", reason: "done" }, f.deps);
			expect(bare.ok).toBe(false);

			const empty = await closeMission({ mission: git, disposition: "abandoned", reason: "  " }, f.deps);
			expect(empty.ok).toBe(false);
			if (!empty.ok) {
				expect(empty.attention).toContain("reason");
				expect(empty.mission.state).toBe("running");
			}
			expect(f.removes).toHaveLength(0);
			expect(f.closed).toHaveLength(0);
		} finally {
			await repo.cleanup();
		}
	});

	test("abandoned with a reason removes the worktree with abandon:true and closes", async () => {
		const f = fixture();
		const start = mission({ provider: "worktrunk", path: "/wt-1", branch: "mission/1-x", base: "main" });
		const outcome = await closeMission(
			{ mission: start, disposition: "abandoned", reason: "wrong direction" },
			f.deps,
		);
		expect(outcome.ok).toBe(true);
		expect(f.removes).toEqual([
			{ repoRoot: "/wt-1", path: "/wt-1", branch: "mission/1-x", base: "main", abandon: true },
		]);
		if (outcome.ok) {
			expect(outcome.mission.disposition).toBe("abandoned");
		}
	});

	test("a driver refusal leaves the mission intact with closedAt unset", async () => {
		const f = fixture(() => Promise.resolve({ ok: false, refusal: "dirty", reason: "worktree is dirty" }));
		const start = mission({ provider: "worktrunk", path: "/wt-1", branch: "mission/1-x", base: "main" });
		const outcome = await closeMission(
			{ mission: start, disposition: "abandoned", reason: "done" },
			{ ...f.deps, isIntegrated: () => Promise.reject(new Error("unused for abandoned")) },
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) {
			throw new Error("expected refusal");
		}
		expect(outcome.attention).toBe("worktree is dirty");
		expect(outcome.mission.state).toBe("running");
		expect(outcome.mission.closedAt).toBeUndefined();
		expect(outcome.mission.worktree).toEqual(start.worktree);
		expect(f.closed).toHaveLength(0);
	});

	test("a held BASE_LEASE refuses and stays held", async () => {
		const f = fixture();
		expect(await f.leases.acquire("w", "other-mission" as AgentId, "base")).toBe("active");
		const start = mission({ provider: "worktrunk", path: "/wt-1", branch: "mission/1-x", base: "main" });
		const outcome = await closeMission({ mission: start, disposition: "abandoned", reason: "done" }, f.deps);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.attention).toBe("another closeout is integrating");
		}
		expect(f.removes).toHaveLength(0);
		expect(await f.leases.holder("w", "base")).toBe("other-mission");
	});

	test("a folder mission closes merged on evidence with no removal", async () => {
		const f = fixture();
		const start = mission(undefined);
		const outcome = await closeMission(
			{ mission: start, disposition: "merged", evidence: "landed", reason: "done" },
			f.deps,
		);
		expect(outcome.ok).toBe(true);
		expect(f.removes).toHaveLength(0);
		if (outcome.ok) {
			expect(outcome.mission.state).toBe("closed");
		}
	});
});
