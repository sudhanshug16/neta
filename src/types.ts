/**
 * Core Neta vocabulary shared by the orchestrator, the worker channel and the
 * control plane.
 *
 * See MANIFESTO.md at the repository root for the design these types encode.
 */

import { estimateCost } from "./pricing.ts";

/**
 * What a worker can be trusted with. Tiers are about trust, not raw model
 * quality: the leader picks a tier from the task shape and never sees model
 * names. The tier -> backend/model mapping lives in settings.
 */
export type Tier = "apprentice" | "journeyman" | "expert" | "architect";

export const TIERS: readonly Tier[] = ["apprentice", "journeyman", "expert", "architect"] as const;

/** Legacy settings names accepted when reading files written by earlier releases. */
export const LEGACY_TIER_ALIASES = {
	intern: "apprentice",
	junior: "journeyman",
	senior: "expert",
	staff: "architect",
} as const;

export type LegacyTier = keyof typeof LEGACY_TIER_ALIASES;
export type TierSettingsKey = Tier | LegacyTier;

export function isTier(value: string): value is Tier {
	return (TIERS as readonly string[]).includes(value);
}

/** Lifecycle of a spawned worker. */
export type WorkerState =
	/** Process is being launched and the session negotiated. */
	| "starting"
	/** Working on its task. */
	| "running"
	/** Blocked on `neta ask`, waiting for the leader to answer. */
	| "waiting"
	/** Queued behind another writer, not yet started. */
	| "queued"
	/** Finished its task. */
	| "done"
	/** Crashed, refused, or was rejected by its backend. */
	| "failed"
	/** Terminated by the leader. */
	| "killed";

export function isTerminalState(state: WorkerState): boolean {
	return state === "done" || state === "failed" || state === "killed";
}

/**
 * One line of worker output the leader can pull. Progress milestones land in
 * this log; nothing here wakes the leader.
 *
 * "text" and "thought" carry the worker's own streamed prose and reasoning,
 * flushed a paragraph at a time; "tool" is one tool call; "diff" is a file
 * change a tool call reported, pre-rendered as unified-diff lines.
 */
export interface WorkerLogEntry {
	at: number;
	kind: "progress" | "say" | "status" | "tool" | "text" | "thought" | "diff" | "error";
	text: string;
	/** On "say" entries: the poster's worker id, so a view can attribute the post. */
	from?: string;
	/** On "say" entries: the poster's display label (name and role/tier). */
	label?: string;
}

/** A post in a room's shared transcript. */
export interface RoomPost {
	at: number;
	/** Worker id of the author, or "leader" when the leader seeds the room. */
	from: string;
	/** Display label for the author (role and tier), for readability. */
	label: string;
	text: string;
}

/**
 * What a worker has cost so far. Backends report this over ACP; anything a
 * backend does not report stays undefined rather than being guessed at.
 */
export interface WorkerUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	/** Tokens currently in the worker's context window. */
	contextUsed?: number;
	/** Size of that context window. */
	contextSize?: number;
	costAmount?: number;
	costCurrency?: string;
}

/** A room's shared transcript, addressed by position like a worker's log page. */
export interface RoomLogPage {
	posts: RoomPost[];
	/** Index to pass as `since` next time. */
	cursor: number;
	/** The room's members, summarized, so a watcher can say who is talking. */
	members: WorkerSummary[];
	/** Every member has reached a terminal state: the exchange is over. */
	done: boolean;
	/** The leader has moved on to a new batch; a view of this room can close. */
	archived: boolean;
}

/** One line of a worker's log, addressed by its position so several readers can follow independently. */
export interface WorkerLogPage {
	entries: WorkerLogEntry[];
	/** Index to pass as `since` next time. */
	cursor: number;
	state: WorkerState;
	/** Who this worker is, so a watcher can say so without a second request. */
	worker?: WorkerSummary;
	/** The leader has moved on to a new batch; a view of this worker can close. */
	archived?: boolean;
}

/** Events that wake the leader. */
export type WorkerEvent =
	| { type: "done"; workerId: string; summary: string; dirtyFiles?: string[] }
	| { type: "failed"; workerId: string; error: string }
	| { type: "ask"; workerId: string; question: string };

export interface SpawnRequest {
	role: string;
	tier: Tier;
	task: string;
	/**
	 * Two or three words naming this worker's job. Five workers all called
	 * "scout" are indistinguishable in a tab bar; "auth flow" and "rails cable"
	 * are not. The leader writes it, because the leader is what knows.
	 */
	name?: string;
	/** Grants edit/write access. Only one writer may be active at a time. */
	writer?: boolean;
	/** Explicit backend override; normally the tier decides. */
	backend?: string;
	/** Room to join. Members of a room can read and post to a shared transcript. */
	room?: string;
	/** Link this worker to a note. */
	note?: string;
}

export interface WorkerSummary {
	id: string;
	/** Short label for this worker's job; falls back to its role. */
	name: string;
	role: string;
	tier: Tier;
	backend: string;
	writer: boolean;
	room?: string;
	state: WorkerState;
	task: string;
	startedAt: number;
	endedAt?: number;
	/** Set once the worker reaches a terminal state. */
	result?: string;
	/** Writer holding the slot, while this worker's state is "queued". */
	queuedBehind?: string;
	/** Question the worker is blocked on, when state is "waiting". */
	pendingQuestion?: string;
	/** The worker's most recent `neta progress`, for a "last:" line in listings. */
	lastProgress?: { text: string; at: number };
	scratchDir: string;
	usage?: WorkerUsage;
	/**
	 * The backend's own session id for this worker.
	 *
	 * A worker driven over ACP is not a special kind of session — it is an
	 * ordinary Claude Code or Codex session, stored where that CLI stores its
	 * own. Knowing the id is what lets a person open the worker in the vendor's
	 * real UI and carry on the conversation by hand.
	 */
	vendorSessionId?: string;
	/** The model this worker negotiated and is running on, if reported by the backend. */
	model?: string;
	/** Raw id of that model, for cost estimation; same as `model` unless the backend names it. */
	modelId?: string;
	/** The mode this worker negotiated and is running in, if reported by the backend. */
	mode?: string;
	/** The ACP bridge the backend runs behind, as "name@version". */
	agentInfo?: string;
	/** Why this worker has no visible mux tab. */
	headlessReason?: string;
}

/**
 * The model a worker line should show. Once a worker is past starting, an
 * unreported model means the backend's own default is running — say so loudly
 * instead of leaving a blank the reader takes as "fine".
 */
export function displayModel(summary: WorkerSummary): string | undefined {
	if (summary.model) return summary.model;
	if (summary.state === "queued" || summary.state === "starting") return undefined;
	return "model unknown — backend default";
}

/** A worker linked to a note, tracked from spawn through its terminal state. */
export interface NoteWorkerLink {
	workerId: string;
	state: WorkerState;
}

/** An open-notes ledger entry for tracking parked/deferred work. */
export interface Note {
	id: string;
	text: string;
	open: boolean;
	createdAt: number;
	closedAt?: number;
	/** Workers linked to this note, with their current state. */
	workers: NoteWorkerLink[];
}

/** What can end a leader's wait. */
export type WaitWakeReason = "completed" | "first" | "ask" | "room" | "timeout";

/** Options for WorkerManager.wait. */
export interface WaitOptions {
	/** Return on the first watched worker to reach a terminal state, instead of all. */
	first?: boolean;
	/** Rooms whose new posts also wake the wait. */
	rooms?: string[];
}

/** Why a wait returned, and the watched workers as of that moment. */
export interface WaitResult {
	reason: WaitWakeReason;
	/** The watched workers, summarized at wake time, in the order they were named. */
	workers: WorkerSummary[];
	/** The worker whose completion ("first") or question ("ask") woke the wait. */
	wokeBy?: WorkerSummary;
	/** The new posts that woke the wait ("room"), and the room they landed in. */
	roomActivity?: { room: string; posts: RoomPost[] };
}

/** A point-in-time view of the writer slot, workers and open-notes ledger. */
export interface WorkerStatusSnapshot {
	/** The writer currently holding exclusive write access, if any. */
	writerSlot?: WorkerSummary;
	/** Writers waiting for the slot, in the order they will start. */
	writerQueue: WorkerSummary[];
	/** Every worker, partitioned into the states useful for a status check. */
	workers: {
		running: WorkerSummary[];
		queued: WorkerSummary[];
		waiting: WorkerSummary[];
		terminal: WorkerSummary[];
	};
	/** Notes that still need follow-through, including each linked worker's state. */
	openNotes: Note[];
}

/** Human-readable token and cost line, or undefined when the backend reported nothing. */
export function formatUsage(usage: WorkerUsage | undefined, modelId?: string): string | undefined {
	if (!usage) return undefined;
	const parts: string[] = [];
	if (usage.totalTokens !== undefined) parts.push(`${usage.totalTokens.toLocaleString("en-US")} tokens`);
	else if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
		parts.push(`${((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)).toLocaleString("en-US")} tokens`);
	}
	if (usage.contextUsed !== undefined && usage.contextSize) {
		parts.push(`context ${Math.round((usage.contextUsed / usage.contextSize) * 100)}%`);
	}
	if (usage.costAmount !== undefined) {
		parts.push(`${usage.costAmount.toFixed(2)} ${usage.costCurrency ?? "USD"}`);
	} else if (modelId) {
		// When backend does not report cost, try to estimate it from bundled pricing
		const estimated = estimateCost(modelId, usage);
		if (estimated !== undefined) {
			parts.push(`est. $${estimated.toFixed(2)}`);
		}
	}
	return parts.length > 0 ? parts.join(", ") : undefined;
}
