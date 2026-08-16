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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "./config.ts";

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
	/** Detached ACP process groups still owned by this manager. */
	workerGroups?: SessionWorkerGroup[];
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
}

function sessionsDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "sessions");
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

/** Remove crash residue, but never touch a session whose manager is still alive. */
export function sweepStaleSessions(agentDir: string = getAgentDir(), options: SessionSweepOptions = {}): void {
	const identify = options.processStartTime ?? processStartTime;
	const warn = options.warn ?? console.warn;
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
		if (isAlive(record.pid)) continue;
		for (const group of Array.isArray(record.workerGroups) ? record.workerGroups : [])
			reapProcessGroup(group, identify, warn);
		if (typeof record.socket === "string" && isNetaSocket(record.socket)) rmSync(record.socket, { force: true });
		rmSync(path, { force: true });
	}
}

/** Live sessions, newest first. Records whose process is gone are deleted. */
export function listSessions(agentDir: string = getAgentDir()): SessionRecord[] {
	const dir = sessionsDir(agentDir);
	sweepStaleSessions(agentDir);
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
		if (!isAlive(record.pid)) continue;
		records.push(record);
	}
	return records.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * The session a command typed in `cwd` most likely means: one started in this
 * directory, else the most recent one if there is exactly one running.
 */
export function findSession(cwd: string, agentDir: string = getAgentDir()): SessionRecord | undefined {
	const records = listSessions(agentDir);
	return records.find((record) => record.cwd === cwd) ?? (records.length === 1 ? records[0] : undefined);
}
