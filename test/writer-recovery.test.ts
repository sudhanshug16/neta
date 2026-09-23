import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Mission } from "../src/core/types.ts";
import { toolMount } from "../src/node/handlers-tools.ts";
import { type AdaptedRuntime, adaptStore } from "../src/node/lifecycle.ts";
import type { TurnNotification } from "../src/node/protocol.ts";
import { loadSettings } from "../src/session/settings.ts";
import { openStore } from "../src/store/index.ts";
import { createTokenTable } from "../src/tools/router.ts";
import { createFileLeaseStore, LeaseManager } from "../src/worktrees/leases.ts";

test.each([
	[false, false],
	[true, false],
	[false, true],
])("writer recovery (close fails: %s, restart: %s)", async (failClose, restart) => {
	const previous = process.env.NETA_DIR;
	const dir = await mkdtemp(join(tmpdir(), "neta-writer-recovery-"));
	process.env.NETA_DIR = dir;
	const real = await openStore();
	const listeners: ((event: TurnNotification) => void)[] = [];
	const actions: string[] = [];
	let mount: ReturnType<typeof toolMount> | undefined;
	try {
		const machine = await real.machine.load();
		await real.workspaces.save({
			id: "w",
			kind: "folder",
			name: "test",
			roots: [{ machineId: machine.id, path: dir }],
			createdAt: new Date(0).toISOString(),
		});
		await real.leaders.save({
			workspaceId: "w",
			machineId: machine.id,
			sessionId: "leader",
			name: "Lead",
			provider: "fake",
			model: "fake",
			mode: "lead",
			modeSince: new Date(0).toISOString(),
			modeActiveMs: 0,
			state: "idle",
		});
		const mission: Mission = {
			id: "m",
			number: 1,
			workspaceId: "w",
			machineId: machine.id,
			name: "Test",
			objective: "Test",
			changes: [],
			lead: { kind: "agent", agentId: "fixture-mission-lead" },
			agentIds: ["first", "second"],
			access: "readWrite",
			state: "running",
			createdAt: new Date(0).toISOString(),
		};
		await real.missions.create(mission);
		const store = await adaptStore(real);
		const first: Agent = {
			id: "first",
			missionId: "m",
			workspaceId: "w",
			sessionId: "s1",
			name: "First",
			task: "First task",
			access: "readWrite",
			provider: "fake",
			model: "fake",
			skills: [],
			canSpawn: false,
			state: "interrupted",
			startedAt: new Date(0).toISOString(),
		};
		await store.putAgent(first);
		await store.putAgent({ ...first, id: "second", sessionId: "s2", name: "Second", state: "queued" });
		const leases = new LeaseManager(createFileLeaseStore(dir));
		await leases.acquire("w", "first", dir);
		await leases.acquire("w", "second", dir);
		const acp = {
			tokens: createTokenTable(),
			onTurn: (fn: (event: TurnNotification) => void) => {
				listeners.push(fn);
				return () => {};
			},
			close: async (id: string) => {
				actions.push(`close:${id}`);
				if (failClose) throw new Error("close unconfirmed");
			},
			createSession: async (input: { sessionId: string }) => {
				actions.push(`start:${input.sessionId}`);
				return { ...input, provider: "fake", model: "fake" };
			},
			prompt: async (id: string) => {
				actions.push(`prompt:${id}`);
				return "turn2";
			},
			listInbox: async () => [],
		} as unknown as AdaptedRuntime;
		mount = toolMount({
			real,
			store,
			runtime: acp,
			settings: loadSettings({ netaDir: dir }).settings,
			hub: () => ({ connections: () => [], broadcast: () => {}, toTail: () => {} }),
		});
		// Follow-ups share the inbox with reports, but are not report-store keys.
		const followup = await real.inbox.enqueue("s1", "Continue", [], {
			readerDirected: false,
			sourceId: `followup:${"a".repeat(64)}`,
		});
		expect(await mount.canDeliverInbox(followup)).toBe(true);
		expect(await mount.canDeliverInbox({ ...followup, sourceId: "unknown-source" })).toBe(false);
		expect(await mount.canDeliverInbox({ ...followup, sourceId: "b".repeat(64) })).toBe(false);
		await real.inbox.markDiscarded("s1", followup.id);
		const event: TurnNotification = {
			sessionId: "s1",
			turn: {
				id: "turn1",
				sessionId: "s1",
				role: "user",
				startedAt: new Date(0).toISOString(),
				endedAt: new Date().toISOString(),
				cancelled: true,
			},
		};
		if (restart) {
			await leases.interrupt("w", "first");
			await mount.recover();
		} else for (const listener of listeners) listener(event);
		for (let i = 0; i < 100 && !actions.includes(failClose ? "close:s1" : "prompt:s2"); i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(actions[0]).toBe(restart ? "start:s2" : "close:s1");
		expect(await leases.holder("w", dir)).toBe(failClose ? "first" : "second");
		expect(actions.includes("prompt:s2")).toBe(!failClose);
	} finally {
		mount?.stop();
		await real.close();
		if (previous === undefined) delete process.env.NETA_DIR;
		else process.env.NETA_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
});
