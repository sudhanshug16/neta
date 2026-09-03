// The listening server: authentication, dispatch and fan-out. This file
// declares the `NodeStore` and `NodeAcp` ports; only `lifecycle.ts` adapts
// the real 02 and 03 modules to them, so handlers stub against these.
import { chmod, unlink } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import type { McpServerSpec } from "../acp/mcp.ts";
import { ulid } from "../core/ids.ts";
import type {
	Access,
	Agent,
	AgentId,
	Event,
	Leader,
	Machine,
	Mission,
	MissionId,
	SessionId,
	TurnId,
	Workspace,
	WorkspaceId,
} from "../core/types.ts";
import {
	type ClientKind,
	type ConversationTailResult,
	decodeLines,
	type EventsListParams,
	type EventsListResult,
	encodeLine,
	type HelloResult,
	type ModelsListParams,
	type ModelsListResult,
	NodeError,
	PROTOCOL_VERSION,
	type RpcId,
	rpcError,
	type TurnNotification,
} from "./protocol.ts";

export interface NodeStore {
	machine(): Machine;
	listWorkspaces(): Workspace[];
	listLeaders(): Leader[];
	listMissions(workspaceId?: WorkspaceId): Mission[];
	listAgents(missionId?: MissionId): Agent[];
	getWorkspace(id: WorkspaceId): Workspace | undefined;
	getLeader(id: WorkspaceId): Leader | undefined;
	getMission(id: MissionId): Mission | undefined;
	getAgent(id: AgentId): Agent | undefined;
	putWorkspace(workspace: Workspace): Promise<void>;
	putAgent(agent: Agent): Promise<void>;
	putLeader(leader: Leader): Promise<void>;
	compact(): Promise<void>;
	appendEvent(event: Omit<Event, "seq" | "at">): Promise<Event>;
	listEvents(query: EventsListParams): Promise<EventsListResult>;
	tailConversation(
		id: SessionId,
		query: { limit: number; cursor?: string },
	): Promise<Omit<ConversationTailResult, "sessionId">>;
}

export interface NodeAcp {
	createSession(o: {
		workspaceId: WorkspaceId;
		cwd: string;
		provider: string;
		model: string;
		access: Access;
		mcpServers: McpServerSpec[];
	}): Promise<{ sessionId: SessionId; provider: string; model: string }>;
	prompt(id: SessionId, text: string): Promise<TurnId>;
	setModel(id: SessionId, model: string): Promise<void>;
	listModels(o: ModelsListParams): Promise<ModelsListResult["models"]>;
	cancel(id: SessionId): Promise<void>;
	close(id: SessionId): Promise<void>;
	closeAll(): Promise<void>;
	onTurn(fn: (notification: TurnNotification) => void): void;
}

export interface Hub {
	broadcast(method: string, params: unknown): void;
	toTail(sessionId: SessionId, params: unknown): void;
	connections(): Connection[];
}

export interface Connection {
	id: string;
	client: ClientKind;
	send(method: string, params: unknown): void;
	tailed: Set<SessionId>;
	close(): void;
}

export interface NodeContext {
	store: NodeStore;
	acp: NodeAcp;
	hub: Hub;
	nodeVersion: string;
	stop(): Promise<void>;
}

export type NodeHandler = (ctx: NodeContext, params: unknown, conn: Connection) => Promise<unknown>;
export type NodeHandlers = Record<string, NodeHandler>;

// A connection 1000 notifications behind is dropped; it must reconnect and
// snapshot. Only notifications count — solicited replies never drop anyone.
const MAX_PENDING_NOTIFICATIONS = 1000;

interface Peer {
	socket: Socket;
	buffer: string;
	authed: boolean;
	client?: ClientKind;
	tailed: Set<SessionId>;
	pending: number;
	conn?: Connection;
}

function writeLine(socket: Socket, line: string): void {
	if (socket.destroyed) {
		return;
	}
	try {
		socket.write(line);
	} catch {
		// A closed socket never throws the server.
	}
}

const CLIENT_KINDS: readonly ClientKind[] = ["cli", "desktop", "tools"];

function rpcIdOrNull(id: unknown): RpcId {
	return typeof id === "string" || typeof id === "number" ? id : null;
}

// Throws a NodeError: INVALID_PARAMS on a bad shape, UNAUTHORIZED on a wrong
// token, PROTOCOL_MISMATCH on a wrong version.
function checkHello(params: unknown, token: string): ClientKind {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		throw new NodeError("INVALID_PARAMS", "hello needs { token, client, protocolVersion }");
	}
	const {
		token: presented,
		client,
		protocolVersion,
	} = params as {
		token?: unknown;
		client?: unknown;
		protocolVersion?: unknown;
	};
	if (presented !== token) {
		throw new NodeError("UNAUTHORIZED", "wrong token");
	}
	if (protocolVersion !== PROTOCOL_VERSION) {
		throw new NodeError(
			"PROTOCOL_MISMATCH",
			`protocol version ${String(protocolVersion)} is not ${PROTOCOL_VERSION}`,
		);
	}
	if (typeof client !== "string" || !(CLIENT_KINDS as readonly string[]).includes(client)) {
		throw new NodeError("INVALID_PARAMS", "hello client is cli, desktop or tools");
	}
	return client as ClientKind;
}

function sendNotification(peer: Peer, method: string, params: unknown): void {
	if (!peer.authed || peer.socket.destroyed) {
		return;
	}
	peer.pending += 1;
	if (peer.pending > MAX_PENDING_NOTIFICATIONS) {
		peer.socket.destroy();
		return;
	}
	try {
		peer.socket.write(encodeLine({ jsonrpc: "2.0", method, params }), () => {
			peer.pending -= 1;
		});
	} catch {
		peer.pending -= 1;
	}
}

export async function createServer(o: {
	socketPath: string;
	token: string;
	handlers: NodeHandlers;
	ctx: Omit<NodeContext, "hub">;
}): Promise<{ hub: Hub; close(): Promise<void> }> {
	try {
		await unlink(o.socketPath);
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") {
			throw error;
		}
	}
	const peers = new Set<Peer>();
	const hub: Hub = {
		broadcast: (method, params) => {
			for (const peer of peers) {
				sendNotification(peer, method, params);
			}
		},
		toTail: (sessionId, params) => {
			for (const peer of peers) {
				if (peer.tailed.has(sessionId)) {
					sendNotification(peer, "turn", params);
				}
			}
		},
		connections: () => {
			const conns: Connection[] = [];
			for (const peer of peers) {
				if (peer.authed && peer.conn !== undefined) {
					conns.push(peer.conn);
				}
			}
			return conns;
		},
	};
	const ctx: NodeContext = { ...o.ctx, hub };

	function replyOk(socket: Socket, id: RpcId, result: unknown): void {
		writeLine(socket, encodeLine({ jsonrpc: "2.0", id, result }));
	}

	function handleMessage(peer: Peer, message: unknown): void {
		const socket = peer.socket;
		if (typeof message !== "object" || message === null || Array.isArray(message)) {
			const error = new NodeError("INVALID_REQUEST", "a request is an object");
			if (!peer.authed) {
				writeLine(socket, rpcError(null, error));
				socket.destroy();
			} else {
				writeLine(socket, rpcError(null, error));
			}
			return;
		}
		const frame = message as { id?: unknown; method?: unknown; params?: unknown };
		if (!peer.authed) {
			const id = rpcIdOrNull(frame.id);
			if (frame.method !== "hello") {
				writeLine(socket, rpcError(id, new NodeError("INVALID_REQUEST", "the first message must be hello")));
				socket.destroy();
				return;
			}
			let client: ClientKind;
			try {
				client = checkHello(frame.params, o.token);
			} catch (error) {
				writeLine(socket, rpcError(id, error));
				socket.destroy();
				return;
			}
			peer.authed = true;
			peer.client = client;
			const conn: Connection = {
				id: ulid(),
				client,
				send: (method, params) => sendNotification(peer, method, params),
				tailed: peer.tailed,
				close: () => {
					socket.destroy();
				},
			};
			peer.conn = conn;
			const result: HelloResult = {
				machine: ctx.store.machine(),
				protocolVersion: PROTOCOL_VERSION,
				nodeVersion: ctx.nodeVersion,
				pid: process.pid,
			};
			replyOk(socket, id, result);
			return;
		}
		if (typeof frame.method !== "string") {
			// A client notification (or garbage) without a method: without an
			// id there is nothing to answer, so it is ignored.
			if (frame.id !== undefined) {
				writeLine(
					socket,
					rpcError(rpcIdOrNull(frame.id), new NodeError("INVALID_REQUEST", "a request needs a method")),
				);
			}
			return;
		}
		const method = frame.method;
		const id = rpcIdOrNull(frame.id);
		const handler = o.handlers[method];
		if (handler === undefined) {
			writeLine(socket, rpcError(id, new NodeError("METHOD_NOT_FOUND", `unknown method: ${method}`)));
			return;
		}
		const conn = peer.conn;
		if (conn === undefined) {
			writeLine(socket, rpcError(id, new NodeError("INTERNAL", "connection is not ready")));
			return;
		}
		const params = frame.params;
		void (async (): Promise<void> => {
			try {
				replyOk(socket, id, await handler(ctx, params, conn));
			} catch (error) {
				// A NodeError keeps its own code; anything else is -32603
				// with no stack in `data`.
				writeLine(socket, rpcError(id, error));
			}
		})();
	}

	const netServer: NetServer = createNetServer((socket: Socket) => {
		const peer: Peer = { socket, buffer: "", authed: false, tailed: new Set(), pending: 0 };
		peers.add(peer);
		socket.on("error", () => {
			// Cleanup happens on "close".
		});
		socket.on("close", () => {
			peers.delete(peer);
		});
		socket.on("data", (chunk: Buffer) => {
			peer.buffer += chunk.toString("utf8");
			let messages: unknown[];
			try {
				const decoded = decodeLines(peer.buffer);
				messages = decoded.messages;
				peer.buffer = decoded.rest;
			} catch (error) {
				if (error instanceof NodeError && error.symbol === "PARSE") {
					writeLine(socket, rpcError(null, error));
					peer.buffer = ((error.data as { rest?: unknown }).rest as string) ?? "";
					return;
				}
				// An oversize line closes the connection.
				socket.destroy();
				return;
			}
			for (const message of messages) {
				if (socket.destroyed) {
					return;
				}
				handleMessage(peer, message);
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		netServer.once("error", reject);
		netServer.listen(o.socketPath, () => {
			netServer.off("error", reject);
			resolve();
		});
	});
	// Accept-loop failures have no client to answer; the server stays up.
	netServer.on("error", () => undefined);
	await chmod(o.socketPath, 0o600);

	let closed = false;
	return {
		hub,
		close: async (): Promise<void> => {
			if (closed) {
				return;
			}
			closed = true;
			for (const peer of peers) {
				peer.socket.destroy();
			}
			peers.clear();
			await new Promise<void>((resolve) => netServer.close(() => resolve()));
			try {
				await unlink(o.socketPath);
			} catch (error) {
				if ((error as { code?: unknown }).code !== "ENOENT") {
					throw error;
				}
			}
		},
	};
}
