import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
