// One active writer per worktree path, or per workspace root in a non-Git
// workspace. Read-only missions never acquire; extra writers queue FIFO and
// the queue is durable. The base checkout is a lease of its own named `base`
// (BASE_LEASE), taken explicitly by closeout, so two closeouts can never
// merge into it concurrently.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "../core/time.ts";
import type { AgentId, IsoTime, WorkspaceId, WorkspaceKind } from "../core/types.ts";
import { encodeWorkspaceId } from "../store/paths.ts";

export const BASE_LEASE = "base";

export type LeaseOutcome = "active" | "queued";

export interface LeaseRecord {
	key: string;
	holder?: AgentId;
	since?: IsoTime;
	queue: AgentId[];
}

export interface LeaseState {
	workspaceId: WorkspaceId;
	leases: Record<string, LeaseRecord>;
}

export interface LeaseStore {
	read(w: WorkspaceId): Promise<LeaseState>;
	write(s: LeaseState): Promise<void>;
}

// `worktrees/<workspaceId>.json` under the given Neta dir, written atomically
// (temp file plus rename, 0600).
export function createFileLeaseStore(netaDir: string): LeaseStore {
	const pathFor = (w: WorkspaceId): string => join(netaDir, "worktrees", `${encodeWorkspaceId(w)}.json`);
	return {
		read: async (w) => {
			let raw: string;
			try {
				raw = await readFile(pathFor(w), "utf8");
			} catch (error) {
				if ((error as { code?: unknown }).code === "ENOENT") {
					return { workspaceId: w, leases: {} };
				}
				throw error;
			}
			return JSON.parse(raw) as LeaseState;
		},
		write: async (s) => {
			await mkdir(join(netaDir, "worktrees"), { recursive: true });
			const target = pathFor(s.workspaceId);
			const tmp = `${target}.tmp.${process.pid}`;
			await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
			await rename(tmp, target);
		},
	};
}

// The worktree path for a Git mission, the workspace root for a `folder`
// workspace. BASE_LEASE is passed explicitly, never derived here.
export function leaseKeyFor(i: { kind: WorkspaceKind; worktreePath?: string; root: string }): string {
	if (i.kind === "git" && i.worktreePath !== undefined) {
		return i.worktreePath;
	}
	return i.root;
}

export class LeaseManager {
	private readonly store: LeaseStore;
	private readonly onChange?: (w: WorkspaceId, r: LeaseRecord) => void;
	private static readonly chains = new Map<WorkspaceId, Promise<void>>();

	constructor(store: LeaseStore, onChange?: (w: WorkspaceId, r: LeaseRecord) => void) {
		this.store = store;
		this.onChange = onChange;
	}

	// One internal promise chain serialises every read-modify-write so two
	// concurrent acquires cannot both go active.
	private enqueue<T>(workspaceId: WorkspaceId, fn: () => Promise<T>): Promise<T> {
		const run = (LeaseManager.chains.get(workspaceId) ?? Promise.resolve()).then(fn);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		LeaseManager.chains.set(workspaceId, tail);
		void tail.finally(() => {
			if (LeaseManager.chains.get(workspaceId) === tail) LeaseManager.chains.delete(workspaceId);
		});
		return run;
	}

	private emit(w: WorkspaceId, r: LeaseRecord): void {
		this.onChange?.(w, { ...r, queue: [...r.queue] });
	}

	acquire(w: WorkspaceId, a: AgentId, key: string): Promise<LeaseOutcome> {
		return this.enqueue(w, async () => {
			const state = await this.store.read(w);
			let record = state.leases[key];
			if (record === undefined) {
				record = { key, queue: [] };
				state.leases[key] = record;
			}
			if (record.holder === a) {
				return "active";
			}
			if (record.holder === undefined && (record.queue.length === 0 || record.queue[0] === a)) {
				record.queue = record.queue.filter((queued) => queued !== a);
				record.holder = a;
				record.since = nowIso();
				await this.store.write(state);
				return "active";
			}
			if (!record.queue.includes(a)) {
				record.queue.push(a);
				await this.store.write(state);
			}
			return "queued";
		});
	}

	release(w: WorkspaceId, a: AgentId): Promise<Array<{ key: string; promoted?: AgentId }>> {
		return this.enqueue(w, async () => {
			const state = await this.store.read(w);
			const changed: Array<{ key: string; promoted?: AgentId }> = [];
			const touched: LeaseRecord[] = [];
			for (const record of Object.values(state.leases)) {
				if (record.holder === a) {
					const promoted = record.queue.shift();
					if (promoted === undefined) {
						delete record.holder;
						delete record.since;
					} else {
						record.holder = promoted;
						record.since = nowIso();
					}
					changed.push({ key: record.key, promoted });
					touched.push(record);
				} else {
					const before = record.queue.length;
					record.queue = record.queue.filter((queued) => queued !== a);
					if (record.queue.length !== before) {
						touched.push(record);
					}
				}
			}
			if (touched.length > 0) {
				await this.store.write(state);
				for (const record of touched) {
					this.emit(w, record);
				}
			}
			return changed;
		});
	}

	// A restarted process is no longer a live writer. Clear its ownership
	// without starting or promoting queued work; recovery remains an explicit
	// leader decision and the FIFO queue stays intact.
	interrupt(w: WorkspaceId, a: AgentId): Promise<void> {
		return this.enqueue(w, async () => {
			const state = await this.store.read(w);
			let changed = false;
			for (const record of Object.values(state.leases)) {
				if (record.holder === a) {
					delete record.holder;
					delete record.since;
					changed = true;
				}
			}
			if (changed) await this.store.write(state);
		});
	}

	queuePosition(w: WorkspaceId, a: AgentId): Promise<number | undefined> {
		return this.enqueue(w, async () => {
			const state = await this.store.read(w);
			for (const record of Object.values(state.leases)) {
				if (record.holder === a) {
					return undefined;
				}
				const index = record.queue.indexOf(a);
				if (index >= 0) {
					return index + 1;
				}
			}
			return undefined;
		});
	}

	holder(w: WorkspaceId, key: string): Promise<AgentId | undefined> {
		return this.enqueue(w, async () => {
			const state = await this.store.read(w);
			return state.leases[key]?.holder;
		});
	}
}
