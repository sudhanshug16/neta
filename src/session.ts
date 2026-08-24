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
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "./config.ts";
import { killSessionSpec } from "./mux/index.ts";
import {
	assertOwnedDirectoryHeld,
	type OwnedDirectoryLease,
	processStartIdentity,
	releaseOwnedDirectory,
	tryAcquireOwnedDirectory,
} from "./ownership.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Keep session/checkpoint path components to 128 ASCII bytes, below 255-byte filesystem limits. */
export const MAX_CANONICAL_SESSION_ID_LENGTH = 128;
declare const checkpointClaimBrand: unique symbol;

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

export type SessionLock = OwnedDirectoryLease;

export interface CheckpointClaim extends SessionLock {
	readonly kind: "checkpoint-claim";
	readonly id: string;
	readonly agentDir: string;
	readonly inode: { readonly dev: number; readonly ino: number };
	readonly owner: { readonly pid: number; readonly startedAt?: string };
	readonly [checkpointClaimBrand]: true;
}

export class SessionIdError extends Error {}

/** The only ids that may become session-owned path components. */
export function assertCanonicalSessionId(id: string, label = "session id"): void {
	if (typeof id !== "string" || id.length > MAX_CANONICAL_SESSION_ID_LENGTH || !SESSION_ID_PATTERN.test(id))
		throw new SessionIdError(`Invalid ${label} "${String(id)}".`);
}

function canonicalAgentDir(agentDir: string): string {
	const supplied = lstatSync(agentDir);
	if (supplied.isSymbolicLink())
		throw new Error(`The Neta directory is a symlink, not a canonical directory: ${agentDir}.`);
	const canonical = realpathSync(agentDir);
	const stat = lstatSync(canonical);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error(`The Neta directory is not a safe directory: ${canonical}.`);
	return canonical;
}

function checkpointClaimPath(id: string, agentDir: string): string {
	assertCanonicalSessionId(id, "checkpoint id");
	return join(agentDir, "sessions", "claims", id);
}

/** Fail closed if a caller's ownership proof was replaced or released. */
export function assertSessionLockHeld(lock: SessionLock): void {
	try {
		assertOwnedDirectoryHeld(lock);
	} catch {
		throw new Error(`Session lock is no longer held: ${lock.path}.`);
	}
}

/** Identity captured when a detached ACP group is created, before crash recovery can ever reap it. */
export interface SessionWorkerGroup {
	pgid: number;
	/** The process id saved for the group leader; `pgid` is retained for old records. */
	leaderPid?: number;
	/** `ps lstart` for the group leader; absence is retained as uncertainty and never treated as death. */
	leaderStartedAt?: string;
	/** Individual owned processes available to the unsupported-group fallback. */
	ownedProcesses?: SessionProcessIdentity[];
}

export interface SessionProcessIdentity {
	pid: number;
	startedAt?: string;
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
	/** Saved manager pid and worker identities for a fresh proof after ambiguity. */
	pid?: number;
	workerGroups?: SessionWorkerGroup[];
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
export function tryAcquireCheckpointClaim(id: string, agentDir: string = getAgentDir()): CheckpointClaim | undefined {
	// This check must precede even agent-dir canonicalization and parent creation:
	// malformed input is not allowed to inspect, reclaim, or create any session
	// state. In particular, basename() is never a validation boundary.
	assertCanonicalSessionId(id, "checkpoint id");
	const canonical = canonicalAgentDir(agentDir);
	const path = checkpointClaimPath(id, canonical);
	const lock = tryAcquireLockDirectory(path);
	if (!lock) return undefined;
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error(`Checkpoint claim is not a safe directory: ${path}.`);
		const owner = lock.owner;
		if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || typeof owner.token !== "string")
			throw new Error(`Checkpoint claim owner is malformed: ${path}.`);
		return Object.freeze({
			...lock,
			kind: "checkpoint-claim" as const,
			id,
			agentDir: canonical,
			inode: { dev: stat.dev, ino: stat.ino },
			owner: {
				pid: owner.pid,
				...(typeof owner.startedAt === "string" ? { startedAt: owner.startedAt } : {}),
			},
		}) as CheckpointClaim;
	} catch (error) {
		releaseSessionLock(lock);
		throw error;
	}
}

/** Validate the exact capability and prove that its directory still belongs to its owner. */
export function assertCheckpointClaimHeld(claim: CheckpointClaim, id: string, agentDir: string): void {
	assertCanonicalSessionId(id, "checkpoint id");
	if (
		!claim ||
		claim.kind !== "checkpoint-claim" ||
		claim.id !== id ||
		typeof claim.agentDir !== "string" ||
		typeof claim.path !== "string" ||
		typeof claim.token !== "string" ||
		!claim.inode ||
		typeof claim.inode.dev !== "number" ||
		typeof claim.inode.ino !== "number" ||
		!claim.owner ||
		typeof claim.owner.pid !== "number"
	) {
		throw new Error(`Invalid checkpoint claim for "${id}".`);
	}
	const canonical = canonicalAgentDir(agentDir);
	const expectedPath = checkpointClaimPath(id, canonical);
	if (claim.agentDir !== canonical || claim.path !== expectedPath)
		throw new Error(`Checkpoint claim does not authorize "${id}" in ${canonical}.`);
	try {
		assertOwnedDirectoryHeld(claim);
	} catch {
		throw new Error(`Checkpoint claim is no longer held for "${id}".`);
	}
}

function tryAcquireLockDirectory(path: string): SessionLock | undefined {
	return tryAcquireOwnedDirectory(path, { processStartTime: processStartIdentity }) as SessionLock | undefined;
}

/** Release only the lock created by this launch or its control-plane child. */
export function releaseSessionLock(lock: SessionLock | { path: string; token: string } | undefined): void {
	if (!lock) return;
	if ("inode" in lock && "owner" in lock) {
		releaseOwnedDirectory(lock);
		return;
	}
	try {
		const stat = lstatSync(lock.path);
		const owner = JSON.parse(readFileSync(join(lock.path, "owner.json"), "utf8")) as {
			pid?: unknown;
			startedAt?: unknown;
			token?: unknown;
		};
		if (!stat.isDirectory() || stat.isSymbolicLink() || owner.token !== lock.token || typeof owner.pid !== "number")
			return;
		releaseOwnedDirectory({
			path: lock.path,
			token: lock.token,
			inode: { dev: Number(stat.dev), ino: Number(stat.ino) },
			owner: { pid: owner.pid, ...(typeof owner.startedAt === "string" ? { startedAt: owner.startedAt } : {}) },
		});
	} catch {
		// The lock is already gone or its proof is no longer readable.
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
		assertCanonicalSessionId(id, "session id");
		const record = JSON.parse(readFileSync(join(sessionsDir(agentDir), `${id}.json`), "utf8")) as
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
 * The only positive proof is that the kernel reports the recorded group empty.
 * A live group with a dead, unidentifiable, or mismatched leader is retained as
 * uncertain: recovery must not hydrate a replacement while it may still own
 * repository-writing descendants.
 */
export function isProcessGroupGone(
	group: SessionWorkerGroup,
	_identify: (pid: number) => string | undefined,
	groupPopulated: (pgid: number) => boolean | undefined = isGroupPopulated,
): boolean {
	const { pgid } = group;
	if (!Number.isInteger(pgid) || pgid <= 1) return false;
	const populated = groupPopulated(pgid);
	if (populated === undefined) return unsupportedProcessGroupGone(group, _identify);
	// An empty group is proof of death. A live or unobservable group is not gone,
	// even when its leader identity is missing or belongs to a replacement.
	return populated === false;
}

type ProcessObservation = "dead" | "owned" | "reused" | "unknown";

function observeProcess(
	identity: SessionProcessIdentity,
	identify: (pid: number) => string | undefined,
): ProcessObservation {
	if (!Number.isInteger(identity.pid) || identity.pid <= 1) return "unknown";
	if (identity.startedAt !== undefined && typeof identity.startedAt !== "string") return "unknown";
	if (!isAlive(identity.pid)) return "dead";
	const actual = identify(identity.pid);
	if (actual === undefined) return "unknown";
	if (identity.startedAt === undefined || actual !== identity.startedAt) return "reused";
	return "owned";
}

/**
 * Windows and other platforms may not implement a meaningful negative-pid
 * process-group probe. In that case only exact saved process identities count:
 * an unavailable identity is unknown, never evidence of death, and no signal is
 * sent because there is no ownership proof for a group-wide operation.
 */
function unsupportedProcessGroupGone(
	group: SessionWorkerGroup,
	identify: (pid: number) => string | undefined,
): boolean {
	const leader: SessionProcessIdentity = {
		pid: group.leaderPid ?? group.pgid,
		...(group.leaderStartedAt ? { startedAt: group.leaderStartedAt } : {}),
	};
	const identities = [leader, ...(group.ownedProcesses ?? [])];
	return identities.every((identity) => observeProcess(identity, identify) === "dead");
}

function ownsLiveProcessGroup(
	group: SessionWorkerGroup,
	identify: (pid: number) => string | undefined,
	groupPopulated: (pgid: number) => boolean | undefined,
): boolean {
	if (groupPopulated(group.pgid) !== true || !isAlive(group.pgid) || !group.leaderStartedAt) return false;
	return identify(group.pgid) === group.leaderStartedAt;
}

/**
 * Stop one recorded worker group and report whether its death is proven.
 *
 * A numeric pgid is reused, so a recorded group is only ever signalled while
 * the live group leader has the exact recorded start identity. If that proof is
 * unavailable, cleanup stops and recovery remains refused.
 */
export function reapProcessGroup(
	group: SessionWorkerGroup,
	identify: (pid: number) => string | undefined,
	warn: (message: string) => void,
	waitMs = 2000,
	groupPopulated: (pgid: number) => boolean | undefined = isGroupPopulated,
): boolean {
	const { pgid } = group;
	if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) {
		warn(`[neta] stale session skipped invalid process group ${pgid}`);
		return false;
	}
	if (groupPopulated(pgid) === undefined) {
		if (isProcessGroupGone(group, identify, groupPopulated)) return true;
		warn(
			`[neta] stale session skipped process group ${pgid}: this platform cannot prove every owned process is stopped`,
		);
		return false;
	}
	if (isProcessGroupGone(group, identify, groupPopulated)) return true;
	if (!ownsLiveProcessGroup(group, identify, groupPopulated)) {
		warn(
			`[neta] stale session skipped process group ${pgid}: live group identity is unavailable or no longer matches`,
		);
		return false;
	}
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		if (isProcessGroupGone(group, identify, groupPopulated)) return true;
		if (!ownsLiveProcessGroup(group, identify, groupPopulated)) {
			warn(
				`[neta] stale session stopped signaling process group ${pgid}: live group identity is unavailable or no longer matches`,
			);
			return false;
		}
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
			if (!ownsLiveProcessGroup(group, identify, groupPopulated)) return false;
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
	assertCanonicalSessionId(id, "session id");
	return join(sessionsDir(agentDir), "stopped", `${id}.json`);
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
			pid: record.pid,
			workerGroups: record.workerGroups,
		},
		agentDir,
	);
	removeSessionRecord(record.id, agentDir);
	return processesStopped;
}

export function writeSessionRecord(record: SessionRecord, agentDir: string = getAgentDir()): string {
	assertCanonicalSessionId(record.id, "session id");
	const dir = sessionsDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${record.id}.json`);
	writeFileSync(path, JSON.stringify(record, null, 2), { encoding: "utf-8", mode: 0o600 });
	return path;
}

export function removeSessionRecord(id: string, agentDir: string = getAgentDir()): void {
	assertCanonicalSessionId(id, "session id");
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
