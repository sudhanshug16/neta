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
import { adapterFor } from "./adapters/index.ts";
import { createChannelAddress } from "./channel/protocol.ts";
import { resolveSelfInvocation } from "./cli-shim.ts";
import { APP_NAME, getAgentDir } from "./config.ts";
import { type DetectedLeaderBackend, detectLeaderBackends, LEADER_BACKENDS } from "./detect.ts";
import { selectMux } from "./mux/index.ts";
import { loadCharter } from "./prompts/charter.ts";
import { materializeFlavors } from "./prompts/flavors.ts";
import { buildLeaderPrompt } from "./prompts/leader.ts";
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
	const cwd = options.cwd;
	const agentDir = options.agentDir ?? getAgentDir();
	const config = loadConfig(cwd, agentDir);
	const backend = await chooseBackend(detectLeaderBackends(), options.leader, config.leader.backend);

	const sessionId = `${process.pid}-${randomBytes(3).toString("hex")}`;
	const sessionDir = await mkdtemp(join(tmpdir(), `${APP_NAME}-session-`));
	const invocation = resolveSelfInvocation();

	const flavors = await materializeFlavors(agentDir, cwd).catch(() => []);
	const leaderPrompt = buildLeaderPrompt({
		tiers: config.tierMapping(),
		charter: loadCharter(cwd, agentDir),
		flavors,
		control: "mcp",
	});

	const adapter = adapterFor(backend.id);
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
	const wrapped =
		config.mux.panes && mux.id !== "none"
			? (mux.wrapLeader({ command: launch.command, args: launch.args }, `neta-${sessionId}`, sessionDir) ?? launch)
			: launch;

	for (const warning of launch.warnings) process.stderr.write(`${APP_NAME}: ${warning}\n`);
	process.stderr.write(
		`${APP_NAME}: leading with ${backend.name}; workers ${config.mux.panes && mux.id !== "none" ? `in ${mux.id} panes` : "headless"}.\n`,
	);

	const env = { ...process.env, ...launch.env, NETA_MUX: mux.id, NETA_PANES: config.mux.panes ? "1" : "0" };
	const run = (spec: { command: string; args: string[] }) =>
		new Promise<number>((resolve) => {
			// The control plane is the process that opens panes, and it is a child
			// of the leader rather than of us, so the choice travels by environment.
			const child = spawn(spec.command, spec.args, { cwd, env, stdio: "inherit" });
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
	if (wrapped !== launch && code !== 0 && Date.now() - startedAt < MUX_STARTUP_MS) {
		process.stderr.write(
			`${APP_NAME}: ${mux.id} exited immediately (${code}); starting ${backend.name} without panes.\n`,
		);
		code = await run(launch);
	}

	await launch.cleanup?.().catch(() => {});
	await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
	return code;
}

function normalizeMux(value: string): "auto" | "zellij" | "tmux" | "none" {
	if (value === "zellij" || value === "tmux" || value === "none" || value === "auto") return value;
	throw new LaunchError(`Unknown multiplexer "${value}". Use zellij, tmux, none or auto.`);
}
