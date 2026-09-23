import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Mission } from "../src/core/types.ts";
import { toolMount } from "../src/node/handlers-tools.ts";
import { type AdaptedRuntime, adaptStore } from "../src/node/lifecycle.ts";
import { loadSettings } from "../src/session/settings.ts";
import { openStore } from "../src/store/index.ts";
import { createTokenTable, type McpToolResponse } from "../src/tools/router.ts";

test("closing an inactive Lead++ mission does not restore its stale native session", async () => {
	const previous = process.env.NETA_DIR;
	const directory = await mkdtemp(join(tmpdir(), "neta-inactive-closeout-"));
	process.env.NETA_DIR = directory;
	const real = await openStore();
	let mount: ReturnType<typeof toolMount> | undefined;
	try {
		const machine = await real.machine.load();
		const workspaceId = "workspace";
		await real.workspaces.save({
			id: workspaceId,
			kind: "folder",
			name: "fixture",
			roots: [{ machineId: machine.id, path: directory }],
			createdAt: new Date(0).toISOString(),
		});

		const mission: Mission = {
			id: "mission",
			number: 1,
			workspaceId,
			machineId: machine.id,
			name: "Historical closeout",
			objective: "close without reviving an inactive conversation",
			changes: [],
			lead: { kind: "agent", agentId: "mission-lead" },
			agentIds: ["mission-lead"],
			access: "readWrite",
			state: "readyToClose",
			createdAt: new Date(0).toISOString(),
		};
		await real.missions.create(mission);
		const lead: Agent = {
			id: "mission-lead",
			missionId: mission.id,
			workspaceId,
			name: "Iris",
			task: "finish the historical mission",
			access: "readOnly",
			provider: "opencode",
			model: "openai/gpt-6-luna-fast",
			skills: [],
			sessionId: "stale-native-session",
			canSpawn: true,
			state: "completed",
			startedAt: new Date(0).toISOString(),
		};
		const leader = {
			workspaceId,
			machineId: machine.id,
			sessionId: "workspace-leader-session",
			name: "Hazel",
			provider: "fake",
			model: "fake",
			mode: "lead" as const,
			modeSince: new Date(0).toISOString(),
			modeActiveMs: 0,
			state: "idle" as const,
			leadModes: {
				[lead.id]: {
					agentId: lead.id,
					missionId: mission.id,
					mode: "leadPlus" as const,
					modeSince: new Date(0).toISOString(),
					modeActiveMs: 0,
				},
			},
		};
		await real.leaders.save(leader);
		const store = await adaptStore(real);
		await store.putAgent(lead);

		const tokens = createTokenTable();
		let ensureCalls = 0;
		const runtime = {
			tokens,
			onTurn: () => () => undefined,
			isTurnActive: () => false,
			runtimeDiagnostics: async () => ({ attached: false }),
			ensureSession: async () => {
				ensureCalls += 1;
				throw new Error("OpenCode session identity or directory differs");
			},
			close: async () => undefined,
			listInbox: async () => [],
		} as unknown as AdaptedRuntime;
		mount = toolMount({
			real,
			store,
			runtime,
			settings: loadSettings({ netaDir: directory }).settings,
			hub: () => ({ connections: () => [], broadcast: () => undefined, toTail: () => undefined }),
		});
		const token = tokens.mint(leader.sessionId);
		const closeMission = (args: Record<string, unknown>): Promise<McpToolResponse> => {
			if (mount === undefined) throw new Error("tool mount is unavailable");
			return mount.handlers["tools.call"](
				{} as never,
				{ actorId: leader.sessionId, token, name: "neta_close", arguments: args },
				{} as never,
			) as Promise<McpToolResponse>;
		};

		const result = await closeMission({
			missionId: mission.number,
			disposition: "completed",
			reason: "work is complete",
		});

		expect(result.isError).toBe(false);
		expect(ensureCalls).toBe(0);
		expect(store.getMission(mission.id)?.state).toBe("closed");
		expect((await real.leaders.load(workspaceId, () => leader)).leadModes?.[lead.id]?.mode).toBe("lead");
	} finally {
		mount?.stop();
		await real.close();
		if (previous === undefined) delete process.env.NETA_DIR;
		else process.env.NETA_DIR = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
