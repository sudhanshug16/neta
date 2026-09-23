// The one object the Node holds for Git isolation and mission closeout.
// Only four callers reach merge detection through here: agent finish,
// `neta_ready`, `neta_close` and `workspace.open`. No timer, interval or
// watcher may call it.
import { realpath, stat } from "node:fs/promises";
import type {
	AgentId,
	EventKind,
	IsoTime,
	Mission,
	MissionId,
	Workspace,
	WorkspaceId,
	Worktree,
} from "../core/types.ts";
import { type CloseMissionInput, type CloseOutcome, closeMission } from "./closeout.ts";
import type { WorktreeDriver } from "./driver.ts";
import { isIntegrated } from "./integration.ts";
import { type LeaseManager, type LeaseOutcome, leaseKeyFor } from "./leases.ts";
import { slugify } from "./naming.ts";
import {
	buildSetupDiagnostic,
	readSetupDiagnostic,
	safeExcerpt,
	type WorktreeSetupDiagnostic,
	WorktreeSetupError,
	writeSetupDiagnostic,
} from "./setup-diagnostics.ts";

export interface WorktreeServiceDeps {
	driver: WorktreeDriver;
	leases: LeaseManager;
	netaDir: string;
	now(): IsoTime;
	emit(kind: EventKind, missionId: MissionId, data: Record<string, string>): void;
	saveMission(mission: Mission): Promise<void>;
	onMissionClosed(mission: Mission): Promise<void>;
}

export interface WorktreeService {
	prepare(
		mission: Mission,
		workspace: Workspace,
		opts?: {
			// Creation defers registry persistence until its lead actor is reserved.
			deferSave?: boolean;
			recovery?: {
				number: number;
				path: string;
				branch: string;
				base: string;
				setupDisposition: "handled" | "waived";
			};
		},
	): Promise<Mission>;
	acquireWriter(m: Mission, w: Workspace, a: AgentId): Promise<LeaseOutcome>;
	releaseWriter(workspaceId: WorkspaceId, a: AgentId): Promise<Array<{ key: string; promoted?: AgentId }>>;
	holdsWriter(m: Mission, w: Workspace, a: AgentId): Promise<boolean>;
	releaseWriterKey(
		m: Mission,
		w: Workspace,
		a: AgentId,
	): Promise<{ released: boolean; changed: Array<{ key: string; promoted?: AgentId }> }>;
	refreshIntegration(mission: Mission): Promise<Mission>;
	close(input: CloseMissionInput): Promise<CloseOutcome>;
}

// The workspace copy on this machine: the first root that exists on disk.
async function rootFor(workspace: Workspace): Promise<string> {
	for (const root of workspace.roots) {
		try {
			await stat(root.path);
			return root.path;
		} catch {
			// Not this machine's copy.
		}
	}
	const first = workspace.roots[0]?.path;
	if (first === undefined) {
		throw new Error(`workspace ${workspace.id} has no roots`);
	}
	return first;
}

export function createWorktreeService(deps: WorktreeServiceDeps): WorktreeService {
	return {
		async prepare(mission, workspace, opts) {
			if (workspace.kind !== "git") {
				return mission;
			}
			if (mission.worktree !== undefined) {
				const verified = await deps.driver.verify(mission.worktree);
				if (verified.ok) {
					return mission;
				}
			}
			const repoRoot = await rootFor(workspace);
			const input = {
				repoRoot,
				number: mission.number,
				slug: slugify(mission.name),
				base: mission.worktree?.base,
			};
			if (opts?.recovery !== undefined) {
				const recovery = opts.recovery;
				const diagnostic = await readSetupDiagnostic(deps.netaDir, workspace.id, mission.number);
				if (
					diagnostic !== undefined &&
					(diagnostic.name !== mission.name ||
						diagnostic.objective !== mission.objective ||
						diagnostic.access !== mission.access ||
						diagnostic.repoRoot !== repoRoot ||
						diagnostic.branch !== recovery.branch ||
						diagnostic.base !== recovery.base)
				) {
					throw new Error(
						`worktree recovery details do not match the recorded setup failure for mission #${mission.number}`,
					);
				}
				if (
					diagnostic?.partialWorktree !== undefined &&
					(await realpath(diagnostic.partialWorktree.path)) !== (await realpath(recovery.path))
				) {
					throw new Error(
						`worktree recovery path is not the recorded canonical partial worktree for mission #${mission.number}`,
					);
				}
				const existing = await deps.driver.findExisting(input, {
					provider: "worktrunk",
					path: recovery.path,
					branch: recovery.branch,
					base: recovery.base,
				});
				if (existing === undefined) {
					throw new Error(
						`recorded setup failure for mission #${mission.number} has no matching existing worktree`,
					);
				}
				const prepared: Mission = {
					...mission,
					worktree: existing,
					worktreeRecovery: { setupDisposition: recovery.setupDisposition, at: deps.now() },
				};
				if (!opts?.deferSave) await deps.saveMission(prepared);
				return prepared;
			}
			let worktree: Worktree;
			try {
				worktree = await deps.driver.create(input);
			} catch (error) {
				let partialWorktree: Worktree | undefined;
				try {
					partialWorktree = await deps.driver.findExisting(input);
				} catch {
					// Discovery must never replace the original Worktrunk failure.
				}
				const evidence = {
					workspaceId: workspace.id,
					number: mission.number,
					name: mission.name,
					objective: mission.objective,
					access: mission.access,
					repoRoot,
					branch: partialWorktree?.branch ?? `mission/${mission.number}-${slugify(mission.name)}`,
					base:
						partialWorktree?.base ??
						input.base ??
						(await deps.driver.defaultBase(repoRoot).catch(() => "unknown")),
					at: deps.now(),
					partialWorktree,
					error: error instanceof Error ? error : new Error(String(error)),
				};
				let diagnostic: WorktreeSetupDiagnostic;
				try {
					diagnostic = await writeSetupDiagnostic(deps.netaDir, evidence);
				} catch (persistenceError) {
					throw new WorktreeSetupError(
						buildSetupDiagnostic(evidence),
						deps.netaDir,
						safeExcerpt(String(persistenceError)),
					);
				}
				throw new WorktreeSetupError(diagnostic, deps.netaDir);
			}
			const prepared = { ...mission, worktree };
			if (!opts?.deferSave) await deps.saveMission(prepared);
			return prepared;
		},

		async acquireWriter(m, w, a) {
			const root = await rootFor(w);
			return deps.leases.acquire(w.id, a, leaseKeyFor({ kind: w.kind, worktreePath: m.worktree?.path, root }));
		},

		async releaseWriter(workspaceId, a) {
			return deps.leases.release(workspaceId, a);
		},

		async holdsWriter(m, w, a) {
			const root = await rootFor(w);
			const key = leaseKeyFor({ kind: w.kind, worktreePath: m.worktree?.path, root });
			return (await deps.leases.holder(w.id, key)) === a;
		},

		async releaseWriterKey(m, w, a) {
			const root = await rootFor(w);
			const key = leaseKeyFor({ kind: w.kind, worktreePath: m.worktree?.path, root });
			const released = await deps.leases.releaseKey(w.id, a, key);
			return {
				released: released.released,
				changed: released.promoted === undefined ? [] : [{ key, promoted: released.promoted }],
			};
		},

		async refreshIntegration(mission) {
			if (mission.integration !== undefined || mission.worktree === undefined) {
				return mission;
			}
			const result = await isIntegrated({
				repoRoot: mission.worktree.path,
				branch: mission.worktree.branch,
				base: mission.worktree.base,
			});
			if (!result.merged || result.commit === undefined) {
				return mission;
			}
			const merged: Mission = {
				...mission,
				integration: { mergedAt: deps.now(), commit: result.commit, base: mission.worktree.base },
			};
			await deps.saveMission(merged);
			deps.emit("mission.merged", merged.id, { commit: result.commit });
			return merged;
		},

		async close(input) {
			const outcome = await closeMission(input, {
				driver: deps.driver,
				leases: deps.leases,
				isIntegrated,
				now: deps.now,
				emit: deps.emit,
				onMissionClosed: deps.onMissionClosed,
			});
			await deps.saveMission(outcome.mission);
			return outcome;
		},
	};
}

export * from "./closeout.ts";
export * from "./driver.ts";
export * from "./integration.ts";
export * from "./leases.ts";
export * from "./naming.ts";
export * from "./setup-diagnostics.ts";
