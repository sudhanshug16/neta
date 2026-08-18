import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_LIMIT_BYTES = 12_000;
const TERM_GRACE_MS = 1_000;
const KILL_GRACE_MS = 3_000;

const READ_ONLY_GIT_COMMANDS = new Set(["diff", "grep", "log", "ls-files", "rev-parse", "show", "status"]);

const FORBIDDEN_GIT_OPTIONS = [
	"-c",
	"--config-env",
	"--exec",
	"--exec-path",
	"--ext-diff",
	"--git-dir",
	"--html-path",
	"--man-path",
	"--no-index",
	"--open-files-in-pager",
	"--output",
	"--paginate",
	"--receive-pack",
	"--repo",
	"--textconv",
	"--work-tree",
];

export interface RepoExecRequest {
	argv: string[];
	cwd?: string;
	timeoutMs?: number;
	userApproved?: boolean;
}

export interface RepoExecResult {
	exitCode: number;
	durationMs: number;
	cwd: string;
	outputPath: string;
	output: string;
	truncated: boolean;
	timedOut: boolean;
}

export interface RepoCommandClassification {
	writeCapable: boolean;
	outward: boolean;
}

function matchesOption(argument: string, option: string): boolean {
	return argument === option || argument.startsWith(`${option}=`);
}

/**
 * The executable allowlist is the safety boundary, not the leader prompt.
 * Shells, interpreters, package scripts and Git aliases/config injection never
 * reach spawn(), so argv-only execution cannot be turned back into `sh -c`.
 */
export function classifyRepoCommand(argv: readonly string[], userApproved = false): RepoCommandClassification {
	if (argv.length === 0 || argv.some((argument) => argument.length === 0 || argument.includes("\0"))) {
		throw new Error("neta_exec requires a non-empty argv list with no empty or NUL arguments.");
	}
	if (argv.length > 128 || argv.some((argument) => Buffer.byteLength(argument) > 8_192)) {
		throw new Error("neta_exec argv is too large for a small mechanical command.");
	}
	if (argv[0] !== basename(argv[0])) {
		throw new Error("neta_exec requires an allowlisted executable name, not a path.");
	}

	if (argv[0] === "bun") {
		if (argv[1] !== "test") {
			throw new Error(
				"neta_exec only allows Bun's test runner; package scripts and interpreter modes are not allowed.",
			);
		}
		if (argv.slice(2).some((argument) => argument === "--preload" || argument.startsWith("--preload="))) {
			throw new Error("neta_exec does not allow Bun preload hooks.");
		}
		return { writeCapable: true, outward: false };
	}

	if (argv[0] !== "git") {
		throw new Error('neta_exec allows only "git" and "bun test"; shells and interpreters are not allowed.');
	}
	let commandIndex = 1;
	if (argv[commandIndex] === "--no-pager") commandIndex += 1;
	const command = argv[commandIndex];
	if (!command || command.startsWith("-")) {
		throw new Error("neta_exec requires an allowlisted Git subcommand and forbids Git config/alias injection.");
	}
	const options = argv.slice(1);
	const forbidden = options.find((argument) =>
		FORBIDDEN_GIT_OPTIONS.some((option) => matchesOption(argument, option)),
	);
	if (forbidden) throw new Error(`neta_exec does not allow Git option ${forbidden}.`);

	if (READ_ONLY_GIT_COMMANDS.has(command)) return { writeCapable: false, outward: false };
	if (command === "push") {
		if (!userApproved) {
			throw new Error(
				"git push is outward-facing; set userApproved only after the user explicitly authorized this push.",
			);
		}
		return { writeCapable: true, outward: true };
	}
	throw new Error(`neta_exec does not allow git ${command}; delegate source edits or ambiguous repository work.`);
}

function safeEnvironment(outward: boolean): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: process.env.HOME,
		LANG: process.env.LANG,
		LC_ALL: process.env.LC_ALL,
		TERM: "dumb",
		NO_COLOR: "1",
		GIT_PAGER: "cat",
		PAGER: "cat",
	};
	if (outward && process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function repositoryCwd(root: string, requested?: string): string {
	const canonicalRoot = realpathSync(root);
	const candidate = requested
		? isAbsolute(requested)
			? requested
			: resolve(canonicalRoot, requested)
		: canonicalRoot;
	const canonicalCandidate = realpathSync(candidate);
	const fromRoot = relative(canonicalRoot, canonicalCandidate);
	if (
		fromRoot === ".." ||
		fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(fromRoot)
	) {
		throw new Error(`neta_exec cwd must remain within the session repository: ${canonicalRoot}`);
	}
	if (!statSync(canonicalCandidate).isDirectory())
		throw new Error(`neta_exec cwd is not a directory: ${canonicalCandidate}`);
	return canonicalCandidate;
}

function groupAlive(childPid: number, childExited: boolean): boolean {
	try {
		process.kill(-childPid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return !childExited;
	}
}

function signalGroup(childPid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-childPid, signal);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ESRCH") {
			try {
				process.kill(childPid, signal);
			} catch {}
		}
	}
}

async function waitForGroupExit(childPid: number, childExited: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!groupAlive(childPid, childExited())) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !groupAlive(childPid, childExited());
}

async function terminateGroup(childPid: number, childExited: () => boolean): Promise<void> {
	signalGroup(childPid, "SIGTERM");
	if (await waitForGroupExit(childPid, childExited, TERM_GRACE_MS)) return;
	signalGroup(childPid, "SIGKILL");
	if (!(await waitForGroupExit(childPid, childExited, KILL_GRACE_MS))) {
		throw new Error(`neta_exec could not prove process group ${childPid} stopped after SIGKILL.`);
	}
}

function readBoundedOutput(path: string): { output: string; truncated: boolean } {
	const size = statSync(path).size;
	const length = Math.min(size, OUTPUT_LIMIT_BYTES);
	const buffer = Buffer.alloc(length);
	const fd = openSync(path, "r");
	try {
		const bytes = readSync(fd, buffer, 0, length, 0);
		return { output: buffer.subarray(0, bytes).toString("utf-8"), truncated: size > OUTPUT_LIMIT_BYTES };
	} finally {
		closeSync(fd);
	}
}

export async function executeRepoCommand(
	root: string,
	auditDir: string,
	request: RepoExecRequest,
	signal?: AbortSignal,
): Promise<RepoExecResult> {
	const classification = classifyRepoCommand(request.argv, request.userApproved);
	const cwd = repositoryCwd(root, request.cwd);
	const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`neta_exec timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} ms.`);
	}
	mkdirSync(auditDir, { recursive: true, mode: 0o700 });
	const outputPath = join(auditDir, `neta-exec-${Date.now()}-${randomBytes(6).toString("hex")}.log`);
	const outputFd = openSync(outputPath, "wx", 0o600);
	let childExited = false;
	const startedAt = Date.now();

	try {
		const child = spawn(request.argv[0], request.argv.slice(1), {
			cwd,
			env: safeEnvironment(classification.outward),
			detached: true,
			// One shared file descriptor preserves stdout/stderr write order. Two
			// pipes only preserve order within each stream and cannot be merged later.
			stdio: ["ignore", outputFd, outputFd],
		});

		const closed = new Promise<{ code: number | null; spawnError?: Error }>((resolveClosed) => {
			child.once("error", (error) => resolveClosed({ code: null, spawnError: error }));
			child.once("close", (code) => {
				childExited = true;
				resolveClosed({ code });
			});
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		const stopped = new Promise<"timeout" | "aborted">((resolveStopped) => {
			timer = setTimeout(() => resolveStopped("timeout"), timeoutMs);
			if (signal) {
				abortListener = () => resolveStopped("aborted");
				if (signal.aborted) abortListener();
				else signal.addEventListener("abort", abortListener, { once: true });
			}
		});

		const winner = await Promise.race([
			closed.then((outcome) => ({ type: "closed" as const, outcome })),
			stopped.then((reason) => ({ type: "stopped" as const, reason })),
		]);
		if (timer) clearTimeout(timer);
		if (signal && abortListener) signal.removeEventListener("abort", abortListener);

		let exitCode: number;
		let timedOut = false;
		if (winner.type === "stopped") {
			timedOut = winner.reason === "timeout";
			if (!child.pid) throw new Error("neta_exec process did not provide a pid for cleanup.");
			await terminateGroup(child.pid, () => childExited);
			await closed;
			exitCode = timedOut ? 124 : 130;
		} else {
			if (winner.outcome.spawnError) throw winner.outcome.spawnError;
			exitCode = winner.outcome.code ?? 1;
			if (child.pid && groupAlive(child.pid, childExited)) {
				await terminateGroup(child.pid, () => childExited);
			}
		}
		const bounded = readBoundedOutput(outputPath);

		return {
			exitCode,
			durationMs: Date.now() - startedAt,
			cwd,
			outputPath,
			output: bounded.output,
			truncated: bounded.truncated,
			timedOut,
		};
	} finally {
		closeSync(outputFd);
	}
}
