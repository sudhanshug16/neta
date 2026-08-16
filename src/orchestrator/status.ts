/**
 * The one status rendering shared by the socket CLI and the leader's MCP tool.
 * Keep this presentation separate from WorkerManager so both doors show the
 * same point-in-time view without duplicating state or formatting rules.
 */

import { displayModel, formatUsage, type Note, type WorkerStatusSnapshot, type WorkerSummary } from "../types.ts";

const OBJECTIVE_LIMIT = 100;
const LAST_NOTIFY_LIMIT = 80;

/** The most recent `neta notify` as a "last:" line, or undefined before any notify. */
export function formatLastNotify(summary: WorkerSummary): string | undefined {
	if (!summary.lastNotify) return undefined;
	const flat = summary.lastNotify.text.replace(/\s+/g, " ").trim();
	if (flat === "") return undefined;
	const clipped = flat.length <= LAST_NOTIFY_LIMIT ? flat : `${flat.slice(0, LAST_NOTIFY_LIMIT - 3).trimEnd()}...`;
	return `last: ${clipped}`;
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
	return parts.join(" | ");
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

function section(label: string, workers: WorkerSummary[]): string[] {
	return [
		label,
		...(workers.length === 0
			? ["  (none)"]
			: workers.flatMap((worker) => {
					const lastNotify = formatLastNotify(worker);
					const line = `  ${formatWorkerSummary(worker)}`;
					return lastNotify ? [line, `    ${lastNotify}`] : [line];
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
		...section("Waiting (blocked on leader answer):", snapshot.workers.waiting),
		...section("Terminal:", snapshot.workers.terminal),
		"Open notes:",
		...formatNotes(snapshot.openNotes),
	].join("\n");
}
