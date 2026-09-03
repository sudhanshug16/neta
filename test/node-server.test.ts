import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import { nodeFile, serveFile } from "../src/node/server.ts";

const prevDir = process.env.NETA_DIR;

beforeEach(() => {
	process.env.NETA_DIR = mkdtempSync(join(tmpdir(), "neta-srv-"));
});

afterEach(() => {
	if (prevDir === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = prevDir;
	}
});

function socketPath(): string {
	return join(tmpdir(), `neta-test-${process.pid}-${ulid()}.sock`);
}

interface RawClient {
	socket: Socket;
	next(): Promise<string>;
	close(): void;
}

function dial(path: string): Promise<RawClient> {
	return new Promise<RawClient>((resolve, reject) => {
		const socket = connect(path);
		let buffer = "";
		const waiting: Array<(line: string) => void> = [];
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) {
					return;
				}
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const waiter = waiting.shift();
				if (waiter !== undefined) {
					waiter(line);
				}
			}
		});
		socket.on("connect", () => {
			resolve({
				socket,
				next: () =>
					new Promise<string>((done) => {
						waiting.push(done);
					}),
				close: () => socket.destroy(),
			});
		});
		socket.on("error", reject);
	});
}

async function ping(
	client: RawClient,
	method: string,
	params?: unknown,
): Promise<{ ok: boolean; result?: unknown; error?: { code: string } }> {
	const id = ulid();
	client.socket.write(`${JSON.stringify({ v: 1, id, method, params })}\n`);
	const line = await client.next();
	return JSON.parse(line) as { ok: boolean; result?: unknown; error?: { code: string } };
}

describe("socket server", () => {
	test("a ping round-trips and nodeFile carries version, pid and startedAt", async () => {
		const path = socketPath();
		const server = await serveFile({
			socketPath: path,
			options: {
				onRequest: (method) => {
					if (method === "neta_ping") {
						return "pong";
					}
					throw new Error("nope");
				},
			},
		});
		try {
			expect(statSync(path).mode & 0o777).toBe(0o600);
			const client = await dial(path);
			expect(server.clients).toBe(1);
			expect(await ping(client, "neta_ping")).toMatchObject({ ok: true, result: "pong" });
			client.close();
			const record = await nodeFile({ socketPath: path });
			expect(record.version).toBe(1);
			expect(record.pid).toBe(process.pid);
			expect(typeof record.startedAt).toBe("string");
		} finally {
			await server.close();
		}
	});

	test("framing errors close one connection, never the server", async () => {
		const path = socketPath();
		const server = await serveFile({
			socketPath: path,
			options: { onRequest: () => "pong" },
		});
		try {
			const bad = await dial(path);
			const closed = new Promise<void>((done) => bad.socket.on("close", () => done()));
			bad.socket.write("{oops\n");
			await closed;
			const good = await dial(path);
			expect((await ping(good, "neta_ping")).ok).toBe(true);
			good.close();
		} finally {
			await server.close();
		}
	});

	test("an abrupt client close leaves the server serving", async () => {
		const path = socketPath();
		const server = await serveFile({
			socketPath: path,
			options: { onRequest: () => "pong" },
		});
		try {
			const first = await dial(path);
			first.socket.destroy();
			await Bun.sleep(50);
			const second = await dial(path);
			expect((await ping(second, "neta_ping")).ok).toBe(true);
			expect(server.clients).toBe(1);
			second.close();
		} finally {
			await server.close();
		}
	});

	test("a live server wins over a second bind, a stale file does not", async () => {
		const path = socketPath();
		const server = await serveFile({
			socketPath: path,
			options: { onRequest: () => "pong" },
		});
		try {
			await expect(serveFile({ socketPath: path, options: { onRequest: () => "pong" } })).rejects.toThrow();
		} finally {
			await server.close();
		}
		const stale = socketPath();
		writeFileSync(stale, "leftover");
		const rebound = await serveFile({ socketPath: stale, options: { onRequest: () => "pong" } });
		const client = await dial(stale);
		expect((await ping(client, "neta_ping")).ok).toBe(true);
		client.close();
		await rebound.close();
	});
});
