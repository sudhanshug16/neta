/**
 * The two long-running MCP processes.
 *
 * `neta mcp` is the control plane: it owns the WorkerManager, the worker socket
 * and every worker process, and it lives exactly as long as the leader session
 * that started it. There is no daemon — closing the leader closes everything it
 * spawned.
 *
 * `neta mcp --worker` is the thin end: it forwards a worker's calls to that
 * socket and holds no state at all.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	createChannelAddress,
	NETA_LEADER_ENV,
	NETA_SOCKET_ENV,
	NETA_WORKER_ENV,
	NETA_WORKER_TOKEN_ENV,
} from "../channel/protocol.ts";
import { ChannelServer } from "../channel/server.ts";
import { type CliInvocation, createLeaderCliShim, prependToPath, resolveSelfInvocation } from "../cli-shim.ts";
import { getAgentDir } from "../config.ts";
import { selectMux } from "../mux/index.ts";
import { createPaneHost } from "../mux/panes.ts";
import { WorkerManager } from "../orchestrator/manager.ts";
import {
	processStartTime,
	releaseSessionLock,
	removeSessionRecord,
	type SessionRecord,
	type SessionWorkerGroup,
	writeSessionRecord,
} from "../session.ts";
import { loadConfig, type MuxMode } from "../settings.ts";
import type { WorkerEvent } from "../types.ts";
import { leaderTools } from "./leader.ts";
import { createMcpServer } from "./serve.ts";
import { workerTools } from "./worker.ts";

/** stdout is the MCP transport, so everything human-readable goes to stderr. */
function note(message: string): void {
	process.stderr.write(`[neta] ${message}\n`);
}

function muxMode(configured: MuxMode): MuxMode {
	const chosen = process.env.NETA_MUX;
	return chosen === "zellij" || chosen === "tmux" || chosen === "none" || chosen === "auto" ? chosen : configured;
}

/** Restore only the identity a fresh Zellij assigns after adapter config exists. */
export function restoreZellijIdentity(
	env: NodeJS.ProcessEnv = process.env,
	read: (path: string, encoding: "utf-8") => string = readFileSync,
): boolean {
	if (env.NETA_MUX !== "zellij") return false;
	const present = [env.ZELLIJ, env.ZELLIJ_SESSION_NAME, env.ZELLIJ_PANE_ID];
	if (present.every(Boolean)) return true;
	// A partial direct identity is not combined with a file from another launch.
	if (present.some(Boolean)) return false;
	const path = env.NETA_ZELLIJ_IDENTITY_FILE;
	if (!path) return false;
	try {
		const lines = read(path, "utf-8").split("\n");
		if (lines.length !== 4 || lines[3] !== "" || lines.slice(0, 3).some((value) => value.length === 0)) return false;
		[env.ZELLIJ, env.ZELLIJ_SESSION_NAME, env.ZELLIJ_PANE_ID] = lines;
		return true;
	} catch {
		return false;
	}
}

function describeEvent(event: WorkerEvent): string {
	switch (event.type) {
		case "done":
			return `${event.workerId} finished${event.dirtyFiles ? `; uncommitted changes: ${event.dirtyFiles.length} files` : ""}`;
		case "failed":
			return `${event.workerId} failed: ${event.error}`;
		case "ask":
			return `${event.workerId} is waiting for an answer: ${event.question}`;
	}
}

export interface ControlPlaneOptions {
	cwd?: string;
	agentDir?: string;
	sessionId?: string;
	/** Backend the leader runs in, recorded so `neta sessions` can name it. */
	leader?: string;
	invocation?: CliInvocation;
}

export async function runControlPlane(options: ControlPlaneOptions = {}): Promise<void> {
	restoreZellijIdentity();
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const config = loadConfig(cwd, agentDir);
	const invocation = options.invocation ?? resolveSelfInvocation();

	// The launcher decides these so the leader's own shell can use the same
	// socket; a hand-registered `neta mcp` makes up its own.
	const address = process.env[NETA_SOCKET_ENV] || createChannelAddress();
	const token = process.env[NETA_LEADER_ENV] || randomBytes(16).toString("hex");
	const sessionId = options.sessionId ?? process.env.NETA_SESSION_ID ?? `s${process.pid}`;
	const lockPath = process.env.NETA_SESSION_LOCK_PATH;
	const lockToken = process.env.NETA_SESSION_LOCK_TOKEN;
	const muxName = process.env.NETA_MUX_SESSION_NAME;
	const muxId = process.env.NETA_MUX;

	const wantsPanes = (process.env.NETA_PANES ?? (config.mux.panes ? "1" : "0")) === "1";
	const mux = selectMux(muxMode(config.mux.mode));
	const panes = wantsPanes ? createPaneHost(mux, invocation, sessionId, cwd, agentDir, muxName) : undefined;
	const headlessReason = !wantsPanes
		? "panes disabled"
		: !panes
			? mux.id === "none"
				? "no multiplexer available"
				: `not inside a ${mux.id} session`
			: undefined;
	if (headlessReason) {
		// Silence here reads as "panes are broken". Usually it just means the
		// leader is not running inside a multiplexer, which is fine and worth
		// saying once rather than leaving the user to wonder where the tabs are.
		note(`workers run headless: ${headlessReason}`);
	}

	let shimDir: string | undefined;
	const workerGroups = new Map<string, SessionWorkerGroup>();
	const sessionRecord: SessionRecord = {
		id: sessionId,
		socket: address,
		token,
		cwd,
		leader: options.leader ?? process.env.NETA_LEADER_BACKEND ?? "unknown",
		pid: process.pid,
		startedAt: Date.now(),
		...(muxName && (muxId === "zellij" || muxId === "tmux") ? { mux: { id: muxId, name: muxName } } : {}),
	};
	const writeRegistry = () =>
		writeSessionRecord({ ...sessionRecord, workerGroups: [...workerGroups.values()] }, agentDir);
	const manager: WorkerManager = new WorkerManager({
		cwd,
		agentDir,
		config,
		channelAddress: address,
		leaderToken: token,
		onEvent: (event) => note(describeEvent(event)),
		prepareEnv: async () => {
			shimDir ??= await createLeaderCliShim(invocation);
			return { PATH: prependToPath(shimDir, process.env.PATH) };
		},
		workerMcpServers: (workerId, _scratchDir, token) => [
			{
				name: "neta",
				command: invocation.command,
				args: [...invocation.prefixArgs, "mcp", "--worker"],
				env: { [NETA_SOCKET_ENV]: address, [NETA_WORKER_ENV]: workerId, [NETA_WORKER_TOKEN_ENV]: token },
			},
		],
		// `--mux` at launch decided this; settings answer when nobody did.
		panes: wantsPanes ? panes : undefined,
		headlessReason,
		onWorkerProcessGroup: (workerId, pgid) => {
			if (pgid === undefined) workerGroups.delete(workerId);
			else {
				const leaderStartedAt = processStartTime(pgid);
				if (leaderStartedAt) workerGroups.set(workerId, { pgid, leaderStartedAt });
			}
			writeRegistry();
		},
	});

	const server = new ChannelServer(address, manager);
	await server.start();
	writeRegistry();
	if (lockPath && lockToken) releaseSessionLock({ path: lockPath, token: lockToken });

	let shutdownPromise: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = (async () => {
			await manager.dispose();
			await server.stop();
			if (shimDir) await rm(shimDir, { recursive: true, force: true }).catch(() => {});
			removeSessionRecord(sessionId, agentDir);
		})();
		return shutdownPromise;
	};
	const exit = () => {
		void shutdown().then(() => process.exit(0));
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, exit);

	// The MCP stdio transport reports data and errors but never the end of the
	// stream, so without these a leader that simply exits would leave this
	// process — and every worker it owns — running forever, spending tokens for
	// a conversation that no longer exists.
	process.stdin.on("end", exit);
	process.stdin.on("close", exit);

	const mcp = createMcpServer(
		"neta",
		leaderTools(manager),
		"Neta worker control. Spawn workers with neta_spawn, collect their results with neta_wait, reopen a terminal " +
			"worker's native TUI with neta_attach, and answer blocked workers with neta_answer. If these tools fail, report the failure — never do the work yourself and never " +
			"substitute this backend's own subagents.",
	);
	mcp.onclose = exit;
	await mcp.connect(new StdioServerTransport());
	note(`control plane ready on ${address} (session ${sessionId}) · worker views: ${panes ? mux.id : "headless"}`);
}

export async function runWorkerBridge(): Promise<void> {
	const address = process.env[NETA_SOCKET_ENV];
	const workerId = process.env[NETA_WORKER_ENV];
	const token = process.env[NETA_WORKER_TOKEN_ENV];
	if (!address || !workerId || !token) {
		process.stderr.write(
			`[neta] ${NETA_SOCKET_ENV}, ${NETA_WORKER_ENV} and ${NETA_WORKER_TOKEN_ENV} must be set; this server only runs inside a Neta worker.\n`,
		);
		process.exitCode = 1;
		return;
	}
	const mcp = createMcpServer(
		"neta-worker",
		workerTools(address, workerId, token),
		"Report progress milestones to your leader with neta_progress, and use neta_ask when you are blocked.",
	);
	await mcp.connect(new StdioServerTransport());
}
