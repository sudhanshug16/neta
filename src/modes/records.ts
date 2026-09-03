// Leadership modes: where they live and the port that owns them. The
// workspace leader's mode is the `mode` fields already on `Leader` (01); a
// mission lead's mode is a `LeadMode` keyed by `agentId` in the same file,
// `leaders/<workspaceId>.json`, which 02 round-trips and 07 touches only
// through `LeadModeStore`. Everyone begins in `lead`.
import { nowIso } from "../core/time.ts";
import type { AgentId, DecisionRecord, IsoTime, Leader, LeaderMode, MissionId, WorkspaceId } from "../core/types.ts";

export interface LeadMode {
	agentId: AgentId;
	missionId: MissionId;
	mode: LeaderMode;
	modeSince: IsoTime;
	modeActiveMs: number;
}

export type ModeSubject =
	| { kind: "leader"; workspaceId: WorkspaceId }
	| { kind: "lead"; workspaceId: WorkspaceId; agentId: AgentId };

export interface ModeSnapshot {
	subject: ModeSubject;
	mode: LeaderMode;
	modeSince: IsoTime;
	modeActiveMs: number;
	missionId?: MissionId;
}

export type ModeCause = "user" | "tool" | "missionClosed" | "missionAbandoned";

export interface LeaderFile {
	leader: Leader;
	leadModes: Record<AgentId, LeadMode>;
}

export interface LeadModeStore {
	read(workspaceId: WorkspaceId): Promise<LeaderFile>;
	writeLeader(workspaceId: WorkspaceId, leader: Leader): Promise<void>;
	writeLeadMode(workspaceId: WorkspaceId, agentId: AgentId, mode: LeadMode | undefined): Promise<void>;
}

export function subjectKey(subject: ModeSubject): string {
	return subject.kind === "leader"
		? `leader:${subject.workspaceId}`
		: `lead:${subject.workspaceId}:${subject.agentId}`;
}

export function snapshotOf(leader: Leader, leadModes: Record<AgentId, LeadMode>, subject: ModeSubject): ModeSnapshot {
	if (subject.kind === "leader") {
		return { subject, mode: leader.mode, modeSince: leader.modeSince, modeActiveMs: leader.modeActiveMs };
	}
	const stored = leadModes[subject.agentId];
	if (stored === undefined) {
		return { subject, mode: "lead", modeSince: nowIso(), modeActiveMs: 0 };
	}
	return {
		subject,
		mode: stored.mode,
		modeSince: stored.modeSince,
		modeActiveMs: stored.modeActiveMs,
		missionId: stored.missionId,
	};
}

// The record written flat onto the `leader.modeChanged` event data: its nine
// fields plus `from`, `to` and `cause`; never nested under a `record` key.
export function modeEventData(input: {
	from: LeaderMode;
	to: LeaderMode;
	cause: ModeCause;
	missionId?: MissionId;
	record?: DecisionRecord;
}): Record<string, string | number | boolean | null> {
	const data: Record<string, string | number | boolean | null> = {
		from: input.from,
		to: input.to,
		cause: input.cause,
	};
	if (input.missionId !== undefined) {
		data.missionId = input.missionId;
	}
	const record = input.record;
	if (record !== undefined) {
		data.objective = record.objective;
		data.whyLeadInsufficient = record.whyLeadInsufficient;
		data.missionId = record.missionId;
		if (record.worktreePath !== undefined) {
			data.worktreePath = record.worktreePath;
		}
		data.mutationKind = record.mutationKind;
		data.estimatedFiles = record.estimatedFiles;
		data.validation = record.validation;
		data.estimatedMinutes = record.estimatedMinutes;
		data.externalEffects = record.externalEffects;
	}
	return data;
}
