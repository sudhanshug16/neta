import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	findLiveSessionInDirectory,
	findSession,
	isProcessGroupGone,
	listSessions,
	processStartTime,
	readSessionRecord,
	reapProcessGroup,
	reapSessionRecord,
	releaseSessionLock,
	removeSessionRecord,
	type SessionRecord,
	sweepStaleSessions,
	tryAcquireCheckpointClaim,
	tryAcquireSessionLock,
	writeSessionRecord,
} from "../src/session.ts";
import { processGone, waitFor } from "./helpers.ts";

const dirs: string[] = [];
const SIGTERM_IGNORING_CHILD = fileURLToPath(new URL("./fixtures/sigterm-ignoring-child.mjs", import.meta.url));
const FAKE_LEADER = fileURLToPath(new URL("./fixtures/fake-leader.mjs", import.meta.url));

// Host live tmux E2E is deliberately absent: macOS portable cleanup cannot atomically target stale PIDs/sockets.
// Future live coverage must run inside a disposable process/container namespace.

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
		cwd: process.cwd(),
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

	it("kills a recorded mux session while sweeping a dead manager", () => {
		const dir = agentDir();
		const killed: string[] = [];
		writeSessionRecord(record({ id: "dead-mux", pid: 2147483646, mux: { id: "tmux", name: "neta-dead-mux" } }), dir);

		sweepStaleSessions(dir, { killMuxSession: (mux) => killed.push(`${mux.id}:${mux.name}`) });

		expect(killed).toEqual(["tmux:neta-dead-mux"]);
		expect(existsSync(join(dir, "sessions", "dead-mux.json"))).toBe(false);
	});

	it("reaps recorded worker groups and socket residue from a dead manager", async () => {
		const dir = agentDir();
		const socket = join(tmpdir(), `neta-stale-${process.pid}-${Date.now()}.sock`);
		const worker = spawn(process.execPath, [SIGTERM_IGNORING_CHILD], { detached: true, stdio: "ignore" });
		const pgid = worker.pid;
		if (pgid === undefined) throw new Error("Could not start worker fixture.");
		worker.unref();
		writeFileSync(socket, "stale");
		const leaderStartedAt = "fixture-started-at";
		writeSessionRecord(
			record({ id: "dead", pid: 2147483646, socket, workerGroups: [{ pgid, leaderStartedAt }] }),
			dir,
		);

		try {
			sweepStaleSessions(dir, { processStartTime: () => leaderStartedAt });
			expect(existsSync(join(dir, "sessions", "dead.json"))).toBe(false);
			expect(existsSync(socket)).toBe(false);
			await waitFor(() => processGone(pgid), 5000);
		} finally {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				// The sweep already killed the detached group.
			}
		}
	});

	// The real shape of an ACP worker: `npx` exits the moment it has started the
	// bridge, so the group leader is gone while the process doing the work — and
	// holding write access to the repository — is still running.
	it("does not call a group gone when its leader exited and a child is still running", async () => {
		const dir = agentDir();
		const marker = join(agentDir(), "child.pid");
		// A group leader that starts a child and exits, exactly like a launcher.
		const leader = spawn("/bin/sh", ["-c", `${process.execPath} ${SIGTERM_IGNORING_CHILD} > ${marker} & sleep 0.4`], {
			detached: true,
			stdio: "ignore",
		});
		const pgid = leader.pid;
		if (pgid === undefined) throw new Error("Could not start the group leader fixture.");
		const leaderStartedAt = processStartTime(pgid);
		if (!leaderStartedAt) throw new Error("Could not identify the group leader fixture.");
		const group = { pgid, leaderStartedAt };
		await waitFor(() => readFileSync(marker, "utf-8").includes("ready"), 5000);
		const childPid = Number.parseInt(readFileSync(marker, "utf-8").split(":")[1] ?? "", 10);
		// Wait for the leader itself to be gone, not merely finished.
		await new Promise<void>((resolve) => leader.on("exit", () => resolve()));
		await waitFor(() => processGone(pgid), 5000);

		try {
			expect(isProcessGroupGone(group, processStartTime)).toBe(false);
			expect(() => process.kill(childPid, 0)).not.toThrow();

			// Reaping it must both kill the child and prove it.
			expect(reapProcessGroup(group, processStartTime, () => {})).toBe(true);
			expect(isProcessGroupGone(group, processStartTime)).toBe(true);
			await waitFor(() => processGone(childPid), 5000);

			// And the sweep must refuse to call the session stopped until then.
			writeSessionRecord(record({ id: "orphaned", pid: 2147483646, workerGroups: [group] }), dir);
			const stopped: boolean[] = [];
			stopped.push(
				reapSessionRecord(readSessionRecord("orphaned", dir) as SessionRecord, dir, {
					groupPopulated: () => true,
					processStartTime: () => undefined,
					warn: () => {},
				}),
			);
			expect(stopped).toEqual([false]);
		} finally {
			for (const pid of [childPid, pgid]) {
				try {
					if (Number.isInteger(pid)) process.kill(-pid, "SIGKILL");
				} catch {
					// Already gone, which is the point of the test.
				}
			}
		}
	});

	it("never kills a live process whose reused PGID has a different identity", () => {
		const dir = agentDir();
		const worker = spawn(process.execPath, [SIGTERM_IGNORING_CHILD], { detached: true, stdio: "ignore" });
		const pgid = worker.pid;
		if (pgid === undefined) throw new Error("Could not start worker fixture.");
		worker.unref();
		writeSessionRecord(
			record({
				id: "reused-pgid",
				pid: 2147483646,
				workerGroups: [{ pgid, leaderStartedAt: "Thu Jan  1 00:00:00 1970" }],
			}),
			dir,
		);

		try {
			sweepStaleSessions(dir, { processStartTime: () => "different-process", warn: () => {} });
			expect(() => process.kill(pgid, 0)).not.toThrow();
			expect(existsSync(join(dir, "sessions", "reused-pgid.json"))).toBe(false);
		} finally {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				// The fixture has already exited.
			}
		}
	});

	it("never reaps a worker group while its manager is alive", async () => {
		const dir = agentDir();
		const socket = join(tmpdir(), `neta-live-${process.pid}-${Date.now()}.sock`);
		const worker = spawn(process.execPath, [SIGTERM_IGNORING_CHILD], { detached: true, stdio: "ignore" });
		const pgid = worker.pid;
		if (pgid === undefined) throw new Error("Could not start worker fixture.");
		worker.unref();
		writeFileSync(socket, "live");
		const leaderStartedAt = "fixture-started-at";
		writeSessionRecord(
			record({ id: "live", pid: process.pid, socket, workerGroups: [{ pgid, leaderStartedAt }] }),
			dir,
		);

		const killed: string[] = [];
		writeSessionRecord(record({ id: "live-mux", pid: process.pid, mux: { id: "tmux", name: "neta-live" } }), dir);
		try {
			sweepStaleSessions(dir, { killMuxSession: (mux) => killed.push(mux.name) });
			expect(existsSync(join(dir, "sessions", "live.json"))).toBe(true);
			expect(existsSync(join(dir, "sessions", "live-mux.json"))).toBe(true);
			expect(existsSync(socket)).toBe(true);
			expect(() => process.kill(pgid, 0)).not.toThrow();
			expect(killed).toEqual([]);
		} finally {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				// The fixture has already exited.
			}
		}
	});

	it("terminates a live manager and removes its session when its directory was deleted", async () => {
		const dir = agentDir();
		const workspace = mkdtempSync(join(tmpdir(), "neta-deleted-worktree-"));
		const manager = spawn(process.execPath, [FAKE_LEADER], {
			env: { ...process.env, FAKE_LEADER_HOLD_MS: "30000" },
			stdio: "ignore",
		});
		if (manager.pid === undefined) throw new Error("Could not start manager fixture.");
		writeSessionRecord(
			record({ id: "deleted-worktree", cwd: workspace, pid: manager.pid, mux: { id: "tmux", name: "deleted" } }),
			dir,
		);
		rmSync(workspace, { recursive: true, force: true });
		const killed: string[] = [];
		try {
			sweepStaleSessions(dir, { killMuxSession: (mux) => killed.push(mux.name) });
			expect(existsSync(join(dir, "sessions", "deleted-worktree.json"))).toBe(false);
			expect(killed).toEqual(["deleted"]);
			await waitFor(() => processGone(manager.pid as number), 5000);
		} finally {
			manager.kill("SIGKILL");
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

	it("matches live sessions through a symlink only after realpath canonicalization", () => {
		const dir = agentDir();
		const workspace = mkdtempSync(join(tmpdir(), "neta-canonical-workspace-"));
		dirs.push(workspace);
		const link = join(tmpdir(), `neta-canonical-link-${process.pid}-${Date.now()}`);
		try {
			symlinkSync(workspace, link);
			writeSessionRecord(record({ cwd: workspace }), dir);
			expect(findLiveSessionInDirectory(link, dir)?.id).toBe("s1");
		} finally {
			rmSync(link, { force: true });
		}
	});

	it("holds one atomic launch lock per canonical directory", () => {
		const dir = agentDir();
		const workspace = mkdtempSync(join(tmpdir(), "neta-lock-workspace-"));
		dirs.push(workspace);
		const first = tryAcquireSessionLock(workspace, dir);
		try {
			expect(first).toBeDefined();
			expect(tryAcquireSessionLock(workspace, dir)).toBeUndefined();
		} finally {
			releaseSessionLock(first);
		}
		expect(tryAcquireSessionLock(workspace, dir)).toBeDefined();
	});

	it("rejects malformed checkpoint ids before touching the populated sessions directory", () => {
		const dir = agentDir();
		const claim = tryAcquireCheckpointClaim("valid-id", dir);
		if (!claim) throw new Error("expected the valid checkpoint claim");
		const before = readdirSync(join(dir, "sessions", "claims", "valid-id")).map((entry) => [
			entry,
			readFileSync(join(dir, "sessions", "claims", "valid-id", entry)),
		]);
		for (const id of ["..", ".", "/", "a/b", join(tmpdir(), "absolute"), "", " ", "%2e%2e", "a\\b", "a∕b"])
			expect(() => tryAcquireCheckpointClaim(id, dir)).toThrow();
		expect(
			readdirSync(join(dir, "sessions", "claims", "valid-id")).map((entry) => [
				entry,
				readFileSync(join(dir, "sessions", "claims", "valid-id", entry)),
			]),
		).toEqual(before);
		releaseSessionLock(claim);
	});

	describe("finding the session a command means", () => {
		it("prefers one started in this directory", () => {
			const dir = agentDir();
			const other = mkdtempSync(join(tmpdir(), "neta-other-directory-"));
			dirs.push(other);
			writeSessionRecord(record({ id: "other", cwd: other, startedAt: 2 }), dir);
			writeSessionRecord(record({ id: "here", cwd: process.cwd(), startedAt: 1 }), dir);

			expect(findSession(process.cwd(), dir)?.id).toBe("here");
		});

		it("falls back to the only running session", () => {
			const dir = agentDir();
			const other = mkdtempSync(join(tmpdir(), "neta-only-directory-"));
			dirs.push(other);
			writeSessionRecord(record({ id: "only", cwd: other }), dir);

			expect(findSession(process.cwd(), dir)?.id).toBe("only");
		});

		// Guessing between two unrelated sessions would send commands to the wrong
		// leader, so it declines instead.
		it("refuses to guess between several unrelated sessions", () => {
			const dir = agentDir();
			const first = mkdtempSync(join(tmpdir(), "neta-first-directory-"));
			const second = mkdtempSync(join(tmpdir(), "neta-second-directory-"));
			dirs.push(first, second);
			writeSessionRecord(record({ id: "a", cwd: first }), dir);
			writeSessionRecord(record({ id: "b", cwd: second }), dir);

			expect(findSession(process.cwd(), dir)).toBeUndefined();
		});
	});
});
