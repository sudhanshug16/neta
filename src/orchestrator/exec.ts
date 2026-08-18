import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
/** Cap on the command-output excerpt alone (`RepoExecResult.output`) — not on the MCP tool text built around it. */
export const OUTPUT_LIMIT_BYTES = 12_000;
/** Exported so tests can assert its exact, uncut presence rather than a loosely matched substring. */
export const TRUNCATION_MARKER = "\n… output truncated …\n";
const TERM_GRACE_MS = 1_000;
const KILL_GRACE_MS = 3_000;
/** Exit code is always 0-255 (plus the synthetic 124/130 below); -1 can only mean the command never ran. */
export const SPAWN_FAILURE_EXIT_CODE = -1;

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
 * Drops trailing characters until the UTF-8 encoding fits, keeping the
 * string's own prefix. Guards the case where a raw byte cut splits a
 * multi-byte sequence, or where decoding invalid bytes inflates length
 * (each bad byte can decode to one 3-byte replacement character).
 */
function capUtf8BytesFromEnd(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let result = text;
	while (Buffer.byteLength(result, "utf-8") > maxBytes) result = result.slice(0, -1);
	return result;
}

/** Drops leading characters until the UTF-8 encoding fits, keeping the string's own suffix — the mirror of capUtf8BytesFromEnd, for content whose end matters more than its start. */
function capUtf8BytesFromStart(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let result = text;
	while (Buffer.byteLength(result, "utf-8") > maxBytes) result = result.slice(1);
	return result;
}

/** How many raw bytes to read from the head and the tail so decoding each independently, even with maximum invalid-byte inflation, can still be capped to fit `excerptBudget` combined. */
function headTailBudgets(size: number, excerptBudget: number): { headBudget: number; tailBudget: number } {
	const headBudget = Math.min(size, Math.ceil((excerptBudget * 2) / 3));
	const tailBudget = Math.min(Math.max(size - headBudget, 0), Math.max(excerptBudget - headBudget, 0));
	return { headBudget, tailBudget };
}

/**
 * Assembles a head+marker+tail excerpt where the marker can never be pushed
 * out and the tail can never be silently dropped. `headBudgetBytes` and
 * `tailBudgetBytes` are enforced independently — the head is capped from its
 * own end (keeping its prefix), the tail from its own start (keeping its
 * suffix) — instead of decoding both, concatenating, and trimming the whole
 * assembled string from the end: that would let head-side inflation from
 * invalid UTF-8 eat the marker and the entire tail while still claiming both
 * were shown. Combined byte length is always <= headBudgetBytes +
 * TRUNCATION_MARKER's bytes + tailBudgetBytes <= OUTPUT_LIMIT_BYTES.
 */
function excerptFromHeadTail(head: Buffer, tail: Buffer, headBudgetBytes: number, tailBudgetBytes: number): string {
	const headExcerpt = capUtf8BytesFromEnd(head.toString("utf-8"), headBudgetBytes);
	const tailExcerpt = capUtf8BytesFromStart(tail.toString("utf-8"), tailBudgetBytes);
	return `${headExcerpt}${TRUNCATION_MARKER}${tailExcerpt}`;
}

/**
 * Reads from the full-output file so the returned excerpt's own UTF-8 byte
 * length — marker included — never exceeds OUTPUT_LIMIT_BYTES, regardless of
 * the file's raw byte size or its content. A command that overflows the
 * budget loses its middle, not its ending: the tail is where a failing
 * build's actual error usually lands, so a head-only cap would hide it.
 *
 * Raw size alone cannot decide truncation: decoding invalid UTF-8 replaces
 * each bad byte with a 3-byte replacement character, so a file at or under
 * the cap can still decode to something well over it (binary output is the
 * common case). Whichever branch overflows after decoding is marked
 * truncated, never silently cut — and never by trimming the assembled
 * head+marker+tail string as a whole, which could erase the marker and tail
 * (see excerptFromHeadTail).
 */
function readBoundedOutput(path: string): { output: string; truncated: boolean } {
	const size = statSync(path).size;
	const fd = openSync(path, "r");
	try {
		const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf-8");
		const excerptBudget = Math.max(0, OUTPUT_LIMIT_BYTES - markerBytes);
		if (size <= OUTPUT_LIMIT_BYTES) {
			const whole = Buffer.alloc(size);
			readSync(fd, whole, 0, size, 0);
			const decoded = whole.toString("utf-8");
			if (Buffer.byteLength(decoded, "utf-8") <= OUTPUT_LIMIT_BYTES) {
				return { output: decoded, truncated: false };
			}
			const { headBudget, tailBudget } = headTailBudgets(size, excerptBudget);
			return {
				output: excerptFromHeadTail(
					whole.subarray(0, headBudget),
					whole.subarray(size - tailBudget, size),
					headBudget,
					tailBudget,
				),
				truncated: true,
			};
		}
		const { headBudget, tailBudget } = headTailBudgets(size, excerptBudget);
		const head = Buffer.alloc(headBudget);
		readSync(fd, head, 0, headBudget, 0);
		const tail = Buffer.alloc(tailBudget);
		readSync(fd, tail, 0, tailBudget, size - tailBudget);
		return { output: excerptFromHeadTail(head, tail, headBudget, tailBudget), truncated: true };
	} finally {
		closeSync(fd);
	}
}

/**
 * Folds a lifecycle-failure message onto an already-bounded excerpt without
 * ever pushing the combined result back over OUTPUT_LIMIT_BYTES. The message
 * is the diagnostic — it explains why exitCode is SPAWN_FAILURE_EXIT_CODE —
 * so it is kept intact and any pre-failure captured output is trimmed first.
 * When trimming is needed, TRUNCATION_MARKER is inserted at the cut so the
 * result never silently drops content while still reporting `truncated`.
 */
export function boundedOutputWithFailure(
	existing: { output: string; truncated: boolean },
	message: string,
): { output: string; truncated: boolean } {
	const separator = existing.output ? "\n" : "";
	const assembled = `${existing.output}${separator}${message}`;
	if (Buffer.byteLength(assembled, "utf-8") <= OUTPUT_LIMIT_BYTES) {
		return { output: assembled, truncated: existing.truncated };
	}
	const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf-8");
	const messageBudget = Math.max(0, Math.min(Buffer.byteLength(message, "utf-8"), OUTPUT_LIMIT_BYTES - markerBytes));
	const cappedMessage = capUtf8BytesFromEnd(message, messageBudget);
	const existingBudget = Math.max(0, OUTPUT_LIMIT_BYTES - markerBytes - Buffer.byteLength(cappedMessage, "utf-8"));
	const cappedExisting = capUtf8BytesFromEnd(existing.output, existingBudget);
	return {
		output: capUtf8BytesFromEnd(`${cappedExisting}${TRUNCATION_MARKER}${cappedMessage}`, OUTPUT_LIMIT_BYTES),
		truncated: true,
	};
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
		} catch (error) {
			// Accepted means counted: a command that could not even be launched (bad
			// executable, group cleanup that cannot be proven) still consumed this
			// call's slot, so it gets a completed result carrying callNumber — never
			// an uncaught rejection that would strand the frequency warning.
			const bounded = readBoundedOutput(outputPath);
			const message = error instanceof Error ? error.message : String(error);
			const withFailure = boundedOutputWithFailure(bounded, message);
			return {
				exitCode: SPAWN_FAILURE_EXIT_CODE,
				durationMs: Date.now() - startedAt,
				cwd,
				outputPath,
				output: withFailure.output,
				truncated: withFailure.truncated,
				timedOut: false,
				callNumber,
			};
		}
	} finally {
		closeSync(outputFd);
	}
}
