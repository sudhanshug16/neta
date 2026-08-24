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
	/** Neta runtime that owns this live lease; absent on pre-metadata records. */
	appVersion?: string;
	/** Channel protocol understood by the manager; absent on pre-metadata records. */
	channelProtocolVersion?: number;
	/** Unix socket or named pipe the control plane listens on. */
	socket: string;
	/** Authorizes worker management. Readable only by this user. */
	token: string;
	cwd: string;
	/** Backend the leader runs in, e.g. "claude". */
	leader: string;
	/** Durable checkpoint this manager owns, so recovery can find one from the other. */
	checkpointId?: string;
	pid: number;
	/** Process identity used to reject PID reuse when matching a durable checkpoint lease. */
	processStartedAt?: string;
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

/** Fail closed if a caller's ownership proof was replaced or released. */
export function assertSessionLockHeld(lock: SessionLock): void {
	try {
		const owner = JSON.parse(readFileSync(lockOwnerPath(lock), "utf-8")) as { token?: unknown };
		if (owner.token !== lock.token) throw new Error("ownership token changed");
	} catch {
		throw new Error(`Session lock is no longer held: ${lock.path}.`);
	}
}

/** Identity captured when a detached ACP group is created, before crash recovery can ever reap it. */
export interface SessionWorkerGroup {
	pgid: number;
	/** `ps lstart` for the group leader; prevents a recycled numeric PGID from being killed. */
	leaderStartedAt: string;
}

/**
 * What the sweep leaves behind after it reaps a crashed manager.
 *
 * Recovery has to prove the old run's processes are gone before it may hydrate,
 * and the evidence for that lives in the session record — which the sweep
 * deletes. Any `neta` command can trigger a sweep, so without this marker a
 * routine `neta workers` between the crash and the resume would quietly destroy
 * the proof and make the session unrecoverable.
 */
export interface SessionStoppedMarker {
	id: string;
	checkpointId?: string;
	at: number;
	/** Every recorded worker group was reaped, or was already gone. */
	processesStopped: boolean;
	processStartedAt?: string;
}

export interface SessionSweepOptions {
	/** Test seam for platforms where the process table is unavailable to the test sandbox. */
	processStartTime?: (pid: number) => string | undefined;
	/** Test seam for process-group membership; normal runs signal the real group. */
	groupPopulated?: (pgid: number) => boolean | undefined;
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
	return tryAcquireLockDirectory(lockPath(cwd, agentDir));
}

/**
 * Claim one durable checkpoint for the duration of a resume.
 *
 * The directory lock already serializes launches per working directory. This
 * second claim is what stops two `neta resume <id>` commands from building two
 * managers over one checkpoint — including the case where the checkpoint's
 * recorded directory is not the directory either command was typed in.
 */
export function tryAcquireCheckpointClaim(id: string, agentDir: string = getAgentDir()): SessionLock | undefined {
	return tryAcquireLockDirectory(join(sessionsDir(agentDir), "claims", basename(id)));
}

function tryAcquireLockDirectory(path: string): SessionLock | undefined {
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
					return tryAcquireLockDirectory(path);
				}
			} catch {
				// A process can die after mkdir but before it writes owner.json. Only
				// reclaim that incomplete lock after its short creation window.
				try {
					if (Date.now() - statSync(path).mtimeMs > 5000) {
						rmSync(path, { recursive: true, force: true });
						return tryAcquireLockDirectory(path);
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

/** One session record by manager id, whether or not its process is still alive. */
export function readSessionRecord(id: string, agentDir: string = getAgentDir()): SessionRecord | undefined {
	try {
		const record = JSON.parse(readFileSync(join(sessionsDir(agentDir), `${basename(id)}.json`), "utf8")) as
			| SessionRecord
			| undefined;
		return record && record.id === id ? record : undefined;
	} catch {
		return undefined;
	}
}

/** True only when the durable lease still names this exact live manager process. */
export function isSessionLeaseAlive(
	lease: { managerId: string; processStartedAt?: string },
	agentDir: string = getAgentDir(),
): boolean {
	const record = readSessionRecord(lease.managerId, agentDir);
	if (!record || !isSessionAlive(record)) return false;
	const expected = lease.processStartedAt ?? record.processStartedAt;
	return expected === undefined || processStartTime(record.pid) === expected;
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

/** Wait without yielding: the sweep runs inside synchronous startup paths. */
function sleepSync(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Whether any process still belongs to this group.
 *
 * `kill(-pgid, 0)` asks the kernel about the whole group, which is the only
 * question worth asking: an ACP bridge routinely outlives the launcher that
 * created the group (`npx` exits, the bridge keeps working), so the group
 * leader's own liveness says nothing about whether work is still running.
 * `undefined` means this platform cannot answer — Windows has no process
 * groups to signal — and callers fall back to the group leader there.
 */
export function isGroupPopulated(pgid: number): boolean | undefined {
	if (!Number.isInteger(pgid) || pgid <= 1) return false;
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		// The group exists and belongs to another user.
		if (code === "EPERM") return true;
		return undefined;
	}
}

/**
 * True once this exact recorded group is gone — never merely "the leader pid is
 * free".
 *
 * Two facts make this decidable. A pgid number cannot be handed to a new
 * process while the group it names still has members (Linux holds the `struct
 * pid`; the BSDs check `pgfind` before reusing a pid), so a live group under a
 * dead leader is still ours. And a live *process* at that number proves the
 * opposite: the number was reissued, which the kernel only allows once our
 * group emptied, so a mismatched leader identity means our group is gone and
 * whatever holds the number now is a stranger.
 */
export function isProcessGroupGone(
	group: SessionWorkerGroup,
	identify: (pid: number) => string | undefined,
	groupPopulated: (pgid: number) => boolean | undefined = isGroupPopulated,
): boolean {
	const { pgid, leaderStartedAt } = group;
	if (!Number.isInteger(pgid) || pgid <= 1) return true;
	const leaderMatches = isAlive(pgid) && identify(pgid) === leaderStartedAt;
	const populated = groupPopulated(pgid);
	// No group signalling here: the recorded leader is the only evidence.
	if (populated === undefined) return !leaderMatches;
	if (!populated) return true;
	// A live group whose number was reissued to an unrelated process is not ours.
	return isAlive(pgid) && !leaderMatches;
}

/**
 * Stop one recorded worker group and report whether its death is proven.
 *
 * The identity check is the whole safety property: a numeric pgid is reused, so
 * a recorded group is only ever signalled while it is still provably the one
 * Neta created — its leader alive under the recorded start time, or the leader
 * gone and the number still held by the group it led.
 */
export function reapProcessGroup(
	group: SessionWorkerGroup,
	identify: (pid: number) => string | undefined,
	warn: (message: string) => void,
	waitMs = 2000,
	groupPopulated: (pgid: number) => boolean | undefined = isGroupPopulated,
): boolean {
	const { pgid, leaderStartedAt } = group;
	if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return true;
	if (isAlive(pgid) && identify(pgid) !== leaderStartedAt) {
		warn(`[neta] stale session skipped process group ${pgid}: group leader identity no longer matches`);
		return true;
	}
	if (isProcessGroupGone(group, identify, groupPopulated)) return true;
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
		const deadline = Date.now() + waitMs / 2;
		while (Date.now() < deadline) {
			if (isProcessGroupGone(group, identify, groupPopulated)) return true;
			sleepSync(25);
		}
	}
	return isProcessGroupGone(group, identify, groupPopulated);
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

function stoppedMarkerPath(id: string, agentDir: string): string {
	return join(sessionsDir(agentDir), "stopped", `${basename(id)}.json`);
}

export function writeStoppedMarker(marker: SessionStoppedMarker, agentDir: string = getAgentDir()): void {
	const path = stoppedMarkerPath(marker.id, agentDir);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify(marker, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function readStoppedMarker(id: string, agentDir: string = getAgentDir()): SessionStoppedMarker | undefined {
	try {
		const marker = JSON.parse(readFileSync(stoppedMarkerPath(id, agentDir), "utf-8")) as SessionStoppedMarker;
		return marker.id === id && typeof marker.processesStopped === "boolean" ? marker : undefined;
	} catch {
		return undefined;
	}
}

export function removeStoppedMarker(id: string, agentDir: string = getAgentDir()): void {
	rmSync(stoppedMarkerPath(id, agentDir), { force: true });
}

/**
 * Reap one manager's residue and report whether every recorded process is
 * provably gone. Used by the stale-session sweep and by `neta resume`, which
 * refuses to hydrate on anything short of proof.
 */
export function reapSessionRecord(
	record: SessionRecord,
	agentDir: string = getAgentDir(),
	options: SessionSweepOptions = {},
): boolean {
	return tearDownSession(
		record,
		agentDir,
		options.processStartTime ?? processStartTime,
		options.warn ?? console.warn,
		options.killMuxSession ?? killMuxSession,
		options.groupPopulated ?? isGroupPopulated,
	);
}

function tearDownSession(
	record: SessionRecord,
	agentDir: string,
	identify: (pid: number) => string | undefined,
	warn: (message: string) => void,
	stopMux: (mux: SessionMux) => void,
	groupPopulated: (pgid: number) => boolean | undefined,
): boolean {
	if (record.mux) stopMux(record.mux);
	let processesStopped = !isSessionAlive(record);
	for (const group of Array.isArray(record.workerGroups) ? record.workerGroups : [])
		if (!reapProcessGroup(group, identify, warn, 2000, groupPopulated)) processesStopped = false;
	if (typeof record.socket === "string" && isNetaSocket(record.socket)) rmSync(record.socket, { force: true });
	// Written before the record is deleted: this marker is the only remaining
	// evidence a later `neta resume` has that these processes were reaped.
	writeStoppedMarker(
		{
			id: record.id,
			checkpointId: record.checkpointId,
			at: Date.now(),
			processesStopped,
			processStartedAt: record.processStartedAt,
		},
		agentDir,
	);
	removeSessionRecord(record.id, agentDir);
	return processesStopped;
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
	const groupPopulated = options.groupPopulated ?? isGroupPopulated;
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
		tearDownSession(record, agentDir, identify, warn, stopMux, groupPopulated);
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

/** Live sessions in this exact real directory, newest first, with symlinks resolved on both sides. */
export function findLiveSessionsInDirectory(cwd: string, agentDir: string = getAgentDir()): SessionRecord[] {
	const canonicalCwd = canonicalizeCwd(cwd);
	return readLiveSessions(sessionsDir(agentDir)).filter((record) => {
		try {
			return canonicalizeCwd(record.cwd) === canonicalCwd;
		} catch {
			return false;
		}
	});
}

/** The newest live session in this exact real directory. */
export function findLiveSessionInDirectory(cwd: string, agentDir: string = getAgentDir()): SessionRecord | undefined {
	return findLiveSessionsInDirectory(cwd, agentDir)[0];
}

/**
 * The session a command typed in `cwd` most likely means: one started in this
 * directory, else the most recent one if there is exactly one running.
 */
export function findSession(cwd: string, agentDir: string = getAgentDir()): SessionRecord | undefined {
	const records = listSessions(agentDir);
	return records.find((record) => record.cwd === cwd) ?? (records.length === 1 ? records[0] : undefined);
}
