export type Ulid = string; // 26 chars, Crockford base32
export type MachineId = Ulid;
export type WorkspaceId = string; // see workspace identity below
export type MissionId = Ulid;
export type AgentId = Ulid;
export type SessionId = Ulid; // Neta's id for one ACP conversation
export type TurnId = Ulid;
export type IsoTime = string; // ISO 8601, UTC, milliseconds

export type WorkspaceKind = "git" | "folder";
export interface Workspace {
	id: WorkspaceId;
	kind: WorkspaceKind;
	name: string; // repo name or folder basename
	remote?: string; // canonical remote, git only
	roots: WorkspaceRoot[]; // copies on this machine
	createdAt: IsoTime;
}
export interface WorkspaceRoot {
	machineId: MachineId;
	path: string;
}

export interface Machine {
	id: MachineId;
	name: string;
	createdAt: IsoTime;
}

export type LeaderMode = "lead" | "leadPlus";
export interface Leader {
	workspaceId: WorkspaceId;
	machineId: MachineId;
	sessionId: SessionId; // the one continuous conversation
	provider: string; // provider name from settings
	model: string; // concrete model id
	mode: LeaderMode;
	modeSince: IsoTime;
	modeActiveMs: number; // active connected time in leadPlus
	activeMissionId?: MissionId; // mission the leader works in directly
	state: "idle" | "running" | "failed";
}

export type Access = "readOnly" | "readWrite";

export type MissionState = "running" | "blocked" | "failed" | "readyToClose" | "mergedNotClosed" | "closed";
export type Disposition = "merged" | "abandoned";

export interface MissionChange {
	// append-only accepted scope change
	at: IsoTime;
	text: string;
	turnId?: TurnId;
}
export interface Worktree {
	provider: "worktrunk";
	path: string;
	branch: string;
	base: string;
}
export type MissionLead = { kind: "leader" } | { kind: "agent"; agentId: AgentId };

export interface Mission {
	id: MissionId;
	number: number; // permanent, per workspace
	workspaceId: WorkspaceId;
	machineId: MachineId;
	name: string; // 2–6 words, operational
	objective: string; // immutable original objective
	changes: MissionChange[];
	lead: MissionLead;
	agentIds: AgentId[];
	access: Access; // what the mission may do at most
	worktree?: Worktree; // present for git missions
	state: MissionState;
	attention?: string; // one line: the question, the error
	createdAt: IsoTime;
	closedAt?: IsoTime;
	disposition?: Disposition;
	closeReason?: string;
	integration?: { mergedAt: IsoTime; commit: string; base: string };
	continuesMissionId?: MissionId;
}

export type AgentState = "starting" | "running" | "blocked" | "failed" | "completed" | "interrupted" | "archived";

export interface Agent {
	id: AgentId;
	missionId: MissionId;
	workspaceId: WorkspaceId;
	name: string; // from the name pool
	task: string; // full task name, never truncated
	access: Access;
	provider: string;
	model: string;
	skills: string[]; // skill names attached
	sessionId: SessionId;
	canSpawn: boolean; // true only for mission leads
	state: AgentState;
	stateBefore?: AgentState; // set when interrupted
	activity?: { text: string; at: IsoTime };
	pendingQuestion?: string;
	startedAt: IsoTime;
	endedAt?: IsoTime;
	outcome?: string; // final report, one paragraph
}

export interface DecisionRecord {
	// Lead++ request, manifesto list
	objective: string;
	whyLeadInsufficient: string;
	missionId: MissionId;
	worktreePath?: string;
	mutationKind: string;
	estimatedFiles: number;
	validation: string;
	estimatedMinutes: number;
	externalEffects: string; // "none" is a valid answer
}

export type EventKind =
	| "mission.created"
	| "mission.changed"
	| "mission.blocked"
	| "mission.unblocked"
	| "mission.failed"
	| "mission.readyToClose"
	| "mission.merged"
	| "mission.closed"
	| "agent.spawned"
	| "agent.finished"
	| "agent.archived"
	| "leader.modeChanged"
	| "leader.modeReminder"
	| "base.integrated"
	| "charter.changed"
	| "node.restarted"
	| "user.pinned";

export interface Event {
	seq: number; // monotonic per workspace
	at: IsoTime;
	workspaceId: WorkspaceId;
	kind: EventKind;
	missionId?: MissionId;
	agentId?: AgentId;
	sessionId?: SessionId;
	turnId?: TurnId; // the conversation turn that caused it
	data: Record<string, string | number | boolean | null>;
}

export type Role = "user" | "agent" | "system";
export type BlockKind = "text" | "thought" | "tool" | "diff" | "status";
export interface Block {
	turnId: TurnId;
	seq: number;
	at: IsoTime;
	role: Role;
	kind: BlockKind;
	text: string; // rendered text; tool blocks carry the title
	data?: Record<string, string | number | boolean | null>;
}
export interface Turn {
	id: TurnId;
	sessionId: SessionId;
	startedAt: IsoTime;
	endedAt?: IsoTime;
	role: Role; // who opened the turn
	cancelled?: boolean;
}
