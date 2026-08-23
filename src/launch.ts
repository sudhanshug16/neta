/**
 * Starting a leader session.
 *
 * `neta` detects the agent CLIs you have, picks one, and launches its native UI
 * with Neta's instructions, control plane and restrictions injected. From that
 * point the user is talking to the CLI they already know; Neta is behind it.
 *
 * The process tree matters. Neta's launcher is the parent, the vendor CLI is
 * its child, and the control plane (`neta mcp`) is the vendor's child — which
 * is exactly why the control plane escapes the vendor's sandbox and can spawn
 * workers when the leader's own shell cannot.
 */

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeInheritedEnv } from "./acp/connection.ts";
import { adapterFor } from "./adapters/index.ts";
import type { LeaderLaunch } from "./adapters/types.ts";
import { createChannelAddress } from "./channel/protocol.ts";
import { emptySessionCheckpoint, ensureLeaderSessionDir } from "./checkpoint.ts";
import { openCheckpointForHydration, writeV6Checkpoint } from "./checkpoint-store.ts";
import { resolveSelfInvocation } from "./cli-shim.ts";
import { APP_NAME, getAgentDir, VERSION } from "./config.ts";
import { type DetectedLeaderBackend, detectLeaderBackends, LEADER_BACKENDS } from "./detect.ts";
import { attachSessionSpec, selectMux } from "./mux/index.ts";
import { zellijIdentityPath } from "./mux/zellij.ts";
import { loadCharter } from "./prompts/charter.ts";
import { materializeFlavors } from "./prompts/flavors.ts";
import { buildLeaderPrompt } from "./prompts/leader.ts";
import {
	buildRecoverySummary,
	proveManagerStopped,
	requireCheckpointCwd,
	requireLeaderConversationId,
} from "./recovery.ts";
import {
	canonicalizeCwd,
	findLiveSessionsInDirectory,
	isSessionAlive,
	releaseSessionLock,
	type SessionLock,
	type SessionRecord,
	sweepStaleSessions,
	tryAcquireCheckpointClaim,
	tryAcquireSessionLock,
} from "./session.ts";
import { loadConfig } from "./settings.ts";
import {
	chooseSessionTiers,
	EmptyTierSelection,
	type PreflightTerminal,
	processPreflightTerminal,
	promptForLeaderBackend,
	StartupCancelled,
} from "./startup/preflight.ts";
import { TIERS, type Tier } from "./types.ts";

export interface LaunchOptions {
	cwd: string;
	/** Backend id from `--leader`; falls back to settings, then to asking. */
	leader?: string;
	/** Multiplexer from `--mux`; falls back to settings. */
	mux?: string;
	/** Arguments passed through to the vendor CLI after `--`. */
	extraArgs: string[];
	agentDir?: string;
	/** Test seam for the startup selectors; defaults to this process's terminal. */
	terminal?: PreflightTerminal;
}

export interface ResumeOptions extends Omit<LaunchOptions, "cwd" | "leader"> {
	/** The durable checkpoint id, exactly as `neta sessions --all` prints it. */
	checkpointId: string;
	/** Where the command was typed; only used for messages, never to pick a session. */
	cwd?: string;
	write?: (line: string) => void;
}

export class LaunchError extends Error {}

/** Below this, a multiplexer exiting non-zero means it never got a session up. */
const MUX_STARTUP_MS = 5000;

const LOCK_RETRY_MS = 25;

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type DirectorySession = { lock: SessionLock } | { existing: SessionRecord[] };

/**
 * The control plane writes the registry record, not the launcher. Keep this
 * lock until that child has registered, so two bare launches cannot both get
 * through the sweep-and-check gap.
 */
async function claimDirectorySession(cwd: string, agentDir: string): Promise<DirectorySession> {
	for (;;) {
		const lock = tryAcquireSessionLock(cwd, agentDir);
		if (lock) {
			sweepStaleSessions(agentDir);
			const existing = findLiveSessionsInDirectory(cwd, agentDir);
			if (existing.length > 0) {
				releaseSessionLock(lock);
				return { existing };
			}
			return { lock };
		}

		// A competing launcher owns the gap before its control plane records the
		// session. Re-check its result instead of starting another leader.
		const existing = findLiveSessionsInDirectory(cwd, agentDir);
		if (existing.length > 0) return { existing };
		await delay(LOCK_RETRY_MS);
	}
}

function headlessSessionsMessage(sessions: SessionRecord[]): string {
	return (
		"Neta found live sessions in this directory, but none has a recorded multiplexer session; each one runs headless:\n" +
		sessions
			.map(
				(session) =>
					`- ${session.id} (pid ${session.pid}, started ${new Date(session.startedAt).toISOString()}, headless): ` +
					`reach it with \`neta workers --session ${session.id}\` or \`neta watch <worker>\`; ` +
					`stop work with \`neta kill <worker> --session ${session.id}\` or stop the leader with \`kill ${session.pid}\`.`,
			)
			.join("\n")
	);
}

async function reconnectToSession(session: SessionRecord): Promise<number> {
	if (!session.mux) throw new LaunchError(headlessSessionsMessage([session]));
	const spec = attachSessionSpec(session.mux.id, session.mux.name);
	return new Promise<number>((resolve) => {
		const child = spawn(spec.command, spec.args, { stdio: "inherit" });
		child.on("error", (error) => {
			process.stderr.write(`${APP_NAME}: could not reattach ${session.mux?.id}: ${error.message}\n`);
			resolve(1);
		});
		child.on("close", (status, signal) => resolve(signal ? 1 : (status ?? 0)));
	});
}

/**
 * Which CLI leads. An explicit choice wins, then settings, then the only one
 * installed; with several installed and no preference, ask with a real selector.
 *
 * The detected list is already filtered to backends that are installed and not
 * disabled, so a disabled leader is simply not offered — while an explicit
 * `--leader` naming one still gets a hard error from the caller rather than a
 * quiet substitution.
 */
export async function chooseBackend(
	detected: DetectedLeaderBackend[],
	requested: string | undefined,
	configured: string | undefined,
	terminal: PreflightTerminal = processPreflightTerminal(),
): Promise<DetectedLeaderBackend> {
	if (detected.length === 0) {
		const installs = LEADER_BACKENDS.map((spec) => `  ${spec.name}: ${spec.install}`).join("\n");
		throw new LaunchError(`No agent CLI found on PATH. Neta leads with one of these:\n${installs}`);
	}

	for (const [source, id] of [
		["--leader", requested],
		["settings", configured],
	] as const) {
		if (!id) continue;
		const match = detected.find((backend) => backend.id === id);
		if (match) return match;
		const available = detected.map((backend) => backend.id).join(", ");
		throw new LaunchError(`${source} asked for "${id}", which is not installed. Installed: ${available}.`);
	}

	if (detected.length === 1) return detected[0];
	if (!terminal.interactive) {
		throw new LaunchError(
			`Several agent CLIs are installed (${detected.map((b) => b.id).join(", ")}). ` +
				`Pick one with --leader <id>, or set leader.backend in settings.`,
		);
	}

	return promptForLeaderBackend(terminal, detected);
}

/** Runs a leader session to completion and resolves with its exit code. */
export async function launchLeader(options: LaunchOptions): Promise<number> {
	const cwd = canonicalizeCwd(options.cwd);
	const agentDir = options.agentDir ?? getAgentDir();
	const claimed = await claimDirectorySession(cwd, agentDir);
	// Keep the liveness decision at the reattach point, even though the sweep
	// and registry lookup already reject dead managers. A stale record must
	// never turn into a terminal attached to an orphaned mux session.
	if ("existing" in claimed) {
		const liveSessions = claimed.existing.filter(isSessionAlive);
		if (liveSessions.length === 0) return launchLeader(options);
		const attachable = liveSessions.find((session) => session.mux);
		if (attachable) return reconnectToSession(attachable);
		throw new LaunchError(headlessSessionsMessage(liveSessions));
	}
	const lock = claimed.lock;
	try {
		const config = loadConfig(cwd, agentDir);
		const preferredLeader = options.leader ?? config.leader.backend;
		if (preferredLeader && config.isBackendDisabled(preferredLeader)) {
			throw new LaunchError(`Backend "${preferredLeader}" is disabled in settings.`);
		}
		const detected = detectLeaderBackends().filter(({ id }) => config.backendNames().includes(id));
		const terminal = options.terminal ?? processPreflightTerminal();
		let backend: DetectedLeaderBackend;
		let sessionTiers: Tier[];
		try {
			backend = await chooseBackend(detected, options.leader, config.leader.backend, terminal);
			// Asked even when `--leader` decided the backend: the two questions are
			// independent, and skipping the checklist because one of them was answered
			// on the command line would silently staff every tier.
			sessionTiers = await chooseSessionTiers({ terminal, agentDir });
		} catch (error) {
			// Esc is an ordinary answer, not a failure. Say one line and stop with the
			// conventional interrupted-by-user code; nothing has been started yet.
			if (error instanceof StartupCancelled) {
				process.stderr.write(`${APP_NAME}: cancelled; no leader was started.\n`);
				return 130;
			}
			if (error instanceof EmptyTierSelection) throw new LaunchError(error.message);
			throw error;
		}
		const logicalSessionId = randomBytes(12).toString("hex");
		// Claude Code lets the caller name the conversation, so Neta assigns one
		// and records it before the CLI starts. That is what makes an exact
		// `--resume <uuid>` possible later without asking the vendor to guess.
		const leaderConversationId = backend.id === "claude" ? randomUUID() : undefined;
		// Fail closed, before any leader process exists. Nothing retries this write
		// in time — the control plane that would is started by the vendor CLI — so
		// carrying on here would hand the user a session that looks normal and can
		// never be resumed, which is the exact failure this is here to prevent.
		try {
			writeV6Checkpoint(
				emptySessionCheckpoint({
					id: logicalSessionId,
					canonicalCwd: cwd,
					leaderBackend: backend.id,
					leaderVendorConversationId: leaderConversationId,
					sessionTiers,
				}),
				join(agentDir, "checkpoints-v6", logicalSessionId),
			);
		} catch (error) {
			throw new LaunchError(
				`Neta could not record this session in ${agentDir}, so it would not be resumable: ` +
					`${error instanceof Error ? error.message : String(error)}\n` +
					`No leader was started. Fix that directory (or point NETA_DIR elsewhere) and run \`${APP_NAME}\` again.`,
			);
		}
		return await runLeaderSession({
			cwd,
			agentDir,
			config,
			backend,
			logicalSessionId,
			leaderConversationId,
			sessionTiers,
			lock,
			options,
		});
	} finally {
		// Normally the control plane releases this immediately after registering.
		// If the vendor never starts it, do not leave later launches wedged.
		releaseSessionLock(lock);
	}
}

/**
 * `neta resume <id>` — reopen one closed session by its exact durable id.
 *
 * The id is authoritative: it decides the directory, the backend and the vendor
 * conversation, and every one of those is verified rather than inferred. If any
 * check fails, nothing is launched and the checkpoint is left exactly as it was.
 */
export async function resumeLeader(options: ResumeOptions): Promise<number> {
	const agentDir = options.agentDir ?? getAgentDir();
	const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
	const checkpoint = openCheckpointForHydration(options.checkpointId, agentDir);
	const cwd = requireCheckpointCwd(checkpoint);

	// Two claims, because they answer different questions: the checkpoint claim
	// stops a second `neta resume <id>`, and the directory lock stops a plain
	// `neta` in the same directory from racing it.
	const claim = tryAcquireCheckpointClaim(checkpoint.id, agentDir);
	if (!claim) {
		throw new LaunchError(
			`Another \`${APP_NAME} resume ${checkpoint.id}\` is already running. Wait for it, or check \`${APP_NAME} sessions --all\`.`,
		);
	}
	try {
		const lock = tryAcquireSessionLock(cwd, agentDir);
		if (!lock) {
			throw new LaunchError(`Another Neta launch holds the lock for ${cwd}. Try again in a moment.`);
		}
		try {
			const live = findLiveSessionsInDirectory(cwd, agentDir).filter(isSessionAlive);
			if (live.length > 0) {
				throw new LaunchError(
					`A Neta session (${live.map((session) => session.id).join(", ")}) is already running in ${cwd}. ` +
						`Reattach with \`${APP_NAME}\` there instead of resuming.`,
				);
			}
			// Nothing from the old run may still be running before its state is
			// reopened. This proves it, or refuses.
			for (const note of await proveManagerStopped(checkpoint, { agentDir })) write(`${APP_NAME}: ${note}`);
			const conversationId = requireLeaderConversationId(checkpoint, agentDir);

			const config = loadConfig(cwd, agentDir);
			if (config.isBackendDisabled(checkpoint.leader.backend)) {
				throw new LaunchError(`Backend "${checkpoint.leader.backend}" is disabled in settings.`);
			}
			const detected = detectLeaderBackends().filter(({ id }) => config.backendNames().includes(id));
			const backend = detected.find(({ id }) => id === checkpoint.leader.backend);
			if (!backend) {
				throw new LaunchError(
					`Session ${checkpoint.id} was led by "${checkpoint.leader.backend}", which is not installed here. ` +
						`Install it to resume; the checkpoint was left unchanged.`,
				);
			}
			// The session's own tiers, never today's startup preferences. Its
			// recorded workers were staffed under this answer, and a resume that
			// silently widened or narrowed it would contradict its own history. A
			// checkpoint written before session tiers existed reads as every tier,
			// which is what those sessions actually ran with.
			const sessionTiers = checkpoint.sessionTiers ?? [...TIERS];
			write(
				`${APP_NAME}: resuming ${checkpoint.id} in ${cwd} · ${backend.name} conversation ${conversationId} · ` +
					`tiers ${sessionTiers.join(", ")} · saved by Neta ${checkpoint.appVersion}, now ${VERSION}`,
			);
			return await runLeaderSession({
				cwd,
				agentDir,
				config,
				backend,
				logicalSessionId: checkpoint.id,
				sessionTiers,
				resumeConversationId: conversationId,
				recovery: buildRecoverySummary(checkpoint, VERSION),
				lock,
				options: { ...options, cwd, extraArgs: options.extraArgs },
			});
		} finally {
			releaseSessionLock(lock);
		}
	} finally {
		releaseSessionLock(claim);
	}
}

interface LeaderSessionParams {
	cwd: string;
	agentDir: string;
	config: ReturnType<typeof loadConfig>;
	backend: DetectedLeaderBackend;
	logicalSessionId: string;
	leaderConversationId?: string;
	resumeConversationId?: string;
	/** Worker tiers this session may staff, for the whole life of the session. */
	sessionTiers: Tier[];
	/** Recovered-state briefing, appended to the leader instructions on resume. */
	recovery?: string;
	lock: SessionLock;
	options: LaunchOptions | ResumeOptions;
}

/** The launch path both a fresh session and a resumed one run through. */
async function runLeaderSession(params: LeaderSessionParams): Promise<number> {
	const { cwd, agentDir, config, backend, logicalSessionId, lock } = params;
	const options = params.options;
	const sessionId = `${process.pid}-${randomBytes(3).toString("hex")}`;
	const sessionDir = await mkdtemp(join(tmpdir(), `${APP_NAME}-session-`));
	// Also before the vendor starts: this directory holds the state a resume
	// needs (the Codex overlay home, OpenCode's capture plugin), so a session
	// that cannot have one is a session that must not start.
	let leaderSessionDir: string;
	try {
		leaderSessionDir = ensureLeaderSessionDir(logicalSessionId, agentDir);
	} catch (error) {
		throw new LaunchError(
			`Neta could not create this session's directory under ${agentDir}, so it would not be resumable: ` +
				`${error instanceof Error ? error.message : String(error)}\nNo leader was started.`,
		);
	}
	const invocation = resolveSelfInvocation();
	// Resolve every value the control plane needs before registration. Codex
	// starts MCP servers with a cleared environment, keeping only this explicit
	// adapter config, so adding mux values after prepare() loses worker tabs.
	const mux = selectMux(options.mux ? normalizeMux(options.mux) : config.mux.mode);
	const showing = config.mux.panes && mux.id !== "none";
	const muxSessionName = showing ? (mux.sessionName() ?? `neta-${sessionId}`) : undefined;
	// Only carry native identity that exists in this launch environment. These
	// values are enough for the manager to address the caller's mux, without
	// copying the rest of the ambient environment into an MCP child. In
	// particular, never invent a pane id for a newly-created session: Zellij
	// assigns it after this point, and acting on a guessed identity is worse than
	// failing closed.
	const tmux = mux.id === "tmux" ? process.env.TMUX || undefined : undefined;
	const zellij = mux.id === "zellij" ? process.env.ZELLIJ || undefined : undefined;
	const zellijSessionName = mux.id === "zellij" ? process.env.ZELLIJ_SESSION_NAME || undefined : undefined;
	const zellijPaneId = mux.id === "zellij" ? process.env.ZELLIJ_PANE_ID || undefined : undefined;
	const zellijIdentityFile = mux.id === "zellij" && !mux.inSession() ? zellijIdentityPath(sessionDir) : undefined;

	const adapter = adapterFor(backend.id);
	const flavors = await materializeFlavors(agentDir, cwd).catch(() => []);
	// Rebuilt from the installed code on every run, including a resume: the
	// point of resuming into a newer Neta is getting today's instructions,
	// today's MCP registration and today's restrictions.
	const leaderPrompt = buildLeaderPrompt({
		tiers: config.tierMapping(),
		// A leader told about a tier it cannot staff will try to use it and get an
		// error; the prompt describes only the ladder this session actually has.
		availableTiers: params.sessionTiers,
		charter: loadCharter(cwd, agentDir),
		flavors,
		control: "mcp",
		// This vendor's names, not ours: a prompt naming tools that do not exist
		// leaves the leader with no way to delegate.
		toolName: (base) => adapter.toolName(base),
		recovery: params.recovery,
	});

	const launchContext = {
		backend,
		cwd,
		sessionDir,
		sessionId,
		logicalSessionId,
		leaderSessionDir,
		agentDir,
		leaderConversationId: params.leaderConversationId,
		resumeConversationId: params.resumeConversationId,
		captureCommand: {
			command: invocation.command,
			args: [...invocation.prefixArgs, "capture-leader-session", "--session", logicalSessionId, "--dir", agentDir],
		},
		socket: createChannelAddress(),
		token: randomBytes(16).toString("hex"),
		leaderPrompt,
		sessionTiers: params.sessionTiers,
		invocation,
		strictMcp: config.leader.strictMcp,
		extraArgs: options.extraArgs,
		mux: mux.id,
		panes: showing,
		muxSessionName,
		tmux,
		zellij,
		zellijSessionName,
		zellijPaneId,
		zellijIdentityFile,
	};
	// An adapter refuses a launch it cannot make resumable, or one whose
	// pass-through arguments would move the conversation. Those are answers for
	// the user, not crashes: report them as launch errors, with nothing started.
	let launch: LeaderLaunch;
	try {
		launch = await adapter.prepare(launchContext);
	} catch (error) {
		if (error instanceof LaunchError) throw error;
		throw new LaunchError(
			`${APP_NAME} cannot start ${backend.name} for this session: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	// Panes need a multiplexer session; if we are not in one, start one around
	// the leader so its workers have somewhere to appear.

	for (const warning of launch.warnings) process.stderr.write(`${APP_NAME}: ${warning}\n`);

	// The leader is a fresh session of that vendor's CLI, exactly like a worker
	// is, so it must not inherit the runtime of whatever agent session Neta was
	// started from — running `neta` inside Claude Code otherwise hands the new
	// leader its parent's session variables and job directory.
	const env = {
		...sanitizeInheritedEnv(process.env),
		...launch.env,
		NETA_SESSION_LOCK_PATH: lock.path,
		NETA_SESSION_LOCK_TOKEN: lock.token,
	};
	// tmux keeps a server-global environment captured by its first session. The
	// server otherwise gives every later leader that first leader's socket and
	// token. Adapters receive the complete launch environment so they can pass it
	// directly to the process they start, rather than relying on that inheritance.
	const leader = { command: launch.command, args: launch.args, env };
	const wrapped = showing
		? (mux.wrapLeader(leader, muxSessionName ?? `neta-${sessionId}`, sessionDir) ?? leader)
		: leader;

	process.stderr.write(
		`${APP_NAME}: leading with ${backend.name} · workers ${showing ? `in ${mux.id} tabs` : "headless"}` +
			// Being dropped inside a multiplexer you did not choose, with no idea how
			// to leave, is its own kind of trap.
			`${wrapped !== leader ? " · quitting the leader ends the session" : ""}\n`,
	);

	const run = (spec: { command: string; args: string[]; env?: Record<string, string> }) =>
		new Promise<number>((resolve) => {
			// The control plane is the process that opens panes, and it is a child
			// of the leader rather than of us, so the choice travels by environment.
			const child = spawn(spec.command, spec.args, { cwd, env: spec.env ?? env, stdio: "inherit" });
			child.on("error", (error) => {
				process.stderr.write(`${APP_NAME}: could not start ${spec.command}: ${error.message}\n`);
				resolve(1);
			});
			child.on("close", (status, signal) => resolve(signal ? 1 : (status ?? 0)));
		});

	const startedAt = Date.now();
	let code = await run(wrapped);

	// Panes are a convenience and must never cost the user their session. A
	// multiplexer that fails this fast never started one: when the leader itself
	// exits, the multiplexer keeps its session open rather than returning an
	// error in a second.
	if (wrapped !== leader && code !== 0 && Date.now() - startedAt < MUX_STARTUP_MS) {
		process.stderr.write(
			`${APP_NAME}: ${mux.id} exited immediately (${code}); starting ${backend.name} without panes.\n`,
		);
		// MCP configuration is generated before the vendor starts. Rebuild it for
		// the fallback too: Codex clears the MCP child's inherited environment and
		// would otherwise keep trying the failed mux from its original TOML env.
		const fallbackLaunch = await adapter.prepare({
			...launchContext,
			mux: "none",
			panes: false,
			muxSessionName: undefined,
			tmux: undefined,
			zellij: undefined,
			zellijSessionName: undefined,
			zellijPaneId: undefined,
			zellijIdentityFile: undefined,
		});
		code = await run({
			command: fallbackLaunch.command,
			args: fallbackLaunch.args,
			env: {
				...sanitizeInheritedEnv(process.env),
				...fallbackLaunch.env,
				NETA_SESSION_LOCK_PATH: lock.path,
				NETA_SESSION_LOCK_TOKEN: lock.token,
			},
		});
		await fallbackLaunch.cleanup?.().catch(() => {});
	}

	await launch.cleanup?.().catch(() => {});
	// The per-run directory goes; the logical session's own directory stays,
	// because vendors record absolute paths into their session indexes.
	await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
	return code;
}

function normalizeMux(value: string): "auto" | "zellij" | "tmux" | "none" {
	if (value === "zellij" || value === "tmux" || value === "none" || value === "auto") return value;
	throw new LaunchError(`Unknown multiplexer "${value}". Use zellij, tmux, none or auto.`);
}
