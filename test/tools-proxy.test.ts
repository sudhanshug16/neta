import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { writeDescriptor } from "../src/node/lockfile.ts";
import { type Connection, createServer, type NodeContext } from "../src/node/server.ts";
import { runProxy } from "../src/tools/proxy.ts";

const TOKEN = "proxy-test-token";
const ACTOR = "actor-1";
const ACTOR_TOKEN = "actor-token-1";

const STUB_TOOLS = [{ name: "neta_status", description: "open-mission state", inputSchema: { type: "object" } }];

type Handler = (ctx: NodeContext, params: unknown, conn: Connection) => Promise<unknown>;

let dir = "";
let savedNetadir: string | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
	savedNetadir = process.env.NETA_DIR;
	dir = await mkdtemp(join(tmpdir(), "neta-proxy-"));
	process.env.NETA_DIR = dir;
});

afterEach(async () => {
	for (const close of closers.splice(0)) {
		await close().catch(() => undefined);
	}
	if (savedNetadir === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = savedNetadir;
	}
	await rm(dir, { recursive: true, force: true });
});

function stubStore(): NodeContext["store"] {
	const machine = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "test", createdAt: new Date(0).toISOString() };
	return {
		machine: () => machine,
		listWorkspaces: () => [],
		listLeaders: () => [],
		listMissions: () => [],
		listAgents: () => [],
		getWorkspace: () => undefined,
		getLeader: () => undefined,
		getMission: () => undefined,
		getAgent: () => undefined,
		putWorkspace: () => Promise.resolve(),
		putAgent: () => Promise.resolve(),
		putLeader: () => Promise.resolve(),
		compact: () => Promise.resolve(),
		appendEvent: () => Promise.reject(new Error("unused")),
		listEvents: () => Promise.reject(new Error("unused")),
		tailConversation: () => Promise.reject(new Error("unused")),
	};
}

async function startStub(seen: { list: unknown[]; call: unknown[] }): Promise<string> {
	const socketPath = join(dir, "node.sock");
	await writeDescriptor({
		socket: socketPath,
		token: TOKEN,
		pid: process.pid,
		protocolVersion: 1,
		startedAt: new Date(0).toISOString(),
	});
	const handlers: Record<string, Handler> = {
		"tools.list": (_ctx, params) => {
			seen.list.push(params);
			return Promise.resolve({ tools: STUB_TOOLS });
		},
		"tools.call": (_ctx, params) => {
			seen.call.push(params);
			return Promise.resolve({ content: [{ type: "text", text: "called" }], isError: false });
		},
	};
	const { close } = await createServer({
		socketPath,
		token: TOKEN,
		handlers,
		ctx: {
			store: stubStore(),
			acp: {
				createSession: () => Promise.reject(new Error("unused")),
				prompt: () => Promise.reject(new Error("unused")),
				setModel: () => Promise.reject(new Error("unused")),
				listModels: () => Promise.reject(new Error("unused")),
				cancel: () => Promise.reject(new Error("unused")),
				close: () => Promise.reject(new Error("unused")),
				closeAll: () => Promise.reject(new Error("unused")),
				onTurn: () => undefined,
			},
			nodeVersion: "0.0.0-test",
			stop: () => Promise.resolve(),
		},
	});
	closers.push(close);
	return socketPath;
}

interface Harness {
	stdin: PassThrough;
	lines: Array<Record<string, unknown>>;
	done: Promise<number>;
	send(method: string, params: unknown, id: number): void;
	notify(method: string, params: unknown): void;
	response(id: number): Promise<Record<string, unknown>>;
}

function harness(extra?: { socketPath?: string }): Harness {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const lines: Array<Record<string, unknown>> = [];
	let buffer = "";
	stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const raw = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (raw !== "") {
				lines.push(JSON.parse(raw) as Record<string, unknown>);
			}
			newline = buffer.indexOf("\n");
		}
	});
	const done = runProxy({ actorId: ACTOR, token: ACTOR_TOKEN, socketPath: extra?.socketPath, stdin, stdout });
	return {
		stdin,
		lines,
		done,
		send(method, params, id) {
			stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		},
		notify(method, params) {
			stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
		},
		async response(id: number) {
			const deadline = Date.now() + 5000;
			for (;;) {
				const found = lines.find((line) => line.id === id);
				if (found !== undefined) {
					return found;
				}
				if (Date.now() > deadline) {
					throw new Error(`no response for id ${id}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
	};
}

describe("stdio MCP proxy", () => {
	test("tools/list after initialize returns the stub's list", async () => {
		const seen = { list: [] as unknown[], call: [] as unknown[] };
		await startStub(seen);
		const h = harness();
		h.send(
			"initialize",
			{ protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
			1,
		);
		const hello = await h.response(1);
		const result = hello.result as {
			protocolVersion: string;
			serverInfo: { name: string; version: string };
			capabilities: { tools: object };
		};
		expect(result.protocolVersion).toBe("2024-11-05");
		expect(result.serverInfo.name).toBe("neta");
		expect(typeof result.serverInfo.version).toBe("string");
		expect(result.capabilities).toEqual({ tools: {} });
		h.notify("notifications/initialized", {});
		h.send("tools/list", {}, 2);
		const listed = await h.response(2);
		expect(listed.result).toEqual({ tools: STUB_TOOLS });
		expect(seen.list).toEqual([{ actorId: ACTOR, token: ACTOR_TOKEN }]);
		h.stdin.end();
		await expect(h.done).resolves.toBe(0);
	});

	test("tools/call forwards name, arguments, actor and token verbatim", async () => {
		const seen = { list: [] as unknown[], call: [] as unknown[] };
		await startStub(seen);
		const h = harness();
		h.send("tools/call", { name: "neta_mission", arguments: { name: "x" } }, 1);
		const answered = await h.response(1);
		expect(answered.result).toEqual({ content: [{ type: "text", text: "called" }], isError: false });
		expect(seen.call).toEqual([
			{ name: "neta_mission", arguments: { name: "x" }, actorId: ACTOR, token: ACTOR_TOKEN },
		]);
		h.stdin.end();
		await expect(h.done).resolves.toBe(0);
	});

	test("an unknown method is JSON-RPC -32601", async () => {
		const seen = { list: [] as unknown[], call: [] as unknown[] };
		await startStub(seen);
		const h = harness();
		h.send("bogus/method", {}, 7);
		const answered = await h.response(7);
		expect((answered.error as { code: number }).code).toBe(-32601);
		h.stdin.end();
		await expect(h.done).resolves.toBe(0);
	});

	test("a refused connection yields an unavailable response rather than a crash", async () => {
		const h = harness({ socketPath: join(dir, "missing.sock") });
		h.send("tools/call", { name: "neta_status", arguments: {} }, 1);
		const answered = await h.response(1);
		const result = answered.result as { content: Array<{ text: string }>; isError: boolean };
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text.startsWith("error unavailable:")).toBe(true);
		h.send("tools/list", {}, 2);
		const listed = await h.response(2);
		expect((listed.error as { code: number }).code).toBe(-32603);
		h.stdin.end();
		await expect(h.done).resolves.toBe(0);
	});
});
