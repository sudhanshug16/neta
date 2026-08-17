/**
 * Reopening a session that is already over.
 *
 * Two things stand between a durable checkpoint and a running leader again.
 *
 * The first is the vendor conversation. Neta never guesses it: every backend is
 * resumed by exact id — `claude --resume <uuid>`, `codex resume <uuid>`,
 * `opencode --session <ses_…>` — and a checkpoint with no captured id is
 * refused rather than reopened with a "latest" or "continue" selector.
 *
 * The second is the process-death barrier below. The old run's workers were
 * detached process groups with write access to the repository. Hydrating a
 * manager while one of them is still running would give the user a status
 * report that says "interrupted" about a process that is, at that moment, still
 * editing their files. So recovery proves death first — by identity, never by
 * pid alone — and refuses to continue when it cannot.
 */

import { existsSync } from "node:fs";
import {
	type CheckpointShutdown,
	listCheckpoints,
	readVendorSessionCapture,
	recordCheckpointStopped,
	recordLeaderVendorConversationId,
	type SessionCheckpoint,
} from "./checkpoint.ts";
import { APP_NAME } from "./config.ts";
import {
	canonicalizeCwd,
	isSessionAlive,
	isSessionLeaseAlive,
	listSessions,
	processStartTime,
	readSessionRecord,
	readStoppedMarker,
	reapSessionRecord,
	removeStoppedMarker,
	type SessionSweepOptions,
} from "./session.ts";
import { isTerminalState } from "./types.ts";

export class RecoveryError extends Error {}

export interface RecoveryOptions extends SessionSweepOptions {
	/** Test seam; production recovery reads the real process table. */
	agentDir: string;
}

/** The exact working directory this checkpoint belongs to, or a visible failure. */
export function requireCheckpointCwd(checkpoint: SessionCheckpoint): string {
	if (!existsSync(checkpoint.canonicalCwd)) {
		throw new RecoveryError(
			`Session ${checkpoint.id} ran in ${checkpoint.canonicalCwd}, which no longer exists. ` +
				`Restore that directory to resume there; the checkpoint was left unchanged.`,
		);
	}
	try {
		return canonicalizeCwd(checkpoint.canonicalCwd);
	} catch (error) {
		throw new RecoveryError(
			`Session ${checkpoint.id} ran in ${checkpoint.canonicalCwd}, which cannot be resolved: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * The exact vendor conversation to resume, or a visible failure. Never a vendor
 * "latest".
 *
 * With an agent directory this also consults what the vendor's session-start
 * hook recorded, which covers the narrow window where a session was closed
 * between the hook writing the id and the control plane adopting it. That is
 * still the vendor's own reported id, not a guess.
 */
export function requireLeaderConversationId(checkpoint: SessionCheckpoint, agentDir?: string): string {
	const captured = agentDir ? readVendorSessionCapture(checkpoint.id, agentDir) : undefined;
	const id = checkpoint.leader.vendorConversationId ?? captured;
	if (id && agentDir && !checkpoint.leader.vendorConversationId) {
		recordLeaderVendorConversationId(checkpoint.id, agentDir, id);
	}
	if (!id) {
		throw new RecoveryError(
			`Session ${checkpoint.id} has no recorded ${checkpoint.leader.backend} conversation id, so its exact leader ` +
				`conversation cannot be reopened. Neta will not guess with a "latest" or "continue" selector. ` +
				`Start a new session with \`${APP_NAME}\`; its worker history stays readable in this checkpoint.`,
		);
	}
	return id;
}

/**
 * Prove that nothing from the previous run can still be running, and record the
 * proof durably. Returns the lines that explain how death was established, for
 * the resume report. Throws instead of guessing.
 */
export async function proveManagerStopped(checkpoint: SessionCheckpoint, options: RecoveryOptions): Promise<string[]> {
	const { agentDir } = options;
	const identify = options.processStartTime ?? processStartTime;
	const lease = checkpoint.liveLease;
	const hadRunningWork = checkpoint.workers.some((worker) => !isTerminalState(worker.state));

	if (checkpoint.shutdown?.processesStopped && !lease) {
		return [`previous run stopped cleanly (${describeShutdown(checkpoint.shutdown)})`];
	}

	if (!lease) {
		if (hadRunningWork) {
			throw new RecoveryError(
				`Session ${checkpoint.id} stopped without recording that its workers were stopped, and no manager ` +
					`record remains to prove it. Recovery refuses to hydrate over processes it cannot account for; ` +
					`the checkpoint was left unchanged.`,
			);
		}
		recordCheckpointStopped(checkpoint.id, agentDir, "recovery");
		return ["no manager lease and no worker was running when the session was last saved"];
	}

	if (isSessionLeaseAlive(lease, agentDir)) {
		throw new RecoveryError(
			`Session ${checkpoint.id} is still running as manager ${lease.managerId}. ` +
				`Reattach to it with \`${APP_NAME}\` in ${checkpoint.canonicalCwd} instead of resuming, ` +
				`or close it first. Nothing was changed.`,
		);
	}

	const notes: string[] = [];
	const record = readSessionRecord(lease.managerId, agentDir);
	if (record) {
		const recordedIdentity = record.processStartedAt;
		if (lease.processStartedAt && recordedIdentity && lease.processStartedAt !== recordedIdentity) {
			throw new RecoveryError(
				`Manager record ${lease.managerId} was started at ${recordedIdentity}, but this checkpoint's lease ` +
					`names a manager started at ${lease.processStartedAt}. Refusing to reap processes on a mismatched ` +
					`identity; the checkpoint was left unchanged.`,
			);
		}
		if (isSessionAlive(record) && identify(record.pid) === (lease.processStartedAt ?? recordedIdentity)) {
			throw new RecoveryError(
				`Manager ${lease.managerId} (pid ${record.pid}) is still alive. Close it, then resume; ` +
					`nothing was changed.`,
			);
		}
		const groups = record.workerGroups?.length ?? 0;
		if (!reapSessionRecord(record, agentDir, options)) {
			throw new RecoveryError(
				`Could not prove every worker process group of manager ${lease.managerId} is gone. ` +
					`Stop the remaining processes yourself and resume again; the checkpoint was left unchanged.`,
			);
		}
		notes.push(
			`manager ${lease.managerId} was gone; reaped ${groups} recorded worker process group${groups === 1 ? "" : "s"}` +
				`${record.mux ? ` and its ${record.mux.id} session` : ""}`,
		);
	} else {
		const marker = readStoppedMarker(lease.managerId, agentDir);
		if (marker && !marker.processesStopped) {
			throw new RecoveryError(
				`An earlier cleanup of manager ${lease.managerId} could not confirm its worker processes exited. ` +
					`Stop them yourself and resume again; the checkpoint was left unchanged.`,
			);
		}
		if (marker) {
			notes.push(`manager ${lease.managerId} was already reaped by an earlier Neta command`);
		} else if (hadRunningWork) {
			throw new RecoveryError(
				`No record of manager ${lease.managerId} remains, and this checkpoint still shows running workers. ` +
					`Recovery cannot prove those processes are gone, so it refuses to hydrate; the checkpoint was ` +
					`left unchanged.`,
			);
		} else {
			notes.push(`manager ${lease.managerId} is gone and no worker was running when the session was last saved`);
		}
	}

	const stopped = recordCheckpointStopped(checkpoint.id, agentDir, "recovery", lease.managerId);
	if (!stopped) {
		throw new RecoveryError(
			`Checkpoint ${checkpoint.id} changed hands while recovery was proving the old manager dead. ` +
				`Run \`${APP_NAME} resume ${checkpoint.id}\` again.`,
		);
	}
	removeStoppedMarker(lease.managerId, agentDir);
	return notes;
}

function describeShutdown(shutdown: CheckpointShutdown): string {
	const when = new Date(shutdown.at).toISOString();
	return shutdown.by === "graceful" ? `closed ${when}` : `${shutdown.by} cleanup ${when}`;
}

export interface DurableSessionRow {
	id: string;
	live: boolean;
	leader: string;
	updatedAt: number;
	/** The exact vendor conversation was captured, so this session can be reopened. */
	resumable: boolean;
	cwd: string;
	error?: string;
}

/**
 * Every session Neta still knows about: the live ones from the registry and the
 * closed ones from durable checkpoints, newest first. Files it cannot read stay
 * in the list carrying their error, because a checkpoint that silently vanishes
 * from a listing is worse than one that says why it cannot be used.
 */
export function listDurableSessions(agentDir: string): DurableSessionRow[] {
	const live = new Map(listSessions(agentDir).map((record) => [record.checkpointId ?? record.id, record]));
	const rows: DurableSessionRow[] = [];
	for (const entry of listCheckpoints(agentDir)) {
		const checkpoint = entry.checkpoint;
		if (!checkpoint) {
			rows.push({
				id: entry.id,
				live: false,
				leader: "?",
				updatedAt: 0,
				resumable: false,
				cwd: entry.path,
				error: entry.error,
			});
			continue;
		}
		rows.push({
			id: checkpoint.id,
			live:
				live.has(checkpoint.id) ||
				(checkpoint.liveLease ? isSessionLeaseAlive(checkpoint.liveLease, agentDir) : false),
			leader: checkpoint.leader.backend,
			updatedAt: checkpoint.updatedAt,
			resumable: Boolean(
				checkpoint.leader.vendorConversationId ?? readVendorSessionCapture(checkpoint.id, agentDir),
			),
			cwd: checkpoint.canonicalCwd,
		});
		live.delete(checkpoint.id);
	}
	// A live manager with no checkpoint of its own still belongs in the list.
	for (const [id, record] of live) {
		rows.push({
			id,
			live: true,
			leader: record.leader,
			updatedAt: record.startedAt,
			resumable: false,
			cwd: record.cwd,
		});
	}
	return rows.sort((left, right) => right.updatedAt - left.updatedAt);
}

/** One tab-separated line per session, so an id can be copied straight into `neta resume`. */
export function formatDurableSession(row: DurableSessionRow): string {
	if (row.error) return `${row.id}\tunreadable\t${row.error}`;
	return [
		row.id,
		row.live ? "live" : "closed",
		row.leader,
		new Date(row.updatedAt).toISOString(),
		row.resumable ? "conversation-id:yes" : "conversation-id:no",
		row.cwd,
	].join("\t");
}

const RESULT_LIMIT = 240;

function clamp(text: string, limit = RESULT_LIMIT): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * What the resumed leader is told about the run it inherited.
 *
 * Short on purpose: the whole state is one `neta_status` away, and a leader that
 * reads a wall of recovered history spends its first turn summarizing instead of
 * working. What it must not miss is that nothing was restarted.
 */
export function buildRecoverySummary(checkpoint: SessionCheckpoint, currentVersion: string): string {
	const lines: string[] = [];
	lines.push("## Recovered session");
	lines.push("");
	lines.push(
		`This conversation was reopened from Neta session \`${checkpoint.id}\`, saved by Neta ` +
			`${checkpoint.appVersion}${checkpoint.appVersion === currentVersion ? "" : ` and now running on ${currentVersion}`}.`,
	);
	lines.push("");

	const workers = checkpoint.workers.filter((worker) => !worker.archived);
	if (workers.length === 0) {
		lines.push("No workers had been started when the session stopped.");
	} else {
		lines.push("Workers from before the restart:");
		lines.push("");
		for (const worker of workers) {
			const state =
				worker.state === "interrupted" && worker.stateBeforeStop
					? `interrupted (was ${worker.stateBeforeStop})`
					: worker.state;
			const outcome = worker.substantiveResponse ?? worker.finalResult;
			lines.push(
				`- \`${worker.id}\` ${worker.name} [${worker.role}/${worker.tier}] — ${state}${outcome ? `: ${clamp(outcome)}` : ""}`,
			);
		}
	}

	const openNotes = checkpoint.notes.filter((note) => note.open);
	if (openNotes.length > 0) {
		lines.push("");
		lines.push("Open notes:");
		lines.push("");
		for (const note of openNotes) lines.push(`- \`${note.id}\` ${clamp(note.text)}`);
	}

	lines.push("");
	lines.push(
		"No worker was restarted. Nothing from the previous run is running: every worker that was still " +
			"active is now marked interrupted and its work is unfinished. Queued work stayed queued and will " +
			"not start by itself.",
	);
	lines.push("");
	lines.push(
		"Before you act, call `neta_status` for the full state, and re-verify anything an interrupted " +
			"worker claimed — check `git log` and `git status` rather than trusting a half-finished handoff. " +
			"Respawn work you still need; the recovered records are history, not running workers.",
	);
	return lines.join("\n");
}
