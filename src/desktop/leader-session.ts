import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { AcpConnection, type AcpSessionUpdate } from "../acp/connection.ts";
import { controlPlaneCommand, controlPlaneEnv, type LeaderLaunchContext } from "../adapters/types.ts";
import { createChannelAddress } from "../channel/protocol.ts";
import { emptySessionCheckpoint, ensureLeaderSessionDir } from "../checkpoint.ts";
import { openCheckpointForHydration, writeV6InitialState } from "../checkpoint-store.ts";
import { resolveSelfInvocation } from "../cli-shim.ts";
import { APP_NAME, getAgentDir, VERSION } from "../config.ts";
import { type DetectedLeaderBackend, detectLeaderBackends } from "../detect.ts";
import { captureLeaderSession } from "../leader-capture.ts";
import { composeFirstPrompt } from "../orchestrator/transport.ts";
import { loadCharter } from "../prompts/charter.ts";
import { materializeFlavors } from "../prompts/flavors.ts";
import { buildLeaderPrompt } from "../prompts/leader.ts";
import {
	buildRecoverySummary,
	proveManagerStopped,
	requireCheckpointCwd,
	requireLeaderConversationId,
} from "../recovery.ts";
import {
	type CheckpointClaim,
	canonicalizeCwd,
	findLiveSessionsInDirectory,
	isSessionAlive,
	listSessions,
	releaseSessionLock,
	type SessionLock,
	tryAcquireCheckpointClaim,
	tryAcquireSessionLock,
} from "../session.ts";
import { loadConfig } from "../settings.ts";
import { TIERS, type Tier } from "../types.ts";
import { detectWorkspaceBinding, readWorkspaceBinding, restoreWorkspace, writeWorkspaceBinding } from "../workspace.ts";

export interface DesktopMessage {
	id: string;
	author: "user" | "agent" | "system";
	text: string;
	at: number;
}

export interface DesktopMessagePage {
	cursor: number;
	messages: DesktopMessage[];
}

export interface DesktopLeaderOptions {
	cwd: string;
	backend?: string;
	agentDir?: string;
}

export interface DesktopResumeOptions {
	checkpointId: string;
	agentDir?: string;
}

interface PreparedDesktopLeader {
	logicalId: string;
	cwd: string;
	agentDir: string;
	backend: DetectedLeaderBackend;
	leaderPrompt: string;
	sessionTiers: Tier[];
	lock: SessionLock;
	resumeConversationId?: string;
	checkpointClaim?: CheckpointClaim;
}

const REGISTRATION_TIMEOUT_MS = 10_000;

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function chooseBackend(
	installed: DetectedLeaderBackend[],
	configured: string | undefined,
	requested: string | undefined,
): DetectedLeaderBackend {
	const id = requested ?? configured ?? installed[0]?.id;
	const backend = installed.find((candidate) => candidate.id === id);
	if (backend) return backend;
	if (id) throw new Error(`Leader backend "${id}" is not installed or is disabled.`);
	throw new Error("No leader backend is installed. Install Claude Code, Codex, or OpenCode first.");
}

async function waitForRegistration(logicalId: string, agentDir: string): Promise<string | undefined> {
	const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
	do {
		const record = listSessions(agentDir).find((session) => session.checkpointId === logicalId);
		if (record) return record.id;
		await delay(50);
	} while (Date.now() < deadline);
	return undefined;
}

export class DesktopLeaderSession {
	readonly logicalId: string;
	readonly cwd: string;
	readonly name: string;
	readonly backend: string;
	private readonly agentDir: string;
	private readonly sessionDir: string;
	private readonly connection: AcpConnection;
	private readonly leaderPrompt: string;
	private checkpointClaim: CheckpointClaim | undefined;
	private readonly messages: DesktopMessage[] = [];
	private firstPrompt = true;
	private activePrompt = false;
	private assistantText = "";
	private registeredSessionId: string | undefined;
	private stopped = false;

	private constructor(options: {
		logicalId: string;
		cwd: string;
		backend: string;
		agentDir: string;
		sessionDir: string;
		connection: AcpConnection;
		leaderPrompt: string;
		checkpointClaim?: CheckpointClaim;
	}) {
		this.logicalId = options.logicalId;
		this.cwd = options.cwd;
		this.name = basename(options.cwd);
		this.backend = options.backend;
		this.agentDir = options.agentDir;
		this.sessionDir = options.sessionDir;
		this.connection = options.connection;
		this.leaderPrompt = options.leaderPrompt;
		this.checkpointClaim = options.checkpointClaim;
	}

	static async start(options: DesktopLeaderOptions): Promise<DesktopLeaderSession> {
		const cwd = canonicalizeCwd(options.cwd);
		const agentDir = options.agentDir ?? getAgentDir();
		const existing = findLiveSessionsInDirectory(cwd, agentDir);
		if (existing.length > 0) {
			throw new Error(`A Neta session is already running in ${cwd}. It is already available on the canvas.`);
		}

		const lock = tryAcquireSessionLock(cwd, agentDir);
		if (!lock) throw new Error(`Another Neta launch is already starting in ${cwd}.`);
		try {
			const config = loadConfig(cwd, agentDir);
			const installed = detectLeaderBackends().filter((candidate) => !config.isBackendDisabled(candidate.id));
			const backend = chooseBackend(installed, config.leader.backend, options.backend);
			const logicalId = randomBytes(12).toString("hex");
			const initial = emptySessionCheckpoint({
				id: logicalId,
				canonicalCwd: cwd,
				leaderBackend: backend.id,
				sessionTiers: [...TIERS],
			});
			writeV6InitialState(
				(({ workers: _workers, ...state }) => state)(initial),
				join(agentDir, "checkpoints-v6", logicalId),
			);
			const workspaceBinding = await detectWorkspaceBinding(cwd, logicalId);
			if (workspaceBinding) {
				try {
					writeWorkspaceBinding(workspaceBinding, agentDir);
				} catch {
					// Optional Worktrunk restoration metadata must never weaken the
					// checkpoint-backed launch guarantee.
				}
			}

			const flavors = await materializeFlavors(agentDir, cwd).catch(() => []);
			const leaderPrompt = buildLeaderPrompt({
				tiers: config.tierMapping(),
				availableTiers: TIERS,
				charter: loadCharter(cwd, agentDir),
				flavors,
				control: "mcp",
				toolName: (base) => base,
			});
			return await DesktopLeaderSession.launchPrepared({
				logicalId,
				cwd,
				agentDir,
				backend,
				leaderPrompt,
				sessionTiers: [...TIERS],
				lock,
			});
		} finally {
			releaseSessionLock(lock);
		}
	}

	static async resume(options: DesktopResumeOptions): Promise<DesktopLeaderSession> {
		const agentDir = options.agentDir ?? getAgentDir();
		let claim: CheckpointClaim | undefined = tryAcquireCheckpointClaim(options.checkpointId, agentDir);
		if (!claim) throw new Error(`Another resume of ${options.checkpointId} is already running.`);
		let lock: SessionLock | undefined;
		try {
			const checkpoint = openCheckpointForHydration(options.checkpointId, agentDir, claim);
			const binding = readWorkspaceBinding(checkpoint.id, agentDir);
			if (binding) {
				await restoreWorkspace(binding);
			} else if (!existsSync(checkpoint.canonicalCwd)) {
				throw new Error(
					`Session ${checkpoint.id} ran in ${checkpoint.canonicalCwd}, which no longer exists and has no Worktrunk binding.`,
				);
			}
			const cwd = requireCheckpointCwd(checkpoint);
			lock = tryAcquireSessionLock(cwd, agentDir);
			if (!lock) throw new Error(`Another Neta launch holds the lock for ${cwd}.`);
			const live = findLiveSessionsInDirectory(cwd, agentDir).filter(isSessionAlive);
			if (live.length > 0) throw new Error(`A Neta session is already running in ${cwd}.`);
			await proveManagerStopped(checkpoint, { agentDir });
			const conversationId = requireLeaderConversationId(checkpoint, agentDir);
			const config = loadConfig(cwd, agentDir);
			if (config.isBackendDisabled(checkpoint.leader.backend)) {
				throw new Error(`Backend "${checkpoint.leader.backend}" is disabled in settings.`);
			}
			const installed = detectLeaderBackends().filter((candidate) => !config.isBackendDisabled(candidate.id));
			const backend = installed.find((candidate) => candidate.id === checkpoint.leader.backend);
			if (!backend)
				throw new Error(`Session ${checkpoint.id} requires ${checkpoint.leader.backend}, which is not installed.`);
			const sessionTiers = checkpoint.sessionTiers ?? [...TIERS];
			const flavors = await materializeFlavors(agentDir, cwd).catch(() => []);
			const leaderPrompt = buildLeaderPrompt({
				tiers: config.tierMapping(),
				availableTiers: sessionTiers,
				charter: loadCharter(cwd, agentDir),
				flavors,
				control: "mcp",
				toolName: (base) => base,
				recovery: buildRecoverySummary(checkpoint, VERSION),
			});
			const workspaceBinding = await detectWorkspaceBinding(cwd, checkpoint.id);
			if (workspaceBinding) {
				try {
					writeWorkspaceBinding(workspaceBinding, agentDir);
				} catch {
					// The exact checkpoint resume remains valid without this optional hint.
				}
			}
			const owner = await DesktopLeaderSession.launchPrepared({
				logicalId: checkpoint.id,
				cwd,
				agentDir,
				backend,
				leaderPrompt,
				sessionTiers,
				lock,
				resumeConversationId: conversationId,
				checkpointClaim: claim,
			});
			claim = undefined;
			lock = undefined;
			return owner;
		} finally {
			releaseSessionLock(lock);
			releaseSessionLock(claim);
		}
	}

	private static async launchPrepared(options: PreparedDesktopLeader): Promise<DesktopLeaderSession> {
		const config = loadConfig(options.cwd, options.agentDir);
		const launcher = config.launcher(options.backend.id);
		if (!launcher.command) throw new Error(`Backend "${options.backend.id}" has no ACP command configured.`);
		const sessionDir = await mkdtemp(join(tmpdir(), `${APP_NAME}-desktop-`));
		try {
			const managerId = `desktop-${process.pid}-${randomBytes(3).toString("hex")}`;
			const invocation = resolveSelfInvocation();
			const launchContext: LeaderLaunchContext = {
				backend: options.backend,
				cwd: options.cwd,
				sessionDir,
				sessionId: managerId,
				logicalSessionId: options.logicalId,
				leaderSessionDir: ensureLeaderSessionDir(options.logicalId, options.agentDir),
				agentDir: options.agentDir,
				...(options.resumeConversationId ? { resumeConversationId: options.resumeConversationId } : {}),
				socket: createChannelAddress(),
				token: randomBytes(16).toString("hex"),
				leaderPrompt: options.leaderPrompt,
				sessionTiers: options.sessionTiers,
				invocation,
				strictMcp: config.leader.strictMcp,
				extraArgs: [],
				mux: "none",
				panes: false,
			};
			const controlPlane = controlPlaneCommand(launchContext);
			const controlEnv = {
				...controlPlaneEnv(launchContext),
				NETA_SESSION_LOCK_PATH: options.lock.path,
				NETA_SESSION_LOCK_TOKEN: options.lock.token,
			};
			let owner: DesktopLeaderSession | undefined;
			const connection = new AcpConnection({
				command: launcher.command,
				args: launcher.args,
				cwd: options.cwd,
				env: launcher.env,
				allowMutations: false,
				...(options.resumeConversationId ? { resumeSessionId: options.resumeConversationId } : {}),
				mcpServers: [{ name: "neta", command: controlPlane.command, args: controlPlane.args, env: controlEnv }],
				onUpdate: (update) => owner?.sessionUpdate(update),
				onStderr: (text) => owner?.append("system", text),
				onDenied: (kind, title) => owner?.append("system", `Denied ${kind}: ${title}`),
				onVendorSession: (sessionId) => {
					captureLeaderSession({
						checkpointId: options.logicalId,
						agentDir: options.agentDir,
						payload: JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId }),
						write: (line) => owner?.append("system", line),
					});
				},
			});
			owner = new DesktopLeaderSession({
				logicalId: options.logicalId,
				cwd: options.cwd,
				backend: options.backend.id,
				agentDir: options.agentDir,
				sessionDir,
				connection,
				leaderPrompt: options.leaderPrompt,
				checkpointClaim: options.checkpointClaim,
			});
			await connection.start();
			owner.registeredSessionId = await waitForRegistration(options.logicalId, options.agentDir);
			if (!owner.registeredSessionId) {
				await connection.kill();
				throw new Error("The leader ACP session started, but its Neta control plane did not register.");
			}
			owner.append(
				"system",
				`${options.resumeConversationId ? "Resumed" : "Connected"} through ACP to ${options.backend.name}.`,
			);
			return owner;
		} catch (error) {
			await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
	}

	get sessionId(): string | undefined {
		return this.registeredSessionId;
	}

	get state(): "running" | "thinking" | "failed" {
		if (this.stopped) return "failed";
		return this.activePrompt ? "thinking" : "running";
	}

	messagePage(since = 0): DesktopMessagePage {
		const cursor = Math.max(0, Math.min(Math.trunc(since), this.messages.length));
		return { cursor: this.messages.length, messages: this.messages.slice(cursor) };
	}

	async prompt(text: string): Promise<DesktopMessage> {
		if (this.stopped) throw new Error("This leader session is closed.");
		if (this.activePrompt) throw new Error("The leader is already handling a message.");
		const clean = text.trim();
		if (!clean) throw new Error("Message cannot be empty.");
		this.append("user", clean);
		this.activePrompt = true;
		this.assistantText = "";
		try {
			const prompt = this.firstPrompt ? composeFirstPrompt(this.leaderPrompt, clean) : clean;
			this.firstPrompt = false;
			const response: PromptResponse = await this.connection.prompt(prompt);
			const output = this.assistantText.trim() || `(turn ended: ${response.stopReason})`;
			return this.append("agent", output);
		} finally {
			this.activePrompt = false;
			this.assistantText = "";
		}
	}

	async cancel(): Promise<void> {
		if (!(await this.connection.cancel())) throw new Error("The leader has no active ACP session.");
	}

	async close(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		try {
			await this.connection.kill();
		} finally {
			await rm(this.sessionDir, { recursive: true, force: true }).catch(() => {});
			releaseSessionLock(this.checkpointClaim);
			this.checkpointClaim = undefined;
		}
	}

	private sessionUpdate(update: AcpSessionUpdate): void {
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text") this.assistantText += update.content.text;
				break;
			case "tool_call":
				this.append("system", update.title);
				break;
			case "usage_update":
			case "agent_thought_chunk":
			case "tool_call_update":
			case "config_option_update":
			case "current_mode_update":
				break;
		}
	}

	private append(author: DesktopMessage["author"], text: string): DesktopMessage {
		const message = {
			id: `leader-${this.messages.length + 1}`,
			author,
			text,
			at: Date.now(),
		} satisfies DesktopMessage;
		this.messages.push(message);
		return message;
	}
}
