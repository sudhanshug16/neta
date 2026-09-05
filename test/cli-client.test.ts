// T8.2: one connection to the Node, on-demand start, error mapping. The
// transport (framing, hello, retry) belongs to `connectNode`; these tests
// pin the CLI layer: `CliError` codes, the version check, and survival of
// a malformed line.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, NodeClient } from "../src/cli/client.ts";
import type { Machine } from "../src/core/types.ts";
import { startNode as startLifecycleNode } from "../src/node/lifecycle.ts";
import { readDescriptor, writeDescriptor } from "../src/node/lockfile.ts";
import { NodeError, PROTOCOL_VERSION } from "../src/node/protocol.ts";
import { type Connection, createServer, type NodeAcp, type NodeContext, type NodeStore } from "../src/node/server.ts";

const TOKEN = "cli-client-test-token";
const MACHINE: Machine = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "test", createdAt: new Date(0).toISOString() };

function stubStore(): NodeStore {
	return {
		machine: () => MACHINE,
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
		appendEvent: () => Promise.reject(new Error("not implemented in this test")),
		listEvents: () => Promise.resolve({ events: [] }),
		tailConversation: () => Promise.reject(new Error("not implemented in this test")),
	};
}

function stubAcp(): NodeAcp {
	return {
		createSession: () => Promise.reject(new Error("not implemented in this test")),
		ensureSession: () => Promise.reject(new Error("not implemented in this test")),
		prompt: () => Promise.reject(new Error("not implemented in this test")),
		setModel: () => Promise.reject(new Error("not implemented in this test")),
		listModels: () => Promise.reject(new Error("not implemented in this test")),
		cancel: () => Promise.reject(new Error("not implemented in this test")),
		close: () => Promise.reject(new Error("not implemented in this test")),
		closeAll: () => Promise.resolve(),
		onTurn: () => undefined,
	};
}

type Handler = (ctx: NodeContext, params: unknown, conn: Connection) => Promise<unknown>;

let dir = "";
let savedNetadir: string | undefined;
let savedSelf: string | undefined;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
	savedNetadir = process.env.NETA_DIR;
	savedSelf = process.argv[1];
	dir = await mkdtemp(join(tmpdir(), "neta-cli-client-"));
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
	if (savedSelf !== undefined) {
		process.argv[1] = savedSelf;
	}
	await rm(dir, { recursive: true, force: true });
});

async function codeOf(promise: Promise<unknown>): Promise<1 | 2 | 3> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(CliError);
		return (error as CliError).code;
	}
	throw new Error("expected the promise to reject with a CliError");
}

async function startTestServer(handlers: Record<string, Handler>): Promise<void> {
	const socketPath = join(dir, "node.sock");
	await writeDescriptor({
		socket: socketPath,
		token: TOKEN,
		pid: process.pid,
		protocolVersion: PROTOCOL_VERSION,
		startedAt: new Date(0).toISOString(),
	});
	const { close } = await createServer({
		socketPath,
		token: TOKEN,
		handlers,
		ctx: { store: stubStore(), acp: stubAcp(), nodeVersion: "0.0.0-test", stop: () => Promise.resolve() },
	});
	closers.push(close);
}

// A raw in-process stand-in for a node: answers `hello`, optionally emits
// raw lines right after it, then answers every request with `respond`.
async function startRawServer(o: {
	token: string;
	helloResult?: Record<string, unknown>;
	prelude?: string[];
	respond?: (method: string, params: unknown) => unknown;
}): Promise<void> {
	const socketPath = join(dir, "node.sock");
	try {
		await unlink(socketPath);
	} catch {
		// No stale socket.
	}
	await writeDescriptor({
		socket: socketPath,
		token: o.token,
		pid: process.pid,
		protocolVersion: PROTOCOL_VERSION,
		startedAt: new Date(0).toISOString(),
	});
	const server: NetServer = createNetServer((socket) => {
		let buffer = "";
		let hellod = false;
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) {
					return;
				}
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line === "") {
					continue;
				}
				let message: { id?: unknown; method?: string; params?: unknown };
				try {
					message = JSON.parse(line) as { id?: unknown; method?: string; params?: unknown };
				} catch {
					continue;
				}
				if (!hellod) {
					hellod = true;
					const result = o.helloResult ?? {
						machine: MACHINE,
						protocolVersion: PROTOCOL_VERSION,
						nodeVersion: "raw-fake",
						pid: process.pid,
					};
					socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
					// On its own tick, so it never shares a chunk with the
					// hello reply: a batched bad line would take the good
					// reply down with it (decodeLines resyncs past it).
					const prelude = o.prelude ?? [];
					if (prelude.length > 0) {
						setTimeout(() => {
							for (const raw of prelude) {
								socket.write(`${raw}\n`);
							}
						}, 50);
					}
					continue;
				}
				if (message.id !== undefined) {
					const result = o.respond?.(message.method ?? "", message.params) ?? { ok: true };
					socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
				}
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	await chmod(socketPath, 0o600);
	closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

describe("connect", () => {
	test("round-trip hello against a running Node", async () => {
		const node = await startLifecycleNode({ store: stubStore(), acp: stubAcp() });
		closers.push(() => node.stop());
		const client = await NodeClient.connect();
		try {
			const snapshot = await client.request<{ protocolVersion: number }>("snapshot", {});
			expect(snapshot.protocolVersion).toBe(PROTOCOL_VERSION);
		} finally {
			client.close();
		}
	});

	test("no node.json with start: false throws CliError code 2", async () => {
		expect(await readDescriptor()).toBeUndefined();
		await expect(NodeClient.connect()).rejects.toMatchObject({ name: "CliError", code: 2 });
		await expect(NodeClient.connect({ start: false })).rejects.toMatchObject({ name: "CliError", code: 2 });
	});

	test("a dead pid with start: false throws CliError code 2", async () => {
		const deadPid = spawnSync("true").pid ?? 2147483647;
		await writeDescriptor({
			socket: join(dir, "node.sock"),
			token: TOKEN,
			pid: deadPid,
			protocolVersion: PROTOCOL_VERSION,
			startedAt: new Date(0).toISOString(),
		});
		const error = await NodeClient.connect().then(
			() => {
				throw new Error("expected connect to reject");
			},
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(CliError);
		expect((error as CliError).code).toBe(2);
	});

	test("a version mismatch is CliError(2)", async () => {
		const spoken = PROTOCOL_VERSION + 1;
		await startRawServer({
			token: TOKEN,
			helloResult: { machine: MACHINE, protocolVersion: spoken, nodeVersion: "raw-fake", pid: process.pid },
		});
		const error = await NodeClient.connect().then(
			() => {
				throw new Error("expected connect to reject");
			},
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(CliError);
		expect((error as CliError).code).toBe(2);
		expect((error as CliError).message).toBe(`node speaks protocol ${spoken}, this CLI speaks ${PROTOCOL_VERSION}`);
	});
});

describe("error mapping", () => {
	test("UNAUTHORIZED and CONFIRMATION_REQUIRED map to code 3, other protocol errors to 1", async () => {
		await startTestServer({
			denied: () => Promise.reject(new NodeError("UNAUTHORIZED", "bad actor token")),
			confirm: () =>
				Promise.reject(new NodeError("CONFIRMATION_REQUIRED", "archiving a running agent needs confirm")),
			missing: () => Promise.reject(new NodeError("NOT_FOUND", "no such mission")),
		});
		const client = await NodeClient.connect();
		try {
			expect(await codeOf(client.request("denied", {}))).toBe(3);
			expect(await codeOf(client.request("confirm", {}))).toBe(3);
			expect(await codeOf(client.request("missing", {}))).toBe(1);
			expect(await codeOf(client.request("no-such-method", {}))).toBe(1);
		} finally {
			client.close();
		}
	});

	test("a malformed NDJSON line is ignored without killing the connection", async () => {
		await startRawServer({ token: TOKEN, prelude: ["this is not json"] });
		const client = await NodeClient.connect();
		// Let the garbage line arrive and be ignored before requesting.
		await new Promise((done) => setTimeout(done, 300));
		try {
			expect(await client.request<{ ok: boolean }>("snapshot", {})).toEqual({ ok: true });
			expect(await client.request<{ ok: boolean }>("snapshot", {})).toEqual({ ok: true });
		} finally {
			client.close();
		}
	});
});

// A fake `neta` the autostart path spawns: after 300 ms it writes a
// descriptor and answers one hello over a raw socket.
const FAKE_NETA = `import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const dir = process.env.NETA_DIR;
await new Promise((done) => setTimeout(done, 300));
await writeFile(join(dir, "node.json"), JSON.stringify({ socket: join(dir, "node.sock"), token: "fake-token", pid: process.pid, protocolVersion: ${PROTOCOL_VERSION}, startedAt: new Date(0).toISOString() }));
const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "hello") {
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { machine: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "fake", createdAt: new Date(0).toISOString() }, protocolVersion: ${PROTOCOL_VERSION}, nodeVersion: "fake", pid: process.pid } }) + "\\n");
    } else if (message.id !== undefined) {
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
    }
  });
});
server.listen(join(dir, "node.sock"));
`;

// The autostart no longer shells out to a bare `neta` from PATH — inside
// `NetaDesktop.app` there is none — but re-invokes this program through
// `core/self.ts`, so the fake goes where `process.argv[1]` points.
async function installFakeNeta(script: string): Promise<void> {
	const fake = join(dir, "fake-neta.mjs");
	await writeFile(fake, script);
	process.argv[1] = fake;
}

describe("start on demand", () => {
	// The fake sleeps 300 ms before it writes `node.json`, and spawning it is
	// a whole process start: the 5 s default was not enough on a machine also
	// running a Swift build, and the connect then timed out after the test
	// had been torn down. `timeoutMs` overrides the default only here; the
	// CLI itself still gives up after 5 s.
	test("start: true starts a reachable Node", async () => {
		await installFakeNeta(FAKE_NETA);
		const client = await NodeClient.connect({ start: true, timeoutMs: 60_000 });
		try {
			expect(await client.request<Record<string, never>>("snapshot", {})).toEqual({});
		} finally {
			client.close();
		}
		const descriptor = await readDescriptor();
		expect(descriptor?.token).toBe("fake-token");
		if (descriptor !== undefined) {
			try {
				process.kill(descriptor.pid, "SIGTERM");
			} catch {
				// Already gone; the temp dir goes with it.
			}
		}
	}, 90_000);
});
