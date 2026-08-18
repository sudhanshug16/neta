/**
 * The parts of resume that must fail closed.
 *
 * Every case here ends with Neta refusing and the checkpoint untouched, because
 * the failure mode this feature has to avoid is not "resume did not work" — it
 * is "resume looked like it worked" over a live manager, a stranger's process,
 * or a conversation Neta guessed at.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ClaudeAdapter } from "../src/adapters/claude.ts";
import {
	CodexAdapter,
	captureHookCommand,
	codexSupportsHooks,
	createHomeOverlay,
	hooksConfig,
	windowsHookCommand,
} from "../src/adapters/codex.ts";
import { capturePluginSource, OpenCodeAdapter } from "../src/adapters/opencode.ts";
import type { LeaderLaunchContext } from "../src/adapters/types.ts";
import {
	CheckpointError,
	checkpointPath,
	emptySessionCheckpoint,
	readCheckpoint,
	readCheckpointForHydration,
	readVendorSessionCapture,
	type SessionCheckpoint,
	writeCheckpointAtomic,
	writeVendorSessionCapture,
} from "../src/checkpoint.ts";
import { shellQuote } from "../src/cli-shim.ts";
import { VERSION } from "../src/config.ts";
import type { DetectedLeaderBackend } from "../src/detect.ts";
import { resumeLeader } from "../src/launch.ts";
import { captureLeaderSession } from "../src/leader-capture.ts";
import { startConversationCapture } from "../src/mcp/run.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import { buildLeaderPrompt } from "../src/prompts/leader.ts";
import {
	buildRecoverySummary,
	formatDurableSession,
	listDurableSessions,
	proveManagerStopped,
	RecoveryError,
	requireCheckpointCwd,
	requireLeaderConversationId,
} from "../src/recovery.ts";
import {
	processStartTime,
	readStoppedMarker,
	type SessionRecord,
	tryAcquireCheckpointClaim,
	writeSessionRecord,
	writeStoppedMarker,
} from "../src/session.ts";
import { EnvStub, fixtureBackendConfig, waitFor } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const run = promisify(execFile);
const dirs: string[] = [];

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

const FAKE_LEADER = fileURLToPath(new URL("./fixtures/fake-leader.mjs", import.meta.url));

/**
 * A "codex" whose `--help` and `app-server` behave like the installed one: the
 * adapter's hook-trust path talks to a real process over real stdio, so what is
 * tested is the arrangement Neta makes, not a description of it.
 */
function fakeCodex(name: string, help?: string): DetectedLeaderBackend {
	const path = join(scratch(`neta-codex-shim-${name}-`), "codex");
	writeFileSync(
		path,
		`#!/bin/sh\n${help === undefined ? "" : `FAKE_LEADER_HELP=${JSON.stringify(help)}\nexport FAKE_LEADER_HELP\n`}` +
			`exec ${process.execPath} ${FAKE_LEADER} "$@"\n`,
		{ mode: 0o755 },
	);
	return { id: "codex", name: "Codex", binary: "codex", install: "", path };
}

function checkpointWith(
	overrides: Partial<SessionCheckpoint> & { id: string; canonicalCwd: string },
): SessionCheckpoint {
	return {
		...emptySessionCheckpoint({
			id: overrides.id,
			canonicalCwd: overrides.canonicalCwd,
			leaderBackend: overrides.leader?.backend ?? "claude",
			leaderVendorConversationId: overrides.leader?.vendorConversationId,
		}),
		...overrides,
	};
}

function runningWorker(id = "rw1"): SessionCheckpoint["workers"][number] {
	return {
		id,
		name: "migration",
		role: "worker",
		tier: "expert",
		backend: "claude",
		writer: true,
		task: "migrate",
		state: "running",
		startedAt: 1,
		updatedAt: 2,
		log: [],
		logFirstIndex: 0,
		logCursor: 0,
		pendingBrief: [],
	};
}

function record(overrides: Partial<SessionRecord> & { id: string; cwd: string }): SessionRecord {
	return {
		socket: join(tmpdir(), `neta-${overrides.id}.sock`),
		token: "registry-secret",
		leader: "claude",
		pid: process.pid,
		startedAt: Date.now(),
		...overrides,
	};
}

/** A stand-in vendor binary whose `--help` decides what Neta believes it supports. */
function openCodeShim(help = "opencode plugin <module>  install plugin and update config"): string {
	const path = join(scratch("neta-opencode-shim-"), "opencode");
	writeFileSync(path, `#!/bin/sh\necho ${JSON.stringify(help)}\n`, { mode: 0o755 });
	return path;
}

/** Load a generated capture plugin the way OpenCode does, and return its hooks. */
async function loadCapturePlugin(
	leaderDir: string,
	directory: string,
	launchedAt: number,
): Promise<{ event: (input: { event: unknown }) => Promise<void> }> {
	const pluginPath = join(leaderDir, "plugin.mjs");
	writeFileSync(
		pluginPath,
		capturePluginSource(
			{ path: join(leaderDir, "vendor-session.json"), errorPath: join(leaderDir, "vendor-session.error") },
			directory,
			launchedAt,
		),
	);
	const plugin = (await import(pathToFileURL(pluginPath).href)) as {
		default: () => Promise<{ event: (input: { event: unknown }) => Promise<void> }>;
	};
	return plugin.default();
}

/**
 * The control plane addresses a capture by agent directory and session id, so a
 * test that owns the session directory hands back its parent.
 */
function leaderSessionParent(leaderDir: string): string {
	const agentDir = scratch("neta-capture-agent-");
	mkdirSync(join(agentDir, "leader-sessions"), { recursive: true });
	symlinkSync(leaderDir, join(agentDir, "leader-sessions", "logical-fail"));
	return agentDir;
}

/** Run the CLI expecting it to refuse, and return what the user would see. */
async function failing(args: string[], agentDir: string): Promise<{ stderr: string; code: number }> {
	try {
		await run(process.execPath, args, { env: { ...process.env, NETA_DIR: agentDir } });
	} catch (error) {
		return error as { stderr: string; code: number };
	}
	throw new Error(`expected \`${args.join(" ")}\` to fail`);
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resume refuses rather than guesses", () => {
	it("refuses a session whose manager is still live, and changes nothing", async () => {
		const agentDir = scratch("neta-resume-home-");
		const cwd = scratch("neta-resume-repo-");
		const identity = processStartTime(process.pid);
		const checkpoint = checkpointWith({
			id: "live-one",
			canonicalCwd: cwd,
			leader: { backend: "claude", vendorConversationId: "11111111-1111-4111-8111-111111111111" },
			liveLease: { managerId: "manager-live", processStartedAt: identity },
		});
		writeCheckpointAtomic(checkpoint, agentDir);
		writeSessionRecord(
			record({ id: "manager-live", cwd, processStartedAt: identity, checkpointId: "live-one" }),
			agentDir,
		);
		const before = readFileSync(checkpointPath("live-one", agentDir), "utf8");

		await expect(proveManagerStopped(checkpoint, { agentDir })).rejects.toThrow(
			"still running as manager manager-live",
		);
		expect(readFileSync(checkpointPath("live-one", agentDir), "utf8")).toBe(before);
	});

	it("refuses a lease whose recorded manager identity does not match", async () => {
		const agentDir = scratch("neta-resume-home-");
		const cwd = scratch("neta-resume-repo-");
		const checkpoint = checkpointWith({
			id: "mismatched",
			canonicalCwd: cwd,
			liveLease: { managerId: "manager-old", processStartedAt: "Mon Jan  1 00:00:00 2020" },
		});
		writeCheckpointAtomic(checkpoint, agentDir);
		writeSessionRecord(
			record({
				id: "manager-old",
				cwd,
				pid: 999_999,
				processStartedAt: "Tue Feb  2 00:00:00 2021",
				checkpointId: "mismatched",
			}),
			agentDir,
		);

		await expect(proveManagerStopped(checkpoint, { agentDir })).rejects.toThrow("mismatched identity");
		expect(readCheckpoint("mismatched", agentDir).shutdown).toBeUndefined();
	});

	it("refuses when a crashed manager left running workers and no evidence", async () => {
		const agentDir = scratch("neta-resume-home-");
		const cwd = scratch("neta-resume-repo-");
		const checkpoint = checkpointWith({
			id: "no-evidence",
			canonicalCwd: cwd,
			liveLease: { managerId: "manager-gone" },
			workers: [runningWorker()],
		});
		writeCheckpointAtomic(checkpoint, agentDir);

		await expect(proveManagerStopped(checkpoint, { agentDir })).rejects.toThrow(
			"cannot prove those processes are gone",
		);
		expect(readCheckpoint("no-evidence", agentDir).shutdown).toBeUndefined();
	});

	it("refuses when an earlier sweep could not confirm the workers exited", async () => {
		const agentDir = scratch("neta-resume-home-");
		const cwd = scratch("neta-resume-repo-");
		const checkpoint = checkpointWith({
			id: "unproven",
			canonicalCwd: cwd,
			liveLease: { managerId: "manager-swept" },
			workers: [runningWorker()],
		});
		writeCheckpointAtomic(checkpoint, agentDir);
		writeStoppedMarker({ id: "manager-swept", at: Date.now(), processesStopped: false }, agentDir);

		await expect(proveManagerStopped(checkpoint, { agentDir })).rejects.toThrow("could not confirm");
	});

	it("never signals a process group whose leader identity was recycled", async () => {
		const agentDir = scratch("neta-resume-home-");
		const cwd = scratch("neta-resume-repo-");
		const checkpoint = checkpointWith({
			id: "recycled",
			canonicalCwd: cwd,
			liveLease: { managerId: "manager-crashed" },
			workers: [runningWorker()],
		});
		writeCheckpointAtomic(checkpoint, agentDir);
		// A live process that is not ours, standing in for a reused pgid.
		const stranger = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
		stranger.unref();
		writeSessionRecord(
			record({
				id: "manager-crashed",
				cwd,
				pid: 999_999,
				processStartedAt: "Mon Jan  1 00:00:00 2020",
				checkpointId: "recycled",
				workerGroups: [{ pgid: stranger.pid as number, leaderStartedAt: "Mon Jan  1 00:00:00 2020" }],
			}),
			agentDir,
		);

		const warnings: string[] = [];
		const notes = await proveManagerStopped(checkpoint, { agentDir, warn: (message) => warnings.push(message) });
		expect(() => process.kill(stranger.pid as number, 0)).not.toThrow();
		process.kill(stranger.pid as number, "SIGKILL");
		expect(warnings.join(" ")).toContain("identity no longer matches");
		expect(notes.join(" ")).toContain("reaped 1 recorded worker process group");
		expect(readCheckpoint("recycled", agentDir).shutdown).toMatchObject({ processesStopped: true, by: "recovery" });
		expect(readStoppedMarker("manager-crashed", agentDir)).toBeUndefined();
	});

	it("accepts a graceful stop and a swept crash, and records the proof once", async () => {
		const agentDir = scratch("neta-resume-home-");
		const cwd = scratch("neta-resume-repo-");
		const graceful = checkpointWith({
			id: "graceful",
			canonicalCwd: cwd,
			shutdown: { at: Date.now(), processesStopped: true, by: "graceful" },
		});
		writeCheckpointAtomic(graceful, agentDir);
		expect((await proveManagerStopped(graceful, { agentDir })).join(" ")).toContain("stopped cleanly");

		const swept = checkpointWith({
			id: "swept",
			canonicalCwd: cwd,
			liveLease: { managerId: "manager-swept" },
			workers: [runningWorker()],
		});
		writeCheckpointAtomic(swept, agentDir);
		writeStoppedMarker({ id: "manager-swept", at: Date.now(), processesStopped: true }, agentDir);
		expect((await proveManagerStopped(swept, { agentDir })).join(" ")).toContain("already reaped");
		expect(readCheckpoint("swept", agentDir).liveLease).toBeUndefined();
	});

	it("refuses a missing conversation id, a deleted directory, and an unknown schema", async () => {
		const agentDir = scratch("neta-resume-home-");
		const cwd = scratch("neta-resume-repo-");
		const noId = checkpointWith({ id: "no-id", canonicalCwd: cwd, leader: { backend: "opencode" } });
		writeCheckpointAtomic(noId, agentDir);
		expect(() => requireLeaderConversationId(noId, agentDir)).toThrow("no recorded opencode conversation id");
		expect(() => requireLeaderConversationId(noId, agentDir)).toThrow("will not guess");

		// A hook that reported an id the control plane never adopted still counts:
		// it is the vendor's own id, and it is persisted on first use.
		writeVendorSessionCapture("no-id", agentDir, "99999999-9999-4999-8999-999999999999");
		expect(requireLeaderConversationId(noId, agentDir)).toBe("99999999-9999-4999-8999-999999999999");
		expect(readCheckpoint("no-id", agentDir).leader.vendorConversationId).toBe(
			"99999999-9999-4999-8999-999999999999",
		);

		const deleted = checkpointWith({ id: "gone", canonicalCwd: join(cwd, "removed") });
		expect(() => requireCheckpointCwd(deleted)).toThrow("no longer exists");

		writeCheckpointAtomic(checkpointWith({ id: "future", canonicalCwd: cwd }), agentDir);
		const path = checkpointPath("future", agentDir);
		const future = JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), schemaVersion: 99 });
		writeFileSync(path, future);
		expect(() => readCheckpoint("future", agentDir)).toThrow(CheckpointError);
		await expect(resumeLeader({ checkpointId: "future", agentDir, extraArgs: [] })).rejects.toThrow(
			"schema version 99",
		);
		expect(readFileSync(path, "utf8")).toBe(future);

		writeFileSync(checkpointPath("broken", agentDir), "{not json");
		await expect(resumeLeader({ checkpointId: "broken", agentDir, extraArgs: [] })).rejects.toThrow("corrupt JSON");
		expect(readFileSync(checkpointPath("broken", agentDir), "utf8")).toBe("{not json");
	});

	it("lets only one resume claim a checkpoint at a time", async () => {
		const agentDir = scratch("neta-resume-home-");
		const cwd = scratch("neta-resume-repo-");
		writeCheckpointAtomic(
			checkpointWith({
				id: "claimed",
				canonicalCwd: cwd,
				leader: { backend: "claude", vendorConversationId: "22222222-2222-4222-8222-222222222222" },
				shutdown: { at: Date.now(), processesStopped: true, by: "graceful" },
			}),
			agentDir,
		);
		const claim = tryAcquireCheckpointClaim("claimed", agentDir);
		expect(claim).toBeDefined();
		expect(tryAcquireCheckpointClaim("claimed", agentDir)).toBeUndefined();

		await expect(resumeLeader({ checkpointId: "claimed", agentDir, extraArgs: [] })).rejects.toThrow(
			"already running",
		);
	});
});

describe("the exact leader conversation", () => {
	const context = (overrides: Partial<LeaderLaunchContext> = {}): LeaderLaunchContext => ({
		backend: { id: "claude", name: "Claude Code", binary: "claude", install: "", path: "/usr/bin/claude" },
		cwd: "/repo",
		sessionDir: scratch("neta-adapter-session-"),
		sessionId: "s1",
		logicalSessionId: "logical-1",
		socket: "/tmp/neta-s1.sock",
		token: "tok",
		leaderPrompt: "You are Neta, a leader",
		invocation: { command: "/usr/bin/neta", prefixArgs: [] },
		strictMcp: false,
		extraArgs: [],
		mux: "none",
		panes: false,
		...overrides,
	});

	it("names a fresh Claude conversation and reopens exactly that one", async () => {
		const fresh = await new ClaudeAdapter().prepare(
			context({ leaderConversationId: "33333333-3333-4333-8333-333333333333" }),
		);
		expect(fresh.args.slice(0, 2)).toEqual(["--session-id", "33333333-3333-4333-8333-333333333333"]);
		expect(fresh.args).toContain("--append-system-prompt");

		const resumed = await new ClaudeAdapter().prepare(
			context({ resumeConversationId: "33333333-3333-4333-8333-333333333333" }),
		);
		expect(resumed.args.slice(0, 2)).toEqual(["--resume", "33333333-3333-4333-8333-333333333333"]);
		expect(resumed.args).not.toContain("--session-id");
		expect(resumed.args).toContain("--mcp-config");
		expect(resumed.args).toContain("--settings");
		expect(resumed.env.NETA_RESUME).toBe("1");
	});

	it("rejects pass-through selectors that would move the conversation", async () => {
		for (const selector of ["--continue", "--resume", "--session-id", "-c"]) {
			await expect(new ClaudeAdapter().prepare(context({ extraArgs: [selector, "x"] }))).rejects.toThrow(
				"cannot be passed through",
			);
		}
		for (const selector of ["resume", "--last", "fork"]) {
			await expect(
				new CodexAdapter().prepare(
					context({
						backend: { id: "codex", name: "Codex", binary: "codex", install: "", path: "/usr/bin/codex" },
						extraArgs: [selector],
					}),
				),
			).rejects.toThrow("cannot be passed through");
		}
	});

	it("names no fresh OpenCode conversation, reopens the exact one, and refuses selectors", async () => {
		const leaderDir = scratch("neta-opencode-leader-");
		const capture = { command: "/usr/bin/neta", args: ["capture-leader-session", "--session", "logical-1"] };
		const backend = {
			id: "opencode" as const,
			name: "OpenCode",
			binary: "opencode",
			install: "",
			path: openCodeShim(),
		};

		const fresh = await new OpenCodeAdapter().prepare(
			context({ backend, leaderSessionDir: leaderDir, captureCommand: capture }),
		);
		expect(fresh.args).not.toContain("--session");
		const freshConfig = JSON.parse(fresh.env.OPENCODE_CONFIG_CONTENT) as { plugin?: string[] };
		const pluginPath = join(leaderDir, "opencode-session-capture.mjs");
		expect(freshConfig.plugin).toEqual([`file://${pluginPath}`]);
		expect(readFileSync(pluginPath, "utf8")).toContain("session.created");

		const resumed = await new OpenCodeAdapter().prepare(
			context({
				backend,
				leaderSessionDir: leaderDir,
				captureCommand: capture,
				resumeConversationId: "ses_ff81218b8ffeBxYzdedz6TJhiQ",
			}),
		);
		expect(resumed.args.slice(0, 2)).toEqual(["--session", "ses_ff81218b8ffeBxYzdedz6TJhiQ"]);
		expect(resumed.args).not.toContain("--continue");
		expect(resumed.env.NETA_RESUME).toBe("1");
		// A resumed session already knows its conversation, so nothing is captured.
		expect(JSON.parse(resumed.env.OPENCODE_CONFIG_CONTENT).plugin).toBeUndefined();

		for (const selector of ["-c", "--continue", "-s", "--session", "--fork"]) {
			await expect(new OpenCodeAdapter().prepare(context({ backend, extraArgs: [selector] }))).rejects.toThrow(
				"cannot be passed through",
			);
		}

		// A launch that could not capture the id is refused, not warned about: a
		// session that starts is a session the user will expect to reopen.
		await expect(
			new OpenCodeAdapter().prepare(
				context({ backend, leaderSessionDir: leaderDir, captureCommand: capture, extraArgs: ["--pure"] }),
			),
		).rejects.toThrow("could never be reopened");
		await expect(
			new OpenCodeAdapter().prepare(
				context({
					backend: { ...backend, path: openCodeShim("opencode [project]\n  -c, --continue  continue\n") },
					leaderSessionDir: leaderDir,
					captureCommand: capture,
				}),
			),
		).rejects.toThrow("no plugin support");
		// Resuming an already-captured session needs no plugin, so it still runs.
		const oldBuild = await new OpenCodeAdapter().prepare(
			context({
				backend: { ...backend, path: openCodeShim("opencode [project]\n  -c, --continue  continue\n") },
				leaderSessionDir: leaderDir,
				captureCommand: capture,
				resumeConversationId: "ses_ff81218b8ffeBxYzdedz6TJhiQ",
			}),
		);
		expect(oldBuild.args.slice(0, 2)).toEqual(["--session", "ses_ff81218b8ffeBxYzdedz6TJhiQ"]);
	});

	it("refuses a Codex build whose hooks cannot record the conversation id", async () => {
		const leaderDir = scratch("neta-codex-nohooks-");
		const realHome = scratch("neta-codex-nohooks-home-");
		const capture = { command: "/usr/bin/neta", args: ["capture-leader-session", "--session", "logical-1"] };
		const path = join(scratch("neta-codex-nohooks-shim-"), "codex");
		writeFileSync(path, `#!/bin/sh\necho "Usage: codex [OPTIONS]"\n`, { mode: 0o755 });
		const backend = { id: "codex" as const, name: "Codex", binary: "codex", install: "", path };

		const stub = new EnvStub();
		stub.set("CODEX_HOME", realHome);
		try {
			await expect(
				new CodexAdapter().prepare(context({ backend, leaderSessionDir: leaderDir, captureCommand: capture })),
			).rejects.toThrow("could never be reopened");
			const resumed = await new CodexAdapter().prepare(
				context({
					backend,
					leaderSessionDir: leaderDir,
					captureCommand: capture,
					resumeConversationId: "44444444-4444-4444-8444-444444444444",
				}),
			);
			expect(resumed.args.slice(0, 2)).toEqual(["resume", "44444444-4444-4444-8444-444444444444"]);
		} finally {
			stub.restore();
		}
	});

	it("records only the leader's own root OpenCode session, once and atomically", async () => {
		const leaderDir = scratch("neta-opencode-plugin-");
		const worktree = scratch("neta-opencode-worktree-");
		const elsewhere = scratch("neta-opencode-elsewhere-");
		// OpenCode reports the worktree root, which can be an ancestor of the
		// directory Neta was started in — and it resolves symlinks where Neta's
		// path may not be. Both were observed against the installed OpenCode.
		mkdirSync(join(worktree, "nested"), { recursive: true });
		const capturePath = join(leaderDir, "vendor-session.json");
		const hooks = await loadCapturePlugin(leaderDir, join(worktree, "nested"), 1_000_000);

		const session = (type: string, id: string, extra: Record<string, unknown> = {}) => ({
			event: { type, properties: { info: { id, directory: worktree, ...extra } } },
		});
		await hooks.event(session("session.created", "ses_childaaaaaaaaaaaaaaaaaa", { parentID: "ses_parentbbbbb" }));
		await hooks.event(session("session.created", "ses_elsewhereccccccccccccc", { directory: elsewhere }));
		// An older session merely being touched is not this launch's session.
		await hooks.event(session("session.updated", "ses_olderdddddddddddddddd", { time: { created: 999_999 } }));
		expect(existsSync(capturePath)).toBe(false);

		await hooks.event(session("session.created", "ses_ff81218b8ffeBxYzdedz6TJhiQ"));
		await hooks.event(session("session.created", "ses_seconddddddddddddddddd"));

		// Written by the plugin itself: no subprocess to lose the failure in.
		expect(JSON.parse(readFileSync(capturePath, "utf8"))).toMatchObject({
			vendorConversationId: "ses_ff81218b8ffeBxYzdedz6TJhiQ",
		});
		expect(statSync(capturePath).mode & 0o777).toBe(0o600);
		expect(readdirSync(leaderDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("surfaces a capture it could not write instead of swallowing it", async () => {
		const leaderDir = scratch("neta-opencode-failure-");
		const worktree = scratch("neta-opencode-failure-worktree-");
		// The capture path is a directory, so the write cannot succeed.
		mkdirSync(join(leaderDir, "vendor-session.json"));
		const hooks = await loadCapturePlugin(leaderDir, worktree, 1_000_000);

		await hooks.event({
			event: {
				type: "session.created",
				properties: { info: { id: "ses_unwritableaaaaaaaaaaa", directory: worktree } },
			},
		});

		const failure = readFileSync(join(leaderDir, "vendor-session.error"), "utf8");
		expect(failure).toContain("could not record session ses_unwritableaaaaaaaaaaa");
		// The control plane turns that into a visible "not resumable" report.
		const reports: string[] = [];
		startConversationCapture(
			{ setLeaderVendorConversationId: () => {} },
			"logical-fail",
			leaderSessionParent(leaderDir),
			{ pollMs: 5, windowMs: 0, report: (message) => reports.push(message) },
		);
		await waitFor(() => reports.length > 0, 5000);
		expect(reports[0]).toContain("never reported its conversation id");
		expect(reports[0]).toContain("will refuse this session");
	});

	it("accepts an update only for a session this launch created", async () => {
		const leaderDir = scratch("neta-opencode-update-");
		const worktree = scratch("neta-opencode-update-worktree-");
		const launchedAt = 2_000_000;
		const hooks = await loadCapturePlugin(leaderDir, worktree, launchedAt);

		// Missing the creation event entirely, an update still identifies the
		// session — but only because its own recorded creation time says this
		// launch made it.
		await hooks.event({
			event: {
				type: "session.updated",
				properties: {
					info: { id: "ses_freshhhhhhhhhhhhhhhhhh", directory: worktree, time: { created: launchedAt } },
				},
			},
		});
		expect(JSON.parse(readFileSync(join(leaderDir, "vendor-session.json"), "utf8"))).toMatchObject({
			vendorConversationId: "ses_freshhhhhhhhhhhhhhhhhh",
		});
	});

	it("captures Codex's id from a session-start hook payload and never replaces one", () => {
		const agentDir = scratch("neta-capture-home-");
		const cwd = scratch("neta-capture-repo-");
		writeCheckpointAtomic(checkpointWith({ id: "cap", canonicalCwd: cwd, leader: { backend: "codex" } }), agentDir);

		expect(
			captureLeaderSession({
				checkpointId: "cap",
				agentDir,
				payload: JSON.stringify({ hook_event_name: "Stop", session_id: "44444444-4444-4444-8444-444444444444" }),
			}),
		).toBeUndefined();
		expect(readCheckpoint("cap", agentDir).leader.vendorConversationId).toBeUndefined();

		const lines: string[] = [];
		expect(
			captureLeaderSession({
				checkpointId: "cap",
				agentDir,
				payload: "not json",
				write: (line) => lines.push(line),
			}),
		).toBeUndefined();
		expect(
			captureLeaderSession({
				checkpointId: "cap",
				agentDir,
				payload: JSON.stringify({ hook_event_name: "SessionStart", session_id: "latest" }),
				write: (line) => lines.push(line),
			}),
		).toBeUndefined();
		expect(lines.join(" ")).toContain("no usable conversation id");

		const captured = captureLeaderSession({
			checkpointId: "cap",
			agentDir,
			payload: JSON.stringify({
				hook_event_name: "SessionStart",
				source: "startup",
				session_id: "44444444-4444-4444-8444-444444444444",
			}),
		});
		expect(captured).toBe("44444444-4444-4444-8444-444444444444");
		expect(readCheckpoint("cap", agentDir).leader.vendorConversationId).toBe(captured);
		expect(readVendorSessionCapture("cap", agentDir)).toBe(captured);

		// A second, different id would silently point resume at another conversation.
		captureLeaderSession({
			checkpointId: "cap",
			agentDir,
			payload: JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: "55555555-5555-4555-8555-555555555555",
			}),
		});
		expect(readCheckpoint("cap", agentDir).leader.vendorConversationId).toBe(captured);
	});

	it("configures the Codex hook only where the installed binary supports hooks", async () => {
		const leaderDir = scratch("neta-codex-leader-");
		const realHome = scratch("neta-codex-real-");
		const capture = { command: "/usr/bin/neta", args: ["capture-leader-session", "--session", "logical-1"] };

		expect(codexSupportsHooks("/fake/codex-hooks", () => "--dangerously-bypass-hook-trust")).toBe(true);
		expect(codexSupportsHooks("/fake/codex-plain", () => "Usage: codex [OPTIONS]")).toBe(false);

		const stub = new EnvStub();
		stub.set("CODEX_HOME", realHome);
		try {
			const supported = await new CodexAdapter().prepare(
				context({
					backend: fakeCodex("hooks"),
					cwd: scratch("neta-codex-cwd-"),
					leaderSessionDir: leaderDir,
					captureCommand: capture,
				}),
			);
			// The hook is written and, on a build that enforces hook trust, vouched
			// for — otherwise Codex would hold it back and never report its id.
			expect(readFileSync(join(leaderDir, "codex-home", "hooks.json"), "utf8")).toContain("SessionStart");
			expect(supported.warnings.join(" ")).toContain("recorded Codex hook trust");
			// In this session's own config, which is the copy Codex reads. The user's
			// stays as they left it — here, absent.
			expect(readFileSync(join(leaderDir, "codex-home", "config.toml"), "utf8")).toContain(
				`[hooks.state."${realpathSync(join(leaderDir, "codex-home", "hooks.json"))}:session_start:0:0"]`,
			);
			expect(existsSync(join(realHome, "config.toml"))).toBe(false);

			// The refusal itself is covered by its own test; here it is enough that
			// the hook file is only written where the mechanism exists.
			rmSync(join(leaderDir, "codex-home", "hooks.json"), { force: true });
			await expect(
				new CodexAdapter().prepare(
					context({
						backend: fakeCodex("plain", "Usage: codex [OPTIONS]"),
						cwd: scratch("neta-codex-cwd-"),
						leaderSessionDir: leaderDir,
						captureCommand: capture,
					}),
				),
			).rejects.toThrow("could never be reopened");
			expect(() => readFileSync(join(leaderDir, "codex-home", "hooks.json"), "utf8")).toThrow();
		} finally {
			stub.restore();
		}
	});

	it("merges the capture hook with the user's own SessionStart hooks", () => {
		const realHome = scratch("neta-real-codex-");
		writeFileSync(
			join(realHome, "hooks.json"),
			JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "user-hook" }] }] } }),
		);
		const merged = JSON.parse(hooksConfig(realHome, { command: "neta", args: ["capture-leader-session"] })) as {
			hooks: { SessionStart: Array<{ hooks: Array<{ command: string; commandWindows?: string }> }> };
		};
		expect(merged.hooks.SessionStart).toHaveLength(2);
		expect(merged.hooks.SessionStart[0].hooks[0].command).toBe("user-hook");
		expect(merged.hooks.SessionStart[1].hooks[0].command).toBe("'neta' 'capture-leader-session'");
		expect(merged.hooks.SessionStart[1].hooks[0].commandWindows).toBe('"neta" "capture-leader-session"');
	});

	/**
	 * Codex 0.147 takes a hook as one command string and runs it through a shell.
	 * Neta does not choose the paths in that string — the executable is wherever
	 * `neta` was installed and the directory comes from `NETA_DIR` — so the string
	 * is quoted, not joined. These run the generated command for real.
	 */
	it("passes an adversarial executable path and arguments through the shell literally", () => {
		const root = scratch("neta-hook-shell-");
		const nasty = join(root, "b in 'dir' $(touch pwned) `touch pwned2`; touch pwned3 && echo x | tee y");
		mkdirSync(nasty, { recursive: true });
		const executable = join(nasty, "ne ta");
		const seen = join(root, "seen.json");
		// Records every argument it was given, plus what arrived on stdin.
		writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(seen)}\ncat >> ${shellQuote(seen)}\n`, {
			mode: 0o755,
		});
		const args = [
			"capture-leader-session",
			"--session",
			"logical 1; touch pwned4",
			"--dir",
			join(root, 'a "quoted" dir'),
			"$HOME",
			"a\nb",
			"back\\slash",
			"semi;colon`x`",
		];
		writeFileSync(join(root, "hooks.json"), hooksConfig(root, { command: executable, args }));
		const command = (
			JSON.parse(readFileSync(join(root, "hooks.json"), "utf8")) as {
				hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
			}
		).hooks.SessionStart[0].hooks[0].command;

		const payload = JSON.stringify({ hook_event_name: "SessionStart", session_id: "1-2-3" });
		const ran = spawnSync("/bin/sh", ["-c", command], { cwd: root, input: payload, encoding: "utf-8" });

		expect({ status: ran.status, stderr: ran.stderr }).toMatchObject({ status: 0 });
		// Every argument arrived exactly as written, and stdin is untouched.
		expect(readFileSync(seen, "utf8")).toBe(`${args.join("\n")}\n${payload}`);
		// Nothing the metacharacters would have done, was done.
		for (const marker of ["pwned", "pwned2", "pwned3", "pwned4", "y"]) {
			expect(existsSync(join(root, marker))).toBe(false);
		}
	});

	it("refuses a Windows command line it cannot express, rather than mis-quoting one", () => {
		expect(windowsHookCommand(["C:\\neta\\neta.exe", "capture-leader-session", "--dir", "C:\\a b\\dir\\"])).toBe(
			'"C:\\neta\\neta.exe" "capture-leader-session" "--dir" "C:\\a b\\dir\\\\"',
		);
		// cmd.exe expands these inside double quotes; there is no quoting that stops it.
		for (const argument of ['a"b', "50%done", "bang!", "line\nbreak"]) {
			expect(windowsHookCommand(["neta", argument])).toBeUndefined();
		}
		expect(() => captureHookCommand({ command: "neta", args: ["50%done"] }, "win32")).toThrow(
			/cannot be expressed as a cmd.exe command line/,
		);
		expect(captureHookCommand({ command: "neta", args: ["50%done"] }, "darwin")).toBe("'neta' '50%done'");
		// A POSIX host still generates the hook; it just carries no Windows form.
		expect(
			hooksConfig(scratch("neta-nowin-"), { command: "neta", args: ["50%done"] }, () => {}, "darwin"),
		).not.toContain("commandWindows");
	});

	it("refuses to start rather than silently drop hooks it cannot read", () => {
		const realHome = scratch("neta-real-codex-");
		mkdirSync(join(realHome, "hooks.json"));

		expect(() => hooksConfig(realHome, { command: "neta", args: [] })).toThrow(/could not read your Codex hooks/);

		// One Codex would reject anyway: the session goes ahead, and says so.
		const other = scratch("neta-real-codex-");
		writeFileSync(join(other, "hooks.json"), "not json at all");
		const warnings: string[] = [];
		expect(hooksConfig(other, { command: "neta", args: [] }, (message) => warnings.push(message))).toContain(
			"SessionStart",
		);
		expect(warnings.join(" ")).toContain("not a JSON object");
	});
});

describe("the Codex overlay home survives the run that created it", () => {
	it("lives outside the temporary directory and is rebuilt in place on resume", async () => {
		const realHome = scratch("neta-real-codex-");
		const leaderDir = scratch("neta-leader-session-");
		writeFileSync(join(realHome, "auth.json"), '{"token":"secret"}');
		writeFileSync(join(realHome, "config.toml"), "model = 'gpt'");
		writeFileSync(join(realHome, "AGENTS.md"), "user instructions");

		const overlay = join(leaderDir, "codex-home");
		await createHomeOverlay(realHome, overlay, "first instructions", '{"hooks":{}}');
		expect(readFileSync(join(overlay, "AGENTS.md"), "utf8")).toContain("user instructions");
		expect(readFileSync(join(overlay, "AGENTS.md"), "utf8")).toContain("first instructions");
		expect(readFileSync(join(overlay, "auth.json"), "utf8")).toContain("secret");

		// config.toml is copied rather than linked, so this session's hook trust has
		// somewhere private to live. The copy is the user's settings, verbatim.
		expect(lstatSync(join(overlay, "config.toml")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(overlay, "config.toml"), "utf8")).toBe("model = 'gpt'");

		// The real home changes between runs; the overlay follows without ever
		// copying credentials or sessions out of it.
		rmSync(join(realHome, "config.toml"));
		writeFileSync(join(realHome, "history.jsonl"), "{}");
		await createHomeOverlay(realHome, overlay, "second instructions");
		expect(readFileSync(join(overlay, "AGENTS.md"), "utf8")).toContain("second instructions");
		expect(readFileSync(join(overlay, "AGENTS.md"), "utf8")).not.toContain("first instructions");
		// Regenerated from what the real home says now, including its removal.
		expect(readFileSync(join(overlay, "config.toml"), "utf8")).toBe("");
		expect(readFileSync(join(overlay, "history.jsonl"), "utf8")).toBe("{}");
		expect(() => readFileSync(join(overlay, "hooks.json"), "utf8")).toThrow();
		expect(overlay.startsWith(tmpdir())).toBe(true); // the scratch root here is tmp; the path itself is Neta's
	});
});

describe("a recovered worker", () => {
	it("keeps its exact vendor session for neta_attach, and attaching restarts nothing", async () => {
		const agentDir = scratch("neta-attach-home-");
		const cwd = scratch("neta-attach-repo-");
		writeCheckpointAtomic(
			checkpointWith({
				id: "attachable",
				canonicalCwd: cwd,
				shutdown: { at: Date.now(), processesStopped: true, by: "graceful" },
				counter: 1,
				workers: [
					{
						...runningWorker("ro1"),
						role: "scout",
						writer: false,
						state: "running",
						vendorSessionId: "88888888-8888-4888-8888-888888888888",
						substantiveResponse: "half-mapped the auth flow",
					},
				],
			}),
			agentDir,
		);

		let transports = 0;
		const attached: Array<{ command: string; args: string[] }> = [];
		const manager = WorkerManager.hydrate(
			{
				cwd,
				agentDir,
				config: fixtureBackendConfig(),
				channelAddress: "/tmp/fresh.sock",
				onEvent: () => {},
				createTransport: () => {
					transports += 1;
					throw new Error("a recovered worker must never be started again");
				},
				panes: {
					open: () => ({ opened: true }),
					openRoom: () => ({ opened: true }),
					attach: (_worker, resume) => {
						attached.push(resume);
						return { opened: true };
					},
				},
			},
			readCheckpointForHydration("attachable", agentDir),
		);

		expect(manager.get("ro1")).toMatchObject({ state: "interrupted", stateBeforeStop: "running" });
		const summary = manager.reopenWorkerTui("ro1");
		expect(summary.state).toBe("interrupted");
		expect(attached).toEqual([{ command: "claude", args: ["--resume", "88888888-8888-4888-8888-888888888888"] }]);
		expect(manager.get("ro1").state).toBe("interrupted");
		expect(transports).toBe(0);
		await manager.dispose();
	});
});

describe("what a resumed leader is told", () => {
	it("summarizes outcomes, open notes, and that nothing was restarted", () => {
		const cwd = scratch("neta-summary-repo-");
		const checkpoint = checkpointWith({
			id: "logical-9",
			canonicalCwd: cwd,
			appVersion: "0.9.0",
			leader: { backend: "codex", vendorConversationId: "66666666-6666-4666-8666-666666666666" },
			workers: [
				{
					...runningWorker("rw1"),
					state: "interrupted",
					stateBeforeStop: "running",
					finalResult: "Interrupted during recovery (was running); review before continuing.",
				},
				{
					...runningWorker("ro2"),
					name: "auth scout",
					role: "scout",
					writer: false,
					state: "done",
					substantiveResponse: "Mapped the auth flow and found the race.",
				},
			],
			notes: [{ id: "n1", text: "decide on the rollout window", open: true, createdAt: 1, workers: [] }],
		});

		const summary = buildRecoverySummary(checkpoint, VERSION);
		expect(summary).toContain("logical-9");
		expect(summary).toContain("0.9.0");
		expect(summary).toContain(VERSION);
		expect(summary).toContain("rw1");
		expect(summary).toContain("interrupted (was running)");
		expect(summary).toContain("Mapped the auth flow");
		expect(summary).toContain("n1");
		expect(summary).toContain("No worker was restarted");
		expect(summary).toContain("neta_status");
		// No secret ever reaches the prompt: the checkpoint holds none to leak.
		expect(summary).not.toContain("token");

		const prompt = buildLeaderPrompt({ tiers: {}, recovery: summary });
		expect(prompt).toContain("## Recovered session");
		expect(prompt.indexOf("## Recovered session")).toBeLessThan(prompt.indexOf("## You do not write code"));
		expect(buildLeaderPrompt({ tiers: {} })).not.toContain("## Recovered session");
	});

	// A report that survived a failed automatic notice has to survive the restart
	// too, and so does the caveat attached to it.
	it("carries a preserved report and its later failure through hydration", async () => {
		const agentDir = scratch("neta-later-failure-home-");
		const cwd = scratch("neta-later-failure-repo-");
		const checkpoint = checkpointWith({
			id: "later-failure",
			canonicalCwd: cwd,
			shutdown: { at: Date.now(), processesStopped: true, by: "graceful" },
			counter: 1,
			workers: [
				{
					...runningWorker("ro1"),
					role: "scout",
					writer: false,
					state: "done",
					finalResult: "Substantive report: mapped the auth flow.",
					substantiveResponse: "Substantive report: mapped the auth flow.",
					lastResponse: "backend closed the session",
					laterFailure: "automatic notice failed after the report above: backend closed the session",
				},
			],
		});
		writeCheckpointAtomic(checkpoint, agentDir);

		const manager = WorkerManager.hydrate(
			{
				cwd,
				agentDir,
				config: fixtureBackendConfig(),
				channelAddress: "/tmp/neta-later-failure.sock",
				onEvent: () => {},
				createTransport: () => {
					throw new Error("a recovered worker must never be started again");
				},
			},
			readCheckpointForHydration("later-failure", agentDir),
		);

		try {
			expect(manager.get("ro1")).toMatchObject({
				state: "done",
				result: "Substantive report: mapped the auth flow.",
				laterFailure: expect.stringContaining("automatic notice failed"),
			});
			const waited = await manager.wait(["ro1"], 1000);
			expect(waited.workers[0].result).toContain("Substantive report");
			expect(waited.workers[0].laterFailure).toContain("backend closed the session");
			expect(buildRecoverySummary(checkpoint, VERSION)).toContain("after its report");
		} finally {
			await manager.dispose();
			rmSync("/tmp/neta-later-failure.sock", { force: true });
		}
	});
});

describe("listing sessions", () => {
	it("shows live and closed sessions with copyable ids and whether they can be reopened", () => {
		const agentDir = scratch("neta-list-home-");
		const cwd = scratch("neta-list-repo-");
		writeCheckpointAtomic(
			{
				...checkpointWith({
					id: "closed-one",
					canonicalCwd: cwd,
					leader: { backend: "codex", vendorConversationId: "77777777-7777-4777-8777-777777777777" },
				}),
				updatedAt: 2000,
			},
			agentDir,
		);
		writeCheckpointAtomic(
			{
				...checkpointWith({ id: "no-id-one", canonicalCwd: cwd, leader: { backend: "opencode" } }),
				updatedAt: 1000,
			},
			agentDir,
		);
		writeFileSync(checkpointPath("unreadable-one", agentDir), "{oops");

		const rows = listDurableSessions(agentDir);
		expect(rows.map((row) => row.id)).toEqual(["closed-one", "no-id-one", "unreadable-one"]);
		expect(rows[0]).toMatchObject({ live: false, leader: "codex", resumable: true, cwd });
		expect(rows[1].resumable).toBe(false);
		expect(rows[2].error).toContain("corrupt JSON");
		expect(formatDurableSession(rows[0]).split("\t")).toEqual([
			"closed-one",
			"closed",
			"codex",
			new Date(2000).toISOString(),
			"conversation-id:yes",
			cwd,
		]);
		expect(formatDurableSession(rows[2])).toContain("unreadable");
	});

	it("documents resume in help and refuses an id that does not exist", async () => {
		const agentDir = scratch("neta-help-home-");
		const { stdout } = await run(process.execPath, [CLI, "--help"]);
		expect(stdout).toContain("neta resume <session-id>");
		expect(stdout).toContain("neta sessions [--all]");

		const usage = await failing([CLI, "resume"], agentDir);
		expect(usage.stderr).toContain("Usage: neta resume <session-id>");
		expect(usage.code).toBe(1);

		const missing = await failing([CLI, "resume", "nope"], agentDir);
		expect(missing.stderr).toContain('Checkpoint "nope" does not exist.');
		expect(missing.code).toBe(1);

		const empty = await run(process.execPath, [CLI, "sessions", "--all"], {
			env: { ...process.env, NETA_DIR: agentDir },
		});
		expect(empty.stdout).toContain("No Neta sessions, running or closed.");
	});
});

describe("recovery errors are their own type", () => {
	it("carries the refusal as a RecoveryError so the CLI can report it without a stack", async () => {
		const agentDir = scratch("neta-type-home-");
		const cwd = scratch("neta-type-repo-");
		const checkpoint = checkpointWith({
			id: "typed",
			canonicalCwd: cwd,
			liveLease: { managerId: "manager-gone" },
			workers: [runningWorker()],
		});
		writeCheckpointAtomic(checkpoint, agentDir);
		await expect(proveManagerStopped(checkpoint, { agentDir })).rejects.toBeInstanceOf(RecoveryError);
	});
});
