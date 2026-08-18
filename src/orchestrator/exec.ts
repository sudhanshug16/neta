import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
export const OUTPUT_LIMIT_BYTES = 12_000;
const OUTPUT_HEAD_BYTES = 8_000;
const OUTPUT_TAIL_BYTES = OUTPUT_LIMIT_BYTES - OUTPUT_HEAD_BYTES;
const TERM_GRACE_MS = 1_000;
const KILL_GRACE_MS = 3_000;

export interface RepoExecRequest {
	argv: string[];
	cwd?: string;
	timeoutMs?: number;
	/**
	 * Deprecated and ignored. neta_exec no longer gates any command on user
	 * approval; kept only so callers built against the old schema still validate.
	 */
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
	/** This session's 1-based count of accepted neta_exec calls, including this one. */
	callNumber: number;
}

/** Every entry must be a real, non-empty argument string; NUL cannot reach execve regardless of policy. */
function validateArgv(argv: readonly string[]): void {
	if (!Array.isArray(argv) || argv.length === 0) {
		throw new Error("neta_exec requires a non-empty argv array.");
	}
	for (const argument of argv) {
		if (typeof argument !== "string" || argument.length === 0) {
			throw new Error("neta_exec argv entries must be non-empty strings.");
		}
		if (argument.includes("\0")) {
			throw new Error("neta_exec argv entries may not contain a NUL byte; the OS cannot pass it to a process.");
		}
	}
}

/** cwd may be any existing directory; output, not the command or its working directory, is the policy boundary. */
function resolveCwd(defaultCwd: string, requested?: string): string {
	const candidate =
		requested === undefined ? defaultCwd : isAbsolute(requested) ? requested : resolve(defaultCwd, requested);
	let real: string;
	try {
		real = realpathSync(candidate);
	} catch {
		throw new Error(`neta_exec cwd does not exist: ${candidate}`);
	}
	if (!statSync(real).isDirectory()) {
		throw new Error(`neta_exec cwd is not a directory: ${real}`);
	}
	return real;
}

function resolveTimeoutMs(timeoutMs?: number): number {
	const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
		throw new Error(`neta_exec timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} ms.`);
	}
	return value;
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

/**
 * Reads at most OUTPUT_LIMIT_BYTES from the full-output file. A command that
 * overflows the budget loses its middle, not its ending: the tail is where a
 * failing build's actual error usually lands, so a head-only cap would hide it.
 */
function readBoundedOutput(path: string): { output: string; truncated: boolean } {
	const size = statSync(path).size;
	const fd = openSync(path, "r");
	try {
		if (size <= OUTPUT_LIMIT_BYTES) {
			const buffer = Buffer.alloc(size);
			readSync(fd, buffer, 0, size, 0);
			return { output: buffer.toString("utf-8"), truncated: false };
		}
		const head = Buffer.alloc(OUTPUT_HEAD_BYTES);
		readSync(fd, head, 0, OUTPUT_HEAD_BYTES, 0);
		const tail = Buffer.alloc(OUTPUT_TAIL_BYTES);
		readSync(fd, tail, 0, OUTPUT_TAIL_BYTES, size - OUTPUT_TAIL_BYTES);
		return {
			output: `${head.toString("utf-8")}\n… output truncated …\n${tail.toString("utf-8")}`,
			truncated: true,
		};
	} finally {
		closeSync(fd);
	}
}

/**
 * Run one caller-specified command. There is no command allowlist: argv[0] is
 * handed to spawn exactly as given, resolved the same way any direct process
 * launch resolves a name or path. The only policy boundary left is the output
 * a caller gets back — bounded here, with the full capture always on disk.
 */
export async function executeRepoCommand(
	defaultCwd: string,
	auditDir: string,
	request: RepoExecRequest,
	signal: AbortSignal | undefined,
	onAccepted: () => number,
): Promise<RepoExecResult> {
	validateArgv(request.argv);
	const cwd = resolveCwd(defaultCwd, request.cwd);
	const timeoutMs = resolveTimeoutMs(request.timeoutMs);
	const callNumber = onAccepted();

	mkdirSync(auditDir, { recursive: true, mode: 0o700 });
	chmodSync(auditDir, 0o700);
	const outputPath = join(auditDir, `neta-exec-${Date.now()}-${randomBytes(6).toString("hex")}.log`);
	const outputFd = openSync(outputPath, "wx", 0o600);
	chmodSync(outputPath, 0o600);
	let childExited = false;
	const startedAt = Date.now();

	try {
		const child = spawn(request.argv[0], request.argv.slice(1), {
			cwd,
			env: process.env,
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
			callNumber,
		};
	} finally {
		closeSync(outputFd);
	}
}
