// One client for the CLI (08), the tools proxy (05) and the tests. Reads
// the descriptor, connects, says hello, and matches replies by id.
import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { ulid } from "../core/ids.ts";
import { type NodeDescriptor, netaDir, readDescriptor } from "./lockfile.ts";
import {
	type ClientKind,
	decodeLines,
	encodeLine,
	type HelloResult,
	NODE_ERRORS,
	NodeError,
	type NodeErrorSymbol,
	PROTOCOL_VERSION,
} from "./protocol.ts";

export type NodeEvent = "event" | "state" | "turn" | "node";

export interface NodeClient {
	request<T>(method: string, params?: unknown): Promise<T>;
	on(method: NodeEvent, fn: (params: unknown) => void): () => void;
	hello: HelloResult;
	close(): Promise<void>;
	closed: Promise<void>;
}

export interface ConnectOptions {
	client?: ClientKind;
	autostart?: boolean;
	timeoutMs?: number;
}

const RETRY_MS = 100;

function isSymbol(code: unknown): code is NodeErrorSymbol {
	return typeof code === "string" && Object.hasOwn(NODE_ERRORS, code);
}

function errorFromReply(error: unknown): NodeError {
	if (typeof error === "object" && error !== null) {
		const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown };
		const symbol = typeof data === "object" && data !== null ? (data as { code?: unknown }).code : undefined;
		if (typeof code === "number" && typeof message === "string" && isSymbol(symbol)) {
			return new NodeError(symbol, message);
		}
		if (typeof message === "string") {
			return new NodeError("INTERNAL", message);
		}
	}
	return new NodeError("INTERNAL", "malformed error reply");
}

// Retryable: no descriptor yet, nothing listening, or a hello that never
// answers. A hello error reply propagates — the node is live but refusing.
class NotReadyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotReadyError";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

interface Pending {
	resolve(result: unknown): void;
	reject(error: Error): void;
}

export async function connectNode(o?: ConnectOptions): Promise<NodeClient> {
	const client: ClientKind = o?.client ?? "cli";
	const autostart = o?.autostart ?? false;
	const timeoutMs = o?.timeoutMs ?? 5000;
	const deadline = Date.now() + timeoutMs;
	let spawned = false;
	for (;;) {
		let descriptor: NodeDescriptor | undefined;
		try {
			descriptor = await readDescriptor();
		} catch {
			throw new NotReadyError(`cannot read the node descriptor in ${netaDir()}`);
		}
		if (descriptor !== undefined) {
			try {
				return await tryConnect(descriptor, client, deadline);
			} catch (error) {
				if (!(error instanceof NotReadyError)) {
					throw error;
				}
			}
		}
		if (!autostart) {
			throw new NotReadyError(`no node is listening on ${join(netaDir(), "node.sock")}`);
		}
		if (!spawned) {
			spawnNode();
			spawned = true;
		}
		if (Date.now() >= deadline) {
			throw new NotReadyError(`timed out connecting to the node in ${netaDir()}`);
		}
		await sleep(Math.min(RETRY_MS, Math.max(0, deadline - Date.now())));
		if (Date.now() >= deadline) {
			throw new NotReadyError(`timed out connecting to the node in ${netaDir()}`);
		}
	}
}

// Spawned once: a detached `neta node start --detach` that outlives us. The
// lock makes the autostart race harmless — the loser throws ALREADY_RUNNING
// and its retry finds the winner's socket.
function spawnNode(): void {
	const child = spawn("neta", ["node", "start", "--detach"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	child.on("error", () => {
		// A missing `neta` surfaces as a connect timeout, not a spawn crash.
	});
}

async function tryConnect(descriptor: NodeDescriptor, client: ClientKind, deadline: number): Promise<NodeClient> {
	const socket: Socket = await new Promise<Socket>((resolve, reject) => {
		const pending = connect(descriptor.socket);
		pending.on("connect", () => resolve(pending));
		pending.on("error", (error) => reject(new NotReadyError(error.message)));
	});
	const pending = new Map<string, Pending>();
	const listeners = new Map<NodeEvent, Set<(params: unknown) => void>>();
	let buffer = "";
	let closedResolve: () => void = () => undefined;
	const closed = new Promise<void>((done) => {
		closedResolve = done;
	});
	const failAll = (error: Error): void => {
		for (const entry of pending.values()) {
			entry.reject(error);
		}
		pending.clear();
	};
	socket.on("error", () => {
		// Close carries the failure; pending requests reject there.
	});
	socket.on("close", () => {
		failAll(new Error("the node connection closed"));
		closedResolve();
	});
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let messages: unknown[];
		try {
			const decoded = decodeLines(buffer);
			messages = decoded.messages;
			buffer = decoded.rest;
		} catch (error) {
			if (error instanceof NodeError && error.symbol === "PARSE") {
				buffer = ((error.data as { rest?: unknown }).rest as string) ?? "";
				return;
			}
			socket.destroy();
			return;
		}
		for (const message of messages) {
			if (typeof message !== "object" || message === null || Array.isArray(message)) {
				continue;
			}
			const frame = message as {
				id?: unknown;
				method?: unknown;
				params?: unknown;
				result?: unknown;
				error?: unknown;
			};
			if (typeof frame.method === "string" && frame.id === undefined) {
				const subs = listeners.get(frame.method as NodeEvent);
				if (subs !== undefined) {
					for (const fn of [...subs]) {
						fn(frame.params);
					}
				}
				continue;
			}
			if (typeof frame.id !== "string" && typeof frame.id !== "number") {
				continue;
			}
			const entry = pending.get(String(frame.id));
			if (entry === undefined) {
				continue;
			}
			pending.delete(String(frame.id));
			if ("error" in frame && frame.error !== undefined) {
				entry.reject(errorFromReply(frame.error));
			} else {
				entry.resolve(frame.result);
			}
		}
	});

	let greeting: HelloResult;
	try {
		greeting = await hello(socket, pending, descriptor, client, deadline);
	} catch (error) {
		socket.destroy();
		throw error;
	}
	const node: NodeClient = {
		hello: greeting,
		request: <T>(method: string, params?: unknown): Promise<T> => {
			const id = ulid();
			return new Promise<T>((resolve, reject) => {
				if (socket.destroyed) {
					reject(new Error("the node connection is closed"));
					return;
				}
				pending.set(id, {
					resolve: (result) => resolve(result as T),
					reject,
				});
				try {
					socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
				} catch (error) {
					pending.delete(id);
					reject(error as Error);
				}
			});
		},
		on: (method, fn) => {
			let subs = listeners.get(method);
			if (subs === undefined) {
				subs = new Set();
				listeners.set(method, subs);
			}
			subs.add(fn);
			return () => {
				subs.delete(fn);
			};
		},
		close: () => {
			socket.destroy();
			return closed;
		},
		closed,
	};
	return node;
}

async function hello(
	socket: Socket,
	pending: Map<string, Pending>,
	descriptor: NodeDescriptor,
	client: ClientKind,
	deadline: number,
): Promise<HelloResult> {
	const id = ulid();
	let rejectHello: (error: Error) => void = () => undefined;
	const answered = new Promise<HelloResult>((resolve, reject) => {
		rejectHello = reject;
		pending.set(id, {
			resolve: (result) => resolve(result as HelloResult),
			reject,
		});
	});
	try {
		socket.write(
			encodeLine({
				jsonrpc: "2.0",
				id,
				method: "hello",
				params: { token: descriptor.token, client, protocolVersion: PROTOCOL_VERSION },
			}),
		);
	} catch (error) {
		pending.delete(id);
		socket.destroy();
		throw new NotReadyError(error instanceof Error ? error.message : String(error));
	}
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		pending.delete(id);
		socket.destroy();
		throw new NotReadyError("timed out waiting for hello");
	}
	const timeout = setTimeout(() => {
		pending.delete(id);
		socket.destroy();
		rejectHello(new NotReadyError("timed out waiting for hello"));
	}, remaining);
	try {
		return await answered;
	} catch (error) {
		if (error instanceof NodeError) {
			throw error;
		}
		throw new NotReadyError(error instanceof Error ? error.message : String(error));
	} finally {
		clearTimeout(timeout);
	}
}
