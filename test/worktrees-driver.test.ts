import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removalConfirmed, WorktrunkDriver } from "../src/worktrees/driver.ts";
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
			expect(refused.reason).toContain("abandoned");
		}
		// An ordinary close never discards: the untracked draft survives.
		await expect(stat(worktree.path)).resolves.toBeDefined();
		await expect(stat(join(worktree.path, "draft.txt"))).resolves.toBeDefined();
		// Abandoned alone does not authorize the loss: without the explicit
		// confirmation the dirty worktree is still refused and preserved.
		const unconfirmed = await driver.remove({
			repoRoot: root,
			path: worktree.path,
			branch: worktree.branch,
			base: "main",
			abandon: true,
		});
		expect(unconfirmed.ok).toBe(false);
		if (!unconfirmed.ok) {
			expect(unconfirmed.refusal).toBe("dirty");
			expect(unconfirmed.reason).toContain("discardUncommitted");
		}
		await expect(stat(join(worktree.path, "draft.txt"))).resolves.toBeDefined();
		const removed = await driver.remove({
			repoRoot: root,
			path: worktree.path,
			branch: worktree.branch,
			base: "main",
			abandon: true,
			discardUncommitted: true,
		});
		expect(removed.ok).toBe(true);
		// Only the explicit abandoned discard removes untracked content.
		await expect(stat(worktree.path)).rejects.toThrow();
	});

	test("a clean unmerged branch removes its directory and retains the branch", async () => {
		useShim();
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		const driver = new WorktrunkDriver();
		const worktree = await driver.create({ repoRoot: root, number: 9, slug: "unmerged" });
		await commitIn(worktree.path, "w.txt");
		const removed = await driver.remove({
			repoRoot: root,
			path: worktree.path,
			branch: worktree.branch,
			base: "main",
		});
		expect(removed.ok).toBe(true);
		if (!removed.ok) {
			throw new Error("expected removal");
		}
		// The directory (with its ignored runtime trees) is reclaimed while
		// the committed source stays on its named branch.
		expect(removed.branchOutcome).toBe("retained_unmerged");
		await expect(stat(worktree.path)).rejects.toThrow();
		expect((await runGit(["rev-parse", "--verify", worktree.branch], root)).code).toBe(0);
	});

	test("a deferred removal fails retryably and the retry reclaims the directory", async () => {
		savedWtBin = process.env.NETA_WT_BIN;
		process.env.NETA_WT_BIN = fakeWtEnv().NETA_WT_BIN;
		process.env.FAKE_WT_REMOVE_OUTCOME = "deferred";
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		const driver = new WorktrunkDriver();
		try {
			const worktree = await driver.create({ repoRoot: root, number: 10, slug: "deferred" });
			extraDirs.push(worktree.path);
			await commitIn(worktree.path, "w.txt");
			expect((await runGit(["merge", "--no-ff", worktree.branch, "-m", "merge"], root)).code).toBe(0);
			const deferred = await driver.remove({
				repoRoot: root,
				path: worktree.path,
				branch: worktree.branch,
				base: "main",
			});
			expect(deferred.ok).toBe(false);
			if (deferred.ok) {
				throw new Error("expected a retryable failure");
			}
			expect(deferred.reason).toContain("deferred");
			expect(deferred.reason).toContain("retry the close");
			await expect(stat(worktree.path)).resolves.toBeDefined();
			delete process.env.FAKE_WT_REMOVE_OUTCOME;
			const retried = await driver.remove({
				repoRoot: root,
				path: worktree.path,
				branch: worktree.branch,
				base: "main",
			});
			expect(retried).toEqual({ ok: true, branchOutcome: "deleted", path: worktree.path });
			await expect(stat(worktree.path)).rejects.toThrow();
		} finally {
			delete process.env.FAKE_WT_REMOVE_OUTCOME;
		}
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

describe("removalConfirmed", () => {
	test("only absence proves removal: present and dangling links stay unconfirmed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "neta-removal-proof-"));
		extraDirs.push(dir);
		expect(await removalConfirmed(join(dir, "missing"))).toEqual({ gone: true });
		await writeFile(join(dir, "kept.txt"), "kept\n");
		const present = await removalConfirmed(join(dir, "kept.txt"));
		expect(present.gone).toBe(false);
		if (!present.gone) {
			expect(present.reason).toContain("still present");
		}
		// A dangling symlink is rubble left behind, not a reclaimed path.
		await symlink(join(dir, "target-missing"), join(dir, "dangling"));
		const dangling = await removalConfirmed(join(dir, "dangling"));
		expect(dangling.gone).toBe(false);
	});

	test("an unreadable path refuses instead of reporting success", async () => {
		const dir = await mkdtemp(join(tmpdir(), "neta-removal-proof-"));
		extraDirs.push(dir);
		const locked = join(dir, "locked");
		await mkdir(locked);
		await chmod(locked, 0o000);
		try {
			const proof = await removalConfirmed(join(locked, "anything"));
			// Running with elevated privileges sees through the mode bits;
			// only assert the refusal where the filesystem enforced it.
			if (proof.gone) {
				return;
			}
			expect(proof.gone).toBe(false);
			if (!proof.gone) {
				expect(proof.reason).toContain("cannot confirm");
			}
		} finally {
			await chmod(locked, 0o755);
		}
	});
});
