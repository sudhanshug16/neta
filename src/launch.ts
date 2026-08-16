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
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { sanitizeInheritedEnv } from "./acp/connection.ts";
import { adapterFor } from "./adapters/index.ts";
import { createChannelAddress } from "./channel/protocol.ts";
import { resolveSelfInvocation } from "./cli-shim.ts";
import { APP_NAME, getAgentDir } from "./config.ts";
import { type DetectedLeaderBackend, detectLeaderBackends, LEADER_BACKENDS } from "./detect.ts";
import { attachSessionSpec, selectMux } from "./mux/index.ts";
import { loadCharter } from "./prompts/charter.ts";
import { materializeFlavors } from "./prompts/flavors.ts";
import { buildLeaderPrompt } from "./prompts/leader.ts";
import {
	canonicalizeCwd,
	findLiveSessionInDirectory,
	releaseSessionLock,
	type SessionLock,
	type SessionRecord,
	sweepStaleSessions,
	tryAcquireSessionLock,
} from "./session.ts";
import { loadConfig } from "./settings.ts";

export interface LaunchOptions {
	cwd: string;
	/** Backend id from `--leader`; falls back to settings, then to asking. */
	leader?: string;
	/** Multiplexer from `--mux`; falls back to settings. */
	mux?: string;
	/** Arguments passed through to the vendor CLI after `--`. */
	extraArgs: string[];
	agentDir?: string;
}

export class LaunchError extends Error {}

/** Below this, a multiplexer exiting non-zero means it never got a session up. */
const MUX_STARTUP_MS = 5000;

const LOCK_RETRY_MS = 25;

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type DirectorySession = { lock: SessionLock } | { existing: SessionRecord };

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
			const existing = findLiveSessionInDirectory(cwd, agentDir);
			if (existing) {
				releaseSessionLock(lock);
				return { existing };
			}
			return { lock };
		}

		// A competing launcher owns the gap before its control plane records the
		// session. Re-check its result instead of starting another leader.
		const existing = findLiveSessionInDirectory(cwd, agentDir);
		if (existing) return { existing };
		await delay(LOCK_RETRY_MS);
	}
}

function headlessSessionMessage(session: SessionRecord): string {
	return (
		`Neta session ${session.id} (pid ${session.pid}, started ${new Date(session.startedAt).toISOString()}) ` +
		"is already live in this directory and runs headless. " +
		`Reach it with \`neta workers --session ${session.id}\` or \`neta watch <worker>\`; ` +
		`stop work with \`neta kill <worker> --session ${session.id}\` or stop the leader with \`kill ${session.pid}\`.`
	);
}

async function reconnectToSession(session: SessionRecord): Promise<number> {
	if (!session.mux) throw new LaunchError(headlessSessionMessage(session));
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
 * installed; with several installed and no preference, ask.
 */
export async function chooseBackend(
	detected: DetectedLeaderBackend[],
	requested: string | undefined,
	configured: string | undefined,
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
	if (!process.stdin.isTTY) {
		throw new LaunchError(
			`Several agent CLIs are installed (${detected.map((b) => b.id).join(", ")}). ` +
				`Pick one with --leader <id>, or set leader.backend in settings.`,
		);
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const menu = detected.map((backend, index) => `  ${index + 1}. ${backend.name} (${backend.path})`).join("\n");
		const answer = await rl.question(`Which agent leads?\n${menu}\nChoice [1]: `);
		const index = answer.trim() === "" ? 0 : Number.parseInt(answer.trim(), 10) - 1;
		const chosen = detected[index];
		if (!chosen) throw new LaunchError(`"${answer.trim()}" is not one of the choices.`);
		return chosen;
	} finally {
		rl.close();
	}
}

/** Runs a leader session to completion and resolves with its exit code. */
export async function launchLeader(options: LaunchOptions): Promise<number> {
	const cwd = canonicalizeCwd(options.cwd);
	const agentDir = options.agentDir ?? getAgentDir();
	const claimed = await claimDirectorySession(cwd, agentDir);
	if ("existing" in claimed) return reconnectToSession(claimed.existing);
	const lock = claimed.lock;
	try {
		const config = loadConfig(cwd, agentDir);
		const preferredLeader = options.leader ?? config.leader.backend;
		if (preferredLeader && config.isBackendDisabled(preferredLeader)) {
			throw new LaunchError(`Backend "${preferredLeader}" is disabled in settings.`);
		}
		const detected = detectLeaderBackends().filter(({ id }) => config.backendNames().includes(id));
		const backend = await chooseBackend(detected, options.leader, config.leader.backend);

		const sessionId = `${process.pid}-${randomBytes(3).toString("hex")}`;
		const sessionDir = await mkdtemp(join(tmpdir(), `${APP_NAME}-session-`));
		const invocation = resolveSelfInvocation();

		const adapter = adapterFor(backend.id);
		const flavors = await materializeFlavors(agentDir, cwd).catch(() => []);
		const leaderPrompt = buildLeaderPrompt({
			tiers: config.tierMapping(),
			charter: loadCharter(cwd, agentDir),
			flavors,
			control: "mcp",
			// This vendor's names, not ours: a prompt naming tools that do not exist
			// leaves the leader with no way to delegate.
			toolName: (base) => adapter.toolName(base),
		});

		const launch = await adapter.prepare({
			backend,
			cwd,
			sessionDir,
			sessionId,
			socket: createChannelAddress(),
			token: randomBytes(16).toString("hex"),
			leaderPrompt,
			invocation,
			strictMcp: config.leader.strictMcp,
			extraArgs: options.extraArgs,
		});

		// Panes need a multiplexer session; if we are not in one, start one around
		// the leader so its workers have somewhere to appear.
		const mux = selectMux(options.mux ? normalizeMux(options.mux) : config.mux.mode);
		const showing = config.mux.panes && mux.id !== "none";

		for (const warning of launch.warnings) process.stderr.write(`${APP_NAME}: ${warning}\n`);

		// The leader is a fresh session of that vendor's CLI, exactly like a worker
		// is, so it must not inherit the runtime of whatever agent session Neta was
		// started from — running `neta` inside Claude Code otherwise hands the new
		// leader its parent's session variables and job directory.
		const muxSessionName = showing && !mux.inSession() ? `neta-${sessionId}` : undefined;
		const env = {
			...sanitizeInheritedEnv(process.env),
			...launch.env,
			NETA_MUX: mux.id,
			NETA_PANES: showing ? "1" : "0",
			NETA_SESSION_LOCK_PATH: lock.path,
			NETA_SESSION_LOCK_TOKEN: lock.token,
			...(muxSessionName ? { NETA_MUX_SESSION_NAME: muxSessionName } : {}),
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
			const fallbackEnv = { ...env, NETA_MUX: "none", NETA_PANES: "0" };
			delete fallbackEnv.NETA_MUX_SESSION_NAME;
			code = await run({ ...leader, env: fallbackEnv });
		}

		await launch.cleanup?.().catch(() => {});
		await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
		return code;
	} finally {
		// Normally the control plane releases this immediately after registering.
		// If the vendor never starts it, do not leave later launches wedged.
		releaseSessionLock(lock);
	}
}

function normalizeMux(value: string): "auto" | "zellij" | "tmux" | "none" {
	if (value === "zellij" || value === "tmux" || value === "none" || value === "auto") return value;
	throw new LaunchError(`Unknown multiplexer "${value}". Use zellij, tmux, none or auto.`);
}
