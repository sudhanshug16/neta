/**
 * The one status rendering shared by the socket CLI and the leader's MCP tool.
 * Keep this presentation separate from WorkerManager so both doors show the
 * same point-in-time view without duplicating state or formatting rules.
 */

import { displayModel, formatUsage, type Note, type WorkerStatusSnapshot, type WorkerSummary } from "../types.ts";

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
		...(workers.length === 0 ? ["  (none)"] : workers.map((worker) => `  ${formatWorkerSummary(worker)}`)),
	];
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
