// The one object the Node holds for Git isolation and mission closeout.
// Only four callers reach merge detection through here: agent finish,
// `neta_ready`, `neta_close` and `workspace.open`. No timer, interval or
// watcher may call it.
import { stat } from "node:fs/promises";
import type { AgentId, EventKind, IsoTime, Mission, MissionId, Workspace, WorkspaceId } from "../core/types.ts";
import { type CloseMissionInput, type CloseOutcome, closeMission } from "./closeout.ts";
import type { WorktreeDriver } from "./driver.ts";
import { isIntegrated } from "./integration.ts";
import { type LeaseManager, type LeaseOutcome, leaseKeyFor } from "./leases.ts";
import { slugify } from "./naming.ts";

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
	prepare(mission: Mission, workspace: Workspace): Promise<Mission>;
	acquireWriter(m: Mission, w: Workspace, a: AgentId): Promise<LeaseOutcome>;
	releaseWriter(workspaceId: WorkspaceId, a: AgentId): Promise<Array<{ key: string; promoted?: AgentId }>>;
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
		async prepare(mission, workspace) {
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
			const worktree = await deps.driver.create({
				repoRoot,
				number: mission.number,
				slug: slugify(mission.name),
				base: mission.worktree?.base,
			});
			const prepared = { ...mission, worktree };
			await deps.saveMission(prepared);
			return prepared;
		},

		async acquireWriter(m, w, a) {
			const root = await rootFor(w);
			return deps.leases.acquire(w.id, a, leaseKeyFor({ kind: w.kind, worktreePath: m.worktree?.path, root }));
		},

		async releaseWriter(workspaceId, a) {
			return deps.leases.release(workspaceId, a);
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
