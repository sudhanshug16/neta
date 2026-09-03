import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "../src/core/types.ts";
import { encodeLine, NodeError, type RpcId } from "../src/node/protocol.ts";
import {
	type Connection,
	createServer,
	type Hub,
	type NodeAcp,
	type NodeContext,
	type NodeStore,
} from "../src/node/server.ts";

const TOKEN = "test-token";
const MACHINE: Machine = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "test", createdAt: new Date(0).toISOString() };

function stubStore(): NodeStore {
	const missing = (): never => {
		throw new Error("not implemented in this test");
	};
	return {
		machine: () => MACHINE,
		listWorkspaces: () => missing(),
		listLeaders: () => missing(),
		listMissions: () => missing(),
		listAgents: () => missing(),
		getWorkspace: () => undefined,
		getLeader: () => undefined,
		getMission: () => undefined,
		getAgent: () => undefined,
		putWorkspace: () => Promise.reject(new Error("not implemented in this test")),
		putAgent: () => Promise.reject(new Error("not implemented in this test")),
		putLeader: () => Promise.reject(new Error("not implemented in this test")),
		compact: () => Promise.reject(new Error("not implemented in this test")),
		appendEvent: () => Promise.reject(new Error("not implemented in this test")),
		listEvents: () => Promise.reject(new Error("not implemented in this test")),
		tailConversation: () => Promise.reject(new Error("not implemented in this test")),
	};
}

function stubAcp(): NodeAcp {
	const missing = (): never => {
		throw new Error("not implemented in this test");
	};
	return {
		createSession: () => Promise.reject(new Error("not implemented in this test")),
		prompt: () => Promise.reject(new Error("not implemented in this test")),
		setModel: () => Promise.reject(new Error("not implemented in this test")),
		listModels: () => Promise.reject(new Error("not implemented in this test")),
		cancel: () => Promise.reject(new Error("not implemented in this test")),
		close: () => Promise.reject(new Error("not implemented in this test")),
		closeAll: () => Promise.reject(new Error("not implemented in this test")),
		onTurn: () => missing(),
	};
}

interface TestServer {
	hub: Hub;
	close(): Promise<void>;
	socketPath: string;
}

async function startTestServer(
	handlers: Record<string, (ctx: NodeContext, params: unknown, conn: Connection) => Promise<unknown>>,
	dir: string,
): Promise<TestServer> {
	const socketPath = join(dir, "node.sock");
	const { hub, close } = await createServer({
		socketPath,
		token: TOKEN,
		handlers,
		ctx: { store: stubStore(), acp: stubAcp(), nodeVersion: "0.0.0-test", stop: () => Promise.resolve() },
	});
	return { hub, close, socketPath };
}

interface RawClient {
	socket: Socket;
	nextFrame(timeoutMs?: number): Promise<Record<string, unknown>>;
	send(message: unknown): void;
	closed: Promise<void>;
}

function openClient(socketPath: string): Promise<RawClient> {
	return new Promise<RawClient>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out connecting")), 2000);
		const socket: Socket = connect(socketPath);
		let buffer = "";
		const waiting: Array<{ done(frame: Record<string, unknown>): void; fail(error: Error): void }> = [];
		let closedResolve: () => void = () => undefined;
		const closed = new Promise<void>((done) => {
			closedResolve = done;
		});
		socket.on("connect", () => {
			clearTimeout(timer);
			resolve({
				socket,
				send: (message: unknown) => {
					socket.write(encodeLine(message));
				},
				nextFrame: (timeoutMs = 2000) =>
					new Promise<Record<string, unknown>>((done, fail) => {
						const timer = setTimeout(() => fail(new Error("timed out waiting for a frame")), timeoutMs);
						waiting.push({
							done: (frame) => {
								clearTimeout(timer);
								done(frame);
							},
							fail: (error) => {
								clearTimeout(timer);
								fail(error);
							},
						});
						pump();
					}),
				closed,
			});
		});
		socket.on("error", () => {
			// Errors surface as close; callers awaiting frames time out.
		});
		socket.on("close", () => {
			closedResolve();
			for (const waiter of waiting.splice(0)) {
				waiter.fail(new Error("connection closed while waiting for a frame"));
			}
		});
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			pump();
		});
		function pump(): void {
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0 || waiting.length === 0) {
					return;
				}
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line === "") {
					continue;
				}
				waiting.shift()?.done(JSON.parse(line) as Record<string, unknown>);
			}
		}
	});
}

function hello(id: RpcId = 1, params?: unknown): Record<string, unknown> {
	return {
		jsonrpc: "2.0",
		id,
		method: "hello",
		params: params ?? { token: TOKEN, client: "cli", protocolVersion: 1 },
	};
}

function errorOf(frame: Record<string, unknown>): { code: number; message: string; data: { code: string } } {
	return (
		(frame.error as { code: number; message: string; data: { code: string } }) ?? {
			code: 0,
			message: "",
			data: { code: "" },
		}
	);
}

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neta-server-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("hello handshake", () => {
	test("a non-hello first message errors and then closes", async () => {
		const server = await startTestServer({}, dir);
		try {
			const client = await openClient(server.socketPath);
			client.send({ jsonrpc: "2.0", id: 1, method: "snapshot", params: {} });
			const frame = await client.nextFrame();
			expect(errorOf(frame).data.code).toBe("INVALID_REQUEST");
			await client.closed;
		} finally {
			await server.close();
		}
	});

	test("a wrong token gives UNAUTHORIZED", async () => {
		const server = await startTestServer({}, dir);
		try {
			const client = await openClient(server.socketPath);
			client.send(hello(1, { token: "wrong", client: "cli", protocolVersion: 1 }));
			const frame = await client.nextFrame();
			expect(errorOf(frame)).toMatchObject({ code: -32000, data: { code: "UNAUTHORIZED" } });
			await client.closed;
		} finally {
			await server.close();
		}
	});

	test("a wrong version gives PROTOCOL_MISMATCH", async () => {
		const server = await startTestServer({}, dir);
		try {
			const client = await openClient(server.socketPath);
			client.send(hello(1, { token: TOKEN, client: "cli", protocolVersion: 999 }));
			const frame = await client.nextFrame();
			expect(errorOf(frame)).toMatchObject({ code: -32001, data: { code: "PROTOCOL_MISMATCH" } });
			await client.closed;
		} finally {
			await server.close();
		}
	});

	test("hello answers and dispatch runs after it", async () => {
		const server = await startTestServer(
			{
				snapshot: (_ctx, params) => Promise.resolve({ echoed: params }),
			},
			dir,
		);
		try {
			const client = await openClient(server.socketPath);
			client.send(hello());
			const welcomed = await client.nextFrame();
			expect(welcomed.result).toMatchObject({ machine: MACHINE, protocolVersion: 1, nodeVersion: "0.0.0-test" });
			expect(typeof (welcomed.result as { pid: number }).pid).toBe("number");
			client.send({ jsonrpc: "2.0", id: 2, method: "snapshot", params: { a: 1 } });
			const answered = await client.nextFrame();
			expect(answered).toMatchObject({ jsonrpc: "2.0", id: 2, result: { echoed: { a: 1 } } });
			client.socket.destroy();
			await server.close();
		} finally {
			await server.close();
		}
	});

	test("a malformed line gets -32700 and the connection stays open", async () => {
		const server = await startTestServer({}, dir);
		try {
			const client = await openClient(server.socketPath);
			client.socket.write("{not json\n");
			const frame = await client.nextFrame();
			expect(errorOf(frame)).toMatchObject({ code: -32700, data: { code: "PARSE" } });
			client.send(hello());
			const welcomed = await client.nextFrame();
			expect(typeof welcomed.result).toBe("object");
			client.socket.destroy();
		} finally {
			await server.close();
		}
	});
});

describe("dispatch errors", () => {
	test("an unknown method gives -32601 and the connection stays open", async () => {
		const server = await startTestServer({ snapshot: () => Promise.resolve({}) }, dir);
		try {
			const client = await openClient(server.socketPath);
			client.send(hello());
			await client.nextFrame();
			client.send({ jsonrpc: "2.0", id: 2, method: "nope", params: {} });
			const frame = await client.nextFrame();
			expect(errorOf(frame)).toMatchObject({ code: -32601, data: { code: "METHOD_NOT_FOUND" } });
			client.send({ jsonrpc: "2.0", id: 3, method: "snapshot", params: {} });
			expect(await client.nextFrame()).toMatchObject({ id: 3, result: {} });
			client.socket.destroy();
		} finally {
			await server.close();
		}
	});

	test("a thrown NodeError keeps its code, anything else is -32603 with no stack", async () => {
		const server = await startTestServer(
			{
				"missions.get": () => Promise.reject(new NodeError("NOT_FOUND", "no such mission")),
				snapshot: () => Promise.reject(new Error("boom")),
			},
			dir,
		);
		try {
			const client = await openClient(server.socketPath);
			client.send(hello());
			await client.nextFrame();
			client.send({ jsonrpc: "2.0", id: 2, method: "missions.get", params: {} });
			expect(errorOf(await client.nextFrame())).toMatchObject({ code: -32002, data: { code: "NOT_FOUND" } });
			client.send({ jsonrpc: "2.0", id: 3, method: "snapshot", params: {} });
			const frame = await client.nextFrame();
			expect(errorOf(frame)).toMatchObject({ code: -32603, data: { code: "INTERNAL" } });
			expect(JSON.stringify(frame).includes("at ")).toBe(false);
			client.socket.destroy();
		} finally {
			await server.close();
		}
	});
});

describe("fan-out", () => {
	test("two clients each receive one hub.broadcast", async () => {
		const server = await startTestServer({}, dir);
		try {
			const first = await openClient(server.socketPath);
			const second = await openClient(server.socketPath);
			first.send(hello(1));
			second.send(hello(2));
			await first.nextFrame();
			await second.nextFrame();
			server.hub.broadcast("event", { event: { seq: 1 } });
			expect(await first.nextFrame()).toMatchObject({ method: "event", params: { event: { seq: 1 } } });
			expect(await second.nextFrame()).toMatchObject({ method: "event", params: { event: { seq: 1 } } });
			first.socket.destroy();
			second.socket.destroy();
		} finally {
			await server.close();
		}
	});

	test("toTail reaches only the connection whose tailed holds that session", async () => {
		const server = await startTestServer({}, dir);
		try {
			const tailer = await openClient(server.socketPath);
			tailer.send(hello(1));
			await tailer.nextFrame();
			const conns = server.hub.connections();
			expect(conns).toHaveLength(1);
			conns[0]?.tailed.add("01ARZ3NDEKTSV4RRFFQ69G5FAV");
			const other = await openClient(server.socketPath);
			other.send(hello(2));
			await other.nextFrame();
			server.hub.toTail("01ARZ3NDEKTSV4RRFFQ69G5FAV", { sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
			expect(await tailer.nextFrame()).toMatchObject({ method: "turn" });
			// The other client gets nothing; a broadcast still reaches both.
			server.hub.broadcast("node", { phase: "stopping" });
			expect(await tailer.nextFrame()).toMatchObject({ method: "node" });
			expect(await other.nextFrame()).toMatchObject({ method: "node" });
			tailer.socket.destroy();
			other.socket.destroy();
		} finally {
			await server.close();
		}
	});

	test("a connection 1000 notifications behind is dropped", async () => {
		const server = await startTestServer({}, dir);
		try {
			const client = await openClient(server.socketPath);
			client.send(hello(1));
			await client.nextFrame();
			const conns = server.hub.connections();
			expect(conns).toHaveLength(1);
			for (let n = 0; n < 1001; n++) {
				conns[0]?.send("event", { n });
			}
			await client.closed;
		} finally {
			await server.close();
		}
	});
});

describe("bind and close", () => {
	test("a stale socket path is unlinked before bind", async () => {
		const socketPath = join(dir, "node.sock");
		await writeFile(socketPath, "stale");
		const server = await startTestServer({}, dir);
		try {
			const client = await openClient(socketPath);
			client.send(hello());
			expect(typeof (await client.nextFrame()).result).toBe("object");
			client.socket.destroy();
		} finally {
			await server.close();
		}
	});

	test("close unlinks the socket and is idempotent", async () => {
		const server = await startTestServer({}, dir);
		const client = await openClient(server.socketPath);
		client.send(hello());
		await client.nextFrame();
		await server.close();
		await server.close();
		await client.closed;
		await expect(stat(server.socketPath)).rejects.toThrow();
	});
});
