/**
 * The session registry.
 *
 * A leader session exists only while its control plane process is alive, but a
 * person in another terminal still wants `neta workers` to work. So the control
 * plane drops a small file in `~/.neta/sessions/` describing how to reach it,
 * and removes it on the way out. Stale files (process gone) are ignored and
 * cleaned up on the next read.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "./config.ts";
import { killSessionSpec } from "./mux/index.ts";

export interface SessionRecord {
	id: string;
	/** Unix socket or named pipe the control plane listens on. */
	socket: string;
	/** Authorizes worker management. Readable only by this user. */
	token: string;
	cwd: string;
	/** Backend the leader runs in, e.g. "claude". */
	leader: string;
	pid: number;
	startedAt: number;
	/** The multiplexer session that contains the leader, when Neta started one. */
	mux?: SessionMux;
	/** Detached ACP process groups still owned by this manager. */
	workerGroups?: SessionWorkerGroup[];
}

export interface SessionMux {
	id: "zellij" | "tmux";
	name: string;
}

export interface SessionLock {
	path: string;
	token: string;
}

/** Identity captured when a detached ACP group is created, before crash recovery can ever reap it. */
export interface SessionWorkerGroup {
	pgid: number;
	/** `ps lstart` for the group leader; prevents a recycled numeric PGID from being killed. */
	leaderStartedAt: string;
}

export interface SessionSweepOptions {
	/** Test seam for platforms where the process table is unavailable to the test sandbox. */
	processStartTime?: (pid: number) => string | undefined;
	/** Emits identity-mismatch warnings without making cleanup fail. */
	warn?: (message: string) => void;
	/** Test seam for multiplexer cleanup; normal runs ignore muxes already gone. */
	killMuxSession?: (mux: SessionMux) => void;
}

function sessionsDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "sessions");
}

/** Resolve symlinks before comparing session directories. */
export function canonicalizeCwd(cwd: string): string {
	return realpathSync(cwd);
}

function lockPath(cwd: string, agentDir: string): string {
	const key = createHash("sha256").update(cwd).digest("hex");
	return join(sessionsDir(agentDir), "locks", key);
}

function lockOwnerPath(lock: SessionLock): string {
	return join(lock.path, "owner.json");
}

/**
 * Acquire a directory-specific launch lock. mkdir is atomic, and the owner
 * token stops the launcher's later cleanup from releasing a successor's lock.
 */
export function tryAcquireSessionLock(cwd: string, agentDir: string = getAgentDir()): SessionLock | undefined {
	const path = lockPath(cwd, agentDir);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try {
		mkdirSync(path, { recursive: false, mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			try {
				const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf-8")) as {
					pid?: unknown;
					startedAt?: unknown;
				};
				const pid = owner.pid;
				const startedAt = owner.startedAt;
				const stale =
					typeof pid === "number" &&
					(!isAlive(pid) || (typeof startedAt === "string" && processStartTime(pid) !== startedAt));
				if (stale) {
					rmSync(path, { recursive: true, force: true });
					return tryAcquireSessionLock(cwd, agentDir);
				}
			} catch {
				// A process can die after mkdir but before it writes owner.json. Only
				// reclaim that incomplete lock after its short creation window.
				try {
					if (Date.now() - statSync(path).mtimeMs > 5000) {
						rmSync(path, { recursive: true, force: true });
						return tryAcquireSessionLock(cwd, agentDir);
					}
				} catch {
					// Another launcher released it; the next retry will acquire it.
				}
			}
			return undefined;
		}
		throw error;
	}
	const lock = { path, token: randomBytes(16).toString("hex") };
	writeFileSync(
		lockOwnerPath(lock),
		JSON.stringify({ pid: process.pid, startedAt: processStartTime(process.pid), token: lock.token }),
		{
			encoding: "utf-8",
			mode: 0o600,
		},
	);
	return lock;
}

/** Release only the lock created by this launch or its control-plane child. */
export function releaseSessionLock(lock: SessionLock | undefined): void {
	if (!lock) return;
	try {
		const owner = JSON.parse(readFileSync(lockOwnerPath(lock), "utf-8")) as { token?: unknown };
		if (owner.token !== lock.token) return;
		rmSync(lock.path, { recursive: true, force: true });
	} catch {
		// A crashed launcher or a control plane that already registered the session
		// may have removed the lock. Either way, it is no longer ours to release.
	}
}

function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		// Signal 0 checks for existence without touching the process.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A session can be reattached only while the process that owns it is alive. */
export function isSessionAlive(record: Pick<SessionRecord, "pid">): boolean {
	return isAlive(record.pid);
}

/** A process identity stable across PID reuse for the lifetime of one boot. */
export function processStartTime(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 1) return undefined;
	try {
		const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" }).trim();
		return startedAt || undefined;
	} catch {
		return undefined;
	}
}

function isNetaSocket(address: string): boolean {
	return process.platform === "win32"
		? address.startsWith("\\\\.\\pipe\\neta-")
		: dirname(address) === tmpdir() && /^neta-.+\.sock$/.test(basename(address));
}

function reapProcessGroup(
	group: SessionWorkerGroup,
	identify: (pid: number) => string | undefined,
	warn: (message: string) => void,
): void {
	const { pgid, leaderStartedAt } = group;
	if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return;
	if (identify(pgid) !== leaderStartedAt) {
		warn(`[neta] stale session skipped process group ${pgid}: group leader identity no longer matches`);
		return;
	}
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		try {
			process.kill(-pgid, signal);
		} catch {
			try {
				process.kill(pgid, signal);
			} catch {
				// The group already exited, or this platform cannot signal groups.
			}
		}
	}
}

function killMuxSession(mux: SessionMux): void {
	try {
		const spec = killSessionSpec(mux.id, mux.name);
		execFileSync(spec.command, spec.args, { stdio: "ignore" });
	} catch {
		// The mux may already be gone, or no longer be installed. Neither should
		// stop registry recovery.
	}
}

function hasDeletedCwd(record: SessionRecord): boolean {
	try {
		canonicalizeCwd(record.cwd);
		return false;
	} catch {
		return true;
	}
}

function tearDownSession(
	record: SessionRecord,
	agentDir: string,
	identify: (pid: number) => string | undefined,
	warn: (message: string) => void,
	stopMux: (mux: SessionMux) => void,
): void {
	if (record.mux) stopMux(record.mux);
	for (const group of Array.isArray(record.workerGroups) ? record.workerGroups : [])
		reapProcessGroup(group, identify, warn);
	if (typeof record.socket === "string" && isNetaSocket(record.socket)) rmSync(record.socket, { force: true });
	removeSessionRecord(record.id, agentDir);
}

export function writeSessionRecord(record: SessionRecord, agentDir: string = getAgentDir()): string {
	const dir = sessionsDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${record.id}.json`);
	writeFileSync(path, JSON.stringify(record, null, 2), { encoding: "utf-8", mode: 0o600 });
	return path;
}

export function removeSessionRecord(id: string, agentDir: string = getAgentDir()): void {
	rmSync(join(sessionsDir(agentDir), `${id}.json`), { force: true });
}

/** Remove crashed sessions and sessions whose recorded directory has been deleted. */
export function sweepStaleSessions(agentDir: string = getAgentDir(), options: SessionSweepOptions = {}): void {
	const identify = options.processStartTime ?? processStartTime;
	const warn = options.warn ?? console.warn;
	const stopMux = options.killMuxSession ?? killMuxSession;
	const dir = sessionsDir(agentDir);
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		let record: SessionRecord;
		try {
			record = JSON.parse(readFileSync(path, "utf-8")) as SessionRecord;
		} catch {
			rmSync(path, { force: true });
			continue;
		}
		const alive = isSessionAlive(record);
		const deletedCwd = hasDeletedCwd(record);
		if (alive && !deletedCwd) continue;
		// A control plane can momentarily be in a directory that was deleted under
		// it. Never have that process tear down its own still-running session.
		if (record.pid === process.pid) continue;
		if (alive && deletedCwd) {
			try {
				process.kill(record.pid, "SIGTERM");
			} catch {
				// It exited between the liveness check and the signal.
			}
		}
		tearDownSession(record, agentDir, identify, warn, stopMux);
	}
}

/** Live sessions, newest first. Records whose process is gone are deleted. */
export function listSessions(agentDir: string = getAgentDir()): SessionRecord[] {
	const dir = sessionsDir(agentDir);
	sweepStaleSessions(agentDir);
	return readLiveSessions(dir);
}

/** Live sessions without sweeping. Callers that need recovery must sweep first. */
function readLiveSessions(dir: string): SessionRecord[] {
	if (!existsSync(dir)) return [];
	const records: SessionRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		let record: SessionRecord;
		try {
			record = JSON.parse(readFileSync(path, "utf-8")) as SessionRecord;
		} catch {
			rmSync(path, { force: true });
			continue;
		}
		if (!isSessionAlive(record)) continue;
		records.push(record);
	}
	return records.sort((a, b) => b.startedAt - a.startedAt);
}

/** A live session in this exact real directory, with symlinks resolved on both sides. */
export function findLiveSessionInDirectory(cwd: string, agentDir: string = getAgentDir()): SessionRecord | undefined {
	const canonicalCwd = canonicalizeCwd(cwd);
	return readLiveSessions(sessionsDir(agentDir)).find((record) => {
		try {
			return canonicalizeCwd(record.cwd) === canonicalCwd;
		} catch {
			return false;
		}
	});
}

/**
 * The session a command typed in `cwd` most likely means: one started in this
 * directory, else the most recent one if there is exactly one running.
 */
export function findSession(cwd: string, agentDir: string = getAgentDir()): SessionRecord | undefined {
	const records = listSessions(agentDir);
	return records.find((record) => record.cwd === cwd) ?? (records.length === 1 ? records[0] : undefined);
}
