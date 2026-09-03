import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "../src/core/types.ts";
import { connectNode, type NodeClient } from "../src/node/client.ts";
import { writeDescriptor } from "../src/node/lockfile.ts";
import {
	type Connection,
	createServer,
	type Hub,
	type NodeAcp,
	type NodeContext,
	type NodeStore,
} from "../src/node/server.ts";

const TOKEN = "client-test-token";
const MACHINE: Machine = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "test", createdAt: new Date(0).toISOString() };

function stubStore(): NodeStore {
	return {
		machine: () => MACHINE,
		listWorkspaces: () => {
			throw new Error("not implemented in this test");
		},
		listLeaders: () => {
			throw new Error("not implemented in this test");
		},
		listMissions: () => {
			throw new Error("not implemented in this test");
		},
		listAgents: () => {
			throw new Error("not implemented in this test");
		},
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
	return {
		createSession: () => Promise.reject(new Error("not implemented in this test")),
		prompt: () => Promise.reject(new Error("not implemented in this test")),
		setModel: () => Promise.reject(new Error("not implemented in this test")),
		listModels: () => Promise.reject(new Error("not implemented in this test")),
		cancel: () => Promise.reject(new Error("not implemented in this test")),
		close: () => Promise.reject(new Error("not implemented in this test")),
		closeAll: () => Promise.reject(new Error("not implemented in this test")),
		onTurn: () => {
			throw new Error("not implemented in this test");
		},
	};
}

type Handler = (ctx: NodeContext, params: unknown, conn: Connection) => Promise<unknown>;

let dir = "";
let savedNetadir: string | undefined;
let savedPath: string | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
	savedNetadir = process.env.NETA_DIR;
	savedPath = process.env.PATH;
	dir = await mkdtemp(join(tmpdir(), "neta-client-"));
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
	if (savedPath !== undefined) {
		process.env.PATH = savedPath;
	}
	await rm(dir, { recursive: true, force: true });
});

async function startNode(handlers: Record<string, Handler>): Promise<{ hub: Hub; socketPath: string }> {
	const socketPath = join(dir, "node.sock");
	await writeDescriptor({
		socket: socketPath,
		token: TOKEN,
		pid: process.pid,
		protocolVersion: 1,
		startedAt: new Date(0).toISOString(),
	});
	const { hub, close } = await createServer({
		socketPath,
		token: TOKEN,
		handlers,
		ctx: { store: stubStore(), acp: stubAcp(), nodeVersion: "0.0.0-test", stop: () => Promise.resolve() },
	});
	closers.push(close);
	return { hub, socketPath };
}

describe("against a real server", () => {
	test("request resolves and hello carries the handshake", async () => {
		await startNode({ snapshot: (_ctx, params) => Promise.resolve({ echoed: params }) });
		const client = await connectNode();
		closers.push(() => client.close());
		expect(client.hello.machine).toEqual(MACHINE);
		expect(client.hello.protocolVersion).toBe(1);
		expect(await client.request<{ echoed: { a: number } }>("snapshot", { a: 1 })).toEqual({ echoed: { a: 1 } });
		await client.close();
	});

	test("a notification callback fires until it unsubscribes", async () => {
		const { hub } = await startNode({});
		const client = await connectNode();
		closers.push(() => client.close());
		const seen: unknown[] = [];
		const off = client.on("event", (params) => {
			seen.push(params);
		});
		hub.broadcast("event", { seq: 1 });
		await new Promise((done) => setTimeout(done, 100));
		off();
		hub.broadcast("event", { seq: 2 });
		await new Promise((done) => setTimeout(done, 100));
		expect(seen).toEqual([{ seq: 1 }]);
		await client.close();
	});

	test("pending requests reject on close", async () => {
		await startNode({ snapshot: () => new Promise<unknown>(() => undefined) });
		const client = await connectNode();
		closers.push(() => client.close());
		const requested = client.request("snapshot", {});
		await client.close();
		await expect(requested).rejects.toThrow(/closed/);
		await client.closed;
	});
});

// A fake `neta` the autostart path spawns: after 300 ms it writes a
// descriptor and answers one hello over a raw socket.
const FAKE_NETA = `import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const dir = process.env.NETA_DIR;
await new Promise((done) => setTimeout(done, 300));
await writeFile(join(dir, "node.json"), JSON.stringify({ socket: join(dir, "node.sock"), token: "fake-token", pid: process.pid, protocolVersion: 1, startedAt: new Date(0).toISOString() }));
const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "hello") {
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { machine: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "fake", createdAt: new Date(0).toISOString() }, protocolVersion: 1, nodeVersion: "fake", pid: process.pid } }) + "\\n");
    }
  });
});
server.listen(join(dir, "node.sock"));
`;

async function installFakeNeta(script: string): Promise<void> {
	const bin = join(dir, "bin");
	await writeFile(join(dir, "fake-neta.mjs"), script);
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "neta"), `#!/bin/sh\nexec node "${join(dir, "fake-neta.mjs")}" "$@"\n`);
	await chmod(join(bin, "neta"), 0o755);
	process.env.PATH = `${bin}:${savedPath ?? ""}`;
}

describe("autostart", () => {
	test("a socket appearing after 300 ms connects", async () => {
		await installFakeNeta(FAKE_NETA);
		const client: NodeClient = await connectNode({ autostart: true, timeoutMs: 5000 });
		closers.push(() => client.close());
		expect(client.hello.machine.name).toBe("fake");
		const pid = client.hello.pid;
		await client.close();
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone; the temp dir goes with it.
		}
	});

	test("a socket that never appears rejects inside timeoutMs", async () => {
		await installFakeNeta("process.exit(0);\n");
		const started = performance.now();
		await expect(connectNode({ autostart: true, timeoutMs: 400 })).rejects.toThrow(/timed out/);
		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(300);
		expect(elapsed).toBeLessThan(10000);
	});
});
