import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	findSession,
	listSessions,
	removeSessionRecord,
	type SessionRecord,
	sweepStaleSessions,
	writeSessionRecord,
} from "../src/session.ts";
import { waitFor } from "./helpers.ts";

const dirs: string[] = [];
const SIGTERM_IGNORING_CHILD = fileURLToPath(new URL("./fixtures/sigterm-ignoring-child.mjs", import.meta.url));

function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "neta-registry-"));
	dirs.push(dir);
	return dir;
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
	return {
		id: "s1",
		socket: "/tmp/neta-s1.sock",
		token: "tok",
		cwd: "/repo",
		leader: "claude",
		pid: process.pid,
		startedAt: 1,
		...overrides,
	};
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session registry", () => {
	it("round-trips a session and then removes it", () => {
		const dir = agentDir();

		writeSessionRecord(record(), dir);
		expect(listSessions(dir).map((entry) => entry.id)).toEqual(["s1"]);

		removeSessionRecord("s1", dir);
		expect(listSessions(dir)).toEqual([]);
	});

	// The file carries a token that authorizes managing workers.
	it("keeps the record readable only by its owner", () => {
		const dir = agentDir();
		const path = writeSessionRecord(record(), dir);

		expect(statSync(path).mode & 0o077).toBe(0);
		expect(JSON.parse(readFileSync(path, "utf-8")).token).toBe("tok");
	});

	// A crashed leader leaves its file behind; a stale socket path must never be
	// handed to someone typing `neta workers`.
	it("drops records whose process is gone", () => {
		const dir = agentDir();
		writeSessionRecord(record({ id: "dead", pid: 2147483646 }), dir);

		expect(listSessions(dir)).toEqual([]);
	});

	it("reaps recorded worker groups and socket residue from a dead manager", async () => {
		const dir = agentDir();
		const socket = join(tmpdir(), `neta-stale-${process.pid}-${Date.now()}.sock`);
		const worker = spawn(process.execPath, [SIGTERM_IGNORING_CHILD], { detached: true, stdio: "ignore" });
		const pgid = worker.pid;
		if (pgid === undefined) throw new Error("Could not start worker fixture.");
		worker.unref();
		writeFileSync(socket, "stale");
		writeSessionRecord(record({ id: "dead", pid: 2147483646, socket, workerPgids: [pgid] }), dir);

		try {
			sweepStaleSessions(dir);
			expect(existsSync(join(dir, "sessions", "dead.json"))).toBe(false);
			expect(existsSync(socket)).toBe(false);
			await waitFor(() => expect(() => process.kill(pgid, 0)).toThrow(), 5000);
		} finally {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				// The sweep already killed the detached group.
			}
		}
	});

	it("never reaps a worker group while its manager is alive", () => {
		const dir = agentDir();
		const socket = join(tmpdir(), `neta-live-${process.pid}-${Date.now()}.sock`);
		const worker = spawn(process.execPath, [SIGTERM_IGNORING_CHILD], { detached: true, stdio: "ignore" });
		const pgid = worker.pid;
		if (pgid === undefined) throw new Error("Could not start worker fixture.");
		worker.unref();
		writeFileSync(socket, "live");
		writeSessionRecord(record({ id: "live", pid: process.pid, socket, workerPgids: [pgid] }), dir);

		try {
			sweepStaleSessions(dir);
			expect(existsSync(join(dir, "sessions", "live.json"))).toBe(true);
			expect(existsSync(socket)).toBe(true);
			expect(() => process.kill(pgid, 0)).not.toThrow();
		} finally {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				// The fixture has already exited.
			}
		}
	});

	it("ignores a corrupt record instead of failing the command", () => {
		const dir = agentDir();
		writeSessionRecord(record(), dir);
		writeFileSync(join(dir, "sessions", "broken.json"), "{ not json");

		expect(listSessions(dir).map((entry) => entry.id)).toEqual(["s1"]);
	});

	it("returns nothing when no session has ever run", () => {
		expect(listSessions(agentDir())).toEqual([]);
	});

	describe("finding the session a command means", () => {
		it("prefers one started in this directory", () => {
			const dir = agentDir();
			writeSessionRecord(record({ id: "other", cwd: "/elsewhere", startedAt: 2 }), dir);
			writeSessionRecord(record({ id: "here", cwd: "/repo", startedAt: 1 }), dir);

			expect(findSession("/repo", dir)?.id).toBe("here");
		});

		it("falls back to the only running session", () => {
			const dir = agentDir();
			writeSessionRecord(record({ id: "only", cwd: "/elsewhere" }), dir);

			expect(findSession("/repo", dir)?.id).toBe("only");
		});

		// Guessing between two unrelated sessions would send commands to the wrong
		// leader, so it declines instead.
		it("refuses to guess between several unrelated sessions", () => {
			const dir = agentDir();
			writeSessionRecord(record({ id: "a", cwd: "/a" }), dir);
			writeSessionRecord(record({ id: "b", cwd: "/b" }), dir);

			expect(findSession("/repo", dir)).toBeUndefined();
		});
	});
});
