/**
 * Core Neta vocabulary shared by the orchestrator, the worker channel and the
 * control plane.
 *
 * See MANIFESTO.md at the repository root for the design these types encode.
 */

/**
 * What a worker can be trusted with. Tiers are about trust, not raw model
 * quality: the leader picks a tier from the task shape and never sees model
 * names. The tier -> backend/model mapping lives in settings.
 */
export type Tier = "junior" | "senior" | "staff";

export const TIERS: readonly Tier[] = ["junior", "senior", "staff"] as const;

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
 * One line of worker output the leader can pull. Workers narrate freely into
 * this log; nothing here wakes the leader.
 */
export interface WorkerLogEntry {
	at: number;
	kind: "notify" | "say" | "status" | "output" | "error";
	text: string;
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

/** One line of a worker's log, addressed by its position so several readers can follow independently. */
export interface WorkerLogPage {
	entries: WorkerLogEntry[];
	/** Index to pass as `since` next time. */
	cursor: number;
	state: WorkerState;
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
	/** Grants edit/write access. Only one writer may be active at a time. */
	writer?: boolean;
	/** Explicit backend override; normally the tier decides. */
	backend?: string;
	/** Room to join. Members of a room can read and post to a shared transcript. */
	room?: string;
}

export interface WorkerSummary {
	id: string;
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
	/** Question the worker is blocked on, when state is "waiting". */
	pendingQuestion?: string;
	scratchDir: string;
	usage?: WorkerUsage;
}

/** Human-readable token and cost line, or undefined when the backend reported nothing. */
export function formatUsage(usage: WorkerUsage | undefined): string | undefined {
	if (!usage) return undefined;
	const parts: string[] = [];
	if (usage.totalTokens !== undefined) parts.push(`${usage.totalTokens.toLocaleString("en-US")} tokens`);
	else if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
		parts.push(`${((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)).toLocaleString("en-US")} tokens`);
	}
	if (usage.contextUsed !== undefined && usage.contextSize) {
		parts.push(`context ${Math.round((usage.contextUsed / usage.contextSize) * 100)}%`);
	}
	if (usage.costAmount !== undefined) parts.push(`${usage.costAmount.toFixed(2)} ${usage.costCurrency ?? "USD"}`);
	return parts.length > 0 ? parts.join(", ") : undefined;
}
