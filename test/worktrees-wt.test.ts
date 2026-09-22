import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorktrunkDriver } from "../src/worktrees/driver.ts";
import { runGit } from "../src/worktrees/integration.ts";
import { runWt, runWtJson, WtError, wtAvailable, wtSearchPath } from "../src/worktrees/wt.ts";
import { fakeWtEnv, makeRepo } from "./helpers/git-repo.ts";

let savedWtBin: string | undefined;
let savedPath: string | undefined;
let pathChanged = false;
const cleanups: Array<() => Promise<void>> = [];

function useShim(): void {
	savedWtBin = process.env.NETA_WT_BIN;
	process.env.NETA_WT_BIN = fakeWtEnv().NETA_WT_BIN;
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup().catch(() => undefined);
	}
	if (savedWtBin === undefined) {
		delete process.env.NETA_WT_BIN;
	} else {
		process.env.NETA_WT_BIN = savedWtBin;
		savedWtBin = undefined;
	}
	if (pathChanged) {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		savedPath = undefined;
		pathChanged = false;
	}
});

describe("wt process runner", () => {
	test("real Worktrunk pre-start failure retains its worktree and both output streams", async () => {
		savedWtBin = process.env.NETA_WT_BIN;
		delete process.env.NETA_WT_BIN;
		const repo = await makeRepo();
		cleanups.push(repo.cleanup);
		await mkdir(join(repo.root, ".config"));
		await writeFile(
			join(repo.root, ".config", "wt.toml"),
			'[pre-start]\nsetup = "echo fixture-stdout; echo fixture-stderr >&2; exit 23"\n',
		);
		expect((await runGit(["add", ".config/wt.toml"], repo.root)).code).toBe(0);
		expect((await runGit(["commit", "-m", "fixture hook"], repo.root)).code).toBe(0);
		const driver = new WorktrunkDriver();
		const input = { repoRoot: repo.root, number: 93, slug: "partial-hook" };
		const error = await driver.create(input).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(WtError);
		if (!(error instanceof WtError)) throw new Error("expected Worktrunk failure");
		expect(error.code).toBe(23);
		expect(error.stdout + error.stderr).toContain("fixture-stdout");
		expect(error.stdout + error.stderr).toContain("fixture-stderr");
		const partial = await driver.findExisting(input);
		expect(partial).toBeDefined();
		if (partial) {
			cleanups.push(() => rm(partial.path, { recursive: true, force: true }));
			expect(await driver.findExisting(input, partial)).toEqual(partial);
		}
	});
	test("Finder PATH is augmented with Homebrew and per-user install locations", () => {
		expect(wtSearchPath("/usr/bin:/bin", "/Users/example").split(":")).toEqual(
			expect.arrayContaining(["/opt/homebrew/bin", "/usr/local/bin", "/Users/example/.local/bin"]),
		);
	});

	test("JSON parses off stdout while stderr prose is ignored", async () => {
		useShim();
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		const payload = (await runWtJson(["list", "--format=json", "--config-set", "list.json-schema=1"], {
			cwd: root,
		})) as Array<{ path: string; is_main: boolean }>;
		expect(Array.isArray(payload)).toBe(true);
		expect(payload.some((entry) => realpathSync(entry.path) === realpathSync(root) && entry.is_main)).toBe(true);
		const run = await runWt(["list", "--format=json"], { cwd: root });
		expect(run.code).toBe(0);
		expect(run.stderr).toContain("fake-wt");
	});

	test("a non-zero exit throws WtError carrying stderr", async () => {
		useShim();
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		const failure = await runWt(["remove", "no-such-branch", "--foreground", "--format=json"], { cwd: root }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(WtError);
		if (failure instanceof WtError) {
			expect(failure.code).toBe(1);
			expect(failure.stderr).toContain("unknown branch");
			expect(failure.argv.join(" ")).toContain("remove");
		}
	});

	test("a missing binary gives ok:false instead of a throw", async () => {
		savedWtBin = process.env.NETA_WT_BIN;
		process.env.NETA_WT_BIN = "/nonexistent/wt-binary";
		await expect(wtAvailable()).resolves.toEqual({
			ok: false,
			reason:
				"Worktrunk executable not found in the app service search path; install Worktrunk, then retry mission creation",
		});
	});

	test("wtAvailable reports the real binary", async () => {
		savedWtBin = process.env.NETA_WT_BIN;
		delete process.env.NETA_WT_BIN;
		const found = await wtAvailable();
		expect(found.ok).toBe(true);
		expect(found.version).toContain("v0.72.0");
	});

	test("Finder's minimal PATH still creates, verifies, and removes a real Worktrunk worktree", async () => {
		savedWtBin = process.env.NETA_WT_BIN;
		delete process.env.NETA_WT_BIN;
		savedPath = process.env.PATH;
		pathChanged = true;
		process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
		const { root, cleanup } = await makeRepo();
		cleanups.push(cleanup);
		const driver = new WorktrunkDriver();
		const worktree = await driver.create({ repoRoot: root, number: 92, slug: "finder-path" });
		try {
			expect(await driver.verify(worktree)).toEqual({ ok: true });
		} finally {
			const removed = await driver.remove({ repoRoot: root, ...worktree, abandon: true });
			expect(removed.ok).toBe(true);
		}
	});
});
