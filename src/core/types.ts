import type { RoutingDecision } from "../routing/types.ts";
export type Ulid = string; // 26 chars, Crockford base32
export type MachineId = Ulid;
export type WorkspaceId = string; // see workspace identity below
export type MissionId = Ulid;
export type AgentId = Ulid;
export type SessionId = Ulid; // Neta's id for one conversation
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

/** Execution coordinator. The saved record and wire key remain `leader`. */
export interface Leader {
	workspaceId: WorkspaceId;
	machineId: MachineId;
	name: string; // fixed Coordinator label
	sessionId: SessionId; // the one continuous conversation
	provider: string; // provider name from settings
	model: string; // concrete model id
	state: "idle" | "running" | "failed";
	currentTurnId?: TurnId;
	bindingGeneration?: string;
	startupError?: string;
}

export type Access = "readOnly" | "readWrite";

export type MissionState = "open" | "closed";
export type Disposition = "merged" | "completed" | "abandoned";

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
	lead: MissionLead;
	agentIds: AgentId[];
	access: Access; // what the mission may do at most
	worktree?: Worktree; // present for git missions
	worktreeRecovery?: { setupDisposition: "handled" | "waived"; at: IsoTime }; // explicit adoption, not setup success
	state: MissionState;
	attention?: string; // runtime or integration detail
	createdAt: IsoTime;
	closedAt?: IsoTime;
	disposition?: Disposition;
	closeReason?: string;
	integration?: { mergedAt: IsoTime; commit: string; base: string };
	continuesMissionId?: MissionId;
}

export type AgentState = "queued" | "idle" | "starting" | "running" | "failed" | "interrupted" | "archived";

export interface Agent {
	runtimeError?: string;
	id: AgentId;
	missionId: MissionId;
	workspaceId: WorkspaceId;
	name: string; // from the name pool
	task: string; // full task name, never truncated
	access: Access;
	provider: string;
	model: string;
	variant?: string;
	skills: string[]; // skill names attached
	sessionId: SessionId;
	canSpawn: boolean; // true only for mission leads
	state: AgentState;
	currentTurnId?: TurnId;
	bindingGeneration?: string;
	requestedModel?: string;
	routing?: RoutingDecision;
	fallbackModels?: string[];
	deliveryStatus?: "pending" | "accepted" | "uncertain" | "failed";
	deliveryError?: string;
	lastReportedTurnId?: TurnId;
	pendingParentTurn?: Turn;
	stateBefore?: AgentState; // set when interrupted
	startedAt: IsoTime;
	endedAt?: IsoTime;
}

export type EventKind =
	| "mission.created"
	| "mission.failed"
	| "worktree.setupFailed"
	| "artifact.published"
	| "mission.merged"
	| "mission.closed"
	| "agent.spawned"
	| "agent.archived"
	| "agent.modelChanged"
	| "routing.failed"
	| "base.integrated"
	| "charter.changed"
	| "node.restarted";

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
export type BlockKind = "text" | "thought" | "tool" | "diff" | "status" | "plan" | "usage";

export interface PromptAttachment {
	id: string;
	kind: "image" | "file";
	name: string;
	mimeType: string;
	dataBase64: string;
}
export type InboxMessageStatus = "queued" | "delivering" | "delivered" | "uncertain" | "discarded";
export interface InboxMessage {
	sourceId?: string;
	sourceHash?: string;
	readerDirected?: boolean;
	id: Ulid;
	sessionId: SessionId;
	createdAt: IsoTime;
	text: string;
	attachments: PromptAttachment[];
	status: InboxMessageStatus;
	deliveredAt?: IsoTime;
	consumedAt?: IsoTime;
	turnId?: TurnId;
}
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
	finalReply?: string; // authoritative final visible native assistant message
	superseded?: boolean; // a later admitted internal message must be considered before reporting this reply
	id: TurnId;
	sessionId: SessionId;
	startedAt: IsoTime;
	endedAt?: IsoTime;
	role: Role; // who opened the turn
	cancelled?: boolean;
	failed?: boolean;
	readerDirected?: boolean;
	model?: string;
	bindingGeneration?: string;
}
