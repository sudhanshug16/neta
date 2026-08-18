import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { findOnPath } from "../detect.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_LIMIT_BYTES = 12_000;
const TERM_GRACE_MS = 1_000;
const KILL_GRACE_MS = 3_000;

const GIT_COMMANDS = new Set(["diff", "log", "ls-files", "rev-parse", "show", "status"]);
const BUN_BOOLEAN_FLAGS = new Set([
	"--no-orphans",
	"--todo",
	"--only",
	"--pass-with-no-tests",
	"--concurrent",
	"--randomize",
	"--isolate",
	"--dots",
	"--only-failures",
	"--bail",
]);
const BUN_VALUE_FLAGS = new Set([
	"--timeout",
	"--rerun-each",
	"--retry",
	"--seed",
	"--test-name-pattern",
	"--max-concurrency",
	"--parallel",
	"--parallel-delay",
	"--shard",
]);
const BUN_SEPARATE_VALUE_FLAGS = new Set(["-t"]);

export interface RepoExecRequest {
	argv: string[];
	cwd?: string;
	timeoutMs?: number;
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
}

/**
 * Only this small positive grammar reaches spawn(). Git is capable of invoking
 * pagers, aliases, diff drivers, remote helpers and hooks even when its own
 * process was started with argv, so rejecting merely "dangerous-looking"
 * options is not a sufficient boundary.
 */
export function classifyRepoCommand(argv: readonly string[]): RepoCommandClassification {
	if (argv.length === 0 || argv.some((argument) => argument.length === 0 || argument.includes("\0"))) {
		throw new Error("neta_exec requires a non-empty argv list with no empty or NUL arguments.");
	}
	if (argv.length > 128 || argv.some((argument) => Buffer.byteLength(argument) > 8_192)) {
		throw new Error("neta_exec argv is too large for a small mechanical command.");
	}
	if (argv.some((argument) => /[`$;&|<>\r\n]/.test(argument))) {
		throw new Error("neta_exec arguments may not contain shell-control characters.");
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
		validateBunArguments(argv.slice(2));
		return { writeCapable: true };
	}

	if (argv[0] !== "git") {
		throw new Error('neta_exec allows only "git" and "bun test"; shells and interpreters are not allowed.');
	}
	const command = argv[1];
	if (!command || command.startsWith("-") || !GIT_COMMANDS.has(command)) {
		throw new Error("neta_exec requires an allowlisted Git subcommand and forbids Git config/alias injection.");
	}
	validateGitArguments(command, argv.slice(2));
	return { writeCapable: false };
}

function optionWithValue(argument: string, options: ReadonlySet<string>): string | undefined {
	for (const option of options) if (argument.startsWith(`${option}=`)) return option;
	return undefined;
}

function validateBunArguments(args: readonly string[]): void {
	let testPathCount = 0;
	let positional = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") {
			positional = true;
			continue;
		}
		if (positional || !argument.startsWith("-")) {
			testPathCount += 1;
			continue;
		}
		if (BUN_BOOLEAN_FLAGS.has(argument)) continue;
		if (optionWithValue(argument, BUN_VALUE_FLAGS)) continue;
		if (BUN_SEPARATE_VALUE_FLAGS.has(argument)) {
			const value = args[++index];
			if (!value || value.startsWith("-"))
				throw new Error(`neta_exec requires a value after Bun test option ${argument}.`);
			continue;
		}
		throw new Error(`neta_exec does not allow Bun test option ${argument}.`);
	}
	if (testPathCount === 0) {
		throw new Error("neta_exec bun test requires at least one explicit repository test file path.");
	}
}

function validateGitArguments(command: string, args: readonly string[]): void {
	const booleanByCommand: Record<string, ReadonlySet<string>> = {
		status: new Set([
			"--short",
			"-s",
			"--branch",
			"-b",
			"--show-stash",
			"--ahead-behind",
			"--no-ahead-behind",
			"--porcelain",
			"-u",
		]),
		diff: new Set([
			"--stat",
			"--numstat",
			"--shortstat",
			"--name-only",
			"--name-status",
			"--check",
			"--cached",
			"--staged",
			"--quiet",
			"--exit-code",
		]),
		log: new Set([
			"--oneline",
			"--stat",
			"--shortstat",
			"--name-only",
			"--name-status",
			"--decorate",
			"--no-decorate",
			"--reverse",
		]),
		show: new Set([
			"--oneline",
			"--stat",
			"--shortstat",
			"--name-only",
			"--name-status",
			"--decorate",
			"--no-decorate",
		]),
		"ls-files": new Set([
			"--cached",
			"-c",
			"--deleted",
			"-d",
			"--modified",
			"-m",
			"--others",
			"-o",
			"--ignored",
			"-i",
			"--stage",
			"-s",
			"--unmerged",
			"-u",
			"--error-unmatch",
		]),
		"rev-parse": new Set([
			"--verify",
			"--quiet",
			"-q",
			"--show-toplevel",
			"--show-prefix",
			"--is-inside-work-tree",
			"--abbrev-ref",
			"--symbolic-full-name",
		]),
	};
	const valuesByCommand: Record<string, ReadonlySet<string>> = {
		status: new Set([]),
		diff: new Set(["--unified", "-U"]),
		log: new Set(["--max-count", "-n", "--since", "--until"]),
		show: new Set(["--unified", "-U"]),
		"ls-files": new Set(["--exclude", "--exclude-from"]),
		"rev-parse": new Set(["--short"]),
	};
	let positional = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") {
			positional = true;
			continue;
		}
		if (positional || !argument.startsWith("-")) continue;
		if (booleanByCommand[command].has(argument) || (command === "ls-files" && argument === "--exclude-standard"))
			continue;
		if (/^--porcelain=v[12]$/.test(argument) && command === "status") continue;
		if (/^--untracked-files=(?:no|normal|all)$/.test(argument) && command === "status") continue;
		if (argument === "--untracked-files" && command === "status") {
			const value = args[++index];
			if (!value || !/^(?:no|normal|all)$/.test(value)) {
				throw new Error("neta_exec git status --untracked-files requires one of: no, normal, all.");
			}
			continue;
		}
		if (/^-U\d+$/.test(argument) && (command === "diff" || command === "show")) continue;
		if (/^-n\d+$/.test(argument) && command === "log") continue;
		if (/^-u(?:no|normal|all)$/.test(argument) && command === "status") continue;
		if (optionWithValue(argument, valuesByCommand[command])) continue;
		if (valuesByCommand[command].has(argument)) {
			const value = args[++index];
			if (!value || value.startsWith("-"))
				throw new Error(`neta_exec requires a value after git ${command} option ${argument}.`);
			continue;
		}
		throw new Error(`neta_exec does not allow git ${command} option ${argument}.`);
	}
}

function safeEnvironment(command: "git" | "bun", safeHome: string): NodeJS.ProcessEnv {
	const windowsGitPaths = [
		process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : undefined,
		process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "cmd") : undefined,
		process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Git", "cmd") : undefined,
	].filter((path): path is string => path !== undefined);
	const env: NodeJS.ProcessEnv = {
		PATH: process.platform === "win32" ? windowsGitPaths.join(delimiter) : "/usr/bin:/bin",
		HOME: command === "git" ? safeHome : process.env.HOME,
		XDG_CONFIG_HOME: command === "git" ? safeHome : process.env.XDG_CONFIG_HOME,
		LANG: process.env.LANG,
		LC_ALL: process.env.LC_ALL,
		TERM: "dumb",
		NO_COLOR: "1",
		GIT_CONFIG_NOSYSTEM: command === "git" ? "1" : undefined,
		GIT_PAGER: command === "git" ? "" : undefined,
		PAGER: command === "git" ? "" : undefined,
	};
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function withinRoot(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return (
		fromRoot !== ".." &&
		!fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		!isAbsolute(fromRoot)
	);
}

function repositoryCwd(root: string, requested?: string): string {
	const canonicalRoot = realpathSync(root);
	const candidate = requested
		? isAbsolute(requested)
			? requested
			: resolve(canonicalRoot, requested)
		: canonicalRoot;
	const canonicalCandidate = realpathSync(candidate);
	if (!withinRoot(canonicalRoot, canonicalCandidate)) {
		throw new Error(`neta_exec cwd must remain within the session repository: ${canonicalRoot}`);
	}
	if (!statSync(canonicalCandidate).isDirectory())
		throw new Error(`neta_exec cwd is not a directory: ${canonicalCandidate}`);
	return canonicalCandidate;
}

function canonicalNearestExisting(path: string): string {
	let candidate = path;
	while (!existsSync(candidate)) {
		const parent = resolve(candidate, "..");
		if (parent === candidate) break;
		candidate = parent;
	}
	return realpathSync(candidate);
}

function validateBunTestPaths(root: string, cwd: string, args: readonly string[]): void {
	let afterSeparator = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") {
			afterSeparator = true;
			continue;
		}
		if (!afterSeparator && argument.startsWith("-")) {
			if (BUN_SEPARATE_VALUE_FLAGS.has(argument)) index += 1;
			continue;
		}
		if (isAbsolute(argument))
			throw new Error(`neta_exec Bun test paths must be relative to the repository: ${argument}`);
		const requested = resolve(cwd, argument);
		const boundary = canonicalNearestExisting(requested);
		if (!withinRoot(root, boundary)) {
			throw new Error(`neta_exec Bun test path escapes the session repository: ${argument}`);
		}
		if (existsSync(requested) && !withinRoot(root, realpathSync(requested))) {
			throw new Error(`neta_exec Bun test path escapes the session repository through a symlink: ${argument}`);
		}
		if (!existsSync(requested) || !statSync(realpathSync(requested)).isFile()) {
			throw new Error(`neta_exec Bun test path must name an existing repository test file: ${argument}`);
		}
	}
}

function bunExecutable(root: string): string {
	const candidate = /^bun(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : findOnPath("bun");
	if (!candidate) throw new Error("neta_exec could not find Bun on PATH.");
	const canonical = realpathSync(candidate);
	if (withinRoot(root, canonical)) {
		throw new Error(`neta_exec refuses a repository-local Bun executable: ${canonical}`);
	}
	return canonical;
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
	classifyRepoCommand(request.argv);
	const cwd = repositoryCwd(root, request.cwd);
	const canonicalRoot = realpathSync(root);
	if (request.argv[0] === "bun") validateBunTestPaths(canonicalRoot, cwd, request.argv.slice(2));
	const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`neta_exec timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} ms.`);
	}
	mkdirSync(auditDir, { recursive: true, mode: 0o700 });
	chmodSync(auditDir, 0o700);
	const outputPath = join(auditDir, `neta-exec-${Date.now()}-${randomBytes(6).toString("hex")}.log`);
	const outputFd = openSync(outputPath, "wx", 0o600);
	chmodSync(outputPath, 0o600);
	let childExited = false;
	const startedAt = Date.now();

	try {
		const executable = request.argv[0] === "bun" ? bunExecutable(canonicalRoot) : "git";
		const gitSafetyArgs =
			request.argv[1] === "diff" || request.argv[1] === "show" || request.argv[1] === "log"
				? ["--no-ext-diff", "--no-textconv"]
				: [];
		const childArgs =
			request.argv[0] === "git"
				? [
						"--no-pager",
						"-c",
						"core.fsmonitor=false",
						"-c",
						"core.hooksPath=/dev/null",
						request.argv[1],
						...gitSafetyArgs,
						...request.argv.slice(2),
					]
				: request.argv.slice(1);
		const child = spawn(executable, childArgs, {
			cwd,
			env: safeEnvironment(request.argv[0] as "git" | "bun", auditDir),
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
