import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { processStartTime } from "../src/session.ts";

const TMUX_TIMEOUT_MS = 5_000;
const TERM_GRACE_MS = 250;
const KILL_GRACE_MS = 1_000;
const POLL_MS = 10;
const OWNERSHIP_DIR = join(tmpdir(), "neta-mux-e2e-owned");
const OWNERSHIP_FILE_PREFIX = "neta-mux-run-";

export interface ProcessIdentity {
	pid: number;
	startedAt: string;
}

export type ProcessIdentityReader = (pid: number) => string | undefined;
export type ProcessAliveReader = (pid: number) => boolean;

export interface OwnedSocketRecord {
	socket: string;
	server?: ProcessIdentity;
}

export interface OwnershipRecord {
	owner: ProcessIdentity;
	sockets: OwnedSocketRecord[];
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
	identify?: ProcessIdentityReader;
}

export interface RunCommandOptions extends TerminationOptions {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export type CommandRunner = (args: string[], options?: RunCommandOptions) => Promise<TmuxCommandResult>;
type ProcessTerminator = (identity: ProcessIdentity) => Promise<boolean>;

const realProcessControl: ProcessControl = {
	signal(pid, signal) {
		try {
			process.kill(-pid, signal);
		} catch (error) {
			// ESRCH means the exact process group is already gone. Never fall back to
			// the bare pid: that number may already belong to an unrelated process.
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
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

const realProcessAlive: ProcessAliveReader = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
};

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function identityMatches(identity: ProcessIdentity, identify: ProcessIdentityReader): boolean {
	return identify(identity.pid) === identity.startedAt;
}

async function waitForProcessGone(
	identity: ProcessIdentity,
	graceMs: number,
	pollMs: number,
	control: ProcessControl,
	identify: ProcessIdentityReader,
): Promise<boolean> {
	const deadline = Date.now() + graceMs;
	while (identityMatches(identity, identify) && control.alive(identity.pid) && Date.now() < deadline) {
		await wait(pollMs);
	}
	return !identityMatches(identity, identify) || !control.alive(identity.pid);
}

/** Terminate only the detached process group rooted at the exact recorded identity. */
export async function terminateOwnedProcess(
	identity: ProcessIdentity,
	options: TerminationOptions = {},
): Promise<boolean> {
	const termGraceMs = options.termGraceMs ?? TERM_GRACE_MS;
	const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
	const pollMs = options.pollMs ?? POLL_MS;
	const control = options.control ?? realProcessControl;
	const identify = options.identify ?? processStartTime;
	if (!identityMatches(identity, identify) || !control.alive(identity.pid)) return false;
	if (!identityMatches(identity, identify)) return false;
	control.signal(identity.pid, "SIGTERM");
	if (await waitForProcessGone(identity, termGraceMs, pollMs, control, identify)) return false;
	if (!identityMatches(identity, identify)) return false;
	control.signal(identity.pid, "SIGKILL");
	if (!(await waitForProcessGone(identity, killGraceMs, pollMs, control, identify))) {
		throw new Error(`tmux test process group ${identity.pid} did not stop after SIGKILL.`);
	}
	return true;
}

function outputText(chunks: Buffer[]): string {
	return Buffer.concat(chunks).toString("utf8");
}

function requireIdentity(pid: number, identify: ProcessIdentityReader): ProcessIdentity {
	const startedAt = identify(pid);
	if (!startedAt) throw new Error(`Could not record process start identity for pid ${pid}.`);
	return { pid, startedAt };
}

async function waitForIdentity(
	pid: number,
	identify: ProcessIdentityReader,
	timeoutMs = 250,
): Promise<ProcessIdentity | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const startedAt = identify(pid);
		if (startedAt) return { pid, startedAt };
		await wait(POLL_MS);
	}
	return undefined;
}

/** Run one command with a mandatory timeout and bounded TERM->KILL cleanup. */
export async function runBoundedCommand(
	command: string,
	args: string[],
	options: RunCommandOptions = {},
): Promise<TmuxCommandResult> {
	const timeoutMs = options.timeoutMs ?? TMUX_TIMEOUT_MS;
	const identify = options.identify ?? processStartTime;
	const child = spawn(command, args, {
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
	child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
	let childIdentity: ProcessIdentity | undefined;
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
		if (child.pid !== undefined) childIdentity = await waitForIdentity(child.pid, identify);
		if (!childIdentity) throw new Error("tmux test process did not provide a verifiable pid for cleanup.");
		await terminateOwnedProcess(childIdentity, options);
		await Promise.race([closed, wait(options.killGraceMs ?? KILL_GRACE_MS)]);
		return { status: 124, stdout: outputText(stdout), stderr: outputText(stderr), timedOut: true };
	}
	if (winner.result.error) {
		return { status: null, stdout: outputText(stdout), stderr: winner.result.error.message, timedOut: false };
	}
	if (childIdentity && (options.control ?? realProcessControl).alive(childIdentity.pid)) {
		await terminateOwnedProcess(childIdentity, options);
	}
	return { status: winner.result.status, stdout: outputText(stdout), stderr: outputText(stderr), timedOut: false };
}

export function uniqueTmuxSocket(prefix: string): string {
	return `${prefix}-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

function isSafeSocketName(socket: string): boolean {
	return /^neta-[A-Za-z0-9_.-]+$/.test(socket);
}

function processIdentity(pid: number, identify: ProcessIdentityReader): ProcessIdentity {
	return requireIdentity(pid, identify);
}

function processOwnerState(
	identity: ProcessIdentity,
	identify: ProcessIdentityReader,
	pidAlive: ProcessAliveReader,
): "alive" | "dead" | "unknown" {
	if (!pidAlive(identity.pid)) return "dead";
	const actual = identify(identity.pid);
	if (actual === undefined) return "unknown";
	return actual === identity.startedAt ? "alive" : "dead";
}

function recordIsValid(value: unknown): value is OwnershipRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<OwnershipRecord>;
	if (!record.owner || typeof record.owner !== "object") return false;
	if (!Number.isSafeInteger(record.owner.pid) || typeof record.owner.startedAt !== "string" || !record.owner.startedAt)
		return false;
	if (!Array.isArray(record.sockets)) return false;
	return record.sockets.every((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const socket = entry as Partial<OwnedSocketRecord>;
		if (typeof socket.socket !== "string" || !isSafeSocketName(socket.socket)) return false;
		if (socket.server === undefined) return true;
		return (
			typeof socket.server === "object" &&
			Number.isSafeInteger(socket.server.pid) &&
			typeof socket.server.startedAt === "string" &&
			socket.server.startedAt.length > 0
		);
	});
}

/** Write a ledger record atomically, preserving the last complete record on interruption. */
export function writeOwnershipRecordAtomic(path: string, record: OwnershipRecord): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let handle: number | undefined;
	try {
		handle = openSync(temporary, "wx", 0o600);
		writeSync(handle, `${JSON.stringify(record)}\n`, undefined, "utf8");
		fsyncSync(handle);
		closeSync(handle);
		handle = undefined;
		renameSync(temporary, path);
		chmodSync(path, 0o600);
		const directoryHandle = openSync(directory, "r");
		try {
			fsyncSync(directoryHandle);
		} finally {
			closeSync(directoryHandle);
		}
	} finally {
		if (handle !== undefined) closeSync(handle);
		rmSync(temporary, { force: true });
	}
}

function socketPathBelongsTo(socketPath: string, socket: string): boolean {
	return basename(socketPath) === socket;
}

function missingServer(result: TmuxCommandResult): boolean {
	return result.status !== 0 && /(no such file|no server|error connecting)/i.test(result.stderr);
}

async function inspectOwnedServer(
	socket: string,
	expected: ProcessIdentity,
	command: CommandRunner,
	identify: ProcessIdentityReader,
	pidAlive: ProcessAliveReader,
): Promise<"owned" | "gone" | "mismatch" | "unknown"> {
	const result = await command(["-L", socket, "display-message", "-p", "#{socket_path}\t#{pid}"]);
	if (result.status !== 0 || result.timedOut) return missingServer(result) ? "gone" : "unknown";
	const [socketPath, pidText] = result.stdout.trim().split("\t");
	const pid = Number(pidText);
	if (!socketPathBelongsTo(socketPath ?? "", socket) || pid !== expected.pid) return "mismatch";
	if (!pidAlive(expected.pid)) return "gone";
	const startedAt = identify(expected.pid);
	if (startedAt === undefined) return "unknown";
	return startedAt === expected.startedAt ? "owned" : "mismatch";
}

export interface ReapOptions {
	ownershipDirectory?: string;
	command?: CommandRunner;
	identify?: ProcessIdentityReader;
	pidAlive?: ProcessAliveReader;
	terminate?: ProcessTerminator;
}

/** Reap only exact records left by a dead test parent; live parallel owners are never touched. */
export async function reapOrphanedTmuxTestRuns(options: ReapOptions = {}): Promise<void> {
	const ownershipDirectory = options.ownershipDirectory ?? OWNERSHIP_DIR;
	const command = options.command ?? ((args, commandOptions) => runBoundedCommand("tmux", args, commandOptions));
	const identify = options.identify ?? processStartTime;
	const pidAlive = options.pidAlive ?? realProcessAlive;
	const terminate = options.terminate ?? ((identity) => terminateOwnedProcess(identity, { identify }));
	let files: string[];
	try {
		files = readdirSync(ownershipDirectory).filter(
			(file) => file.startsWith(OWNERSHIP_FILE_PREFIX) && file.endsWith(".json"),
		);
	} catch {
		return;
	}
	for (const file of files) {
		const path = join(ownershipDirectory, file);
		let record: OwnershipRecord;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!recordIsValid(parsed)) continue;
			record = parsed;
		} catch {
			// A malformed ledger is evidence to preserve, never a reason to guess a
			// socket or PID and never a reason to run a broad cleanup sweep.
			continue;
		}
		if (processOwnerState(record.owner, identify, pidAlive) !== "dead") continue;
		let complete = true;
		for (const artifact of record.sockets) {
			if (!artifact.server) {
				complete = false;
				continue;
			}
			let ownership: "owned" | "gone" | "mismatch" | "unknown";
			try {
				ownership = await inspectOwnedServer(artifact.socket, artifact.server, command, identify, pidAlive);
			} catch {
				complete = false;
				continue;
			}
			if (ownership === "unknown") {
				complete = false;
				continue;
			}
			if (ownership !== "owned") continue;
			try {
				const result = await command(["-L", artifact.socket, "kill-server"], { timeoutMs: TMUX_TIMEOUT_MS });
				if (result.timedOut) await terminate(artifact.server);
				else if (result.status !== 0 && !missingServer(result)) complete = false;
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

const activeRuns = new Set<TmuxTestRun>();
let signalCleanup: Promise<void> | undefined;

function signalNumber(signal: NodeJS.Signals): number {
	const signals: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
	return signals[signal] ?? 1;
}

process.once("exit", () => {
	// `exit` cannot await tmux. Revalidate each exact server identity before
	// signalling its process group; never signal a bare, potentially reused PID.
	for (const run of activeRuns) run.emergencyCleanup();
});

export interface TmuxTestRunOptions {
	ownershipDirectory?: string;
	ownerIdentity?: ProcessIdentity;
	identify?: ProcessIdentityReader;
	pidAlive?: ProcessAliveReader;
}

export class TmuxTestRun {
	private readonly sockets = new Set<string>();
	private readonly servers = new Map<string, ProcessIdentity>();
	private readonly ownershipPath: string;
	private readonly command: CommandRunner;
	private readonly terminate: ProcessTerminator;
	private readonly ownerIdentity: ProcessIdentity;
	private readonly identify: ProcessIdentityReader;
	private readonly pidAlive: ProcessAliveReader;
	private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();
	private cleanupPromise: Promise<void> | undefined;

	constructor(
		command: CommandRunner = (args, options) => runBoundedCommand("tmux", args, options),
		terminate: ProcessTerminator = (identity) => terminateOwnedProcess(identity),
		options: TmuxTestRunOptions = {},
	) {
		this.command = command;
		this.terminate = terminate;
		this.identify = options.identify ?? processStartTime;
		this.pidAlive = options.pidAlive ?? realProcessAlive;
		this.ownerIdentity = options.ownerIdentity ?? processIdentity(process.pid, this.identify);
		this.ownershipPath = join(
			options.ownershipDirectory ?? OWNERSHIP_DIR,
			`${OWNERSHIP_FILE_PREFIX}${this.ownerIdentity.pid}-${randomBytes(6).toString("hex")}.json`,
		);
		activeRuns.add(this);
		this.installSignalHandlers();
	}

	get recordPath(): string {
		return this.ownershipPath;
	}

	private installSignalHandlers(): void {
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			const handler = () => {
				if (signalCleanup) return;
				signalCleanup = Promise.all([...activeRuns].map((run) => run.cleanup())).then(() => undefined);
				void signalCleanup.finally(() => process.exit(128 + signalNumber(signal)));
			};
			this.signalHandlers.set(signal, handler);
			process.once(signal, handler);
		}
	}

	private unregisterSignalHandlers(): void {
		for (const [signal, handler] of this.signalHandlers) process.removeListener(signal, handler);
		this.signalHandlers.clear();
	}

	ownSocket(socket: string): string {
		if (!isSafeSocketName(socket)) throw new Error(`Unsafe tmux test socket name: ${socket}`);
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
		const result = await this.command([
			"-L",
			socket,
			"display-message",
			"-p",
			"#{socket_path},#{pid},#{window_index}",
		]);
		if (result.status !== 0 || result.timedOut)
			throw new Error(result.stderr || "Could not inspect tmux test server.");
		const [socketPath, pidText] = result.stdout.trim().split(",");
		const pid = Number(pidText);
		if (!socketPathBelongsTo(socketPath ?? "", socket) || !Number.isSafeInteger(pid) || pid < 1)
			throw new Error(`Could not record tmux server identity from: ${result.stdout.trim()}`);
		const server = existing ?? processIdentity(pid, this.identify);
		if (server.pid !== pid || !identityMatches(server, this.identify))
			throw new Error(`tmux test server identity changed for socket ${socket}.`);
		this.servers.set(socket, server);
		this.persistOwnership();
		return { locator: result.stdout.trim(), pid };
	}

	private persistOwnership(): void {
		writeOwnershipRecordAtomic(this.ownershipPath, {
			owner: this.ownerIdentity,
			sockets: [...this.sockets].map((socket) => ({ socket, server: this.servers.get(socket) })),
		});
	}

	async cleanup(): Promise<void> {
		if (this.cleanupPromise) return this.cleanupPromise;
		this.cleanupPromise = (async () => {
			let complete = true;
			try {
				for (const socket of this.sockets) {
					const server = this.servers.get(socket);
					if (!server) {
						complete = false;
						continue;
					}
					let ownership: "owned" | "gone" | "mismatch" | "unknown";
					try {
						ownership = await inspectOwnedServer(socket, server, this.command, this.identify, this.pidAlive);
					} catch {
						complete = false;
						continue;
					}
					if (ownership === "unknown") {
						complete = false;
						continue;
					}
					if (ownership !== "owned") continue;
					try {
						const result = await this.command(["-L", socket, "kill-server"], { timeoutMs: TMUX_TIMEOUT_MS });
						if (result.timedOut) await this.terminate(server);
						else if (result.status !== 0 && !missingServer(result)) complete = false;
					} catch {
						complete = false;
					}
				}
			} finally {
				this.unregisterSignalHandlers();
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
		for (const server of this.servers.values()) {
			if (!identityMatches(server, this.identify)) continue;
			try {
				realProcessControl.signal(server.pid, "SIGTERM");
			} catch {}
			if (!identityMatches(server, this.identify)) continue;
			try {
				realProcessControl.signal(server.pid, "SIGKILL");
			} catch {}
		}
	}
}
