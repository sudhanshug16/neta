/**
 * The session registry.
 *
 * A leader session exists only while its control plane process is alive, but a
 * person in another terminal still wants `neta workers` to work. So the control
 * plane drops a small file in `~/.neta/sessions/` describing how to reach it,
 * and removes it on the way out. Stale files (process gone) are ignored and
 * cleaned up on the next read.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
}

function sessionsDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "sessions");
}

function isAlive(pid: number): boolean {
	try {
		// Signal 0 checks for existence without touching the process.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
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

/** Live sessions, newest first. Records whose process is gone are deleted. */
export function listSessions(agentDir: string = getAgentDir()): SessionRecord[] {
	const dir = sessionsDir(agentDir);
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
		if (!record.pid || !isAlive(record.pid)) {
			rmSync(path, { force: true });
			continue;
		}
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
