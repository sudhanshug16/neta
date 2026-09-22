// Mission worktrees through Worktrunk (`wt`): create, describe, verify and
// remove. Only closeout passes `abandon`; `force` is always false in practice
// (kept for the flag mapping). Removal pre-checks run before shelling out so
// a check never destroys anything.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Worktree } from "../core/types.ts";
import { isIntegrated, runGit } from "./integration.ts";
import { missionBranch } from "./naming.ts";
import { runWtJson, WtError, type WtOptions } from "./wt.ts";

export interface CreateInput {
	repoRoot: string;
	number: number;
	slug: string;
	base?: string;
}

export interface WorktreeEntry {
	branch?: string;
	path: string;
	commit: string;
	isMain: boolean;
	isCurrent: boolean;
	dirty: boolean;
}

export type Refusal = "dirty" | "unmerged" | "checkedOut" | "failed";

export interface RemoveInput {
	repoRoot: string;
	path: string;
	branch: string;
	base: string;
	evidenceCommit?: string;
	force?: boolean;
	abandon?: boolean;
}

export type RemoveResult =
	| { ok: true; branchOutcome: string; path: string }
	| { ok: false; refusal: Refusal; reason: string };

export interface WorktreeDriver {
	create(input: CreateInput): Promise<Worktree>;
	findExisting(input: CreateInput, expected?: Worktree): Promise<Worktree | undefined>;
	remove(input: RemoveInput): Promise<RemoveResult>;
	list(repoRoot: string): Promise<WorktreeEntry[]>;
	verify(worktree: Worktree): Promise<{ ok: boolean; reason?: string }>;
	defaultBase(repoRoot: string): Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean {
	return value === true;
}

function entryOf(row: unknown): WorktreeEntry | undefined {
	if (!isRecord(row)) {
		return undefined;
	}
	const path = asString(row.path);
	const commitRow = isRecord(row.commit) ? row.commit : undefined;
	const commit = commitRow !== undefined ? asString(commitRow.sha) : undefined;
	if (path === undefined || commit === undefined) {
		return undefined;
	}
	const tree = isRecord(row.working_tree) ? row.working_tree : undefined;
	const dirty =
		tree !== undefined &&
		(tree.staged === true ||
			tree.modified === true ||
			tree.untracked === true ||
			tree.renamed === true ||
			tree.deleted === true ||
			(typeof tree.staged === "number" && tree.staged > 0) ||
			(typeof tree.modified === "number" && tree.modified > 0) ||
			(typeof tree.untracked === "number" && tree.untracked > 0) ||
			(typeof tree.renamed === "number" && tree.renamed > 0) ||
			(typeof tree.deleted === "number" && tree.deleted > 0));
	return {
		branch: asString(row.branch),
		path,
		commit,
		isMain: asBoolean(row.is_main),
		isCurrent: asBoolean(row.is_current),
		dirty,
	};
}

function firstLine(text: string): string {
	const line = text.split("\n")[0]?.trim() ?? "";
	return line === "" ? "(no stderr)" : line;
}

export class WorktrunkDriver implements WorktreeDriver {
	private readonly timeoutMs?: number;
	private readonly bases = new Map<string, string>();

	constructor(opts?: { timeoutMs?: number }) {
		this.timeoutMs = opts?.timeoutMs;
	}

	private wtOptions(cwd: string): WtOptions {
		return this.timeoutMs === undefined ? { cwd } : { cwd, timeoutMs: this.timeoutMs };
	}

	async create(input: CreateInput): Promise<Worktree> {
		const branch = missionBranch(input.number, input.slug);
		const base = input.base ?? (await this.defaultBase(input.repoRoot));
		const payload = await runWtJson(
			["switch", "--create", branch, "--base", base, "--no-cd", "--format=json"],
			this.wtOptions(input.repoRoot),
		);
		// Never compute the path: it comes out of the JSON.
		if (!isRecord(payload)) {
			throw new Error(`wt switch --create returned no object for ${branch}`);
		}
		const path = asString(payload.path);
		const returnedBranch = asString(payload.branch);
		if (path === undefined || returnedBranch === undefined) {
			throw new Error(`wt switch --create is missing path or branch for ${branch}`);
		}
		return { provider: "worktrunk", path, branch: returnedBranch, base };
	}

	async findExisting(input: CreateInput, expected?: Worktree): Promise<Worktree | undefined> {
		const branch = missionBranch(input.number, input.slug);
		const base = input.base ?? (await this.defaultBase(input.repoRoot));
		const entry = (await this.list(input.repoRoot)).find((candidate) => candidate.branch === branch);
		if (entry === undefined) {
			return undefined;
		}
		const worktree: Worktree = { provider: "worktrunk", path: entry.path, branch, base };
		if (
			expected !== undefined &&
			(expected.branch !== worktree.branch ||
				expected.base !== worktree.base ||
				(await realpath(expected.path)) !== (await realpath(worktree.path)))
		) {
			throw new Error("existing worktree identity does not match the requested recovery path, branch, and base");
		}
		const commonDir = async (cwd: string): Promise<string | undefined> => {
			const result = await runGit(["rev-parse", "--git-common-dir"], cwd);
			if (result.code !== 0) return undefined;
			const path = result.stdout.trim();
			return realpath(isAbsolute(path) ? path : resolve(cwd, path));
		};
		const [repoGitDir, worktreeGitDir] = await Promise.all([commonDir(input.repoRoot), commonDir(worktree.path)]);
		if (repoGitDir === undefined || worktreeGitDir === undefined || repoGitDir !== worktreeGitDir) {
			throw new Error(`existing worktree is not part of the expected repository: ${worktree.path}`);
		}
		const verified = await this.verify(worktree);
		if (!verified.ok) {
			throw new Error(verified.reason ?? `existing worktree could not be verified: ${worktree.path}`);
		}
		return worktree;
	}

	async list(repoRoot: string): Promise<WorktreeEntry[]> {
		const payload = await runWtJson(
			["list", "--format=json", "--config-set", "list.json-schema=1"],
			this.wtOptions(repoRoot),
		);
		if (!Array.isArray(payload)) {
			throw new Error("wt list returned no array");
		}
		return payload.map((row) => entryOf(row)).filter((entry): entry is WorktreeEntry => entry !== undefined);
	}

	async defaultBase(repoRoot: string): Promise<string> {
		const cached = this.bases.get(repoRoot);
		if (cached !== undefined) {
			return cached;
		}
		const main = (await this.list(repoRoot)).find((entry) => entry.isMain);
		let base = main?.branch;
		if (base === undefined) {
			const run = await runGit(["symbolic-ref", "--short", "HEAD"], repoRoot);
			if (run.code !== 0) {
				throw new Error(`no main worktree and HEAD is unresolvable in ${repoRoot}`);
			}
			base = run.stdout.trim();
		}
		this.bases.set(repoRoot, base);
		return base;
	}

	forgetBase(repoRoot: string): void {
		this.bases.delete(repoRoot);
	}

	async verify(worktree: Worktree): Promise<{ ok: boolean; reason?: string }> {
		try {
			await stat(worktree.path);
		} catch {
			return { ok: false, reason: `worktree path is gone: ${worktree.path}` };
		}
		// `wt -C` resolves the repo from any worktree checkout, so the list
		// runs at the worktree itself: the repo root is not stored anywhere.
		let entries: WorktreeEntry[];
		try {
			entries = await this.list(worktree.path);
		} catch {
			return { ok: false, reason: `worktree is not listed: ${worktree.path}` };
		}
		// `git worktree list` resolves symlinks (macOS /var), so compare
		// canonical paths, not the stored string.
		const canonical = await realpath(worktree.path);
		const entry = entries.find((candidate) => candidate.path === worktree.path || candidate.path === canonical);
		if (entry === undefined) {
			return { ok: false, reason: `worktree is not listed: ${worktree.path}` };
		}
		if (entry.branch !== worktree.branch) {
			return {
				ok: false,
				reason: `worktree holds ${entry.branch ?? "a detached checkout"} instead of ${worktree.branch}`,
			};
		}
		return { ok: true };
	}

	async remove(input: RemoveInput): Promise<RemoveResult> {
		if (input.abandon !== true) {
			const entries = await this.list(input.repoRoot);
			const entry = entries.find((candidate) => candidate.branch === input.branch);
			if (entry?.dirty) {
				return { ok: false, refusal: "dirty", reason: `worktree ${input.branch} has uncommitted changes` };
			}
			const integrated = await isIntegrated({
				repoRoot: input.repoRoot,
				branch: input.branch,
				base: input.base,
				evidenceCommit: input.evidenceCommit,
			});
			if (!integrated.merged) {
				return {
					ok: false,
					refusal: "unmerged",
					reason: `branch ${input.branch} is not merged into ${input.base}`,
				};
			}
		}
		const argv = ["remove", input.branch, "--foreground", "--format=json"];
		if (input.abandon === true) {
			argv.push("--force", "-D");
		} else if (input.force === true) {
			argv.push("--force");
		}
		let payload: unknown;
		try {
			payload = await runWtJson(argv, this.wtOptions(input.repoRoot));
		} catch (error) {
			const detail =
				error instanceof WtError ? error.stderr : error instanceof Error ? error.message : String(error);
			return { ok: false, refusal: "failed", reason: firstLine(detail) };
		}
		const outcome = Array.isArray(payload) && isRecord(payload[0]) ? asString(payload[0].branch_outcome) : undefined;
		if (outcome === undefined) {
			return { ok: false, refusal: "failed", reason: "wt remove returned no branch outcome" };
		}
		if (outcome === "deleted" || outcome === "deferred" || outcome === "not_attempted") {
			return { ok: true, branchOutcome: outcome, path: input.path };
		}
		if (outcome === "retained_checked_out") {
			return {
				ok: false,
				refusal: "checkedOut",
				reason: `branch ${input.branch} is checked out in another worktree`,
			};
		}
		return { ok: false, refusal: "failed", reason: `worktree removal failed: ${outcome}` };
	}
}
