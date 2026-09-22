import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isIntegrated, runGit } from "../src/worktrees/integration.ts";
import { makeRepo } from "./helpers/git-repo.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup().catch(() => undefined);
	}
});

async function commitFile(root: string, name: string, message: string): Promise<void> {
	await writeFile(join(root, name), `${message}\n`);
	await runGit(["add", name], root);
	const added = await runGit(["commit", "-m", message], root);
	expect(added.code).toBe(0);
}

async function tipOf(root: string, ref: string): Promise<string> {
	const run = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], root);
	expect(run.code).toBe(0);
	return run.stdout.trim();
}

describe("merge detection", () => {
	test("a fresh branch is not integrated; after a merge it is", async () => {
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		await runGit(["checkout", "-b", "mission/1-lens"], root);
		await commitFile(root, "lens.txt", "lens work");
		expect((await isIntegrated({ repoRoot: root, branch: "mission/1-lens", base: "main" })).merged).toBe(false);
		await runGit(["checkout", "main"], root);
		const merged = await runGit(["merge", "--no-ff", "mission/1-lens", "-m", "merge lens"], root);
		expect(merged.code).toBe(0);
		const result = await isIntegrated({ repoRoot: root, branch: "mission/1-lens", base: "main" });
		expect(result.merged).toBe(true);
		expect(result.commit).toBe(await tipOf(root, "mission/1-lens"));
		expect(result.baseCommit).toBe(await tipOf(root, "main"));
	});

	test("a squash-merge needs its evidence commit, then verifies the complete branch change", async () => {
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		await runGit(["checkout", "-b", "mission/2-docs"], root);
		await commitFile(root, "docs.txt", "docs work");
		await runGit(["checkout", "main"], root);
		const squashed = await runGit(["merge", "--squash", "mission/2-docs"], root);
		expect(squashed.code).toBe(0);
		const committed = await runGit(["commit", "-m", "squash docs"], root);
		expect(committed.code).toBe(0);
		// Same content, no ancestry: evidence ties the squash to this branch.
		expect((await isIntegrated({ repoRoot: root, branch: "mission/2-docs", base: "main" })).merged).toBe(false);
		const evidenceCommit = await tipOf(root, "main");
		expect(await isIntegrated({ repoRoot: root, branch: "mission/2-docs", base: "main", evidenceCommit })).toEqual({
			merged: true,
			base: "main",
			commit: evidenceCommit,
			baseCommit: evidenceCommit,
		});
	});

	test("squash evidence survives later base changes and a lagging local checkout", async () => {
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		await runGit(["branch", "old-main"], root);
		await runGit(["checkout", "-b", "mission/squash"], root);
		await commitFile(root, "work.txt", "first");
		await commitFile(root, "work.txt", "second");
		await runGit(["checkout", "main"], root);
		await commitFile(root, "unrelated.txt", "other base work");
		await runGit(["merge", "--squash", "mission/squash"], root);
		expect((await runGit(["commit", "-m", "squash"], root)).code).toBe(0);
		const evidenceCommit = await tipOf(root, "main");
		await commitFile(root, "work.txt", "later base edit");
		const baseCommit = await tipOf(root, "main");
		await runGit(["update-ref", "refs/remotes/origin/main", baseCommit], root);
		await runGit(["checkout", "old-main"], root);
		await runGit(["branch", "-f", "main", "old-main"], root);
		expect(await isIntegrated({ repoRoot: root, branch: "mission/squash", base: "main", evidenceCommit })).toEqual({
			merged: true,
			base: "main",
			commit: evidenceCommit,
			baseCommit,
		});
	});

	for (const extra of ["additional commit", "whitespace", "binary", "mode"] as const) {
		test(`squash evidence cannot discard later branch work: ${extra}`, async () => {
			const { root, cleanup } = await makeRepo();
			cleanups.push(cleanup);
			await runGit(["checkout", "-b", "mission/squash"], root);
			await commitFile(root, "work.txt", "work");
			await runGit(["checkout", "main"], root);
			await runGit(["merge", "--squash", "mission/squash"], root);
			await runGit(["commit", "-m", "squash"], root);
			const evidenceCommit = await tipOf(root, "main");
			await runGit(["checkout", "mission/squash"], root);
			if (extra === "mode") {
				await runGit(["update-index", "--chmod=+x", "work.txt"], root);
			} else {
				await writeFile(
					join(root, "work.txt"),
					extra === "whitespace" ? "work \n" : extra === "binary" ? Buffer.from([0, 1, 2, 255]) : "more work\n",
				);
				await runGit(["add", "work.txt"], root);
			}
			expect((await runGit(["commit", "-m", extra], root)).code).toBe(0);
			expect(
				(await isIntegrated({ repoRoot: root, branch: "mission/squash", base: "main", evidenceCommit })).merged,
			).toBe(false);
		});
	}

	test("unrelated, missing and non-base evidence cannot certify an unmerged branch", async () => {
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		await runGit(["checkout", "-b", "mission/work"], root);
		await commitFile(root, "work.txt", "work");
		const branchTip = await tipOf(root, "HEAD");
		await runGit(["checkout", "main"], root);
		await commitFile(root, "other.txt", "unrelated");
		for (const evidenceCommit of [await tipOf(root, "main"), "no-such-commit", branchTip]) {
			expect(
				(await isIntegrated({ repoRoot: root, branch: "mission/work", base: "main", evidenceCommit })).merged,
			).toBe(false);
		}
	});

	test("an unknown branch gives merged:false, a raw SHA works", async () => {
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		expect(await isIntegrated({ repoRoot: root, branch: "no-such-branch", base: "main" })).toEqual({
			merged: false,
			base: "main",
		});
		const sha = await tipOf(root, "main");
		const result = await isIntegrated({ repoRoot: root, branch: sha, base: "main" });
		expect(result.merged).toBe(true);
		expect(result.commit).toBe(sha);
	});
});
