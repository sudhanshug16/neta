import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId, WorkspaceId } from "../src/core/types.ts";
import {
	BASE_LEASE,
	createFileLeaseStore,
	LeaseManager,
	type LeaseRecord,
	type LeaseState,
	type LeaseStore,
	leaseKeyFor,
} from "../src/worktrees/leases.ts";

const W = "ws";
const KEY = "/wt-1";

function memoryStore(): LeaseStore {
	const states = new Map<WorkspaceId, LeaseState>();
	return {
		read: (w) => Promise.resolve(states.get(w) ?? { workspaceId: w, leases: {} }),
		write: (s) => {
			states.set(s.workspaceId, JSON.parse(JSON.stringify(s)) as LeaseState);
			return Promise.resolve();
		},
	};
}

describe("writer leases", () => {
	test("three writers on one key give active, queued, queued with positions 1 and 2", async () => {
		const manager = new LeaseManager(memoryStore());
		const [a, b, c] = await Promise.all([
			manager.acquire(W, "a1" as AgentId, KEY),
			manager.acquire(W, "a2" as AgentId, KEY),
			manager.acquire(W, "a3" as AgentId, KEY),
		]);
		expect([a, b, c]).toEqual(["active", "queued", "queued"]);
		expect(await manager.holder(W, KEY)).toBe("a1");
		expect(await manager.queuePosition(W, "a2")).toBe(1);
		expect(await manager.queuePosition(W, "a3")).toBe(2);
		expect(await manager.queuePosition(W, "a1")).toBeUndefined();
		expect(await manager.queuePosition(W, "stranger" as AgentId)).toBeUndefined();
	});

	test("releasing the holder promotes the first queued agent", async () => {
		const seen: LeaseRecord[] = [];
		const manager = new LeaseManager(memoryStore(), (_w, record) => seen.push(record));
		await manager.acquire(W, "a1" as AgentId, KEY);
		await manager.acquire(W, "a2" as AgentId, KEY);
		await manager.acquire(W, "a3" as AgentId, KEY);
		const changed = await manager.release(W, "a1" as AgentId);
		expect(changed).toEqual([{ key: KEY, promoted: "a2" }]);
		expect(await manager.holder(W, KEY)).toBe("a2");
		expect(await manager.queuePosition(W, "a3")).toBe(1);
		expect(seen.map((record) => record.holder)).toEqual(["a2"]);
	});

	test("interrupting a holder preserves the queue without starting it", async () => {
		const manager = new LeaseManager(memoryStore());
		await manager.acquire(W, "a1" as AgentId, KEY);
		await manager.acquire(W, "a2" as AgentId, KEY);
		await manager.interrupt(W, "a1" as AgentId);
		expect(await manager.holder(W, KEY)).toBeUndefined();
		expect(await manager.queuePosition(W, "a2" as AgentId)).toBe(1);
		expect(await manager.acquire(W, "a2" as AgentId, KEY)).toBe("active");
	});

	test("releasing a queued agent leaves the holder alone", async () => {
		const manager = new LeaseManager(memoryStore());
		await manager.acquire(W, "a1" as AgentId, KEY);
		await manager.acquire(W, "a2" as AgentId, KEY);
		const changed = await manager.release(W, "a2" as AgentId);
		expect(changed).toEqual([]);
		expect(await manager.holder(W, KEY)).toBe("a1");
		expect(await manager.queuePosition(W, "a2")).toBeUndefined();
	});

	test("two keys grant two active writers at once", async () => {
		const manager = new LeaseManager(memoryStore());
		expect(await manager.acquire(W, "a1" as AgentId, "/wt-1")).toBe("active");
		expect(await manager.acquire(W, "a2" as AgentId, "/wt-2")).toBe("active");
	});

	test("keyed recovery releases only the identified stale reservation", async () => {
		const manager = new LeaseManager(memoryStore());
		await manager.acquire(W, "mission" as AgentId, "/wt-1");
		await manager.acquire(W, "queued" as AgentId, "/wt-1");
		await manager.acquire(W, "mission" as AgentId, "/wt-2");
		const released = await manager.releaseKey(W, "mission" as AgentId, "/wt-1");
		expect(released).toEqual({ released: true, promoted: "queued" });
		expect(await manager.holder(W, "/wt-1")).toBe("queued");
		expect(await manager.holder(W, "/wt-2")).toBe("mission");
	});

	test("a folder workspace keys on its root; read-only missions take no lease", async () => {
		expect(leaseKeyFor({ kind: "folder", root: "/ws" })).toBe("/ws");
		expect(leaseKeyFor({ kind: "git", worktreePath: "/wt-1", root: "/ws" })).toBe("/wt-1");
		expect(leaseKeyFor({ kind: "git", root: "/ws" })).toBe("/ws");
		const manager = new LeaseManager(memoryStore());
		expect(await manager.acquire(W, "a1" as AgentId, "/ws")).toBe("active");
		// The second writer queues; nothing in this module grants a lease to
		// a read-only mission because callers never ask for one.
		expect(await manager.acquire(W, "a2" as AgentId, "/ws")).toBe("queued");
	});

	test("state survives a fresh LeaseManager", async () => {
		const dir = await mkdtemp(join(tmpdir(), "neta-leases-"));
		try {
			const store = createFileLeaseStore(dir);
			const first = new LeaseManager(store);
			expect(await first.acquire(W, "a1" as AgentId, KEY)).toBe("active");
			expect(await first.acquire(W, "a2" as AgentId, KEY)).toBe("queued");
			const second = new LeaseManager(store);
			expect(await second.holder(W, KEY)).toBe("a1");
			expect(await second.queuePosition(W, "a2")).toBe(1);
			expect(await second.release(W, "a1" as AgentId)).toEqual([{ key: KEY, promoted: "a2" }]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("BASE_LEASE is an ordinary key", async () => {
		expect(BASE_LEASE).toBe("base");
		const manager = new LeaseManager(memoryStore());
		expect(await manager.acquire(W, "closer" as AgentId, BASE_LEASE)).toBe("active");
		expect(await manager.acquire(W, "other" as AgentId, BASE_LEASE)).toBe("queued");
	});
});
