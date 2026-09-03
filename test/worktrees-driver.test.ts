import { afterEach, describe, expect, test } from "bun:test";
import { chmod, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktrunkDriver } from "../src/worktrees/driver.ts";
import { runGit } from "../src/worktrees/integration.ts";
import { slugify } from "../src/worktrees/naming.ts";
import { fakeWtEnv, makeRepo } from "./helpers/git-repo.ts";

let savedWtBin: string | undefined;
const cleanups: Array<() => Promise<void>> = [];
const extraDirs: string[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup().catch(() => undefined);
	}
	for (const dir of extraDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
	if (savedWtBin === undefined) {
		delete process.env.NETA_WT_BIN;
	} else {
		process.env.NETA_WT_BIN = savedWtBin;
		savedWtBin = undefined;
	}
	delete process.env.WT_REAL_BIN;
	delete process.env.WT_COUNT_FILE;
});

function useShim(): void {
	savedWtBin = process.env.NETA_WT_BIN;
	process.env.NETA_WT_BIN = fakeWtEnv().NETA_WT_BIN;
}

async function commitIn(dir: string, name: string): Promise<void> {
	await writeFile(join(dir, name), `${name}\n`);
	expect((await runGit(["add", name], dir)).code).toBe(0);
	expect((await runGit(["commit", "-m", name], dir)).code).toBe(0);
}

describe("worktrunk driver", () => {
	test("mission 7 yields its branch and the payload's path, not a computed one", async () => {
		useShim();
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		const driver = new WorktrunkDriver();
		const worktree = await driver.create({ repoRoot: root, number: 7, slug: slugify("add retry budget") });
		extraDirs.push(worktree.path);
		expect(worktree.branch).toBe("mission/7-add-retry-budget");
		expect(worktree.base).toBe("main");
		// The shim places siblings as <repo>.<flattened branch>: the driver
		// must have read this path, not built it.
		expect(worktree.path).toBe(`${root}.mission-7-add-retry-budget`);
		await expect(stat(worktree.path)).resolves.toBeDefined();
		expect((await runGit(["rev-parse", "--verify", worktree.branch], root)).code).toBe(0);
		expect((await driver.verify(worktree)).ok).toBe(true);
	});

	test("defaultBase returns main and shells out once for two calls", async () => {
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		// Counting wrapper around the shim.
		const wrapper = join(tmpdir(), `neta-wt-count-${Date.now()}.mjs`);
		const countFile = `${wrapper}.count`;
		await writeFile(
			wrapper,
			`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
appendFileSync(process.env.WT_COUNT_FILE, "x");
const r = spawnSync(process.env.WT_REAL_BIN, process.argv.slice(2), { encoding: "buffer" });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
`,
		);
		await chmod(wrapper, 0o755);
		extraDirs.push(wrapper, countFile);
		await writeFile(countFile, "");
		savedWtBin = process.env.NETA_WT_BIN;
		process.env.NETA_WT_BIN = wrapper;
		process.env.WT_REAL_BIN = fakeWtEnv().NETA_WT_BIN;
		process.env.WT_COUNT_FILE = countFile;
		const { readFile } = await import("node:fs/promises");
		const driver = new WorktrunkDriver();
		expect(await driver.defaultBase(root)).toBe("main");
		expect(await driver.defaultBase(root)).toBe("main");
		expect((await readFile(countFile, "utf8")).length).toBe(1);
		driver.forgetBase(root);
		expect(await driver.defaultBase(root)).toBe("main");
		expect((await readFile(countFile, "utf8")).length).toBe(2);
	});

	test("verify passes fresh, then fails once the directory is gone or the branch differs", async () => {
		useShim();
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		const driver = new WorktrunkDriver();
		const worktree = await driver.create({ repoRoot: root, number: 7, slug: "gone" });
		expect(await driver.verify(worktree)).toEqual({ ok: true });
		expect((await driver.verify({ ...worktree, branch: "mission/7-other" })).ok).toBe(false);
		await rm(worktree.path, { recursive: true, force: true });
		const missing = await driver.verify(worktree);
		expect(missing.ok).toBe(false);
		expect(missing.reason).toContain("gone");
	});

	test("a clean merged worktree removes with branchOutcome deleted", async () => {
		useShim();
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		const driver = new WorktrunkDriver();
		const worktree = await driver.create({ repoRoot: root, number: 7, slug: "merged" });
		await commitIn(worktree.path, "w.txt");
		expect((await runGit(["merge", "--no-ff", worktree.branch, "-m", "merge"], root)).code).toBe(0);
		const removed = await driver.remove({
			repoRoot: root,
			path: worktree.path,
			branch: worktree.branch,
			base: "main",
		});
		expect(removed).toEqual({ ok: true, branchOutcome: "deleted", path: worktree.path });
		expect((await driver.verify(worktree)).ok).toBe(false);
	});

	test("a dirty worktree is refused dirty and still exists, then removes with abandon:true", async () => {
		useShim();
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		const driver = new WorktrunkDriver();
		const worktree = await driver.create({ repoRoot: root, number: 8, slug: "dirty" });
		extraDirs.push(worktree.path);
		await writeFile(join(worktree.path, "draft.txt"), "uncommitted\n");
		const refused = await driver.remove({
			repoRoot: root,
			path: worktree.path,
			branch: worktree.branch,
			base: "main",
		});
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.refusal).toBe("dirty");
		}
		await expect(stat(worktree.path)).resolves.toBeDefined();
		const removed = await driver.remove({
			repoRoot: root,
			path: worktree.path,
			branch: worktree.branch,
			base: "main",
			abandon: true,
		});
		expect(removed.ok).toBe(true);
	});

	test("a clean unmerged branch is refused unmerged", async () => {
		useShim();
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		const driver = new WorktrunkDriver();
		const worktree = await driver.create({ repoRoot: root, number: 9, slug: "unmerged" });
		extraDirs.push(worktree.path);
		await commitIn(worktree.path, "w.txt");
		const refused = await driver.remove({
			repoRoot: root,
			path: worktree.path,
			branch: worktree.branch,
			base: "main",
		});
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.refusal).toBe("unmerged");
		}
		await expect(stat(worktree.path)).resolves.toBeDefined();
	});

	test("a non-zero exit gives failed with the stderr line", async () => {
		useShim();
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		const driver = new WorktrunkDriver();
		const failed = await driver.remove({
			repoRoot: root,
			path: "/nonexistent",
			branch: "no-such-branch",
			base: "main",
			abandon: true,
		});
		expect(failed.ok).toBe(false);
		if (!failed.ok) {
			expect(failed.refusal).toBe("failed");
			expect(failed.reason).toContain("unknown branch");
		}
	});
});
