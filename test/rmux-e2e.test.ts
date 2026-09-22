import { afterEach, describe, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import { workspaceIdFor } from "../src/core/workspace-id.ts";
import type { Agent, Mission, Workspace } from "../src/core/types.ts";
import { writeJsonAtomic } from "../src/store/files.ts";
import { openStore } from "../src/store/index.ts";
import { paths } from "../src/store/paths.ts";

const root = join(import.meta.dir, "..");
const state = join(tmpdir(), `neta-rmux-e2e-${process.pid}`);

afterEach(() => {
	try {
		execFileSync("bun", ["src/cli/main.ts", "node", "stop"], { cwd: root, env: { ...process.env, NETA_DIR: state } });
	} catch {}
	rmSync(state, { recursive: true, force: true });
});

function seedFakeProvider(): void {
	mkdirSync(state, { recursive: true });
	writeFileSync(
		join(state, "settings.json"),
		JSON.stringify({
			providers: {
				fake: {
					command: process.execPath,
					args: [join(root, "test/fixtures/fake-acp-agent.mjs")],
					resume: true,
					defaultModel: "test-model",
				},
			},
			leader: { provider: "fake", model: "test-model" },
			forbiddenModels: [],
		}),
	);
}

function legacyPiRoot(sessionId: string): string {
	return join(
		tmpdir(),
		"neta-rmux-pi-sessions",
		`h${Buffer.from("local").toString("hex")}-s${Buffer.from(sessionId).toString("hex")}`,
	);
}

async function seedArchivedTranscript(): Promise<string> {
	const previous = process.env.NETA_DIR;
	process.env.NETA_DIR = state;
	try {
		const store = await openStore();
		const workspaceId = workspaceIdFor({
			kind: "git",
			remote: "https://github.com/sudhanshug16/neta.git",
			path: root,
		});
		const machine = await store.machine.load();
		const now = new Date().toISOString();
		const workspace: Workspace = {
			id: workspaceId,
			kind: "git",
			name: "neta",
			remote: "github.com/sudhanshug16/neta",
			roots: [{ machineId: machine.id, path: root }],
			createdAt: now,
		};
		await store.workspaces.save(workspace);
		const agentId = ulid();
		const sessionId = ulid();
		const mission: Mission = {
			id: ulid(),
			number: await store.missions.allocateNumber(workspaceId),
			workspaceId,
			machineId: machine.id,
			name: "Saved archive mission",
			objective: "Keep the completed transcript.",
			changes: [],
			lead: { kind: "agent", agentId },
			agentIds: [agentId],
			access: "readOnly",
			state: "closed",
			createdAt: now,
			closedAt: now,
		};
		const agent: Agent = {
			id: agentId,
			missionId: mission.id,
			workspaceId,
			name: "Saved Ada",
			task: "Archived terminal work",
			access: "readOnly",
			provider: "fake",
			model: "test-model",
			skills: [],
			sessionId,
			canSpawn: true,
			state: "archived",
			startedAt: now,
			endedAt: now,
		};
		await store.missions.create(mission);
		await writeJsonAtomic(join(paths().root, "agents.json"), { [agentId]: agent });
		await store.conversations.create({ sessionId, provider: "fake", model: "test-model", createdAt: now });
		const turnId = ulid();
		await store.conversations.appendTurn({ id: turnId, sessionId, startedAt: now, endedAt: now, role: "agent" });
		for (let seq = 1; seq <= 51; seq += 1) {
			await store.conversations.appendBlock(sessionId, {
				turnId,
				seq,
				at: now,
				role: "agent",
				kind: "text",
				text: seq === 1 ? "ARCHIVE_OLD_EXACT_SESSION" : seq === 51 ? "ARCHIVE_NEW_EXACT_SESSION" : `archive block ${seq}`,
			});
		}
		await store.close();
		return mission.id;
	} finally {
		if (previous === undefined) delete process.env.NETA_DIR;
		else process.env.NETA_DIR = previous;
	}
}

async function seedSpine(sessionPrefix = "spine-session"): Promise<void> {
	const previous = process.env.NETA_DIR;
	process.env.NETA_DIR = state;
	try {
		const store = await openStore();
		const workspaceId = workspaceIdFor({
			kind: "git",
			remote: "https://github.com/sudhanshug16/neta.git",
			path: root,
		});
		const machine = await store.machine.load();
		const workspace: Workspace = {
			id: workspaceId,
			kind: "git",
			name: "neta",
			remote: "github.com/sudhanshug16/neta",
			roots: [{ machineId: machine.id, path: root }],
			createdAt: "2026-09-09T09:00:00.000Z",
		};
		await store.workspaces.save(workspace);
		const agents: Record<string, Agent> = {};
		for (let number = 1; number <= 14; number += 1) {
			const missionId = `spine-mission-${number}`;
			const agentId = `spine-agent-${number}`;
			const mission: Mission = {
				id: missionId,
				number: await store.missions.allocateNumber(workspaceId),
				workspaceId,
				machineId: machine.id,
				name: `Spine mission ${number}`,
				objective: `Exercise mission ${number} in the rmux spine.`,
				changes: [],
				lead: { kind: "agent", agentId },
				agentIds: [agentId],
				access: "readOnly",
				state: "running",
				createdAt: `2026-09-09T${String(number).padStart(2, "0")}:00:00.000Z`,
			};
			agents[agentId] = {
				id: agentId,
				missionId,
				workspaceId,
				name: `Spine agent ${number}`,
				task: `selected mission ${number}`,
				access: "readOnly",
				provider: "fake",
				model: "test-model",
				skills: [],
				sessionId: `${sessionPrefix}-${number}`,
				canSpawn: true,
				state: "running",
				startedAt: mission.createdAt,
			};
			await store.missions.create(mission);
		}
		await writeJsonAtomic(join(paths().root, "agents.json"), agents);
		await store.close();
	} finally {
		if (previous === undefined) delete process.env.NETA_DIR;
		else process.env.NETA_DIR = previous;
	}
}

async function seedRemoteAgent(remoteState: string, sessionId = "remote-agent-session"): Promise<void> {
	const previous = process.env.NETA_DIR;
	process.env.NETA_DIR = remoteState;
	try {
		const store = await openStore();
		const workspaceId = workspaceIdFor({ kind: "git", remote: "https://github.com/sudhanshug16/neta.git", path: root });
		const machine = await store.machine.load();
		const now = new Date().toISOString();
		const agentId = "remote-agent-copy";
		const mission: Mission = {
			id: "remote-agent-mission", number: await store.missions.allocateNumber(workspaceId), workspaceId, machineId: machine.id,
			name: "Remote reconnect mission", objective: "Preserve this selected remote agent on reconnect.", changes: [],
			lead: { kind: "agent", agentId }, agentIds: [agentId], access: "readOnly", state: "running", createdAt: now,
		};
		const agent: Agent = {
			id: agentId, missionId: mission.id, workspaceId, name: "Remote agent", task: "Reconnect target", access: "readOnly",
			provider: "fake", model: "test-model", skills: [], sessionId, canSpawn: true, state: "running", startedAt: now,
		};
		await store.missions.create(mission);
		await writeJsonAtomic(join(paths().root, "agents.json"), { [agentId]: agent });
		await store.close();
	} finally {
		if (previous === undefined) delete process.env.NETA_DIR;
		else process.env.NETA_DIR = previous;
	}
}

describe.skipIf(process.env.NETA_RMUX_E2E !== "1")("rmux outer shell", () => {
	test("picker, navigation, and terminal bytes cross the complete launcher PTY", () => {
		seedFakeProvider();
		execFileSync("python3", [join(root, "test/fixtures/rmux-e2e.py")], {
			cwd: root,
			stdio: "inherit",
			env: {
				...process.env,
				NETA_DIR: state,
				NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"),
				NETA_PI_CLI: join(root, "test/fixtures/fake-rmux-pi.mjs"),
				NETA_FAKE_PI_INPUT_LOG: join(state, "fake-pi-input.bin"),
				NETA_FAKE_PI_CLIENT_TRANSCRIPT: "FAKE_CLIENT_PI_TRANSCRIPT",
				NETA_FAKE_PI_SIZE_LOG: join(state, "fake-pi-sizes.log"),
				NETA_FAKE_PI_START_LOG: join(state, "fake-pi-starts.log"),
				NETA_FAKE_PI_SESSION_INPUT_LOG: join(state, "fake-pi-session-input.log"),
				RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux"),
			},
		});
	}, 30_000);

	test("packaged rmux launches staged Rust, daemon, extension, and real Pi against fake ACP", () => {
		const promptCapture = join(state, "packaged-prompts.ndjson");
		const workspace = join(state, "packaged-workspace");
		mkdirSync(state, { recursive: true });
		mkdirSync(workspace);
		writeFileSync(join(state, "settings.json"), JSON.stringify({ providers: { fake: { command: process.execPath, args: [join(root, "test/fixtures/fake-acp-agent.mjs"), "--prompt-capture", promptCapture], resume: true, defaultModel: "test-model" } }, leader: { provider: "fake", model: "test-model" }, forbiddenModels: [] }));
		execFileSync("bun", ["run", "build:tui"], { cwd: root, stdio: "inherit" });
		const packaged = join(root, "dist", "main.js");
		const { NETA_RMUX_BINARY, NETA_PI_CLI, NETA_PI_ACP_EXTENSION, RMUX_SDK_DAEMON_BINARY, NETA_PI_EXECUTABLE, ...environment } = process.env;
		execFileSync("python3", [join(root, "test/fixtures/rmux-packaged-real-e2e.py")], {
			cwd: workspace,
			stdio: "inherit",
			env: { ...environment, NETA_DIR: state, NETA_PACKAGED_CLI: packaged, NETA_PACKAGED_PROMPTS: promptCapture },
		});
	}, 45_000);

	test("navigation diagnostics export collects the local Node and Escape leaves a pasted destination untouched", async () => {
		seedFakeProvider();
		await seedArchivedTranscript();
		const other = join(state, "diagnostics-other-workspace");
		mkdirSync(other, { recursive: true });
		execFileSync("python3", [join(root, "test/fixtures/rmux-diagnostics-e2e.py")], {
			cwd: root,
			stdio: "inherit",
			env: {
				...process.env,
				NETA_DIR: state,
				NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"),
				NETA_PI_CLI: join(root, "test/fixtures/fake-rmux-pi.mjs"),
				NETA_FAKE_PI_INPUT_LOG: join(state, "fake-pi-input.bin"),
				NETA_FAKE_PI_CLIENT_TRANSCRIPT: "FAKE_CLIENT_PI_TRANSCRIPT",
				NETA_RMUX_E2E_OTHER: other,
				RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux"),
			},
		});
	}, 30_000);

	test("actual Pi copies its latest Unicode multiline ACP response through rmux and submits the bracketed paste exactly", () => {
		seedFakeProvider();
		const promptCapture = join(state, "copy-prompts.ndjson");
		writeFileSync(
			join(state, "settings.json"),
			JSON.stringify({
				providers: {
					fake: {
						command: process.execPath,
						args: [join(root, "test/fixtures/fake-acp-agent.mjs"), "--prompt-capture", promptCapture],
						resume: true,
						defaultModel: "test-model",
					},
				},
				leader: { provider: "fake", model: "test-model" },
				forbiddenModels: [],
			}),
		);
		execFileSync("bun", ["src/cli/main.ts", "node", "start", "--detach"], {
			cwd: root,
			env: { ...process.env, NETA_DIR: state },
		});
		execFileSync("python3", [join(root, "test/fixtures/rmux-copy-e2e.py")], {
			cwd: root,
			stdio: "inherit",
			env: {
				...process.env,
				NETA_DIR: state,
				NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"),
				NETA_COPY_PROMPT_CAPTURE: promptCapture,
				RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux"),
			},
		});
	}, 30_000);

	test("clicking a tab returns input to its exact workspace session", () => {
		seedFakeProvider();
		const other = join(state, "other-workspace");
		mkdirSync(other, { recursive: true });
		execFileSync("python3", [join(root, "test/fixtures/rmux-tabs-e2e.py")], {
			cwd: root,
			stdio: "inherit",
			env: {
				...process.env,
				NETA_DIR: state,
				NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"),
				NETA_PI_CLI: join(root, "test/fixtures/fake-rmux-pi.mjs"),
				NETA_FAKE_PI_INPUT_LOG: join(state, "fake-pi-input.bin"),
				NETA_FAKE_PI_START_LOG: join(state, "fake-pi-starts.log"),
				NETA_FAKE_PI_CWD_LOG: join(state, "fake-pi-cwds.log"),
				NETA_RMUX_E2E_OTHER: other,
				NETA_FAKE_PI_SESSION_INPUT_LOG: join(state, "fake-pi-session-input.log"),
				RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux"),
			},
		});
	}, 30_000);

	test("closed archived transcripts page their stored session and keep Pi read-only", async () => {
		seedFakeProvider();
		await seedArchivedTranscript();
		execFileSync("python3", [join(root, "test/fixtures/rmux-archive-e2e.py")], {
			cwd: root,
			stdio: "inherit",
			env: {
				...process.env,
				NETA_DIR: state,
				NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"),
				NETA_PI_CLI: join(root, "test/fixtures/fake-rmux-pi.mjs"),
				NETA_FAKE_PI_INPUT_LOG: join(state, "fake-pi-input.bin"),
				NETA_FAKE_PI_START_LOG: join(state, "fake-pi-starts.log"),
				RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux"),
			},
		});
	}, 30_000);

	test("real Pi preserves leader editor text while archived follow-up is inserted without submission", async () => {
		const promptCapture = join(state, "followup-prompts.ndjson");
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "settings.json"), JSON.stringify({ providers: { fake: { command: process.execPath, args: [join(root, "test/fixtures/fake-acp-agent.mjs"), "--prompt-capture", promptCapture], resume: true, defaultModel: "test-model" } }, leader: { provider: "fake", model: "test-model" }, forbiddenModels: [] }));
		const sourceMissionId = await seedArchivedTranscript();
		execFileSync("bun", ["src/cli/main.ts", "node", "start", "--detach"], { cwd: root, env: { ...process.env, NETA_DIR: state } });
		execFileSync("python3", [join(root, "test/fixtures/rmux-archive-followup-real-e2e.py")], { cwd: root, stdio: "inherit", env: { ...process.env, NETA_DIR: state, NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"), NETA_FOLLOWUP_PROMPT_CAPTURE: promptCapture, NETA_FOLLOWUP_SOURCE_MISSION_ID: sourceMissionId, RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux") } });
	}, 30_000);

	test("real Pi holds an archived follow-up draft until a cold editor signals readiness", async () => {
		const promptCapture = join(state, "followup-cold-prompts.ndjson");
		const gate = join(state, "pi-release");
		const started = join(state, "pi-gated-started");
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "settings.json"), JSON.stringify({ providers: { fake: { command: process.execPath, args: [join(root, "test/fixtures/fake-acp-agent.mjs"), "--prompt-capture", promptCapture], resume: true, defaultModel: "test-model" } }, leader: { provider: "fake", model: "test-model" }, forbiddenModels: [] }));
		const sourceMissionId = await seedArchivedTranscript();
		execFileSync("bun", ["src/cli/main.ts", "node", "start", "--detach"], { cwd: root, env: { ...process.env, NETA_DIR: state } });
		execFileSync("python3", [join(root, "test/fixtures/rmux-archive-followup-cold-real-e2e.py")], { cwd: root, stdio: "inherit", env: { ...process.env, NETA_DIR: state, NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"), NETA_PI_CLI: join(root, "test/fixtures/gated-rmux-pi.mjs"), NETA_REAL_PI_CLI: join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), NETA_PI_GATE_FILE: gate, NETA_PI_GATE_STARTED_FILE: started, NETA_FOLLOWUP_PROMPT_CAPTURE: promptCapture, NETA_FOLLOWUP_SOURCE_MISSION_ID: sourceMissionId, RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux") } });
	}, 30_000);

	test("long newest-first spine pages to the selected mission without leaking navigation keys", async () => {
		seedFakeProvider();
		await seedSpine();
		execFileSync("python3", [join(root, "test/fixtures/rmux-spine-e2e.py")], {
			cwd: root,
			stdio: "inherit",
			env: {
				...process.env,
				NETA_DIR: state,
				NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"),
				NETA_PI_CLI: join(root, "test/fixtures/fake-rmux-pi.mjs"),
				NETA_FAKE_PI_INPUT_LOG: join(state, "fake-pi-input.bin"),
				NETA_FAKE_PI_START_LOG: join(state, "fake-pi-starts.log"),
				NETA_FAKE_PI_SESSION_INPUT_LOG: join(state, "fake-pi-session-input.log"),
				RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux"),
			},
		});
	}, 30_000);

	test("a failed Pi target launch preserves the active pane and keeps the TUI interactive", async () => {
		seedFakeProvider();
		const sessionPrefix = `launch-error-${ulid()}`;
		const failedSession = `${sessionPrefix}-1`;
		await seedSpine(sessionPrefix);
		const legacy = legacyPiRoot(failedSession);
		mkdirSync(legacy);
		writeFileSync(join(legacy, "history.jsonl"), "not a Pi session header\n");
		try {
			execFileSync("python3", [join(root, "test/fixtures/rmux-launch-error-e2e.py")], {
				cwd: root,
				stdio: "inherit",
				env: {
					...process.env,
					NETA_DIR: state,
					NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"),
					NETA_PI_CLI: join(root, "test/fixtures/fake-rmux-pi.mjs"),
					NETA_FAKE_PI_START_LOG: join(state, "fake-pi-starts.log"),
					NETA_FAKE_PI_SESSION_INPUT_LOG: join(state, "fake-pi-session-input.log"),
					NETA_RMUX_FAILURE_SESSION: failedSession,
					RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux"),
				},
			});
		} finally {
			rmSync(legacy, { recursive: true, force: true });
		}
	}, 30_000);

	test("compact terminal focuses the pane, preserves input across resize, and quits", async () => {
		seedFakeProvider();
		await seedSpine();
		execFileSync("python3", [join(root, "test/fixtures/rmux-compact-e2e.py")], {
			cwd: root,
			stdio: "inherit",
			env: {
				...process.env,
				NETA_DIR: state,
				NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"),
				NETA_PI_CLI: join(root, "test/fixtures/fake-rmux-pi.mjs"),
				NETA_FAKE_PI_INPUT_LOG: join(state, "fake-pi-input.bin"),
				NETA_FAKE_PI_START_LOG: join(state, "fake-pi-starts.log"),
				NETA_FAKE_PI_SESSION_INPUT_LOG: join(state, "fake-pi-session-input.log"),
				NETA_FAKE_PI_SIZE_LOG: join(state, "fake-pi-sizes.log"),
				RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux"),
			},
		});
	}, 30_000);

	test("remote reconnect preserves the selected agent pane and keeps its input host-scoped", async () => {
		seedFakeProvider();
		const remoteAgentSession = `remote-agent-${ulid()}`;
		const failedLegacy = join(tmpdir(), "neta-rmux-pi-sessions", `h${Buffer.from("saved:fake").toString("hex")}-s${Buffer.from(remoteAgentSession).toString("hex")}`);
		writeFileSync(join(state, "settings.json"), JSON.stringify({ providers: { fake: { command: process.execPath, args: [join(root, "test/fixtures/fake-acp-agent.mjs")], resume: true, defaultModel: "test-model" } }, leader: { provider: "pi", model: "" }, forbiddenModels: [] }));
		const remote = `${state}-remote`;
		const shim = `${state}-ssh`;
		mkdirSync(shim, { recursive: true });
		execFileSync("bun", ["src/cli/main.ts", "node", "start", "--detach"], { cwd: root, env: { ...process.env, NETA_DIR: state } });
		execFileSync("bun", ["src/cli/main.ts", "open", root], { cwd: root, env: { ...process.env, NETA_DIR: state } });
		execFileSync("bun", ["src/cli/main.ts", "node", "stop"], { cwd: root, env: { ...process.env, NETA_DIR: state } });
		cpSync(state, remote, { recursive: true });
		await seedRemoteAgent(remote, remoteAgentSession);
		rmSync(join(remote, "node.json"), { force: true });
		rmSync(join(remote, "node.sock"), { force: true });
		rmSync(join(remote, "node.lock"), { force: true });
		writeFileSync(join(state, "client-hosts.json"), JSON.stringify({ hosts: [{ id: "fake", displayName: "Fake remote", sshDestination: "fake", sshConfig: null, remoteNetaDir: remote, remoteLauncher: null, lastRemoteWorkspacePath: root }] }));
		writeFileSync(join(shim, "ssh"), `#!/bin/sh\nexec python3 ${join(root, "test/fixtures/local-ssh-shim.py")} "$@"\n`);
		chmodSync(join(shim, "ssh"), 0o755);
		execFileSync("bun", ["src/cli/main.ts", "node", "start", "--detach"], { cwd: root, env: { ...process.env, NETA_DIR: remote } });
		execFileSync("python3", [join(root, "test/fixtures/rmux-workspace-picker-e2e.py")], { cwd: root, stdio: "inherit", env: { ...process.env, NETA_DIR: state, NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"), NETA_PI_CLI: join(root, "test/fixtures/fake-rmux-pi.mjs"), NETA_FAKE_PI_AUDIT_LOG: join(state, "audit.log"), NETA_RMUX_REMOTE_DIR: remote, PATH: `${shim}:${process.env.PATH}`, RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux") } });
		writeFileSync(join(state, "audit.log"), "");
		try {
			execFileSync("python3", [join(root, "test/fixtures/rmux-multihost-agent-e2e.py")], { cwd: root, stdio: "inherit", env: { ...process.env, NETA_DIR: state, NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"), NETA_PI_CLI: join(root, "test/fixtures/fake-rmux-pi.mjs"), NETA_FAKE_PI_AUDIT_LOG: join(state, "audit.log"), NETA_RMUX_REMOTE_DIR: remote, NETA_RMUX_REMOTE_AGENT_SESSION: remoteAgentSession, NETA_RMUX_STALE_FAILURE_DIR: failedLegacy, PATH: `${shim}:${process.env.PATH}`, RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux") } });
		} finally {
			rmSync(failedLegacy, { recursive: true, force: true });
		}
		writeFileSync(join(state, "audit.log"), "");
		execFileSync("python3", [join(root, "test/fixtures/rmux-multihost-e2e.py")], { cwd: root, stdio: "inherit", env: { ...process.env, NETA_DIR: state, NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"), NETA_PI_CLI: join(root, "test/fixtures/fake-rmux-pi.mjs"), NETA_FAKE_PI_AUDIT_LOG: join(state, "audit.log"), NETA_RMUX_REMOTE_DIR: remote, PATH: `${shim}:${process.env.PATH}`, RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux") } });
	}, 30_000);

	test("machine picker saves pasted SSH host fields and cancels without mutation", () => {
		seedFakeProvider();
		execFileSync("python3", [join(root, "test/fixtures/rmux-add-host-e2e.py")], { cwd: root, stdio: "inherit", env: { ...process.env, NETA_DIR: state, NETA_RMUX_BINARY: join(root, "target/debug/neta-rmux"), NETA_PI_CLI: join(root, "test/fixtures/fake-rmux-pi.mjs"), RMUX_SDK_DAEMON_BINARY: join(root, ".cache/rmux/libexec/rmux/rmux") } });
	}, 30_000);
});
