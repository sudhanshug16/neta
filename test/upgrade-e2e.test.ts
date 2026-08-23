/**
 * The upgrade path, with two different Neta executables.
 *
 * The old half, A, is `fixtures/neta-old-runtime.mjs`: a real Neta, built from a
 * pinned commit with `bun build --target=node` and checked in as one Node-runnable
 * file. It is run as a Neta — it starts leaders, registers sessions, runs its own
 * control plane over MCP, spawns workers over ACP, and writes its own checkpoints
 * — and it can no more read the current source than an installed copy could. The
 * new half, B, is the artifact that ships today, built from `src/`. Neither half
 * can borrow the other's idea of the format, which is the whole point: a test
 * where both sides are today's code proves only that today's code agrees with
 * itself.
 *
 * What has to hold: the current build lists a session an older Neta saved,
 * reopens its exact vendor conversation on all three backends whether that older
 * Neta closed cleanly or was killed, gives it a fresh manager, socket, token,
 * prompt and MCP registration, keeps the recorded results, notes and rooms, and
 * restarts no worker.
 *
 * Regenerating A: `bun run scripts/build-old-runtime.ts`. Its provenance — commit,
 * subject, version and SHA-256 — is `fixtures/neta-old-runtime.json`, and the
 * first test here checks the checked-in bytes against it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SessionCheckpoint } from "../src/checkpoint.ts";
import { CHECKPOINT_SCHEMA_VERSION, checkpointPath, emptySessionCheckpoint } from "../src/checkpoint.ts";
import { VERSION } from "../src/config.ts";
import type { SessionRecord } from "../src/session.ts";
import { processGone, readAuthoritativeCheckpoint, waitFor } from "./helpers.ts";

const OLD_RUNTIME = fileURLToPath(new URL("./fixtures/neta-old-runtime.mjs", import.meta.url));
const OLD_PROVENANCE = fileURLToPath(new URL("./fixtures/neta-old-runtime.json", import.meta.url));
const FAKE_LEADER = fileURLToPath(new URL("./fixtures/fake-leader.mjs", import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const SOURCE_ENTRY = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const run = promisify(execFile);

interface Provenance {
	bundle: string;
	sha256: string;
	commit: string;
	subject: string;
	appVersion: string;
}

const provenance = JSON.parse(readFileSync(OLD_PROVENANCE, "utf-8")) as Provenance;

/** The runtime users have: Node, not Bun. Falls back where a test host has none. */
const nodePath = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf-8" }).stdout.trim() || process.execPath;

const dirs: string[] = [];

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Build the artifact that ships: one Node-runnable file, no dependency tree. */
function buildCurrentBundle(): string {
	const outDir = scratch("neta-bundle-b-");
	const built = spawnSync("bun", ["build", SOURCE_ENTRY, "--target=node", "--outdir", outDir], {
		encoding: "utf-8",
		cwd: fileURLToPath(new URL("..", import.meta.url)),
	});
	if (built.status !== 0) throw new Error(built.stderr || "could not build the current bundle");
	const bundle = join(outDir, "cli.js");
	if (!existsSync(bundle)) throw new Error(`build produced no ${bundle}`);
	return bundle;
}

/**
 * Stand-in vendor CLIs.
 *
 * The old runtime predates Codex's hook trust, so its Codex advertises the help
 * of a build from that time — and the fixture then runs its session-start hooks
 * as configured, which is what that Codex did.
 */
function vendorShims(help?: string): string {
	const dir = scratch("neta-old-bin-");
	for (const name of ["claude", "codex", "opencode"]) {
		writeFileSync(
			join(dir, name),
			`#!/bin/sh\n${help === undefined ? "" : `FAKE_LEADER_HELP=${JSON.stringify(help)}\nexport FAKE_LEADER_HELP\n`}` +
				`exec ${process.execPath} ${FAKE_LEADER} "$@"\n`,
			"utf-8",
		);
		chmodSync(join(dir, name), 0o755);
	}
	return dir;
}

interface LaunchRecord {
	argv: string[];
	files: Record<string, string>;
	env: Record<string, string | null>;
}

function readCheckpointFile(agentDir: string, id: string): SessionCheckpoint {
	return readAuthoritativeCheckpoint(agentDir, id);
}

function liveSessions(agentDir: string): SessionRecord[] {
	const dir = join(agentDir, "sessions");
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as SessionRecord)
		.filter((record) => {
			try {
				process.kill(record.pid, 0);
				return true;
			} catch {
				return false;
			}
		});
}

function liveSession(agentDir: string, exclude?: string): SessionRecord {
	const records = liveSessions(agentDir).filter((record) => record.id !== exclude);
	if (records.length !== 1) throw new Error(`expected one live session, found ${records.length}`);
	return records[0];
}

interface RunningLeader {
	pid: number;
	quit: () => Promise<{ code: number; stderr: string }>;
	stderr: () => string;
}

function startLeader(bundle: string, cwd: string, env: Record<string, string>, args: string[]): RunningLeader {
	const child = spawn(nodePath, [bundle, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stdout.on("data", () => {});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const closed = new Promise<{ code: number; stderr: string }>((resolve) =>
		child.on("close", (code, signal) => resolve({ code: signal ? 1 : (code ?? 0), stderr })),
	);
	return {
		pid: child.pid as number,
		stderr: () => stderr,
		quit: async () => {
			writeFileSync(env.FAKE_LEADER_QUIT_FILE, "quit");
			return closed;
		},
	};
}

describe("the pinned old Neta runtime", () => {
	it("is a real, self-contained executable, and not the current one", () => {
		const source = readFileSync(OLD_RUNTIME, "utf-8");

		// The bytes are the ones the provenance records, so what this suite resumes
		// from is the commit it says it is.
		expect(sha256(OLD_RUNTIME)).toBe(provenance.sha256);
		expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/);

		// It cannot reach the current source. Every module it loads is a Node
		// builtin, statically or dynamically, and no path into this checkout appears
		// in it at all — so what it runs is its own code whatever `src/` says today.
		const imports = [...source.matchAll(/^\s*(?:import|export)[^\n]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
		const dynamic = [...source.matchAll(/(?:\bimport|\brequire)\(\s*"([^"]+)"/g)].map((match) => match[1]);
		expect(imports.length).toBeGreaterThan(0);
		expect(imports.filter((specifier) => !/^(node:)?[a-z_]+(\/[a-z]+)?$/.test(specifier))).toEqual([]);
		expect([...imports, ...dynamic].filter((specifier) => /^[./]/.test(specifier))).toEqual([]);
		expect(source).not.toContain(fileURLToPath(new URL("../src/", import.meta.url)));
		// And it is a whole Neta, not a description of one.
		expect(source.length).toBeGreaterThan(500_000);

		// Different executables, on disk and when asked.
		expect(sha256(OLD_RUNTIME)).not.toBe(sha256(buildCurrentBundle()));
		const version = spawnSync(nodePath, [OLD_RUNTIME, "--version"], { encoding: "utf-8" });
		expect(version.stdout.trim()).toBe(provenance.appVersion);
		const help = spawnSync(nodePath, [OLD_RUNTIME, "--help"], { encoding: "utf-8" });
		expect(help.stdout).toContain("neta resume");
	}, 120000);

	it("fails closed on the current schema-4 checkpoint", async () => {
		const agentDir = scratch("neta-old-schema-");
		const repo = scratch("neta-old-schema-repo-");
		// writeCheckpointAtomic intentionally normalizes every readable input to the
		// current schema, so write this compatibility fixture at its intended v4
		// boundary instead of accidentally testing a v5 file.
		mkdirSync(join(agentDir, "checkpoints"), { recursive: true });
		const schemaFour = {
			...emptySessionCheckpoint({ id: "schema-four", canonicalCwd: repo, leaderBackend: "claude" }),
			schemaVersion: 4,
		};
		writeFileSync(checkpointPath("schema-four", agentDir), `${JSON.stringify(schemaFour)}\n`);
		const result = await run(nodePath, [OLD_RUNTIME, "sessions", "--all"], {
			env: { ...process.env, NETA_DIR: agentDir },
		});
		expect(result.stdout).toContain("schema-four");
		expect(result.stdout).toContain("schema version 4");
		expect(result.stdout).toContain("unreadable");
	});
});

describe("a session saved by an older Neta, reopened by the current build", () => {
	it("lists and resumes Claude, Codex and OpenCode sessions without restarting a worker", async () => {
		const bundle = buildCurrentBundle();
		const agentDir = scratch("neta-upgrade-home-");
		const promptMarker = join(scratch("neta-upgrade-marker-"), "prompted");
		const scoutBarrier = join(scratch("neta-upgrade-barrier-"), "release-scout");
		const scoutBarrierReady = join(scratch("neta-upgrade-barrier-ready-"), "scout-ready");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mux: { panes: false },
				tiers: { expert: { backend: "fake" }, architect: { backend: "fake" } },
				backends: {
					fake: {
						command: process.execPath,
						args: [
							FAKE_AGENT,
							"--prompt-marker",
							promptMarker,
							"--barrier-file",
							scoutBarrier,
							"--barrier-ready-file",
							scoutBarrierReady,
						],
					},
				},
			}),
		);
		// A Codex from before hook trust, which is the Codex the pinned commit knew.
		const binDir = vendorShims("Fake CLI\n  --hooks <file>  Run configured hooks\n  opencode plugin <module>\n");
		const calls = join(scratch("neta-upgrade-calls-"), "calls.json");
		writeFileSync(
			calls,
			JSON.stringify([
				{ name: "neta_note", arguments: { text: "decide on the rollout window" } },
				{ name: "neta_room", arguments: { room: "review", post: "the race is in the refresh" } },
			]),
		);

		const baseEnv = {
			...process.env,
			PATH: `${binDir}${delimiter}${process.env.PATH}`,
			NETA_DIR: agentDir,
			NETA_SOCKET: "",
			NETA_LEADER_TOKEN: "",
			NETA_WORKER_ID: "",
			NETA_WORKER_TOKEN: "",
			FAKE_LEADER_HOST_MCP: "1",
			CODEX_HOME: join(agentDir, "real-codex"),
		} as Record<string, string>;

		const backends = [
			{ id: "claude", close: "graceful", resume: (conversation: string) => ["--resume", conversation] },
			{ id: "codex", close: "crash", resume: (conversation: string) => ["resume", conversation] },
			{ id: "opencode", close: "graceful", resume: (conversation: string) => ["--session", conversation] },
		] as const;

		const saved: Array<{
			backend: string;
			checkpointId: string;
			conversation: string;
			repo: string;
			legacyBytes: string;
		}> = [];

		// A: the old runtime runs three real sessions and leaves three checkpoints.
		for (const backend of backends) {
			rmSync(scoutBarrier, { force: true });
			rmSync(scoutBarrierReady, { force: true });
			const repo = scratch(`neta-upgrade-${backend.id}-`);
			const env = {
				...baseEnv,
				FAKE_LEADER_RECORD: join(scratch("neta-upgrade-record-"), "old.json"),
				FAKE_LEADER_QUIT_FILE: join(scratch("neta-upgrade-quit-"), "quit"),
				FAKE_LEADER_MCP_CALLS: calls,
				FAKE_LEADER_MCP_RESULT: join(scratch("neta-upgrade-mcp-"), "result.json"),
			};
			const old = startLeader(OLD_RUNTIME, repo, env, ["--leader", backend.id, "--mux", "none"]);
			await waitFor(() => void liveSession(agentDir), 30000).catch((error) => {
				throw new Error(`${backend.id}: ${error}\nold stderr:\n${old.stderr()}`);
			});
			const session = liveSession(agentDir);
			const checkpointId = session.checkpointId as string;

			// Worker state built by the old runtime's own ACP path. The scout blocks
			// until this test has spawned the writer. `spawn` returns only after the
			// old manager has queued the writer-start notice, so the scout cannot
			// archive its substantive handoff before that automatic-notice step.
			const oldNeta = (args: string[]) =>
				run(nodePath, [OLD_RUNTIME, ...args, "--session", session.id], { cwd: repo, env: baseEnv });
			await oldNeta([
				"spawn",
				"--role",
				"scout",
				"--tier",
				"expert",
				"--name",
				"auth scout",
				"--room",
				"review",
				"WAIT_FOR_BARRIER SUBSTANTIVE_HANDOFF map the auth flow",
			]);
			await waitFor(() => existsSync(scoutBarrierReady), 30000);
			await oldNeta(["spawn", "--role", "worker", "--tier", "expert", "--writer", "config work"]);
			writeFileSync(scoutBarrier, "release\n", "utf-8");
			await oldNeta(["wait", "ro1", "rw2", "--timeout", "30"]);

			// The old runtime's own control plane recorded the note and the room post.
			await waitFor(() => existsSync(env.FAKE_LEADER_MCP_RESULT), 30000);
			const mcp = JSON.parse(readFileSync(env.FAKE_LEADER_MCP_RESULT, "utf8")) as Array<{
				name: string;
				error?: unknown;
			}>;
			expect(mcp.map((call) => call.name)).toEqual(["neta_note", "neta_room"]);
			expect(mcp.filter((call) => call.error)).toEqual([]);

			const before = readCheckpointFile(agentDir, checkpointId);
			expect(before.appVersion).toBe(provenance.appVersion);
			expect(before.workers.map((worker) => worker.substantiveResponse ?? worker.finalResult).join("\n")).toContain(
				"Substantive report",
			);
			const conversation = before.leader.vendorConversationId as string;
			expect(conversation).toBeTruthy();
			expect(before.notes[0]).toMatchObject({ id: "n1", open: true });
			expect(before.rooms[0].posts.map((post) => post.text)).toContain("the race is in the refresh");

			if (backend.close === "graceful") {
				expect((await old.quit()).code).toBe(0);
			} else {
				// A crash: the manager is killed where it stands, with no shutdown and
				// no proof of its own. The vendor process is quit afterwards.
				process.kill(session.pid, "SIGKILL");
				await waitFor(() => processGone(session.pid), 20000);
				await old.quit();
			}
			await waitFor(() => liveSessions(agentDir).length === 0, 20000);
			const legacyBytes = readFileSync(checkpointPath(checkpointId, agentDir), "utf8");
			saved.push({ backend: backend.id, checkpointId, conversation, repo, legacyBytes });
		}

		// The old runtime really did run those workers, so it really did prompt the
		// backend. Clear the marker: from here on, anything that writes it is the
		// current build restarting work it should only be reading.
		expect(existsSync(promptMarker)).toBe(true);
		rmSync(promptMarker, { force: true });

		// B: the current build lists what the old runtime left behind.
		const listed = await run(nodePath, [bundle, "sessions", "--all"], { env: baseEnv });
		for (const entry of saved) {
			expect(listed.stdout).toContain(`${entry.checkpointId}\tclosed`);
		}
		expect(listed.stdout.match(/conversation-id:yes/g)).toHaveLength(3);
		expect(saved.some((entry) => listed.stdout.includes(`neta resume ${entry.checkpointId}`))).toBe(true);

		// ...and reopens each of them.
		for (const entry of saved) {
			const backend = backends.find((candidate) => candidate.id === entry.backend);
			if (!backend) throw new Error(`no backend for ${entry.backend}`);
			const record = join(scratch("neta-upgrade-record-"), "new.json");
			const env = {
				...baseEnv,
				FAKE_LEADER_RECORD: record,
				FAKE_LEADER_QUIT_FILE: join(scratch("neta-upgrade-quit-"), "quit"),
			};
			const resumed = startLeader(bundle, entry.repo, env, ["resume", entry.checkpointId, "--mux", "none"]);
			try {
				await waitFor(() => void liveSession(agentDir), 30000).catch((error) => {
					throw new Error(`${entry.backend}: ${error}\nresume stderr:\n${resumed.stderr()}`);
				});
				const session = liveSession(agentDir);
				const launch = JSON.parse(readFileSync(record, "utf8")) as LaunchRecord;

				// The exact conversation, chosen by the backend's own selector.
				expect(launch.argv.slice(0, 2)).toEqual([...backend.resume(entry.conversation)]);
				expect(launch.argv).not.toContain("--last");
				expect(launch.argv).not.toContain("--continue");
				expect(launch.env.NETA_RESUME).toBe("1");
				expect(launch.env.NETA_CHECKPOINT_ID).toBe(entry.checkpointId);

				// Everything runtime is this run's, and everything generated is this
				// build's — including the MCP registration, which points at B.
				const configured = Object.values(launch.files).join("\n") + (launch.env.OPENCODE_CONFIG_CONTENT ?? "");
				const launched = `${launch.argv.join(" ")}\n${configured}`;
				expect(launched).toContain(session.socket);
				expect(launched).toContain(bundle);
				expect(launched).not.toContain(OLD_RUNTIME);

				const prompt = launch.argv.includes("--append-system-prompt")
					? launch.argv[launch.argv.indexOf("--append-system-prompt") + 1]
					: Object.values(launch.files).join("\n");
				expect(prompt).toContain("## Recovered session");
				expect(prompt).toContain(entry.checkpointId);
				const forbiddenRecoveryAnnouncement =
					`This conversation was reopened from Neta session \`${entry.checkpointId}\`, saved by Neta ` +
					`${provenance.appVersion} and now running on ${VERSION}.`;
				expect(prompt).not.toContain(forbiddenRecoveryAnnouncement);
				expect(prompt).toContain("No worker was restarted");
				expect(prompt).toContain("Substantive report");

				// The recovered state is readable through the live control plane.
				const neta = (args: string[]) =>
					run(nodePath, [bundle, ...args, "--session", session.id], { cwd: entry.repo, env: baseEnv });
				const status = await neta(["status"]);
				expect(status.stdout).toContain("done=2");
				expect(status.stdout).not.toContain("ro1");
				expect(status.stdout).toContain("decide on the rollout window");
				const workers = await neta(["workers"]);
				expect(workers.stdout).toContain("Substantive report");
			} finally {
				const exit = await resumed.quit();
				expect({ backend: entry.backend, ...exit }).toMatchObject({ code: 0 });
			}

			const after = readCheckpointFile(agentDir, entry.checkpointId);
			// Migration publishes v6 beside the old checkpoint. The old bytes are
			// evidence of the source format and remain recoverable forever.
			expect(readFileSync(checkpointPath(entry.checkpointId, agentDir), "utf8")).toBe(entry.legacyBytes);
			expect(after.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
			expect(after.appVersion).toBe(VERSION);
			expect(after.leader.vendorConversationId).toBe(entry.conversation);
			expect(after.workers.map((worker) => worker.finalResult).join("\n")).toContain("Substantive report");
			expect(after.notes[0]).toMatchObject({ id: "n1", open: true });
			expect(after.rooms[0].posts.map((post) => post.text)).toContain("the race is in the refresh");
			// The scout's own vendor session is carried across, so `neta attach` still
			// reaches the conversation it had.
			expect(after.workers.find((worker) => worker.id === "ro1")?.vendorSessionId).toBeTruthy();
		}

		// No worker was ever restarted: the fake backend writes this file the moment
		// anything prompts it, and it has not been prompted since the old runtime.
		expect(existsSync(promptMarker)).toBe(false);
	}, 300000);
});
