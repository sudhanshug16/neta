import { readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { ulid } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import type { Leader, Machine, Workspace, WorkspaceId } from "../core/types.ts";
import { createMutex, type Mutex, readJson, writeJsonAtomic } from "./files.ts";
import { paths } from "./paths.ts";

export interface MachineStore {
	load(): Promise<Machine>;
	save(m: Machine): Promise<void>;
}

export interface WorkspaceStore {
	load(id: WorkspaceId, defaults: () => Workspace): Promise<Workspace>;
	save(workspace: Workspace): Promise<void>;
	list(): Promise<Workspace[]>;
}

export interface LeaderStore {
	load(id: WorkspaceId, defaults: () => Leader): Promise<Leader>;
	save(l: Leader): Promise<void>;
}

async function loadOrCreate<T>(path: string, mutex: Mutex, defaults: () => T): Promise<T> {
	return mutex(async () => {
		const existing = await readJson<T>(path);
		if (existing !== undefined) {
			return existing;
		}
		const created = defaults();
		await writeJsonAtomic(path, created);
		return created;
	});
}

export function openMachineStore(): MachineStore {
	const mutex = createMutex();
	return {
		load: () =>
			loadOrCreate(paths().machineJson, mutex, () => ({
				id: ulid(),
				name: hostname(),
				createdAt: nowIso(),
			})),
		save: (m) => mutex(() => writeJsonAtomic(paths().machineJson, m)),
	};
}

export function openWorkspaceStore(): WorkspaceStore {
	const mutex = createMutex();
	return {
		load: (id, defaults) => loadOrCreate(paths().workspace(id), mutex, defaults),
		save: (workspace) => mutex(() => writeJsonAtomic(paths().workspace(workspace.id), workspace)),
		list: async () => {
			let names: string[];
			try {
				names = await readdir(paths().workspacesDir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return [];
				}
				throw error;
			}
			const out: Workspace[] = [];
			for (const name of names.sort()) {
				const record = await readJson<Workspace>(join(paths().workspacesDir, name));
				if (record === undefined) {
					throw new Error(`workspace file vanished: ${name}`);
				}
				out.push(record);
			}
			out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
			return out;
		},
	};
}

export function openLeaderStore(): LeaderStore {
	const mutex = createMutex();
	return {
		load: (id, defaults) => loadOrCreate(paths().leader(id), mutex, defaults),
		save: (l) => mutex(() => writeJsonAtomic(paths().leader(l.workspaceId), l)),
	};
}
