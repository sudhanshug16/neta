/**
 * Closing a session and reopening it, with nothing stubbed but the model.
 *
 * The fake vendor CLI does what a real one does around resume: it starts Neta's
 * control plane from the MCP config it was given, runs the Codex session-start
 * hook it was configured with, and exits when the user quits. So these tests
 * exercise the whole chain — launcher, vendor, control plane, checkpoint,
 * recovery barrier — without a provider call.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFile, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SessionCheckpoint } from "../src/checkpoint.ts";
import { VERSION } from "../src/config.ts";
import type { SessionRecord } from "../src/session.ts";
import { waitFor } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FAKE_LEADER = fileURLToPath(new URL("./fixtures/fake-leader.mjs", import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const run = promisify(execFile);

const dirs: string[] = [];

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function fakeBackend(name: string): string {
	const dir = scratch(`neta-bin-${name}-`);
	writeFileSync(join(dir, name), `#!/bin/sh\nexec ${process.execPath} ${FAKE_LEADER} "$@"\n`, "utf-8");
	chmodSync(join(dir, name), 0o755);
	return dir;
}

function writeSettings(agentDir: string): void {
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			mux: { panes: false },
			tiers: { expert: { backend: "fake" }, architect: { backend: "fake" } },
			backends: { fake: { command: process.execPath, args: [FAKE_AGENT] } },
		}),
	);
}

interface LaunchRecord {
	argv: string[];
	files: Record<string, string>;
	env: Record<string, string | null>;
}

interface RunningLeader {
	quit: () => Promise<{ code: number; stderr: string }>;
	stderr: () => string;
}

function startLeader(
	backend: string,
	cwd: string,
	env: Record<string, string>,
	args: string[] = ["--leader", backend, "--mux", "none"],
): RunningLeader {
	const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stdout.on("data", () => {});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const closed = new Promise<{ code: number; stderr: string }>((resolve) =>
		child.on("close", (code, signal) => resolve({ code: signal ? 1 : (code ?? 0), stderr })),
	);
	return {
		stderr: () => stderr,
		quit: async () => {
			writeFileSync(env.FAKE_LEADER_QUIT_FILE, "quit");
			return closed;
		},
	};
}

function leaderEnv(options: {
	binDir: string;
	agentDir: string;
	record: string;
	quitFile: string;
	codexHome?: string;
	mcpCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}): Record<string, string> {
	const callsFile = options.mcpCalls ? join(scratch("neta-mcp-calls-"), "calls.json") : undefined;
	const resultFile = options.mcpCalls ? join(scratch("neta-mcp-results-"), "results.json") : undefined;
	if (callsFile) writeFileSync(callsFile, JSON.stringify(options.mcpCalls), "utf-8");
	return {
		...process.env,
		PATH: `${options.binDir}${delimiter}${process.env.PATH}`,
		NETA_DIR: options.agentDir,
		NETA_SOCKET: "",
		NETA_LEADER_TOKEN: "",
		NETA_WORKER_ID: "",
		NETA_WORKER_TOKEN: "",
		FAKE_LEADER_RECORD: options.record,
		FAKE_LEADER_QUIT_FILE: options.quitFile,
		FAKE_LEADER_HOST_MCP: "1",
		CODEX_HOME: options.codexHome ?? join(options.agentDir, "real-codex"),
		...(callsFile ? { FAKE_LEADER_MCP_CALLS: callsFile, FAKE_LEADER_MCP_RESULT: resultFile as string } : {}),
	} as Record<string, string>;
}

/** Every running manager, ignoring the crashed records a resume has yet to sweep. */
function liveSessionsIn(agentDir: string, exclude?: string): SessionRecord[] {
	const dir = join(agentDir, "sessions");
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as SessionRecord)
		.filter((record) => record.id !== exclude && isAlive(record.pid))
		.sort((left, right) => left.startedAt - right.startedAt);
}

/** The one running manager, where a test expects exactly one. */
function liveSession(agentDir: string, exclude?: string): SessionRecord {
	const records = liveSessionsIn(agentDir, exclude);
	if (records.length !== 1) throw new Error(`expected one live session, found ${records.length}`);
	return records[0];
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readCheckpointFile(agentDir: string, id: string): SessionCheckpoint {
	return JSON.parse(readFileSync(join(agentDir, "checkpoints", `${id}.json`), "utf8")) as SessionCheckpoint;
}

function neta(
	args: string[],
	agentDir: string,
	cwd: string,
	environment: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
	return run(process.execPath, [CLI, ...args], {
		cwd,
		env: {
			...process.env,
			...environment,
			NETA_DIR: agentDir,
			NETA_SOCKET: "",
			NETA_LEADER_TOKEN: "",
			NETA_WORKER_ID: "",
			NETA_WORKER_TOKEN: "",
		},
	}) as Promise<{ stdout: string; stderr: string }>;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("closing and reopening a session", () => {
	it("gives Claude Code an exact id, then resumes that exact conversation on the current build", async () => {
		const binDir = fakeBackend("claude");
		const agentDir = scratch("neta-resume-home-");
		const repo = scratch("neta-resume-repo-");
		writeSettings(agentDir);
		const firstRecord = join(scratch("neta-record-"), "first.json");
		const env = leaderEnv({
			binDir,
			agentDir,
			record: firstRecord,
			quitFile: join(scratch("neta-quit-"), "quit"),
			mcpCalls: [
				{
					name: "neta_delegate",
					arguments: {
						team: "review",
						workers: [
							{ role: "scout", tier: "expert", name: "auth", task: "WAIT_FOR_NOTICE SUBSTANTIVE_HANDOFF" },
							{ role: "worker", tier: "expert", writer: true, task: "config work" },
						],
					},
				},
			],
		});

		const leader = startLeader("claude", repo, env);
		await waitFor(() => expect(existsSync(join(agentDir, "sessions"))).toBe(true), 20000);
		await waitFor(() => void liveSession(agentDir), 20000);
		const session = liveSession(agentDir);
		const checkpointId = session.checkpointId as string;

		const first = JSON.parse(readFileSync(firstRecord, "utf8")) as LaunchRecord;
		const conversationId = first.argv[first.argv.indexOf("--session-id") + 1];
		expect(conversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(first.argv).not.toContain("--resume");
		expect(first.env.NETA_RESUME).toBe(null);

		// Real worker state to carry across the restart, including the automatic
		// writer notice that must not overwrite the reader's substantive handoff.
		await neta(["wait", "ro1", "rw2", "--timeout", "30", "--session", session.id], agentDir, repo);
		const beforeClose = readCheckpointFile(agentDir, checkpointId);
		expect(beforeClose.leader.vendorConversationId).toBe(conversationId);
		expect(beforeClose.liveLease?.managerId).toBe(session.id);

		const exit = await leader.quit();
		expect(exit.code).toBe(0);

		// A graceful close proves its own processes stopped, and retires the lease.
		const closed = readCheckpointFile(agentDir, checkpointId);
		expect(closed.shutdown).toMatchObject({ processesStopped: true, by: "graceful" });
		expect(closed.liveLease).toBeUndefined();
		expect(closed.workers[0]).toMatchObject({ id: "ro1", state: "done", room: "review" });
		expect(closed.workers[0].finalResult).toContain("Substantive report");
		expect(closed.rooms.map((room) => room.name)).toEqual(["review"]);
		expect(closed.workers.map((worker) => worker.id)).toEqual(["ro1", "rw2"]);
		expect(closed.counter).toBe(2);

		const listed = await neta(["sessions", "--all"], agentDir, repo);
		expect(listed.stdout).toContain(checkpointId);
		expect(listed.stdout).toContain("closed");
		expect(listed.stdout).toContain("conversation-id:yes");
		expect(listed.stdout).toContain(`neta resume ${checkpointId}`);

		// Pretend the checkpoint was written by an older Neta, as an upgrade would.
		writeFileSync(
			join(agentDir, "checkpoints", `${checkpointId}.json`),
			JSON.stringify({ ...closed, appVersion: "0.0.1-old" }, null, 2),
		);

		const secondRecord = join(scratch("neta-record-"), "second.json");
		const resumeEnv = leaderEnv({
			binDir,
			agentDir,
			record: secondRecord,
			quitFile: join(scratch("neta-quit-"), "quit"),
		});
		const resumed = startLeader("claude", repo, resumeEnv, ["resume", checkpointId, "--mux", "none"]);
		await waitFor(() => void liveSession(agentDir), 20000);
		const resumedSession = liveSession(agentDir);

		const second = JSON.parse(readFileSync(secondRecord, "utf8")) as LaunchRecord;
		expect(second.argv.slice(0, 2)).toEqual(["--resume", conversationId]);
		expect(second.argv).not.toContain("--session-id");
		expect(second.argv).not.toContain("--continue");
		expect(second.env.NETA_RESUME).toBe("1");
		// Same conversation and same logical session; everything runtime is new.
		expect(second.env.NETA_CHECKPOINT_ID).toBe(checkpointId);
		expect(resumedSession.id).not.toBe(session.id);
		expect(resumedSession.socket).not.toBe(session.socket);
		expect(resumedSession.token).not.toBe(session.token);
		// The rebuilt prompt carries the recovered state, not the old one.
		const prompt = second.argv[second.argv.indexOf("--append-system-prompt") + 1];
		expect(prompt).toContain("## Recovered session");
		expect(prompt).toContain(checkpointId);
		expect(prompt).toContain("0.0.1-old");
		expect(prompt).toContain("No worker was restarted");
		expect(prompt).toContain("neta_status");

		const status = await neta(["status", "--session", resumedSession.id], agentDir, repo);
		expect(status.stdout).toContain("ro1");
		// The substantive handoff survives both the automatic writer notice and the
		// restart, and comes back from wait and workers without draining the log.
		const waited = await neta(["wait", "ro1", "--timeout", "10", "--session", resumedSession.id], agentDir, repo);
		expect(waited.stdout).toContain("Substantive report");
		const workers = await neta(["workers", "--session", resumedSession.id], agentDir, repo);
		expect(workers.stdout).toContain("Substantive report");

		await resumed.quit();
		const after = readCheckpointFile(agentDir, checkpointId);
		expect(after.appVersion).toBe(VERSION);
		expect(after.id).toBe(checkpointId);
		expect(after.leader.vendorConversationId).toBe(conversationId);
		expect(after.workers.find((worker) => worker.id === "ro1")?.finalResult).toContain("Substantive report");
	}, 90000);

	it("captures Codex's own id through its session-start hook and resumes from a stable Codex home", async () => {
		const binDir = fakeBackend("codex");
		const agentDir = scratch("neta-resume-home-");
		const repo = scratch("neta-resume-repo-");
		writeSettings(agentDir);
		const realCodexHome = scratch("neta-codex-home-");
		writeFileSync(join(realCodexHome, "auth.json"), '{"token":"real-secret"}');
		writeFileSync(join(realCodexHome, "AGENTS.md"), "user codex instructions");
		const firstRecord = join(scratch("neta-record-"), "first.json");
		const env = leaderEnv({
			binDir,
			agentDir,
			record: firstRecord,
			quitFile: join(scratch("neta-quit-"), "quit"),
			codexHome: realCodexHome,
			mcpCalls: [
				{
					name: "neta_delegate",
					arguments: { workers: [{ role: "scout", tier: "expert", name: "codex scout", task: "hello" }] },
				},
			],
		});

		const leader = startLeader("codex", repo, env);
		await waitFor(() => void liveSession(agentDir), 20000);
		const session = liveSession(agentDir);
		const checkpointId = session.checkpointId as string;
		const first = JSON.parse(readFileSync(firstRecord, "utf8")) as LaunchRecord;

		// The overlay is Neta's own, outside any temporary directory.
		const overlay = join(agentDir, "leader-sessions", checkpointId, "codex-home");
		expect(first.env.CODEX_HOME).toBe(overlay);
		expect(statSync(join(agentDir, "leader-sessions", checkpointId)).mode & 0o777).toBe(0o700);
		expect(readFileSync(join(overlay, "AGENTS.md"), "utf8")).toContain("user codex instructions");
		// Credentials stay linked, never copied.
		expect(statSync(join(overlay, "auth.json")).isFile()).toBe(true);
		expect(readFileSync(join(overlay, "auth.json"), "utf8")).toContain("real-secret");
		expect(readdirSync(overlay)).toContain("hooks.json");

		// The hook the fixture ran wrote the exact conversation id.
		await waitFor(
			() => expect(readCheckpointFile(agentDir, checkpointId).leader.vendorConversationId).toBeTruthy(),
			20000,
		);
		const conversationId = readCheckpointFile(agentDir, checkpointId).leader.vendorConversationId as string;
		expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);

		await neta(["wait", "ro1", "--timeout", "30", "--session", session.id], agentDir, repo);
		await leader.quit();

		// Every per-run temporary directory is gone by now; resume must not need one.
		for (const name of readdirSync(tmpdir())) {
			if (name.startsWith("neta-session-")) rmSync(join(tmpdir(), name), { recursive: true, force: true });
		}
		expect(existsSync(overlay)).toBe(true);

		const secondRecord = join(scratch("neta-record-"), "second.json");
		const resumeEnv = leaderEnv({
			binDir,
			agentDir,
			record: secondRecord,
			quitFile: join(scratch("neta-quit-"), "quit"),
			codexHome: realCodexHome,
		});
		const resumed = startLeader("codex", repo, resumeEnv, ["resume", checkpointId, "--mux", "none"]);
		await waitFor(() => void liveSession(agentDir), 20000).catch((error) => {
			throw new Error(`${error}\nfirst stderr:\n${leader.stderr()}\nresume stderr:\n${resumed.stderr()}`);
		});
		const second = JSON.parse(readFileSync(secondRecord, "utf8")) as LaunchRecord;

		expect(second.argv.slice(0, 2)).toEqual(["resume", conversationId]);
		expect(second.argv).not.toContain("--last");
		expect(second.env.CODEX_HOME).toBe(overlay);
		expect(second.argv.some((arg) => arg.startsWith("mcp_servers.neta.command="))).toBe(true);
		// Instructions are regenerated from the installed build on resume.
		expect(second.files[join(overlay, "AGENTS.md")]).toContain("You are Neta, a leader");
		expect(second.files[join(overlay, "AGENTS.md")]).toContain("## Recovered session");

		await resumed.quit();
		const after = readCheckpointFile(agentDir, checkpointId);
		expect(after.leader.vendorConversationId).toBe(conversationId);
		expect(after.workers.find((worker) => worker.id === "ro1")?.state).toBe("done");
	}, 90000);

	/**
	 * Two Codex sessions started at once, in two directories, against one Codex
	 * home.
	 *
	 * Arranging hook trust used to mean rewriting the user's shared config.toml,
	 * which two launches could do on top of each other: the loser started with an
	 * untrusted capture hook, Codex never ran it, and that session's id was gone
	 * with no error anywhere. Each session now has its own config, and this is the
	 * whole chain end to end — two launchers, two Codexes, two hooks, two
	 * checkpoints, two resumes. The forced interleaving is covered where it can be
	 * forced, in the trust unit tests.
	 */
	it("captures both ids when two Codex sessions are launched at once, and leaves the user's config alone", async () => {
		const binDir = fakeBackend("codex");
		const agentDir = scratch("neta-resume-home-");
		writeSettings(agentDir);
		const realCodexHome = scratch("neta-codex-home-");
		const userConfig =
			'model = "gpt-5.6-sol"\n\n[hooks.state."/home/u/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:user"\n';
		writeFileSync(join(realCodexHome, "config.toml"), userConfig);

		const launches = ["one", "two"].map((name) => {
			const repo = scratch(`neta-concurrent-${name}-`);
			const record = join(scratch("neta-record-"), `${name}.json`);
			const env = leaderEnv({
				binDir,
				agentDir,
				record,
				quitFile: join(scratch("neta-quit-"), "quit"),
				codexHome: realCodexHome,
			});
			return { name, repo, env };
		});

		// Both launchers are started before either has finished arranging trust.
		const leaders = launches.map((launch) => ({
			...launch,
			leader: startLeader("codex", launch.repo, launch.env),
		}));
		try {
			await waitFor(() => expect(liveSessionsIn(agentDir)).toHaveLength(2), 30000).catch((error) => {
				throw new Error(
					`${error}\n${leaders.map((entry) => `${entry.name}:\n${entry.leader.stderr()}`).join("\n")}`,
				);
			});
			const sessions = liveSessionsIn(agentDir);
			const checkpointIds = sessions.map((session) => session.checkpointId as string);
			expect(new Set(checkpointIds).size).toBe(2);

			// Both hooks ran: two different exact ids, one per session.
			for (const id of checkpointIds) {
				await waitFor(
					() => expect(readCheckpointFile(agentDir, id).leader.vendorConversationId).toBeTruthy(),
					30000,
				);
			}
			const conversations = checkpointIds.map(
				(id) => readCheckpointFile(agentDir, id).leader.vendorConversationId as string,
			);
			expect(new Set(conversations).size).toBe(2);

			// Each session's trust lives in its own copy of the user's config, and the
			// user's own file is exactly as they left it.
			expect(readFileSync(join(realCodexHome, "config.toml"), "utf8")).toBe(userConfig);
			for (const id of checkpointIds) {
				const own = readFileSync(join(agentDir, "leader-sessions", id, "codex-home", "config.toml"), "utf8");
				expect(own).toContain('model = "gpt-5.6-sol"');
				expect(own).toContain(join(agentDir, "leader-sessions", id, "codex-home", "hooks.json"));
				for (const other of checkpointIds.filter((candidate) => candidate !== id)) {
					expect(own).not.toContain(join(agentDir, "leader-sessions", other));
				}
			}

			for (const entry of leaders) expect((await entry.leader.quit()).code).toBe(0);

			// And both reopen the conversation they recorded, not each other's.
			for (const [index, id] of checkpointIds.entries()) {
				const repo = readCheckpointFile(agentDir, id).canonicalCwd;
				const record = join(scratch("neta-record-"), `resume-${index}.json`);
				const env = leaderEnv({
					binDir,
					agentDir,
					record,
					quitFile: join(scratch("neta-quit-"), "quit"),
					codexHome: realCodexHome,
				});
				const resumed = startLeader("codex", repo, env, ["resume", id, "--mux", "none"]);
				await waitFor(() => expect(existsSync(record)).toBe(true), 30000).catch((error) => {
					throw new Error(`${error}\nresume stderr:\n${resumed.stderr()}`);
				});
				const launch = JSON.parse(readFileSync(record, "utf8")) as LaunchRecord;
				expect(launch.argv.slice(0, 2)).toEqual(["resume", conversations[index]]);
				await resumed.quit();
			}
		} finally {
			for (const entry of leaders) await entry.leader.quit();
		}
	}, 120000);

	it("reaps a crashed manager's workers before hydrating, and starts nothing", async () => {
		const binDir = fakeBackend("claude");
		const agentDir = scratch("neta-resume-home-");
		const repo = scratch("neta-resume-repo-");
		writeSettings(agentDir);
		const env = leaderEnv({
			binDir,
			agentDir,
			record: join(scratch("neta-record-"), "first.json"),
			quitFile: join(scratch("neta-quit-"), "quit"),
			mcpCalls: [
				{
					name: "neta_delegate",
					arguments: {
						workers: [
							{ role: "scout", tier: "expert", task: "HOLD_FOREVER reader" },
							{ role: "worker", tier: "expert", writer: true, task: "HOLD_FOREVER writer" },
							{ role: "worker", tier: "expert", writer: true, task: "queued write" },
						],
					},
				},
			],
		});
		const promptMarker = join(scratch("neta-marker-"), "prompted");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mux: { panes: false },
				tiers: { expert: { backend: "fake" }, architect: { backend: "fake" } },
				backends: {
					fake: { command: process.execPath, args: [FAKE_AGENT, "--prompt-marker", promptMarker] },
				},
			}),
		);

		const leader = startLeader("claude", repo, env);
		await waitFor(() => void liveSession(agentDir), 20000);
		const session = liveSession(agentDir);
		const checkpointId = session.checkpointId as string;

		await waitFor(() => {
			const groups = liveSession(agentDir).workerGroups ?? [];
			expect(groups.length).toBe(2);
		}, 20000);
		await waitFor(() => expect(readCheckpointFile(agentDir, checkpointId).workers).toHaveLength(3), 20000);
		const groups = (liveSession(agentDir).workerGroups ?? []).map((group) => group.pgid);

		// Kill the manager the way a crash does: no shutdown, no cleanup.
		process.kill(session.pid, "SIGKILL");
		await waitFor(() => {
			expect(() => process.kill(session.pid, 0)).toThrow();
		}, 10000);
		rmSync(promptMarker, { force: true });

		const resumeEnv = leaderEnv({
			binDir,
			agentDir,
			record: join(scratch("neta-record-"), "second.json"),
			quitFile: join(scratch("neta-quit-"), "quit"),
		});
		const resumed = startLeader("claude", repo, resumeEnv, ["resume", checkpointId, "--mux", "none"]);
		await waitFor(() => void liveSession(agentDir, session.id), 20000).catch((error) => {
			throw new Error(`${error}\nresume stderr:\n${resumed.stderr()}`);
		});
		const resumedSession = liveSession(agentDir, session.id);

		// The old worker groups are gone, and nothing was prompted again.
		for (const pgid of groups) expect(() => process.kill(pgid, 0)).toThrow();
		expect(existsSync(promptMarker)).toBe(false);

		const status = await neta(["status", "--session", resumedSession.id], agentDir, repo);
		expect(status.stdout).toContain("interrupted");
		expect(status.stdout).not.toContain("running");
		const checkpoint = readCheckpointFile(agentDir, checkpointId);
		expect(checkpoint.workers.map((worker) => worker.state)).toEqual(["interrupted", "interrupted", "interrupted"]);
		expect(checkpoint.workers.map((worker) => worker.stateBeforeStop)).toContain("queued");
		// The recovery proof is consumed by the resumed run, which owns the lease now.
		expect(checkpoint.liveLease?.managerId).toBe(resumedSession.id);
		expect(checkpoint.shutdown).toBeUndefined();

		await resumed.quit();
		// The crashed run's vendor process is still sitting there; let it go too.
		await leader.quit();
	}, 120000);

	it("refuses to start a leader it cannot record, rather than making an unresumable session", async () => {
		const binDir = fakeBackend("claude");
		const agentDir = scratch("neta-resume-home-");
		const repo = scratch("neta-resume-repo-");
		writeSettings(agentDir);
		// Nothing retries the checkpoint write before the vendor starts, so an
		// unwritable checkpoint directory has to stop the launch outright.
		writeFileSync(join(agentDir, "checkpoints"), "not a directory");
		const record = join(scratch("neta-record-"), "never.json");
		const env = leaderEnv({ binDir, agentDir, record, quitFile: join(scratch("neta-quit-"), "quit") });

		const refused = await startLeader("claude", repo, env).quit();
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("would not be resumable");
		expect(refused.stderr).toContain("No leader was started");
		// The vendor CLI never ran, no session was registered, and no per-session
		// directory was left behind. (`sessions/` itself holds the launch lock.)
		expect(existsSync(record)).toBe(false);
		expect(readdirSync(join(agentDir, "sessions")).filter((name) => name.endsWith(".json"))).toEqual([]);
		expect(existsSync(join(agentDir, "leader-sessions"))).toBe(false);
	}, 30000);

	it("captures OpenCode's assigned session id through its plugin and resumes it exactly", async () => {
		const binDir = fakeBackend("opencode");
		const agentDir = scratch("neta-resume-home-");
		const repo = scratch("neta-resume-repo-");
		writeSettings(agentDir);
		const firstRecord = join(scratch("neta-record-"), "first.json");
		const env = leaderEnv({
			binDir,
			agentDir,
			record: firstRecord,
			quitFile: join(scratch("neta-quit-"), "quit"),
			mcpCalls: [
				{
					name: "neta_delegate",
					arguments: { workers: [{ role: "scout", tier: "expert", name: "oc", task: "SUBSTANTIVE_HANDOFF" }] },
				},
			],
		});

		const leader = startLeader("opencode", repo, env);
		await waitFor(() => void liveSession(agentDir), 20000).catch((error) => {
			throw new Error(`${error}\nstderr:\n${leader.stderr()}`);
		});
		const session = liveSession(agentDir);
		const checkpointId = session.checkpointId as string;
		const first = JSON.parse(readFileSync(firstRecord, "utf8")) as LaunchRecord;

		// OpenCode keeps its own global storage; Neta only adds inline config and
		// one generated plugin at its own stable path.
		const config = JSON.parse(first.env.OPENCODE_CONFIG_CONTENT as string) as {
			plugin: string[];
			instructions: string[];
			mcp: Record<string, unknown>;
		};
		const pluginPath = join(agentDir, "leader-sessions", checkpointId, "opencode-session-capture.mjs");
		expect(config.plugin).toEqual([`file://${pluginPath}`]);
		expect(existsSync(pluginPath)).toBe(true);
		expect(first.argv).not.toContain("--session");
		expect(first.env.NETA_RESUME).toBe(null);

		// The plugin ignored a child session and another directory's session, and
		// reported this leader's exact id.
		await waitFor(
			() => expect(readCheckpointFile(agentDir, checkpointId).leader.vendorConversationId).toBeTruthy(),
			20000,
		);
		const conversationId = readCheckpointFile(agentDir, checkpointId).leader.vendorConversationId as string;
		expect(conversationId).toMatch(/^ses_[A-Za-z0-9]{16,}$/);

		await neta(["wait", "ro1", "--timeout", "30", "--session", session.id], agentDir, repo);
		await leader.quit();

		const listed = await neta(["sessions", "--all"], agentDir, repo);
		expect(listed.stdout).toContain(`${checkpointId}\tclosed\topencode`);
		expect(listed.stdout).toContain("conversation-id:yes");

		// Resume on a newer bundle: same ids, fresh everything else.
		const closed = readCheckpointFile(agentDir, checkpointId);
		writeFileSync(
			join(agentDir, "checkpoints", `${checkpointId}.json`),
			JSON.stringify({ ...closed, appVersion: "0.0.1-old" }, null, 2),
		);
		const secondRecord = join(scratch("neta-record-"), "second.json");
		const resumeEnv = leaderEnv({
			binDir,
			agentDir,
			record: secondRecord,
			quitFile: join(scratch("neta-quit-"), "quit"),
		});
		const resumed = startLeader("opencode", repo, resumeEnv, ["resume", checkpointId, "--mux", "none"]);
		await waitFor(() => void liveSession(agentDir), 20000).catch((error) => {
			throw new Error(`${error}\nstderr:\n${resumed.stderr()}`);
		});
		const resumedSession = liveSession(agentDir);
		const second = JSON.parse(readFileSync(secondRecord, "utf8")) as LaunchRecord;

		expect(second.argv.slice(0, 2)).toEqual(["--session", conversationId]);
		expect(second.argv).not.toContain("--continue");
		expect(second.argv).not.toContain("--fork");
		expect(second.env.NETA_RESUME).toBe("1");
		expect(second.env.NETA_CHECKPOINT_ID).toBe(checkpointId);
		expect(resumedSession.id).not.toBe(session.id);
		expect(resumedSession.socket).not.toBe(session.socket);
		expect(resumedSession.token).not.toBe(session.token);
		// Instructions are rebuilt from the installed build, recovery briefing included.
		const resumedConfig = JSON.parse(second.env.OPENCODE_CONFIG_CONTENT as string) as { instructions: string[] };
		const instructions = second.files[resumedConfig.instructions[0]];
		expect(instructions).toContain("You are Neta, a leader");
		expect(instructions).toContain("## Recovered session");
		expect(instructions).toContain("0.0.1-old");
		expect(instructions).toContain("No worker was restarted");

		const workers = await neta(["workers", "--session", resumedSession.id], agentDir, repo);
		expect(workers.stdout).toContain("Substantive report");

		await resumed.quit();
		const after = readCheckpointFile(agentDir, checkpointId);
		expect(after.appVersion).toBe(VERSION);
		expect(after.leader.vendorConversationId).toBe(conversationId);
	}, 90000);

	it("reaps a crashed OpenCode manager and resumes its exact session without rerunning work", async () => {
		const binDir = fakeBackend("opencode");
		const agentDir = scratch("neta-resume-home-");
		const repo = scratch("neta-resume-repo-");
		const promptMarker = join(scratch("neta-marker-"), "prompted");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mux: { panes: false },
				tiers: { expert: { backend: "fake" } },
				backends: { fake: { command: process.execPath, args: [FAKE_AGENT, "--prompt-marker", promptMarker] } },
			}),
		);
		const env = leaderEnv({
			binDir,
			agentDir,
			record: join(scratch("neta-record-"), "first.json"),
			quitFile: join(scratch("neta-quit-"), "quit"),
			mcpCalls: [
				{
					name: "neta_delegate",
					arguments: { workers: [{ role: "worker", tier: "expert", writer: true, task: "HOLD_FOREVER work" }] },
				},
			],
		});

		const leader = startLeader("opencode", repo, env);
		await waitFor(() => void liveSession(agentDir), 20000);
		const session = liveSession(agentDir);
		const checkpointId = session.checkpointId as string;
		await waitFor(
			() => expect(readCheckpointFile(agentDir, checkpointId).leader.vendorConversationId).toBeTruthy(),
			20000,
		);
		const conversationId = readCheckpointFile(agentDir, checkpointId).leader.vendorConversationId as string;

		await waitFor(() => expect((liveSession(agentDir).workerGroups ?? []).length).toBe(1), 20000);
		await waitFor(() => expect(readCheckpointFile(agentDir, checkpointId).workers).toHaveLength(1), 20000);
		const groups = (liveSession(agentDir).workerGroups ?? []).map((group) => group.pgid);

		process.kill(session.pid, "SIGKILL");
		await waitFor(() => expect(() => process.kill(session.pid, 0)).toThrow(), 10000);
		rmSync(promptMarker, { force: true });

		const resumeEnv = leaderEnv({
			binDir,
			agentDir,
			record: join(scratch("neta-record-"), "second.json"),
			quitFile: join(scratch("neta-quit-"), "quit"),
		});
		const resumed = startLeader("opencode", repo, resumeEnv, ["resume", checkpointId, "--mux", "none"]);
		await waitFor(() => void liveSession(agentDir, session.id), 20000).catch((error) => {
			throw new Error(`${error}\nstderr:\n${resumed.stderr()}`);
		});
		const resumedSession = liveSession(agentDir, session.id);

		for (const pgid of groups) expect(() => process.kill(pgid, 0)).toThrow();
		expect(existsSync(promptMarker)).toBe(false);
		const status = await neta(["status", "--session", resumedSession.id], agentDir, repo);
		expect(status.stdout).toContain("interrupted");
		expect(readCheckpointFile(agentDir, checkpointId).leader.vendorConversationId).toBe(conversationId);

		await resumed.quit();
		await leader.quit();
	}, 120000);

	it("refuses an OpenCode session whose id was never captured, and conflicting selectors", async () => {
		const binDir = fakeBackend("opencode");
		const agentDir = scratch("neta-resume-home-");
		const repo = scratch("neta-resume-repo-");
		writeSettings(agentDir);
		const record = join(scratch("neta-record-"), "pure.json");
		const env = {
			...leaderEnv({ binDir, agentDir, record, quitFile: join(scratch("neta-quit-"), "quit") }),
			FAKE_LEADER_HOST_MCP: "0",
		};

		// `--pure` disables plugins, which is where the capture lives. The launch
		// is refused outright rather than starting a session nobody could reopen.
		const pure = startLeader("opencode", repo, env, ["--leader", "opencode", "--mux", "none", "--", "--pure"]);
		const exit = await pure.quit();
		expect(exit.code).toBe(1);
		expect(exit.stderr).toContain("--pure");
		expect(exit.stderr).toContain("could never be reopened");
		// Refused, not started: no vendor process and no registered session.
		expect(exit.stderr).not.toContain("at prepare (");
		expect(existsSync(record)).toBe(false);
		expect(readdirSync(join(agentDir, "sessions")).filter((name) => name.endsWith(".json"))).toEqual([]);

		const checkpointId = readdirSync(join(agentDir, "checkpoints"))
			.map((name) => name.replace(/\.json$/, ""))
			.at(0) as string;
		expect(readCheckpointFile(agentDir, checkpointId).leader.vendorConversationId).toBeUndefined();
		const refused = await neta(["resume", checkpointId], agentDir, repo).catch((error: { stderr: string }) => error);
		expect(refused.stderr).toContain("no recorded opencode conversation id");
		expect(refused.stderr).toContain("will not guess");

		for (const selector of ["--session", "--continue", "-c", "--fork"]) {
			const rejected = await neta(["--leader", "opencode", "--mux", "none", "--", selector, "x"], agentDir, repo, {
				PATH: `${binDir}${delimiter}${process.env.PATH}`,
			}).catch((error: { stderr: string }) => error);
			expect(rejected.stderr).toContain(`"${selector}" cannot be passed through`);
		}
	}, 90000);
});
