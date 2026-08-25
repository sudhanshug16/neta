/**
 * Wire protocol for the worker channel.
 *
 * Workers reach the leader by running `neta progress|blocked|room-post|room` from whatever
 * shell tool their backend gives them. This is the second door into the
 * orchestrator: the leader itself uses MCP tools, but any unsandboxed process
 * — and any human with a terminal — can use this one.
 *
 * One newline-delimited JSON request per connection, one response, close.
 */

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tier, WorkerState } from "../types.ts";

/** Set on every worker process so the CLI knows where to reach its leader. */
export const NETA_SOCKET_ENV = "NETA_SOCKET";
/** Set on every worker process so the leader knows which worker is calling. */
export const NETA_WORKER_ENV = "NETA_WORKER_ID";
/** Per-worker capability token. It authorizes worker-channel requests for that one worker. */
export const NETA_WORKER_TOKEN_ENV = "NETA_WORKER_TOKEN";
/** Present only for workers delegated into a shared team transcript. */
export const NETA_WORKER_TEAM_ENV = "NETA_WORKER_TEAM";
/** Scratch directory outside the repo, one per worker. */
export const NETA_SCRATCH_ENV = "NETA_SCRATCH";
/**
 * Set on the leader's process. Holding this token authorizes the leader-only
 * channel commands; workers never see it.
 */
export const NETA_LEADER_ENV = "NETA_LEADER_TOKEN";

/** Version of the leader channel requests shared by managers and watchers. */
export const CHANNEL_PROTOCOL_VERSION = 1;

export type WorkerChannelRequest =
	/** Record a progress milestone in this worker's log. The leader pulls it; nothing is pushed. */
	| { type: "progress"; workerId: string; token: string; text: string }
	/** Block until the leader answers. Not available to juniors. */
	| { type: "blocked"; workerId: string; token: string; text: string }
	/** Post to the worker's room transcript. */
	| { type: "room-post"; workerId: string; token: string; text: string }
	/** Read the worker's room transcript. */
	| { type: "room"; workerId: string; token: string; tail?: number }
	/** Read only active, queued and finished writers. */
	| { type: "writer-status"; workerId: string; token: string }
	| { type: "goal-status"; workerId: string; token: string }
	| {
			type: "discover";
			workerId: string;
			token: string;
			impact: "local" | "goal";
			finding: string;
			suggestion?: string;
	  };

/**
 * Requests only a token holder may make. These mirror the leader's MCP tools,
 * so the same operations are reachable from a plain shell.
 */
export type LeaderChannelRequest =
	| { type: "workers"; token: string }
	| { type: "status"; token: string }
	/** Machine-readable, read-only live actor state for authenticated integrations. */
	| { type: "actor-snapshot"; token: string }
	/**
	 * Read a worker's log without consuming it. `log` moves the leader's cursor;
	 * this is for extra readers — the pane watcher, a person in another terminal.
	 */
	| { type: "tail"; token: string; workerId: string; since?: number }
	/** Read a room's merged transcript without consuming it; `tail` for a room. */
	| { type: "room-tail"; token: string; room: string; since?: number }
	/**
	 * A bounded window onto one worker's recent input and output, capped by the
	 * manager rather than by the caller. This is how a worker row expands in
	 * place, including for a worker with no multiplexer tab.
	 */
	| { type: "inspect"; token: string; workerId: string }
	/** Block until the listed workers are terminal or the timeout fires. */
	| { type: "wait"; token: string; workerIds: string[]; timeoutMs?: number }
	| { type: "send"; token: string; workerId: string; text: string }
	/** Pane-only atomic input: answer a live question, otherwise queue the next turn. */
	| { type: "pane-input"; token: string; workerId: string; text: string }
	| { type: "kill"; token: string; workerId: string };

export type ChannelRequest = WorkerChannelRequest | LeaderChannelRequest;

export const LEADER_REQUEST_TYPES = new Set([
	"workers",
	"status",
	"actor-snapshot",
	"tail",
	"room-tail",
	"inspect",
	"wait",
	"send",
	"pane-input",
	"kill",
]);

/** `data` carries a structured payload for callers that parse rather than print. */
export type ChannelResponse = { ok: true; text?: string; data?: unknown } | { ok: false; error: string };

export interface NetaActorSnapshot {
	version: 1;
	session: {
		id: string;
		logicalId: string;
		cwd: string;
		managerPid: number;
		processStartedAt?: string;
		startedAt: number;
	};
	leader: {
		id: string;
		backend: string;
		state: "running";
		startedAt: number;
		vendorSessionId?: string;
	};
	workers: Array<{
		id: string;
		state: WorkerState;
		name: string;
		role: string;
		tier: Tier;
		backend: string;
		writer: boolean;
		task: string;
		cwd: string;
		startedAt: number;
		endedAt?: number;
		activeStartedAt?: number;
		queuedStartedAt?: number;
		pendingQuestion?: string;
		lastProgress?: { text: string; at: number };
		vendorSessionId?: string;
	}>;
}

/**
 * Unix domain socket path, or a named pipe on Windows where AF_UNIX paths are
 * not available.
 */
export function createChannelAddress(): string {
	const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
	if (process.platform === "win32") return `\\\\.\\pipe\\neta-${id}`;
	return join(tmpdir(), `neta-${id}.sock`);
}
