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
import { createTokenTable, type McpToolResponse } from "../src/tools/router.ts";
import { createFileLeaseStore, LeaseManager } from "../src/worktrees/leases.ts";

test("a delayed Lead++ restore cannot reopen a closed self-led mission", async () => {
	const previous = process.env.NETA_DIR;
	const directory = await mkdtemp(join(tmpdir(), "neta-deferred-closeout-"));
	process.env.NETA_DIR = directory;
	const real = await openStore();
	let mount: ReturnType<typeof toolMount> | undefined;
	try {
		const machine = await real.machine.load();
		await real.workspaces.save({
			id: "workspace",
			kind: "folder",
			name: "fixture",
			roots: [{ machineId: machine.id, path: directory }],
			createdAt: new Date(0).toISOString(),
		});
		const mission: Mission = {
			id: "mission",
			number: 1,
			workspaceId: "workspace",
			machineId: machine.id,
			name: "Close race",
			objective: "close safely",
			changes: [],
			lead: { kind: "leader" },
			agentIds: [],
			access: "readWrite",
			state: "running",
			createdAt: new Date(0).toISOString(),
		};
		await real.missions.create(mission);
		await real.leaders.save({
			workspaceId: "workspace",
			machineId: machine.id,
			sessionId: "leader-session",
			name: "Hazel",
			provider: "fake",
			model: "fake",
			mode: "lead",
			modeSince: new Date(0).toISOString(),
			modeActiveMs: 0,
			activeMissionId: mission.id,
			state: "idle",
		});
		const store = await adaptStore(real);
		const listeners: Array<(notification: TurnNotification) => void> = [];
		const tokens = createTokenTable();
		let active = true;
		const acp = {
			tokens,
			onTurn: (listener: (notification: TurnNotification) => void) => {
				listeners.push(listener);
				return () => undefined;
			},
			isTurnActive: () => active,
			ensureSession: async () => {
				throw new Error("saved conversation cannot be restored");
			},
			close: async () => undefined,
			listInbox: async () => [],
		} as unknown as AdaptedRuntime;
		mount = toolMount({
			real,
			store,
			runtime: acp,
			settings: loadSettings({ netaDir: directory }).settings,
			hub: () => ({ connections: () => [], broadcast: () => undefined, toTail: () => undefined }),
		});
		const token = tokens.mint("leader-session");
		const call = (name: string, args: Record<string, unknown>): Promise<McpToolResponse> => {
			if (mount === undefined) throw new Error("tool mount is unavailable");
			return mount.handlers["tools.call"](
				{} as never,
				{ actorId: "leader-session", token, name, arguments: args },
				{} as never,
			) as Promise<McpToolResponse>;
		};

		const mode = await call("neta_mode", {
			mode: "leadPlus",
			record: {
				missionId: mission.number,
				objective: "repair closeout",
				whyLeadInsufficient: "requires a write",
				worktreePath: directory,
				mutationKind: "source change",
				estimatedFiles: 1,
				validation: "test",
				estimatedMinutes: 1,
				externalEffects: "none",
			},
		});
		if (mode.isError) throw new Error(mode.content[0]?.text);
		expect(mode.isError).toBe(false);
		const close = await call("neta_close", { missionId: mission.number, disposition: "completed", reason: "done" });
		expect(close.isError).toBe(false);
		expect(store.getMission(mission.id)?.state).toBe("closed");
		expect(store.getLeader("workspace")?.activeMissionId).toBeUndefined();

		active = false;
		for (const listener of listeners) {
			listener({
				sessionId: "leader-session",
				turn: {
					id: "late-turn",
					sessionId: "leader-session",
					role: "user",
					startedAt: new Date(0).toISOString(),
					endedAt: new Date().toISOString(),
				},
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 25));

		const persisted = await real.missions.get("workspace", mission.id);
		expect(persisted).toMatchObject({ state: "closed", disposition: "completed" });
		expect(persisted?.attention).toBeUndefined();
	} finally {
		mount?.stop();
		await real.close();
		if (previous === undefined) delete process.env.NETA_DIR;
		else process.env.NETA_DIR = previous;
		await rm(directory, { recursive: true, force: true });
	}
});

test("Lead returns one stale workspace-leader reservation and promotes its queued writer", async () => {
	const previous = process.env.NETA_DIR;
	const directory = await mkdtemp(join(tmpdir(), "neta-stale-leader-lease-"));
	process.env.NETA_DIR = directory;
	const real = await openStore();
	let mount: ReturnType<typeof toolMount> | undefined;
	try {
		const machine = await real.machine.load();
		await real.workspaces.save({
			id: "workspace",
			kind: "folder",
			name: "fixture",
			roots: [{ machineId: machine.id, path: directory }],
			createdAt: new Date(0).toISOString(),
		});
		const lead: Agent = {
			id: "mission-lead",
			missionId: "mission",
			workspaceId: "workspace",
			name: "Dora",
			task: "coordinate",
			access: "readOnly",
			provider: "fake",
			model: "fake",
			skills: [],
			sessionId: "lead-session",
			canSpawn: true,
			state: "completed",
			startedAt: new Date(0).toISOString(),
		};
		const queued: Agent = {
			id: "queued-writer",
			missionId: "mission",
			workspaceId: "workspace",
			name: "Iris",
			task: "write after recovery",
			access: "readWrite",
			provider: "fake",
			model: "fake",
			skills: [],
			sessionId: "queued-session",
			canSpawn: false,
			state: "queued",
			startedAt: new Date(0).toISOString(),
		};
		const mission: Mission = {
			id: "mission",
			number: 1,
			workspaceId: "workspace",
			machineId: machine.id,
			name: "Agent-led recovery",
			objective: "release only stale ownership",
			changes: [],
			lead: { kind: "agent", agentId: lead.id },
			agentIds: [lead.id, queued.id],
			access: "readWrite",
			state: "readyToClose",
			createdAt: new Date(0).toISOString(),
		};
		await real.missions.create(mission);
		await real.leaders.save({
			workspaceId: "workspace",
			machineId: machine.id,
			sessionId: "leader-session",
			name: "Hazel",
			provider: "fake",
			model: "fake",
			mode: "lead",
			modeSince: new Date(0).toISOString(),
			modeActiveMs: 0,
			state: "idle",
		});
		const store = await adaptStore(real);
		await store.putAgent(lead);
		await store.putAgent(queued);
		const tokens = createTokenTable();
		const acp = {
			tokens,
			onTurn: () => () => undefined,
			isTurnActive: () => false,
			ensureSession: async ({ sessionId }: { sessionId: string }) => ({ sessionId }),
			createSession: async ({ sessionId }: { sessionId: string }) => ({ sessionId }),
			prompt: async () => undefined,
			close: async () => undefined,
			listInbox: async () => [],
		} as unknown as AdaptedRuntime;
		mount = toolMount({
			real,
			store,
			runtime: acp,
			settings: loadSettings({ netaDir: directory }).settings,
			hub: () => ({ connections: () => [], broadcast: () => undefined, toTail: () => undefined }),
		});
		const token = tokens.mint("leader-session");
		const call = (name: string, args: Record<string, unknown>): Promise<McpToolResponse> =>
			mount?.handlers["tools.call"](
				{} as never,
				{ actorId: "leader-session", token, name, arguments: args },
				{} as never,
			) as Promise<McpToolResponse>;

		const granted = await call("neta_mode", {
			mode: "leadPlus",
			record: {
				missionId: mission.number,
				objective: "perform the bounded edit",
				whyLeadInsufficient: "writer authority is required",
				worktreePath: directory,
				mutationKind: "source change",
				estimatedFiles: 1,
				validation: "test",
				estimatedMinutes: 1,
				externalEffects: "none",
			},
		});
		expect(granted.isError).toBe(false);
		expect(store.getLeader("workspace")?.activeMissionId).toBe(mission.id);
		const leases = new LeaseManager(createFileLeaseStore(directory));
		expect(await leases.holder("workspace", directory)).toBe(mission.id);
		expect(await leases.acquire("workspace", queued.id, directory)).toBe("queued");

		// This is the interrupted/partial return observed in production: the
		// durable mode is Lead but its former mission association is gone.
		const leader = store.getLeader("workspace");
		if (leader === undefined) throw new Error("leader is missing");
		await store.putLeader({ ...leader, mode: "lead", activeMissionId: undefined });
		await store.putAgent({ ...queued, state: "running" });
		const refused = await call("neta_mode", { mode: "lead" });
		expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("unavailable") }] });
		expect(await leases.holder("workspace", directory)).toBe(mission.id);
		await store.putAgent(queued);

		const recovered = await call("neta_mode", { mode: "lead" });
		expect(recovered.isError).toBe(false);
		expect(JSON.parse(recovered.content[0]?.text.split("\n")[0] ?? "{}")).toMatchObject({
			approved: true,
			recovered: { missionId: mission.number, promoted: queued.id },
		});
		expect(await leases.holder("workspace", directory)).toBe(queued.id);
		expect(store.getAgent(queued.id)?.state).toBe("starting");
	} finally {
		mount?.stop();
		await real.close();
		if (previous === undefined) delete process.env.NETA_DIR;
		else process.env.NETA_DIR = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
