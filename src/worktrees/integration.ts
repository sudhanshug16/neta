// Merge detection over plain read-only git: "is this branch in the base?"
// Never writes: no fetch, no checkout. Only the tests mutate repos.
import { spawn } from "node:child_process";
import type { WtRun } from "./wt.ts";

export function runGit(argv: readonly string[], cwd: string): Promise<WtRun> {
	return new Promise<WtRun>((resolve, reject) => {
		const child = spawn("git", [...argv], {
			stdio: ["ignore", "pipe", "pipe"],
			cwd,
			env: { ...process.env, NO_COLOR: "1", TERM: "dumb" } as Record<string, string>,
			timeout: 120_000,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => reject(error));
		child.on("close", (code, signal) => {
			if (signal !== null) {
				reject(new Error(`git ${argv.join(" ")} killed by ${signal}`));
				return;
			}
			resolve({ stdout, stderr, code: code ?? 1 });
		});
	});
}

export interface IntegrationQuery {
	repoRoot: string;
	branch: string;
	base: string;
	evidenceCommit?: string;
}

export interface IntegrationResult {
	merged: boolean;
	base: string;
	commit?: string;
	baseCommit?: string;
}

async function tip(cwd: string, ref: string): Promise<string | undefined> {
	const run = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
	if (run.code !== 0) {
		return undefined;
	}
	const sha = run.stdout.trim().split("\n")[0]?.trim();
	return sha === undefined || sha === "" ? undefined : sha;
}

async function isAncestor(cwd: string, maybeAncestor: string, descendant: string): Promise<boolean> {
	const run = await runGit(["merge-base", "--is-ancestor", maybeAncestor, descendant], cwd);
	return run.code === 0;
}

export async function isIntegrated(q: IntegrationQuery): Promise<IntegrationResult> {
	// Resolve the actual branch even when a squash commit is supplied as evidence.
	const branchTip = await tip(q.repoRoot, q.branch);
	if (branchTip === undefined) {
		// An unresolvable branch is not an error at closeout: a deleted
		// branch simply is not merged.
		return { merged: false, base: q.base };
	}
	const localBase = await tip(q.repoRoot, q.base);
	const originBase = await tip(q.repoRoot, `origin/${q.base}`);
	let baseTip = localBase;
	// A lagging checkout cannot hide a merge: prefer the remote tip when it
	// exists and is strictly ahead of the local one.
	if (originBase !== undefined && originBase !== localBase) {
		if (localBase === undefined || (await isAncestor(q.repoRoot, localBase, originBase))) {
			baseTip = originBase;
		}
	}
	if (baseTip === undefined) {
		return { merged: false, base: q.base };
	}
	const integratedTip = q.evidenceCommit === undefined ? baseTip : await tip(q.repoRoot, q.evidenceCommit);
	if (integratedTip === undefined || !(await isAncestor(q.repoRoot, integratedTip, baseTip))) {
		return { merged: false, base: q.base };
	}
	if (await isAncestor(q.repoRoot, branchTip, integratedTip)) {
		return {
			merged: true,
			base: q.base,
			commit: q.evidenceCommit === undefined ? branchTip : integratedTip,
			baseCommit: baseTip,
		};
	}
	if (q.evidenceCommit !== undefined) {
		// A squash changes commit identities. Compare the complete branch change
		// with the supplied commit, including paths, modes and exact blob IDs.
		// Unlike patch-id, this preserves whitespace and binary differences. The
		// evidence must be on the base, and extra branch work must still refuse.
		const parents = await runGit(["rev-list", "--parents", "-n", "1", integratedTip], q.repoRoot);
		const commits = parents.stdout.trim().split(/\s+/);
		const parent = commits[1];
		if (parents.code !== 0 || commits.length !== 2 || parent === undefined) {
			return { merged: false, base: q.base };
		}
		const common = await runGit(["merge-base", "--all", branchTip, parent], q.repoRoot);
		const bases = common.stdout.trim().split(/\s+/);
		if (common.code !== 0 || bases.length !== 1 || !bases[0]) {
			return { merged: false, base: q.base };
		}
		const diffArgs = [
			"-c",
			"core.quotePath=true",
			"diff",
			"--raw",
			"--no-abbrev",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
			"--no-relative",
			"--no-color",
			"--ignore-submodules=none",
		];
		const [branchDiff, squashDiff] = await Promise.all([
			runGit([...diffArgs, bases[0], branchTip, "--"], q.repoRoot),
			runGit([...diffArgs, parent, integratedTip, "--"], q.repoRoot),
		]);
		if (
			branchDiff.code === 0 &&
			squashDiff.code === 0 &&
			branchDiff.stdout !== "" &&
			branchDiff.stdout === squashDiff.stdout
		) {
			return { merged: true, base: q.base, commit: integratedTip, baseCommit: baseTip };
		}
	}
	return { merged: false, base: q.base };
}
