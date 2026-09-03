// `neta mcp --actor <id> --token <t>`: the stdio MCP server one ACP session
// holds. It keeps no state and decides nothing: `initialize` is answered
// locally, every `tools/list` and `tools/call` is forwarded to the Node over
// the socket with the actor's token. Both sides speak NDJSON JSON-RPC 2.0.
import { connect, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { readDescriptor } from "../node/lockfile.ts";
import { decodeLines, encodeLine, PROTOCOL_VERSION } from "../node/protocol.ts";
import { netaVersion } from "../version.ts";

export interface ProxyOptions {
	actorId: string;
	token: string;
	socketPath?: string;
	stdin?: Readable;
	stdout?: Writable;
}

interface RpcMessage {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

function rpcId(value: unknown): string | number | null {
	return typeof value === "string" || typeof value === "number" ? value : null;
}

function ok(id: string | number | null, result: unknown): string {
	return encodeLine({ jsonrpc: "2.0", id, result });
}

function fail(id: string | number | null, code: number, message: string): string {
	return encodeLine({ jsonrpc: "2.0", id, error: { code, message } });
}

function unavailable(text: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
	return { content: [{ type: "text", text }], isError: true };
}

// One socket request: connect, hello as a tools client, send, read the one
// reply, close. Rejects on any transport or hello failure.
function socketRequest(socketPath: string, token: string, method: string, params: unknown): Promise<unknown> {
	return new Promise<unknown>((resolve, reject) => {
		const socket: Socket = connect(socketPath);
		const id = "proxy-1";
		let buffer = "";
		let settled = false;
		const done = (fn: () => void): void => {
			if (!settled) {
				settled = true;
				socket.destroy();
				fn();
			}
		};
		socket.on("connect", () => {
			try {
				socket.write(
					encodeLine({
						jsonrpc: "2.0",
						id: "proxy-hello",
						method: "hello",
						params: { token, client: "tools", protocolVersion: PROTOCOL_VERSION },
					}),
				);
				socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
			} catch (error) {
				done(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		});
		socket.on("error", (error) => {
			done(() => reject(error));
		});
		socket.on("close", () => {
			done(() => reject(new Error("the node connection closed")));
		});
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let messages: unknown[];
			try {
				const decoded = decodeLines(buffer);
				messages = decoded.messages;
				buffer = decoded.rest;
			} catch {
				done(() => reject(new Error("malformed reply from the node")));
				return;
			}
			for (const message of messages) {
				if (typeof message !== "object" || message === null || Array.isArray(message)) {
					continue;
				}
				const frame = message as RpcMessage;
				if (rpcId(frame.id) === "proxy-hello") {
					if (frame.error !== undefined) {
						done(() => reject(new Error("the node refused hello")));
					}
					continue;
				}
				if (rpcId(frame.id) !== id) {
					continue;
				}
				if (frame.error !== undefined) {
					done(() => reject(new Error("the node answered an error")));
					return;
				}
				done(() => resolve(frame.result));
				return;
			}
		});
	});
}

async function forward(
	socketPath: string | undefined,
	clientToken: string,
	method: string,
	params: unknown,
	actorId: string,
	token: string,
): Promise<unknown> {
	let path = socketPath;
	let nodeToken = clientToken;
	if (path === undefined) {
		const descriptor = await readDescriptor().catch(() => undefined);
		if (descriptor === undefined) {
			throw new Error("no node descriptor");
		}
		path = descriptor.socket;
		nodeToken = descriptor.token;
	}
	const payload =
		method === "tools.list" ? { actorId, token } : { ...(params as Record<string, unknown>), actorId, token };
	let last: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return await socketRequest(path, nodeToken, method, payload);
		} catch (error) {
			last = error;
		}
	}
	throw last instanceof Error ? last : new Error(String(last));
}

// Drive the proxy to stdin end; resolves 0, killing nothing.
export async function runProxy(options: ProxyOptions): Promise<number> {
	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	let clientToken = "";
	if (options.socketPath !== undefined) {
		clientToken = (await readDescriptor().catch(() => undefined))?.token ?? "";
	}
	const pending = new Set<Promise<void>>();
	let buffer = "";

	function send(line: string): void {
		stdout.write(`${line}\n`);
	}

	async function handle(raw: string): Promise<void> {
		let message: RpcMessage;
		try {
			message = JSON.parse(raw) as RpcMessage;
		} catch {
			send(fail(null, -32700, "not JSON"));
			return;
		}
		if (typeof message !== "object" || message === null || Array.isArray(message)) {
			send(fail(null, -32600, "a request is an object"));
			return;
		}
		if (message.id === undefined) {
			// A notification (e.g. notifications/initialized): nothing to answer.
			return;
		}
		const id = rpcId(message.id);
		if (typeof message.method !== "string") {
			send(fail(id, -32600, "a request needs a method"));
			return;
		}
		if (message.method === "initialize") {
			const params = (message.params ?? {}) as { protocolVersion?: unknown };
			send(
				ok(id, {
					protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
					serverInfo: { name: "neta", version: netaVersion() },
					capabilities: { tools: {} },
				}),
			);
			return;
		}
		if (message.method === "tools/list") {
			try {
				const result = (await forward(
					options.socketPath,
					clientToken,
					"tools.list",
					{},
					options.actorId,
					options.token,
				)) as {
					tools: unknown;
				};
				send(ok(id, { tools: result.tools }));
			} catch (error) {
				send(fail(id, -32603, `error unavailable: ${error instanceof Error ? error.message : String(error)}`));
			}
			return;
		}
		if (message.method === "tools/call") {
			const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
			try {
				const result = (await forward(
					options.socketPath,
					clientToken,
					"tools.call",
					{ name: params.name, arguments: params.arguments ?? {} },
					options.actorId,
					options.token,
				)) as { content: unknown; isError: unknown };
				send(ok(id, { content: result.content, isError: result.isError }));
			} catch (error) {
				send(ok(id, unavailable(`error unavailable: ${error instanceof Error ? error.message : String(error)}`)));
			}
			return;
		}
		send(fail(id, -32601, `unknown method: ${message.method}`));
	}

	stdin.on("data", (chunk: Buffer | string) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const raw = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (raw !== "") {
				const task = handle(raw).catch(() => undefined);
				pending.add(task);
				task.finally(() => pending.delete(task));
			}
			newline = buffer.indexOf("\n");
		}
	});
	await new Promise<void>((resolve) => {
		stdin.on("end", () => resolve());
		stdin.on("close", () => resolve());
	});
	await Promise.all([...pending]);
	return 0;
}
