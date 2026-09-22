// The one place a mission may be closed, with evidence or a reason. Only
// closeout passes `abandon` to the driver; a refused removal leaves the
// mission open with `attention` set to the refusal reason. There is no
// retained-but-closed state.
import type { Disposition, EventKind, IsoTime, Mission, MissionId } from "../core/types.ts";
import type { WorktreeDriver } from "./driver.ts";
import type { IntegrationResult, isIntegrated } from "./integration.ts";
import { BASE_LEASE, type LeaseManager } from "./leases.ts";

export interface CloseMissionInput {
	mission: Mission;
	disposition: Disposition;
	reason: string;
	evidence?: string;
}

export type CloseOutcome = { ok: true; mission: Mission } | { ok: false; attention: string; mission: Mission };

export interface CloseoutDeps {
	driver: WorktreeDriver;
	leases: LeaseManager;
	isIntegrated: typeof isIntegrated;
	now(): IsoTime;
	emit(kind: EventKind, missionId: MissionId, data: Record<string, string>): void;
	onMissionClosed(mission: Mission): Promise<void>;
}

// The first 7–40 hex token: the commit an evidence string names.
export function extractCommit(evidence: string): string | undefined {
	return /[0-9a-fA-F]{7,40}/.exec(evidence)?.[0];
}

function refuse(mission: Mission, attention: string): CloseOutcome {
	return { ok: false, attention, mission: { ...mission, attention } };
}

export async function closeMission(i: CloseMissionInput, d: CloseoutDeps): Promise<CloseOutcome> {
	const w = i.mission.workspaceId;
	// BASE_LEASE first, so two closeouts never merge concurrently. The holder
	// is the mission id: a closeout owner marker, not an agent. Freed on
	// every exit path below.
	if ((await d.leases.acquire(w, i.mission.id, BASE_LEASE)) !== "active") {
		return refuse(i.mission, "another closeout is integrating");
	}
	try {
		let mission = i.mission;
		if (i.disposition === "merged") {
			const confirmed = await confirmMerged(i, d);
			if (!confirmed.ok) {
				return refuse(mission, confirmed.attention);
			}
			mission = confirmed.mission;
		} else if (i.reason.trim() === "") {
			return refuse(mission, `${i.disposition} needs a reason`);
		}
		if (i.disposition === "completed" && mission.integration !== undefined) {
			return refuse(mission, "integrated work must close as merged");
		}
		if (mission.worktree !== undefined) {
			// Any in-repo path anchors git and `wt`; only creation needs the
			// true root, and closeout never creates.
			const removed = await d.driver.remove({
				repoRoot: mission.worktree.path,
				path: mission.worktree.path,
				branch: mission.worktree.branch,
				base: mission.worktree.base,
				...(mission.integration === undefined ? {} : { evidenceCommit: mission.integration.commit }),
				abandon: i.disposition === "abandoned",
			});
			if (!removed.ok) {
				return refuse(mission, removed.reason);
			}
			mission = { ...mission, worktree: undefined };
		}
		const closed: Mission = {
			...mission,
			state: "closed",
			closedAt: d.now(),
			disposition: i.disposition,
			closeReason: i.reason,
			attention: undefined,
		};
		d.emit("mission.closed", closed.id, { disposition: i.disposition });
		// The Node callback persists the closed state before handing a released
		// slot to its scheduler, so a queued member of this mission is skipped.
		await d.onMissionClosed(closed);
		for (const agentId of closed.agentIds) {
			await d.leases.release(w, agentId);
		}
		await d.leases.release(w, closed.id);
		return { ok: true, mission: closed };
	} finally {
		await d.leases.release(w, i.mission.id);
	}
}

async function confirmMerged(
	i: CloseMissionInput,
	d: CloseoutDeps,
): Promise<{ ok: true; mission: Mission } | { ok: false; attention: string }> {
	const mission = i.mission;
	if (mission.integration !== undefined) {
		return { ok: true, mission };
	}
	// A folder workspace is not git: there is no ancestry to confirm, so the
	// leader's evidence stands on its own and no worktree is removed.
	if (mission.worktree === undefined) {
		if (i.evidence === undefined) {
			return { ok: false, attention: "merged needs evidence" };
		}
		return { ok: true, mission };
	}
	const commit = i.evidence === undefined ? undefined : extractCommit(i.evidence);
	if (commit === undefined) {
		return { ok: false, attention: "merged needs evidence naming a commit" };
	}
	let result: IntegrationResult;
	try {
		result = await d.isIntegrated({
			repoRoot: mission.worktree.path,
			branch: mission.worktree.branch,
			base: mission.worktree.base,
			evidenceCommit: commit,
		});
	} catch {
		return { ok: false, attention: `could not confirm ${commit} against ${mission.worktree.base}` };
	}
	if (!result.merged) {
		return {
			ok: false,
			attention: `branch ${mission.worktree.branch} is not merged into ${mission.worktree.base} by evidence ${commit}`,
		};
	}
	return {
		ok: true,
		mission: {
			...mission,
			integration: { mergedAt: d.now(), commit: result.commit ?? commit, base: mission.worktree.base },
		},
	};
}
