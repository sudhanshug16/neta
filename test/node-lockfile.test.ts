import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AlreadyRunningError,
	acquireLock,
	clearDescriptor,
	type NodeDescriptor,
	netaDir,
	newToken,
	readDescriptor,
	writeDescriptor,
} from "../src/node/lockfile.ts";

let dir = "";
let savedNetadir: string | undefined;

beforeEach(async () => {
	savedNetadir = process.env.NETA_DIR;
	dir = await mkdtemp(join(tmpdir(), "neta-lock-"));
	process.env.NETA_DIR = dir;
});

afterEach(async () => {
	if (savedNetadir === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = savedNetadir;
	}
	await rm(dir, { recursive: true, force: true });
});

describe("node descriptor", () => {
	test("it round-trips at mode 0600", async () => {
		const descriptor: NodeDescriptor = {
			socket: join(netaDir(), "node.sock"),
			token: newToken(),
			pid: process.pid,
			protocolVersion: 1,
			startedAt: new Date(0).toISOString(),
		};
		await writeDescriptor(descriptor);
		expect(await readDescriptor()).toEqual(descriptor);
		expect((await stat(join(dir, "node.json"))).mode & 0o777).toBe(0o600);
	});

	test("a missing descriptor reads undefined, clearing is idempotent", async () => {
		expect(await readDescriptor()).toBeUndefined();
		await clearDescriptor();
		await clearDescriptor();
	});

	test("tokens are 64 hex chars and unique", () => {
		const first = newToken();
		const second = newToken();
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(second).toMatch(/^[0-9a-f]{64}$/);
		expect(first).not.toBe(second);
	});
});

describe("single-instance lock", () => {
	test("a second acquireLock throws ALREADY_RUNNING", async () => {
		const first = await acquireLock();
		let thrown: unknown;
		try {
			await acquireLock();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AlreadyRunningError);
		expect((thrown as AlreadyRunningError).name).toBe("AlreadyRunningError");
		expect((thrown as AlreadyRunningError).pid).toBe(process.pid);
		await first.release();
	});

	test("a lock held by a dead pid is taken over", async () => {
		const child = Bun.spawnSync(["true"]);
		expect(child.exitCode).toBe(0);
		await writeFile(join(dir, "node.lock"), String(child.pid), { flag: "wx" });
		const lock = await acquireLock();
		expect(lock.pid).toBe(process.pid);
		await lock.release();
	});

	test("release removes the file and is idempotent", async () => {
		const lock = await acquireLock();
		await lock.release();
		await lock.release();
		await expect(stat(join(dir, "node.lock"))).rejects.toThrow();
		// The lock can be taken again after release.
		const again = await acquireLock();
		await again.release();
	});
});

test("concurrent reclamation of abandoned records elects exactly one owner", async () => {
	// A persisted PID can be recycled: JSON identity records are not liveness.
	await writeFile(join(dir, "node.lock"), JSON.stringify({ pid: process.pid, instanceId: "abandoned" }));
	const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock()));
	const winners = attempts.filter((item) => item.status === "fulfilled");
	expect(winners).toHaveLength(1);
	expect(
		attempts.filter((item) => item.status === "rejected" && item.reason instanceof AlreadyRunningError),
	).toHaveLength(7);
	for (const winner of winners) if (winner.status === "fulfilled") await winner.value.release();
});

test("old cleanup does not remove successor descriptor or lock", async () => {
	const first = await acquireLock();
	await first.release();
	const successor = await acquireLock();
	const descriptor: NodeDescriptor = {
		socket: join(dir, "node.sock"),
		token: newToken(),
		pid: process.pid,
		protocolVersion: 1,
		startedAt: new Date().toISOString(),
		instanceId: successor.instanceId,
	};
	await writeDescriptor(descriptor);
	await clearDescriptor(first.instanceId);
	await first.release();
	expect(await readDescriptor()).toEqual(descriptor);
	expect(JSON.parse(await readFile(join(dir, "node.lock"), "utf8")).instanceId).toBe(successor.instanceId);
	await clearDescriptor(successor.instanceId);
	expect(await readDescriptor()).toBeUndefined();
	await successor.release();
});

test("kernel releases ownership after SIGKILL without deleting stale files", async () => {
	const child = Bun.spawn([process.execPath, new URL("fixtures/node-lock-owner.ts", import.meta.url).pathname], {
		env: { ...process.env, NETA_DIR: dir },
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const reader = child.stdout.getReader();
		const first = await reader.read();
		reader.releaseLock();
		expect(new TextDecoder().decode(first.value).trim()).toMatch(/^[0-9a-f-]{36}$/);
		await expect(acquireLock()).rejects.toBeInstanceOf(AlreadyRunningError);
		child.kill("SIGKILL");
		await child.exited;
		const recovered = await acquireLock();
		await recovered.release();
	} finally {
		child.kill();
		await child.exited;
	}
});

test("foreign listener collision fails closed without removing records", async () => {
	const key = createHash("sha256")
		.update(await realpath(dir))
		.digest("hex");
	const port = 20000 + (Number.parseInt(key.slice(0, 8), 16) % 40000);
	const foreign = createServer((socket) => socket.end("foreign service\n"));
	await new Promise<void>((resolve, reject) => {
		foreign.once("error", reject);
		foreign.listen(port, "127.0.0.1", resolve);
	});
	try {
		await writeFile(join(dir, "node.lock"), "retained");
		await expect(acquireLock()).rejects.toThrow("unrelated or unresponsive listener");
		expect(await readFile(join(dir, "node.lock"), "utf8")).toBe("retained");
		expect(foreign.listening).toBe(true);
	} finally {
		await new Promise<void>((resolve) => foreign.close(() => resolve()));
	}
});

test("corrupt descriptors report a classified recovery error", async () => {
	for (const value of ["{broken", "null", "{}", '{"pid":1}']) {
		await writeFile(join(dir, "node.json"), value);
		try {
			await readDescriptor();
			throw new Error("unexpected success");
		} catch (error) {
			expect(error).toMatchObject({ code: "NETA_DESCRIPTOR_INVALID" });
		}
	}
});
