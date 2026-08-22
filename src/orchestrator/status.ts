/**
 * The one status rendering shared by the socket CLI and the leader's MCP tool.
 * Keep this presentation separate from WorkerManager so both doors show the
 * same point-in-time view without duplicating state or formatting rules.
 */

import { APP_NAME } from "../config.ts";
import {
	displayModel,
	formatUsage,
	type Note,
	type SessionGoal,
	type SteerResult,
	type WorkerInspection,
	type WorkerStatusSnapshot,
	type WorkerSummary,
} from "../types.ts";

const OBJECTIVE_LIMIT = 100;
const LAST_PROGRESS_LIMIT = 80;
/** Total rendered size of `neta inspect`, including metadata and footer. */
export const INSPECT_RENDER_MAX_CHARS = 6000;

/** The most recent `neta progress` as a "last:" line, or undefined before any progress. */
export function formatLastProgress(summary: WorkerSummary): string | undefined {
	if (!summary.lastProgress) return undefined;
	const flat = summary.lastProgress.text.replace(/\s+/g, " ").trim();
	if (flat === "") return undefined;
	const clipped = flat.length <= LAST_PROGRESS_LIMIT ? flat : `${flat.slice(0, LAST_PROGRESS_LIMIT - 3).trimEnd()}...`;
	return `last: ${clipped}`;
}

/**
 * How to expand this worker's recent input and output where you are standing.
 *
 * Every worker row carries it, because the row is where a reader decides they
 * want more, and a headless worker has no tab to open instead.
 */
export function inspectHint(workerId: string): string {
	return `expand: ${APP_NAME} inspect ${workerId}`;
}

/**
 * Render a bounded inspection: what was sent to the worker and what it said
 * back, with the cap stated out loud wherever it bit.
 *
 * The markers are deliberate and unmissable. A truncated dump that looks
 * complete is worse than no dump: a reader concludes the worker did nothing
 * between the lines that are missing.
 */
export function formatInspection(inspection: WorkerInspection): string[] {
	const { worker } = inspection;
	const lines = [`${formatWorkerSummary(worker)}`];
	if (inspection.headlessReason) {
		lines.push(`Worker view: headless — ${inspection.headlessReason}; inspection still works without a tab.`);
	}
	lines.push(`task: ${worker.task.replace(/\s+/g, " ").trim()}`);
	lines.push("");
	if (inspection.droppedEntries > 0) {
		lines.push(`… ${inspection.droppedEntries} earlier entries not shown (inspection cap)`);
	}
	if (inspection.droppedChars > 0) {
		lines.push(`… ${inspection.droppedChars} earlier characters truncated (inspection cap)`);
	}
	if (inspection.entries.length === 0) {
		lines.push("(this worker has produced no output yet)");
	}
	for (const entry of inspection.entries) lines.push(`[${entry.kind}] ${entry.text}`);
	lines.push("");
	lines.push(
		`Full stream: \`${APP_NAME} watch ${worker.id}\`` +
			`${worker.vendorSessionId ? ` · in its own CLI: \`${APP_NAME} attach ${worker.id}\`` : ""}`,
	);
	const rendered = lines.join("\n");
	if (rendered.length <= INSPECT_RENDER_MAX_CHARS) return lines;
	const details = [
		inspection.droppedEntries > 0
			? `${inspection.droppedEntries} earlier entries not shown (inspection cap)`
			: undefined,
		inspection.droppedChars > 0
			? `${inspection.droppedChars} earlier characters truncated (inspection cap)`
			: undefined,
	].filter((detail) => detail !== undefined);
	const marker = `… earlier inspection content truncated (${INSPECT_RENDER_MAX_CHARS} character hard cap)${details.length > 0 ? `; ${details.join("; ")}` : ""}`;
	const newest = rendered.slice(-(INSPECT_RENDER_MAX_CHARS - marker.length - 1));
	return [marker, newest];
}

export function formatWorkerSummary(summary: WorkerSummary): string {
	const named = summary.name === summary.role ? summary.id : `${summary.id} "${summary.name}"`;
	const parts = [`${named} ${summary.role}/${summary.tier}`, `backend=${summary.backend}`, summary.state];
	if (summary.writer) parts.push("writer");
	if (summary.room) parts.push(`room=${summary.room}`);
	const model = displayModel(summary);
	if (model) parts.push(summary.model ? `model=${summary.model}` : model);
	if (summary.mode) parts.push(`mode=${summary.mode}`);
	const usage = formatUsage(summary.usage, summary.modelId ?? summary.model);
	if (usage) parts.push(usage);
	if (summary.pendingQuestion) parts.push(`asking: ${summary.pendingQuestion}`);
	if (summary.promptBlockedReason) parts.push(`steering blocked: ${summary.promptBlockedReason}`);
	return [
		parts.join(" | "),
		...(summary.laterFailure ? [`After its report: ${summary.laterFailure}`] : []),
		...(summary.headlessReason ? [`Worker view: headless — ${summary.headlessReason}`] : []),
	].join("\n");
}

/**
 * What a steer did, in one line the caller can act on.
 *
 * The distinction that matters is whether the worker has the message. "Queued"
 * and "delivered" are different facts, and reporting the first as the second
 * would have a leader believe it had redirected a worker that is still doing
 * the old thing.
 */
export function formatSteerResult(result: SteerResult): string {
	const id = result.worker.id;
	const headline: Record<SteerResult["delivery"], string> = {
		"pending-brief": `${id} has not started yet; your message was added to its opening brief and arrives with its task.`,
		"next-turn": `Your message is queued as ${id}'s next prompt.`,
		interrupted: `Interrupted ${id}'s running turn; it is now working on your message.`,
		"turn-ended": `${id}'s turn ended before the interrupt landed; it is now working on your message.`,
		"cancel-pending": `Asked ${id} to stop its turn; it has NOT read your message yet.`,
		"cancel-failed": `Could not safely stop ${id}'s turn; your message was NOT delivered.`,
	};
	return result.note ? `${headline[result.delivery]} ${result.note}` : headline[result.delivery];
}

function formatNotes(notes: Note[]): string[] {
	if (notes.length === 0) return ["  (none)"];
	return notes.map((note) => {
		const workers =
			note.workers.length === 0
				? "unworked"
				: note.workers.map((worker) => `${worker.workerId} ${worker.state}`).join(", ");
		return `  ${note.id} "${note.text}" (${workers})`;
	});
}

function formatGoal(goal: SessionGoal | undefined): string[] {
	if (!goal) return [];
	const pending = goal.discoveries.filter(
		(discovery) => discovery.impact === "goal" && discovery.status === "pending",
	);
	return [
		"Goal:",
		`  status=${goal.status} | revision=${goal.revision} | discovery policy=${goal.discoveryPolicy}`,
		`  original intent: ${goal.originalIntent}`,
		`  working objective: ${goal.workingObjective}`,
		`  pending goal discoveries: ${pending.length ? pending.map((discovery) => discovery.id).join(", ") : "none"}`,
	];
}

/**
 * One status section. Every worker row names its own expand command, so a reader
 * who wants to see what a worker actually said does not have to know that
 * `neta inspect` exists — the row says so, including for workers whose
 * multiplexer tab was never created.
 */
function section(label: string, workers: WorkerSummary[]): string[] {
	return [
		label,
		...(workers.length === 0
			? ["  (none)"]
			: workers.flatMap((worker) => {
					const lastProgress = formatLastProgress(worker);
					const line = `  ${formatWorkerSummary(worker)}`;
					return [...(lastProgress ? [line, `    ${lastProgress}`] : [line]), `    ${inspectHint(worker.id)}`];
				})),
	];
}

/** A compact, stable description shared by writer context and writer status. */
export function formatWriterObjective(summary: WorkerSummary): string {
	const firstLine = summary.task.split(/\r?\n/, 1)[0]?.trim() ?? "";
	const objective = [summary.name, firstLine].filter(Boolean).join(": ");
	if (objective.length <= OBJECTIVE_LIMIT) return objective;
	return `${objective.slice(0, OBJECTIVE_LIMIT - 3).trimEnd()}...`;
}

/** A machine-generated heads-up for readers whose checkout may change under them. */
export function formatWriterActivityNotice(
	summary: WorkerSummary,
	activity: "started" | "finished",
	changes?: string,
): string {
	const name = summary.name === summary.role ? summary.name : `"${summary.name}"`;
	const lines = [
		"[Neta system notice — automatic heads-up, not a new instruction. Your task is unchanged.]",
		`Writer ${summary.id} ${name} ${activity}.`,
		`Objective: ${formatWriterObjective(summary)}`,
	];
	if (changes) lines.push(`Changes: ${changes}`);
	lines.push("Use `git show HEAD:<path>` to read the committed version.");
	return lines.join("\n");
}

function formatWriter(summary: WorkerSummary): string {
	const name = summary.name === summary.role ? summary.name : `"${summary.name}"`;
	return `${summary.id} ${name} | ${formatWriterObjective(summary)}`;
}

/** Context prepended to a read-only task while writers may change the checkout. */
export function formatWriterContext(active: WorkerSummary | undefined, queued: WorkerSummary[]): string | undefined {
	if (!active && queued.length === 0) return undefined;

	const lines = ["# Concurrent writer context", ""];
	if (active) lines.push(`Active writer: ${formatWriter(active)}`);
	if (queued.length > 0) {
		lines.push("Queued writers:", ...queued.map((writer) => `- ${formatWriter(writer)}`));
	}
	lines.push(
		"",
		"The working tree may contain uncommitted edits. `git show HEAD:<path>` reads the last committed version.",
	);
	return lines.join("\n");
}

/** Render only writers for workers that need to inspect concurrent write work. */
export function formatWriterStatus(snapshot: WorkerStatusSnapshot): string {
	const active = [...snapshot.workers.running, ...snapshot.workers.waiting].filter((worker) => worker.writer);
	const finished = snapshot.workers.terminal.filter((worker) => worker.writer);
	const queued = snapshot.writerQueue.filter((worker) => worker.writer);
	const writerSection = (label: string, writers: WorkerSummary[]): string[] => [
		label,
		...(writers.length === 0 ? ["  (none)"] : writers.map((writer) => `  ${formatWriter(writer)}`)),
	];

	return [
		"Neta writers",
		...writerSection("Finished:", finished),
		...writerSection("Active:", active),
		...writerSection("Queued:", queued),
	].join("\n");
}

/** Render a full status snapshot for either Neta control-plane door. */
export function formatStatusSnapshot(snapshot: WorkerStatusSnapshot): string {
	return [
		"Neta status",
		...section("Writer slot:", snapshot.writerSlot ? [snapshot.writerSlot] : []),
		...section("Writer queue:", snapshot.writerQueue),
		...section("Running:", snapshot.workers.running),
		...section("Queued:", snapshot.workers.queued),
		...section("Waiting (legacy active state):", snapshot.workers.waiting),
		...section("Terminal:", snapshot.workers.terminal),
		...formatGoal(snapshot.goal),
		"Open notes:",
		...formatNotes(snapshot.openNotes),
	].join("\n");
}
