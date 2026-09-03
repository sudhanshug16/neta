import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { runWt, runWtJson, WtError, wtAvailable } from "../src/worktrees/wt.ts";
import { fakeWtEnv, makeRepo } from "./helpers/git-repo.ts";

let savedWtBin: string | undefined;
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
});

describe("wt process runner", () => {
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
		await expect(wtAvailable()).resolves.toEqual({ ok: false, reason: expect.any(String) });
	});

	test("wtAvailable reports the real binary", async () => {
		savedWtBin = process.env.NETA_WT_BIN;
		delete process.env.NETA_WT_BIN;
		const found = await wtAvailable();
		expect(found.ok).toBe(true);
		expect(found.version).toContain("v0.72.0");
	});
});
