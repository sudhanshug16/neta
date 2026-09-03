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

	test("a squash-merge is not merged by ancestry", async () => {
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		await runGit(["checkout", "-b", "mission/2-docs"], root);
		await commitFile(root, "docs.txt", "docs work");
		await runGit(["checkout", "main"], root);
		const squashed = await runGit(["merge", "--squash", "mission/2-docs"], root);
		expect(squashed.code).toBe(0);
		const committed = await runGit(["commit", "-m", "squash docs"], root);
		expect(committed.code).toBe(0);
		// Same content, no ancestry: this is the documented limitation.
		expect((await isIntegrated({ repoRoot: root, branch: "mission/2-docs", base: "main" })).merged).toBe(false);
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
