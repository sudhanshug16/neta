import { nextNumber } from "../core/numbering.ts";
import { nowIso } from "../core/time.ts";
import type { IsoTime, Mission, MissionId, WorkspaceId } from "../core/types.ts";
import {
	appendLine,
	createMutex,
	ensureDir,
	type Mutex,
	readJson,
	readNdjson,
	readText,
	repairTornTail,
	writeFileAtomic,
	writeJsonAtomic,
} from "./files.ts";
import { createMissionIndex, type MissionIndex, type MissionPage, type MissionQuery } from "./mission-index.ts";
import { paths } from "./paths.ts";

export interface RegistryLine {
	op: "create" | "update";
	at: IsoTime;
	mission: Mission;
}

export interface RegistrySnapshot {
	version: 1;
	at: IsoTime;
	missions: Mission[];
}

export interface MissionRegistry {
	load(workspaceId: WorkspaceId): Promise<void>;
	allocateNumber(workspaceId: WorkspaceId): Promise<number>;
	create(mission: Mission): Promise<Mission>;
	update(mission: Mission): Promise<Mission>;
	get(workspaceId: WorkspaceId, id: MissionId): Promise<Mission | undefined>;
	byNumber(workspaceId: WorkspaceId, n: number): Promise<Mission | undefined>;
	list(workspaceId: WorkspaceId, query: MissionQuery): Promise<MissionPage>;
	compact(workspaceId: WorkspaceId): Promise<void>;
	close(): Promise<void>;
}

export const COMPACT_AFTER_LINES = 10_000;

interface WorkspaceState {
	index: MissionIndex;
	tailLines: number;
	mutex: Mutex;
	loaded: boolean;
}

export function openMissionRegistry(): MissionRegistry {
	const states = new Map<WorkspaceId, WorkspaceState>();

	function stateFor(workspaceId: WorkspaceId): WorkspaceState {
		let state = states.get(workspaceId);
		if (state === undefined) {
			state = { index: createMissionIndex(), tailLines: 0, mutex: createMutex(), loaded: false };
			states.set(workspaceId, state);
		}
		return state;
	}

	async function loadInner(workspaceId: WorkspaceId, state: WorkspaceState): Promise<void> {
		const p = paths();
		// Crash recovery: a torn tail warns once here and is cut, so the next
		// append lands on a line boundary. Replaying the surviving lines over
		// the snapshot stays idempotent.
		await repairTornTail(p.registryLog(workspaceId));
		const snapshot = await readJson<RegistrySnapshot>(p.registrySnapshot(workspaceId));
		const index = createMissionIndex();
		if (snapshot !== undefined) {
			for (const mission of snapshot.missions) {
				index.put(mission);
			}
		}
		const tail = await readNdjson<RegistryLine>(p.registryLog(workspaceId));
		for (const line of tail.records) {
			index.put(line.mission);
		}
		state.index = index;
		state.tailLines = tail.records.length;
	}

	async function ensureLoaded(workspaceId: WorkspaceId): Promise<WorkspaceState> {
		const state = stateFor(workspaceId);
		if (!state.loaded) {
			await state.mutex(() => loadInner(workspaceId, state));
			state.loaded = true;
		}
		return state;
	}

	async function maybeCompact(workspaceId: WorkspaceId, state: WorkspaceState): Promise<void> {
		if (state.tailLines <= COMPACT_AFTER_LINES) {
			return;
		}
		await compactInner(workspaceId, state);
	}

	async function compactInner(workspaceId: WorkspaceId, state: WorkspaceState): Promise<void> {
		const p = paths();
		const snapshot: RegistrySnapshot = { version: 1, at: nowIso(), missions: state.index.all() };
		await writeJsonAtomic(p.registrySnapshot(workspaceId), snapshot);
		await writeFileAtomic(p.registryLog(workspaceId), "");
		state.tailLines = 0;
	}

	return {
		load: async (workspaceId) => {
			const state = stateFor(workspaceId);
			await state.mutex(() => loadInner(workspaceId, state));
			state.loaded = true;
		},

		allocateNumber: async (workspaceId) => {
			const state = await ensureLoaded(workspaceId);
			return state.mutex(async () => {
				const p = paths();
				const raw = await readText(p.counter(workspaceId));
				const next = raw === undefined ? nextNumber(state.index.maxNumber()) : Number.parseInt(raw, 10);
				if (!Number.isInteger(next) || next < 1) {
					throw new Error(`corrupt mission counter for ${workspaceId}`);
				}
				await writeFileAtomic(p.counter(workspaceId), `${nextNumber(next)}\n`);
				return next;
			});
		},

		create: async (mission) => {
			const state = await ensureLoaded(mission.workspaceId);
			return state.mutex(async () => {
				if (state.index.get(mission.id) !== undefined) {
					throw new Error(`mission ${mission.id} already exists`);
				}
				await ensureDir(paths().missionsDir(mission.workspaceId));
				const line: RegistryLine = { op: "create", at: nowIso(), mission };
				await appendLine(paths().registryLog(mission.workspaceId), line);
				state.index.put(mission);
				state.tailLines += 1;
				await maybeCompact(mission.workspaceId, state);
				return mission;
			});
		},

		update: async (mission) => {
			const state = await ensureLoaded(mission.workspaceId);
			return state.mutex(async () => {
				if (state.index.get(mission.id) === undefined) {
					throw new Error(`mission ${mission.id} is unknown`);
				}
				await ensureDir(paths().missionsDir(mission.workspaceId));
				const line: RegistryLine = { op: "update", at: nowIso(), mission };
				await appendLine(paths().registryLog(mission.workspaceId), line);
				state.index.put(mission);
				state.tailLines += 1;
				await maybeCompact(mission.workspaceId, state);
				return mission;
			});
		},

		get: async (workspaceId, id) => (await ensureLoaded(workspaceId)).index.get(id),

		byNumber: async (workspaceId, n) => (await ensureLoaded(workspaceId)).index.byNumber(n),

		list: async (workspaceId, query) => (await ensureLoaded(workspaceId)).index.list(query),

		compact: async (workspaceId) => {
			const state = await ensureLoaded(workspaceId);
			await state.mutex(() => compactInner(workspaceId, state));
		},

		close: async () => {
			for (const [workspaceId, state] of states) {
				await state.mutex(() => compactInner(workspaceId, state));
			}
		},
	};
}
