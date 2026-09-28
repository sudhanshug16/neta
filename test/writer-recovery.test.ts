import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Mission } from "../src/core/types.ts";
import { openMeStore } from "../src/me/store.ts";
import { toolMount } from "../src/node/handlers-tools.ts";
import { type AdaptedRuntime, adaptStore } from "../src/node/lifecycle.ts";
import type { TurnNotification } from "../src/node/protocol.ts";
import { loadSettings } from "../src/session/settings.ts";
import { openStore } from "../src/store/index.ts";
import { createTokenTable } from "../src/tools/router.ts";
import { createFileLeaseStore, LeaseManager } from "../src/worktrees/leases.ts";

test.each([false, true])("writer admission releases after the turn boundary (restart: %s)", async (restart) => {
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
			state: "idle",
		});
		const mission: Mission = {
			id: "m",
			number: 1,
			workspaceId: "w",
			machineId: machine.id,
			name: "Test",
			objective: "Test",
			lead: { kind: "agent", agentId: "fixture-mission-lead" },
			agentIds: ["first", "second"],
			access: "readWrite",
			state: "open",
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
			wakeInbox: (id: string) => actions.push(`wake:${id}`),
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
		const me = openMeStore();
		const filter = await me.filterIdentity("w");
		const source = await me.capture({
			id: "",
			workspaceId: "w",
			workspaceName: "test",
			sessionId: "leader",
			actorKind: "leader",
			kind: "message",
			at: new Date().toISOString(),
			text: "Report ready",
			turnId: "report-turn",
		});
		expect(
			await mount.canDeliverInbox({
				...followup,
				sessionId: filter.sessionId,
				sourceId: `filter-decision:${source.id}:2`,
			}),
		).toBe(true);
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
		} else {
			expect(await mount.beforeTurn("s1")).toBe(true);
			if (!event.turn) throw new Error("Fixture turn missing");
			for (const listener of listeners) listener({ ...event, turn: { ...event.turn, endedAt: undefined } });
			expect(await leases.holder("w", dir)).toBe("first");
			await mount.afterTurn("s1");
		}
		expect(actions[0]).toBe("start:s2");
		expect(await leases.holder("w", dir)).toBe("second");
		expect(actions).toContain("prompt:s2");
		// Parent wakeup has to wait for this writer; idle parent is not a second writer.
		expect(await mount.beforeTurn("leader")).toBe(false);
		expect(await leases.holder("w", dir)).toBe("second");
	} finally {
		mount?.stop();
		await real.close();
		if (previous === undefined) delete process.env.NETA_DIR;
		else process.env.NETA_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
});
