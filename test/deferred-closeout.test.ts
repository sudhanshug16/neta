import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/acp/settings.ts";
import type { Mission } from "../src/core/types.ts";
import { toolMount } from "../src/node/handlers-tools.ts";
import { type AdaptedAcp, adaptStore } from "../src/node/lifecycle.ts";
import type { TurnNotification } from "../src/node/protocol.ts";
import { openStore } from "../src/store/index.ts";
import { createTokenTable, type McpToolResponse } from "../src/tools/router.ts";

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
		} as unknown as AdaptedAcp;
		mount = toolMount({
			real,
			store,
			acp,
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
