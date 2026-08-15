import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findSession,
	listSessions,
	removeSessionRecord,
	type SessionRecord,
	writeSessionRecord,
} from "../src/session.ts";

const dirs: string[] = [];

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
