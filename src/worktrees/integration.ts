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
	// `branch` accepts a raw SHA, so evidence is confirmed by passing it here.
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
	if (await isAncestor(q.repoRoot, branchTip, baseTip)) {
		return { merged: true, base: q.base, commit: branchTip, baseCommit: baseTip };
	}
	return { merged: false, base: q.base };
}
