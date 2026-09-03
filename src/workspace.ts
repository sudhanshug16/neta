import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface WorkspaceBinding {
	version: 1;
	provider: "worktrunk";
	checkpointId: string;
	repositoryRoot: string;
	worktreeRoot: string;
	relativeCwd: string;
	branch?: string;
	head: string;
	capturedAt: number;
}

function bindingDir(agentDir: string): string {
	return join(agentDir, "workspace-bindings");
}

function bindingPath(checkpointId: string, agentDir: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(checkpointId)) throw new Error(`Invalid checkpoint id "${checkpointId}".`);
	return join(bindingDir(agentDir), `${checkpointId}.json`);
}

function parseWorktreeRoot(output: string): string | undefined {
	const first = output.split(/\r?\n/).find((line) => line.startsWith("worktree "));
	return first?.slice("worktree ".length).trim();
}

function safeRelativePath(from: string, to: string): string | undefined {
	const value = relative(from, to);
	if (value === "") return ".";
	if (value === ".." || value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(value))
		return undefined;
	return value;
}

export async function detectWorkspaceBinding(cwd: string, checkpointId: string): Promise<WorkspaceBinding | undefined> {
	try {
		const [topLevel, worktrees, head, branch] = await Promise.all([
			run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }),
			run("git", ["-C", cwd, "worktree", "list", "--porcelain"], { encoding: "utf8" }),
			run("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }),
			run("git", ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" }).catch(
				() => undefined,
			),
		]);
		const canonicalCwd = realpathSync(cwd);
		const worktreeRoot = realpathSync(topLevel.stdout.trim());
		const repositoryRootValue = parseWorktreeRoot(worktrees.stdout);
		if (!repositoryRootValue) return undefined;
		const repositoryRoot = realpathSync(repositoryRootValue);
		const relativeCwd = safeRelativePath(worktreeRoot, canonicalCwd);
		if (!relativeCwd) return undefined;
		return {
			version: 1,
			provider: "worktrunk",
			checkpointId,
			repositoryRoot,
			worktreeRoot,
			relativeCwd,
			...(branch?.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
			head: head.stdout.trim(),
			capturedAt: Date.now(),
		};
	} catch {
		return undefined;
	}
}

export function writeWorkspaceBinding(binding: WorkspaceBinding, agentDir: string): string {
	const dir = bindingDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = bindingPath(binding.checkpointId, agentDir);
	const temp = join(dir, `.${binding.checkpointId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		writeFileSync(temp, `${JSON.stringify(binding, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temp, path);
		chmodSync(path, 0o600);
		return path;
	} finally {
		rmSync(temp, { force: true });
	}
}

export function readWorkspaceBinding(checkpointId: string, agentDir: string): WorkspaceBinding | undefined {
	const path = bindingPath(checkpointId, agentDir);
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkspaceBinding>;
		if (
			value.version !== 1 ||
			value.provider !== "worktrunk" ||
			value.checkpointId !== checkpointId ||
			typeof value.repositoryRoot !== "string" ||
			typeof value.worktreeRoot !== "string" ||
			typeof value.relativeCwd !== "string" ||
			typeof value.head !== "string" ||
			typeof value.capturedAt !== "number" ||
			(value.branch !== undefined && typeof value.branch !== "string")
		)
			return undefined;
		return value as WorkspaceBinding;
	} catch {
		return undefined;
	}
}

export function workspaceBindingsMatch(saved: WorkspaceBinding, current: WorkspaceBinding): boolean {
	return (
		saved.repositoryRoot === current.repositoryRoot &&
		saved.worktreeRoot === current.worktreeRoot &&
		saved.relativeCwd === current.relativeCwd &&
		saved.branch === current.branch
	);
}

function worktreePathFromJson(value: unknown, branch: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const match = worktreePathFromJson(item, branch);
			if (match) return match;
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (record.branch === branch && typeof record.worktree_path === "string") return record.worktree_path;
	if (record.branch === branch && typeof record.path === "string") return record.path;
	if (typeof record.worktree_path === "string") return record.worktree_path;
	if (record.worktree && typeof record.worktree === "object") {
		const worktree = record.worktree as Record<string, unknown>;
		if (typeof worktree.path === "string") return worktree.path;
	}
	if (Array.isArray(record.items)) return worktreePathFromJson(record.items, branch);
	return undefined;
}

async function worktreePathFromList(binding: WorkspaceBinding, wtCommand = "wt"): Promise<string | undefined> {
	const result = await run(
		wtCommand,
		["-C", binding.repositoryRoot, "--config-set", "list.json-schema=2", "list", "--format=json"],
		{ encoding: "utf8" },
	).catch((error: unknown) => {
		const output = error as { stdout?: string };
		return output.stdout ? { stdout: output.stdout, stderr: "" } : undefined;
	});
	if (!result?.stdout) return undefined;
	try {
		return worktreePathFromJson(JSON.parse(result.stdout), binding.branch ?? "");
	} catch {
		return undefined;
	}
}

export async function restoreWorkspace(
	binding: WorkspaceBinding,
	options: { wtCommand?: string } = {},
): Promise<string> {
	const wtCommand = options.wtCommand ?? "wt";
	if (existsSync(binding.worktreeRoot)) {
		const existing = resolve(binding.worktreeRoot, binding.relativeCwd);
		if (!existsSync(existing)) throw new Error(`The saved project subdirectory no longer exists: ${existing}`);
		const current = await detectWorkspaceBinding(existing, binding.checkpointId);
		if (!current || !workspaceBindingsMatch(binding, current)) {
			throw new Error(
				`The path ${existing} exists, but it is no longer the recorded Worktrunk worktree and branch. ` +
					"Refusing to resume in a different workspace.",
			);
		}
		return realpathSync(existing);
	}
	if (!binding.branch)
		throw new Error("This archived session used a detached worktree, so Worktrunk cannot recreate it by branch.");
	if (!existsSync(binding.repositoryRoot)) {
		throw new Error(`The repository Worktrunk needs no longer exists: ${binding.repositoryRoot}`);
	}

	let switchPath: string | undefined;
	try {
		const result = await run(
			wtCommand,
			["-C", binding.repositoryRoot, "switch", binding.branch, "--no-cd", "--format=json"],
			{ encoding: "utf8" },
		);
		try {
			switchPath = worktreePathFromJson(JSON.parse(result.stdout), binding.branch);
		} catch {
			switchPath = undefined;
		}
	} catch (error) {
		throw new Error(
			`Worktrunk could not restore ${binding.branch}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const restoredRoot = switchPath ?? (await worktreePathFromList(binding, wtCommand));
	if (!restoredRoot || !existsSync(restoredRoot)) {
		throw new Error(`Worktrunk did not report a restored worktree for ${binding.branch}.`);
	}
	const canonicalRoot = realpathSync(restoredRoot);
	if (canonicalRoot !== binding.worktreeRoot) {
		throw new Error(
			`Worktrunk restored ${binding.branch} at ${canonicalRoot}, but this session is bound to ${binding.worktreeRoot}. ` +
				"Move or restore that exact worktree path before resuming.",
		);
	}
	const cwd = resolve(canonicalRoot, binding.relativeCwd);
	if (!existsSync(cwd))
		throw new Error(`The restored worktree does not contain the saved project subdirectory: ${cwd}`);
	return realpathSync(cwd);
}

export function workspaceAvailability(
	cwd: string,
	binding: WorkspaceBinding | undefined,
): "available" | "restorable" | "missing" {
	if (existsSync(cwd)) return "available";
	return binding?.branch && existsSync(binding.repositoryRoot) ? "restorable" : "missing";
}
