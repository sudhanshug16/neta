/**
 * Wire protocol for the worker channel.
 *
 * Workers reach the leader by running `neta progress|ask|say|room` from whatever
 * shell tool their backend gives them. This is the second door into the
 * orchestrator: the leader itself uses MCP tools, but any unsandboxed process
 * — and any human with a terminal — can use this one.
 *
 * One newline-delimited JSON request per connection, one response, close.
 */

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set on every worker process so the CLI knows where to reach its leader. */
export const NETA_SOCKET_ENV = "NETA_SOCKET";
/** Set on every worker process so the leader knows which worker is calling. */
export const NETA_WORKER_ENV = "NETA_WORKER_ID";
/** Scratch directory outside the repo, one per worker. */
export const NETA_SCRATCH_ENV = "NETA_SCRATCH";
/**
 * Set on the leader's process. Holding this token authorizes the leader-only
 * channel commands (spawn, kill, answer, ...); workers never see it.
 */
export const NETA_LEADER_ENV = "NETA_LEADER_TOKEN";

export type WorkerChannelRequest =
	/** Record a progress milestone in this worker's log. The leader pulls it; nothing is pushed. */
	| { type: "progress"; workerId: string; text: string }
	/** Block until the leader answers. Not available to juniors. */
	| { type: "ask"; workerId: string; text: string }
	/** Post to the worker's room transcript. */
	| { type: "say"; workerId: string; text: string }
	/** Read the worker's room transcript. */
	| { type: "room"; workerId: string; tail?: number }
	/** Read only active, queued and finished writers. */
	| { type: "writer-status"; workerId: string };

/**
 * Requests only a token holder may make. These mirror the leader's MCP tools,
 * so the same operations are reachable from a plain shell.
 */
export type LeaderChannelRequest =
	| {
			type: "spawn";
			token: string;
			role: string;
			tier: string;
			task: string;
			name?: string;
			writer?: boolean;
			room?: string;
			backend?: string;
			note?: string;
	  }
	| { type: "workers"; token: string }
	| { type: "status"; token: string }
	| { type: "log"; token: string; workerId: string }
	/**
	 * Read a worker's log without consuming it. `log` moves the leader's cursor;
	 * this is for extra readers — the pane watcher, a person in another terminal.
	 */
	| { type: "tail"; token: string; workerId: string; since?: number }
	/** Block until the listed workers are terminal or the timeout fires. */
	| { type: "wait"; token: string; workerIds: string[]; timeoutMs?: number }
	| { type: "send"; token: string; workerId: string; text: string }
	| { type: "answer"; token: string; workerId: string; text: string }
	| { type: "kill"; token: string; workerId: string };

export type ChannelRequest = WorkerChannelRequest | LeaderChannelRequest;

export const LEADER_REQUEST_TYPES = new Set([
	"spawn",
	"workers",
	"status",
	"log",
	"tail",
	"wait",
	"send",
	"answer",
	"kill",
]);

/** `data` carries a structured payload for callers that parse rather than print. */
export type ChannelResponse = { ok: true; text?: string; data?: unknown } | { ok: false; error: string };

/**
 * Unix domain socket path, or a named pipe on Windows where AF_UNIX paths are
 * not available.
 */
export function createChannelAddress(): string {
	const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
	if (process.platform === "win32") return `\\\\.\\pipe\\neta-${id}`;
	return join(tmpdir(), `neta-${id}.sock`);
}
