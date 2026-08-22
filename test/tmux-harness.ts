import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMUX_TIMEOUT_MS = 5_000;
const TERM_GRACE_MS = 250;
const KILL_GRACE_MS = 1_000;
const POLL_MS = 10;
const OWNERSHIP_DIR = join(tmpdir(), "neta-mux-e2e-owned");
const OWNERSHIP_FILE_PREFIX = "neta-mux-run-";

interface OwnershipRecord {
	ownerPid: number;
	sockets: string[];
}

export interface TmuxCommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface ProcessControl {
	signal(pid: number, signal: NodeJS.Signals): void;
	alive(pid: number): boolean;
}

interface TerminationOptions {
	termGraceMs?: number;
	killGraceMs?: number;
	pollMs?: number;
	control?: ProcessControl;
}

const realProcessControl: ProcessControl = {
	signal(pid, signal) {
		try {
			process.kill(-pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			try {
				process.kill(pid, signal);
			} catch (fallbackError) {
				if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") throw fallbackError;
			}
		}
	},
	alive(pid) {
		try {
			process.kill(-pid, 0);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ESRCH") return false;
			if (code === "EPERM") return true;
			return true;
		}
	},
};

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessGone(
	pid: number,
	graceMs: number,
	pollMs: number,
	control: ProcessControl,
): Promise<boolean> {
	const deadline = Date.now() + graceMs;
	while (control.alive(pid) && Date.now() < deadline) await wait(pollMs);
	return !control.alive(pid);
}

/** Terminate only the detached process group rooted at the exact recorded pid. */
export async function terminateOwnedProcess(pid: number, options: TerminationOptions = {}): Promise<boolean> {
	const termGraceMs = options.termGraceMs ?? TERM_GRACE_MS;
	const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
	const pollMs = options.pollMs ?? POLL_MS;
	const control = options.control ?? realProcessControl;
	if (!control.alive(pid)) return false;
	control.signal(pid, "SIGTERM");
	if (await waitForProcessGone(pid, termGraceMs, pollMs, control)) return false;
	control.signal(pid, "SIGKILL");
	if (!(await waitForProcessGone(pid, killGraceMs, pollMs, control))) {
		throw new Error(`tmux test process group ${pid} did not stop after SIGKILL.`);
	}
	return true;
}

interface RunCommandOptions extends TerminationOptions {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

function outputText(chunks: Buffer[]): string {
	return Buffer.concat(chunks).toString("utf8");
}

/** Run one command with a mandatory timeout and bounded TERM->KILL cleanup. */
export async function runBoundedCommand(
	command: string,
	args: string[],
	options: RunCommandOptions = {},
): Promise<TmuxCommandResult> {
	const timeoutMs = options.timeoutMs ?? TMUX_TIMEOUT_MS;
	const child = spawn(command, args, {
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
	child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
	const closed = new Promise<{ status: number | null; error?: Error }>((resolve) => {
		child.once("error", (error) => resolve({ status: null, error }));
		child.once("close", (status) => resolve({ status }));
	});
	let stopTimer: ReturnType<typeof setTimeout> | undefined;
	const stopped = new Promise<"timeout">((resolve) => {
		stopTimer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	const winner = await Promise.race([
		closed.then((result) => ({ type: "closed" as const, result })),
		stopped.then((reason) => ({ type: "stopped" as const, reason })),
	]);
	if (stopTimer) clearTimeout(stopTimer);
	if (winner.type === "stopped") {
		if (child.pid === undefined) throw new Error("tmux test process did not provide a pid for cleanup.");
		await terminateOwnedProcess(child.pid, options);
		await Promise.race([closed, wait(options.killGraceMs ?? KILL_GRACE_MS)]);
		return { status: 124, stdout: outputText(stdout), stderr: outputText(stderr), timedOut: true };
	}
	if (winner.result.error) {
		return { status: null, stdout: outputText(stdout), stderr: winner.result.error.message, timedOut: false };
	}
	if (child.pid !== undefined && (options.control ?? realProcessControl).alive(child.pid)) {
		await terminateOwnedProcess(child.pid, options);
	}
	return { status: winner.result.status, stdout: outputText(stdout), stderr: outputText(stderr), timedOut: false };
}

export function uniqueTmuxSocket(prefix: string): string {
	return `${prefix}-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

function ownerAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function writeOwnershipRecord(path: string, record: OwnershipRecord): void {
	mkdirSync(OWNERSHIP_DIR, { recursive: true, mode: 0o700 });
	chmodSync(OWNERSHIP_DIR, 0o700);
	writeFileSync(path, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
	chmodSync(path, 0o600);
}

/** Reap only exact records left by a dead test parent; live parallel owners are never touched. */
export async function reapOrphanedTmuxTestRuns(): Promise<void> {
	let files: string[];
	try {
		files = readdirSync(OWNERSHIP_DIR).filter((file) => file.startsWith(OWNERSHIP_FILE_PREFIX));
	} catch {
		return;
	}
	for (const file of files) {
		const path = join(OWNERSHIP_DIR, file);
		let record: OwnershipRecord;
		try {
			record = JSON.parse(readFileSync(path, "utf8")) as OwnershipRecord;
		} catch {
			continue;
		}
		if (!Number.isSafeInteger(record.ownerPid) || ownerAlive(record.ownerPid) || !Array.isArray(record.sockets))
			continue;
		let complete = true;
		for (const socket of record.sockets) {
			if (typeof socket !== "string" || socket.length === 0) {
				complete = false;
				continue;
			}
			try {
				const result = await runBoundedCommand("tmux", ["-L", socket, "kill-server"]);
				if (result.timedOut) complete = false;
			} catch {
				complete = false;
			}
		}
		if (complete) {
			try {
				unlinkSync(path);
			} catch {}
		}
	}
}

type CommandRunner = (args: string[], options?: RunCommandOptions) => Promise<TmuxCommandResult>;
type ProcessTerminator = (pid: number) => Promise<boolean>;

const activeRuns = new Set<TmuxTestRun>();
let signalCleanup: Promise<void> | undefined;

function signalNumber(signal: NodeJS.Signals): number {
	const signals: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
	return signals[signal] ?? 1;
}

function installProcessCleanup(): void {
	if (activeRuns.size === 0) return;
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.once(signal, () => {
			if (signalCleanup) return;
			signalCleanup = Promise.all([...activeRuns].map((run) => run.cleanup())).then(() => undefined);
			void signalCleanup.finally(() => process.exit(128 + signalNumber(signal)));
		});
	}
}

process.once("exit", () => {
	// `exit` cannot await tmux. Send signals only to recorded server pids; an
	// interrupted parent may leave a bounded residual on macOS if it dies first.
	for (const run of activeRuns) run.emergencyCleanup();
});

export class TmuxTestRun {
	private readonly sockets = new Set<string>();
	private readonly servers = new Map<string, number>();
	private readonly ownershipPath = join(
		OWNERSHIP_DIR,
		`${OWNERSHIP_FILE_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}.json`,
	);
	private readonly command: CommandRunner;
	private readonly terminate: ProcessTerminator;
	private cleanupPromise: Promise<void> | undefined;

	constructor(
		command: CommandRunner = (args, options) => runBoundedCommand("tmux", args, options),
		terminate: ProcessTerminator = (pid) => terminateOwnedProcess(pid),
	) {
		this.command = command;
		this.terminate = terminate;
		activeRuns.add(this);
		installProcessCleanup();
	}

	ownSocket(socket: string): string {
		this.sockets.add(socket);
		this.persistOwnership();
		return socket;
	}

	async invoke(args: string[], options?: RunCommandOptions): Promise<TmuxCommandResult> {
		return this.command(args, options);
	}

	async recordServer(socket: string): Promise<{ locator: string; pid: number }> {
		this.ownSocket(socket);
		const existing = this.servers.get(socket);
		if (existing !== undefined) {
			const result = await this.command([
				"-L",
				socket,
				"display-message",
				"-p",
				"#{socket_path},#{pid},#{window_index}",
			]);
			if (result.status !== 0 || result.timedOut)
				throw new Error(result.stderr || "Could not inspect tmux test server.");
			return { locator: result.stdout.trim(), pid: existing };
		}
		const result = await this.command([
			"-L",
			socket,
			"display-message",
			"-p",
			"#{socket_path},#{pid},#{window_index}",
		]);
		if (result.status !== 0 || result.timedOut)
			throw new Error(result.stderr || "Could not inspect tmux test server.");
		const parts = result.stdout.trim().split(",");
		const pid = Number(parts[1]);
		if (!Number.isSafeInteger(pid) || pid < 1)
			throw new Error(`Could not record tmux server pid from: ${result.stdout.trim()}`);
		this.servers.set(socket, pid);
		this.persistOwnership();
		return { locator: result.stdout.trim(), pid };
	}

	private persistOwnership(): void {
		writeOwnershipRecord(this.ownershipPath, { ownerPid: process.pid, sockets: [...this.sockets] });
	}

	async cleanup(): Promise<void> {
		if (this.cleanupPromise) return this.cleanupPromise;
		this.cleanupPromise = (async () => {
			let complete = true;
			for (const socket of this.sockets) {
				let commandTimedOut = false;
				try {
					const result = await this.command(["-L", socket, "kill-server"], { timeoutMs: TMUX_TIMEOUT_MS });
					commandTimedOut = result.timedOut;
				} catch {
					complete = false;
				}
				const pid = this.servers.get(socket);
				if (pid !== undefined) {
					try {
						await this.terminate(pid);
					} catch {
						complete = false;
					}
				} else if (commandTimedOut) {
					complete = false;
				}
			}
			if (complete) {
				this.sockets.clear();
				this.servers.clear();
				activeRuns.delete(this);
				try {
					unlinkSync(this.ownershipPath);
				} catch {}
			}
		})();
		return this.cleanupPromise;
	}

	emergencyCleanup(): void {
		for (const pid of this.servers.values()) {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {}
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
			try {
				process.kill(-pid, "SIGKILL");
			} catch {}
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
}
