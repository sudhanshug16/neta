import { join } from "node:path";
import { type ConversationStore, openConversationStore } from "./conversations.ts";
import { type EventLog, openEventLog } from "./event-log.ts";
import { ensureDir } from "./files.ts";
import { type MissionRegistry, openMissionRegistry } from "./mission-registry.ts";
import { netaDir } from "./paths.ts";
import {
	type LeaderStore,
	type MachineStore,
	openLeaderStore,
	openMachineStore,
	openWorkspaceStore,
	type WorkspaceStore,
} from "./records.ts";

export interface Store {
	dir: string;
	machine: MachineStore;
	workspaces: WorkspaceStore;
	leaders: LeaderStore;
	missions: MissionRegistry;
	events: EventLog;
	conversations: ConversationStore;
	close(): Promise<void>;
}

// The Node's entry point to durable state. Creates the layout, loads the
// machine record (creating it on first run), and wires the six stores. No
// timers, no background work: `close` is what the Node calls on stop.
export async function openStore(): Promise<Store> {
	const dir = netaDir();
	await ensureDir(dir);
	for (const sub of ["workspaces", "leaders", "missions", "events", "conversations", "worktrees", "charters"]) {
		await ensureDir(join(dir, sub));
	}
	const machine = openMachineStore();
	await machine.load();
	const missions = openMissionRegistry();
	const events = openEventLog();
	return {
		dir,
		machine,
		workspaces: openWorkspaceStore(),
		leaders: openLeaderStore(),
		missions,
		events,
		conversations: openConversationStore(),
		close: async () => {
			await missions.close();
			await events.close();
		},
	};
}

export * from "./conversations.ts";
export * from "./event-log.ts";
export * from "./files.ts";
export * from "./mission-index.ts";
export * from "./mission-registry.ts";
export * from "./paths.ts";
export * from "./records.ts";
