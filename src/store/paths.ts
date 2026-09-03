import { homedir } from "node:os";
import { join } from "node:path";
import type { IsoTime, SessionId, WorkspaceId } from "../core/types.ts";

export interface Paths {
	root: string;
	nodeJson: string;
	nodeSock: string;
	machineJson: string;
	workspacesDir: string;
	workspace(id: WorkspaceId): string;
	leader(id: WorkspaceId): string;
	missionsDir(id: WorkspaceId): string;
	counter(id: WorkspaceId): string;
	registryLog(id: WorkspaceId): string;
	registrySnapshot(id: WorkspaceId): string;
	eventsDir(id: WorkspaceId): string;
	eventSeq(id: WorkspaceId): string;
	eventMonth(id: WorkspaceId, month: string): string;
	conversation(id: SessionId): string;
	conversationMeta(id: SessionId): string;
	worktrees(id: WorkspaceId): string;
	charterHash(id: WorkspaceId): string;
}

// Resolved on every call and never cached, so a test can point NETA_DIR at a
// temp directory between calls.
export function netaDir(): string {
	const override = process.env.NETA_DIR;
	if (override !== undefined && override !== "") {
		return override;
	}
	return join(homedir(), ".neta");
}

export function encodeWorkspaceId(id: WorkspaceId): string {
	return encodeURIComponent(id);
}

export function decodeWorkspaceId(name: string): WorkspaceId {
	return decodeURIComponent(name);
}

// "2026-09", UTC.
export function monthKey(at: IsoTime): string {
	const ms = Date.parse(at);
	const date = new Date(ms);
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	return `${date.getUTCFullYear()}-${month}`;
}

export function paths(): Paths {
	const root = netaDir();
	return {
		root,
		nodeJson: join(root, "node.json"),
		nodeSock: join(root, "node.sock"),
		machineJson: join(root, "machine.json"),
		workspacesDir: join(root, "workspaces"),
		workspace: (id) => join(root, "workspaces", `${encodeWorkspaceId(id)}.json`),
		leader: (id) => join(root, "leaders", `${encodeWorkspaceId(id)}.json`),
		missionsDir: (id) => join(root, "missions", encodeWorkspaceId(id)),
		counter: (id) => join(root, "missions", encodeWorkspaceId(id), "counter"),
		registryLog: (id) => join(root, "missions", encodeWorkspaceId(id), "registry.ndjson"),
		registrySnapshot: (id) => join(root, "missions", encodeWorkspaceId(id), "registry.snapshot.json"),
		eventsDir: (id) => join(root, "events", encodeWorkspaceId(id)),
		eventSeq: (id) => join(root, "events", encodeWorkspaceId(id), "seq"),
		eventMonth: (id, month) => join(root, "events", encodeWorkspaceId(id), `${month}.ndjson`),
		conversation: (id) => join(root, "conversations", `${id}.ndjson`),
		conversationMeta: (id) => join(root, "conversations", `${id}.meta.json`),
		worktrees: (id) => join(root, "worktrees", `${encodeWorkspaceId(id)}.json`),
		charterHash: (id) => join(root, "charters", `${encodeWorkspaceId(id)}.hash`),
	};
}
