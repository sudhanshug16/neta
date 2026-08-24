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
const SUMMARY_FIELD_LIMIT = 240;
const NOTE_PREVIEW_LIMIT = 5;
const DETAIL_ROW_LIMIT = 5;
/** Total rendered size of `neta inspect`, including metadata and footer. */
export const INSPECT_RENDER_MAX_CHARS = 6000;

function clipDisplay(value: string, limit = SUMMARY_FIELD_LIMIT): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 3).trimEnd()}...`;
}

function omittedLine(omitted: number, noun: string): string | undefined {
	return omitted > 0 ? `  ... ${omitted} ${noun} omitted` : undefined;
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const remainder = seconds % 60;
	const parts = [
		days > 0 ? `${days}d` : undefined,
		hours > 0 ? `${hours}h` : undefined,
		minutes > 0 ? `${minutes}m` : undefined,
		remainder > 0 || seconds === 0 ? `${remainder}s` : undefined,
	].filter((part): part is string => part !== undefined);
	return parts.join(" ");
}

/** Shared compact timing suffix for every leader-facing worker row. */
export function formatWorkerDuration(summary: WorkerSummary, now = Date.now()): string {
	const active =
		(summary.activeMs ?? 0) +
		(summary.activeStartedAt === undefined ? 0 : Math.max(0, now - summary.activeStartedAt));
	const queued =
		(summary.queuedMs ?? 0) +
		(summary.queuedStartedAt === undefined ? 0 : Math.max(0, now - summary.queuedStartedAt));
	return `active ${formatDuration(active)}${queued > 0 ? ` | queued ${formatDuration(queued)}` : ""}`;
}

/** The most recent `neta progress` as a "last:" line, or undefined before any progress. */
export function formatLastProgress(summary: WorkerSummary): string | undefined {
	if (!summary.lastProgress) return undefined;
	const flat = summary.lastProgress.text.replace(/\s+/g, " ").trim();
	if (flat === "") return undefined;
	const clipped = flat.length <= LAST_PROGRESS_LIMIT ? flat : `${flat.slice(0, LAST_PROGRESS_LIMIT - 3).trimEnd()}...`;
	return `last: ${clipped}`;
}

/** How to expand this worker's recent input and output where you are standing. */
export function inspectHint(workerId: string): string {
	return `expand: ${APP_NAME} inspect ${workerId}`;
}

export interface HandoffClassification {
	status: "complete" | "missing" | "clipped" | "diagnostic";
	text: string;
}

/** Classify the one authoritative terminal result used by MCP, socket, status and inspect. */
export function classifyHandoff(
	summary: Pick<WorkerSummary, "state" | "result" | "resultClipped" | "resultMissing" | "laterFailure">,
	resultLimit = 3000,
): HandoffClassification | undefined {
	if (!["blocked", "done", "failed", "killed", "interrupted"].includes(summary.state)) return undefined;
	const available = !summary.resultMissing && summary.result !== undefined && summary.result.trim() !== "";
	const clipped = available && (summary.resultClipped === true || (summary.result?.length ?? 0) > resultLimit);
	if (summary.state === "done") {
		if (!available) return { status: "missing", text: "handoff: missing; inspect required" };
		if (clipped) return { status: "clipped", text: "handoff: clipped; inspect required" };
		if (summary.laterFailure)
			return { status: "diagnostic", text: "handoff: inspect required; later failure detected" };
		return {
			status: "complete",
			text: "handoff: complete",
		};
	}
	return { status: "diagnostic", text: "handoff: inspect required" };
}

/**
 * The next action a status row should suggest. A live worker can be expanded
 * for context; a problematic terminal needs inspection for diagnosis. Clean
 * terminal outcomes already have their handoff and should stay quiet.
 */
export function statusHint(
	summary: Pick<WorkerSummary, "id" | "state" | "resultClipped" | "resultMissing" | "laterFailure">,
): string | undefined {
	if (
		summary.state === "starting" ||
		summary.state === "running" ||
		summary.state === "waiting" ||
		summary.state === "queued"
	) {
		return inspectHint(summary.id);
	}
	if (
		summary.state === "blocked" ||
		summary.state === "failed" ||
		summary.state === "interrupted" ||
		summary.state === "killed" ||
		summary.resultClipped ||
		summary.resultMissing ||
		summary.laterFailure
	) {
		return `inspect: ${APP_NAME} inspect ${summary.id}`;
	}
	return undefined;
}

/**
 * Render a bounded inspection: what was sent to the worker and what it said
 * back, with the cap stated out loud wherever it bit.
 *
 * The markers are deliberate and unmissable. A truncated dump that looks
 * complete is worse than no dump: a reader concludes the worker did nothing
 * between the lines that are missing.
 */
export function formatInspection(inspection: WorkerInspection, now = Date.now()): string[] {
	const { worker } = inspection;
	const lines = [`${formatWorkerSummary(worker, now)}`];
	if (inspection.headlessReason) {
		lines.push(`Worker view: headless — ${inspection.headlessReason}; inspection still works without a tab.`);
	}
	lines.push(`task: ${worker.task.replace(/\s+/g, " ").trim()}`);
	const handoff = classifyHandoff(worker);
	if (handoff) lines.push(handoff.text);
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

export function formatWorkerSummary(summary: WorkerSummary, now = Date.now()): string {
	const name = clipDisplay(summary.name);
	const role = clipDisplay(summary.role);
	const named = name === role ? summary.id : `${summary.id} "${name}"`;
	const parts = [`${named} ${role}/${summary.tier}`, `backend=${clipDisplay(summary.backend)}`, summary.state];
	if (summary.writer) parts.push("writer");
	if (summary.room) parts.push(`room=${clipDisplay(summary.room)}`);
	const model = displayModel(summary);
	if (model) parts.push(summary.model ? `model=${clipDisplay(summary.model)}` : model);
	if (summary.mode) parts.push(`mode=${clipDisplay(summary.mode)}`);
	const usage = formatUsage(summary.usage, summary.modelId ?? summary.model);
	if (usage) parts.push(clipDisplay(usage));
	if (summary.pendingQuestion) parts.push(`asking: ${clipDisplay(summary.pendingQuestion)}`);
	if (summary.promptBlockedReason) parts.push(`steering blocked: ${clipDisplay(summary.promptBlockedReason)}`);
	parts.push(formatWorkerDuration(summary, now));
	return [
		parts.join(" | "),
		...(summary.laterFailure ? [`After its report: ${clipDisplay(summary.laterFailure)}`] : []),
		...(summary.headlessReason ? [`Worker view: headless — ${clipDisplay(summary.headlessReason)}`] : []),
		...(summary.viewStatus === "verification-pending"
			? [
					`Worker view: view verification pending${summary.viewReason ? ` — ${clipDisplay(summary.viewReason)}` : ""}`,
				]
			: []),
		...(summary.viewStatus === "verification-unavailable"
			? [
					`Worker view: view launched; verification unavailable${summary.viewReason ? ` — ${clipDisplay(summary.viewReason)}` : ""}`,
				]
			: []),
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

function formatNoteWorkers(note: Note): string {
	if (note.workers.length === 0) return "unworked";
	return clipDisplay(
		note.workers.map((worker) => `${worker.workerId} ${worker.state}`).join(", "),
		SUMMARY_FIELD_LIMIT,
	);
}

export function formatNotePreview(note: Note): string {
	return `${note.id} "${clipDisplay(note.text, 120)}" (${formatNoteWorkers(note)}) [linked workers: ${note.workers.length}]`;
}

function newestNotes(notes: Note[]): Note[] {
	return notes
		.map((note, index) => ({ note, index }))
		.sort((left, right) => right.note.createdAt - left.note.createdAt || right.index - left.index)
		.map(({ note }) => note);
}

export function formatOpenNotesLines(notes: Note[], heading = "Open notes:"): string[] {
	const newest = newestNotes(notes);
	const lines = [heading];
	if (newest.length === 0) lines.push("  (none)");
	else lines.push(...newest.slice(0, NOTE_PREVIEW_LIMIT).map((note) => `  ${formatNotePreview(note)}`));
	lines.push(`  total: ${notes.length}`);
	const omitted = notes.length - NOTE_PREVIEW_LIMIT;
	const omittedLineText = omittedLine(omitted, "note previews");
	if (omittedLineText) lines.push(omittedLineText);
	return lines;
}

/** All unresolved notes belong in the default summary; fields remain bounded per row. */
function formatAllOpenNotesLines(notes: Note[], heading = "Open notes:"): string[] {
	const newest = newestNotes(notes);
	return [
		heading,
		...(newest.length === 0 ? ["  (none)"] : newest.map((note) => `  ${formatNotePreview(note)}`)),
		`  total: ${notes.length}`,
	];
}

function formatGoal(goal: SessionGoal | undefined): string[] {
	if (!goal) return [];
	const pending = goal.discoveries.filter(
		(discovery) => discovery.impact === "goal" && discovery.status === "pending",
	);
	return [
		"Goal:",
		`  status=${goal.status} | revision=${goal.revision} | discovery policy=${goal.discoveryPolicy}`,
		`  original intent: ${clipDisplay(goal.originalIntent)}`,
		`  working objective: ${clipDisplay(goal.workingObjective)}`,
		`  pending goal discoveries: ${
			pending.length
				? pending
						.slice(0, DETAIL_ROW_LIMIT)
						.map((discovery) => discovery.id)
						.join(", ")
				: "none"
		}${pending.length > DETAIL_ROW_LIMIT ? ` ... ${pending.length - DETAIL_ROW_LIMIT} omitted` : ""}`,
	];
}

/** One status section, with an action hint only where it is useful. */

function section(label: string, workers: WorkerSummary[], now: number): string[] {
	return [
		label,
		...(workers.length === 0
			? ["  (none)"]
			: workers.flatMap((worker) => {
					const lastProgress = formatLastProgress(worker);
					const line = `  ${formatWorkerSummary(worker, now)}`;
					const hint = statusHint(worker);
					return [...(lastProgress ? [line, `    ${lastProgress}`] : [line]), ...(hint ? [`    ${hint}`] : [])];
				})),
		`  total: ${workers.length}`,
	];
}

function terminalSection(workers: WorkerSummary[], now: number): string[] {
	const states = ["blocked", "failed", "interrupted", "done", "killed"] as const;
	const counts = states.map((state) => `${state}=${workers.filter((worker) => worker.state === state).length}`);
	const diagnostic = workers.filter(
		(worker) => worker.state !== "done" || worker.resultClipped || worker.resultMissing || worker.laterFailure,
	);
	return [
		"Terminal:",
		`  counts: ${counts.join(" | ")}`,
		...(diagnostic.length === 0
			? ["  (no diagnostic rows; ordinary clean done rows omitted)"]
			: diagnostic.slice(0, DETAIL_ROW_LIMIT).flatMap((worker) => {
					const line = `  ${formatWorkerSummary(worker, now)}`;
					const handoff = classifyHandoff(worker);
					const hint = statusHint(worker);
					return [line, ...(handoff ? [`    ${handoff.text}`] : []), ...(hint ? [`    ${hint}`] : [])];
				})),
		...(diagnostic.length > DETAIL_ROW_LIMIT
			? [`  ... ${diagnostic.length - DETAIL_ROW_LIMIT} diagnostic rows omitted`]
			: []),
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

function formatWriter(summary: WorkerSummary, now = Date.now()): string {
	const name = clipDisplay(summary.name);
	const displayName = name === clipDisplay(summary.role) ? name : `"${name}"`;
	const handoff = classifyHandoff(summary);
	return `${summary.id} ${displayName} | ${formatWriterObjective(summary)} | ${formatWorkerDuration(summary, now)}${handoff ? ` | ${handoff.text}` : ""}`;
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
export function formatWriterStatus(snapshot: WorkerStatusSnapshot, now = Date.now()): string {
	const active = [...snapshot.workers.running, ...snapshot.workers.waiting].filter((worker) => worker.writer);
	const finished = snapshot.workers.terminal.filter((worker) => worker.writer);
	const queued = snapshot.writerQueue.filter((worker) => worker.writer);
	const diagnostic = finished.filter(
		(worker) =>
			worker.state === "blocked" ||
			worker.state === "failed" ||
			worker.state === "interrupted" ||
			worker.state === "killed" ||
			worker.resultClipped ||
			worker.resultMissing ||
			worker.laterFailure,
	);
	const recent = [...finished].reverse();
	const previews = [...diagnostic, ...recent.filter((worker) => !diagnostic.includes(worker))].slice(
		0,
		DETAIL_ROW_LIMIT,
	);
	const writerSection = (label: string, writers: WorkerSummary[]): string[] => [
		label,
		...(writers.length === 0 ? ["  (none)"] : writers.map((writer) => `  ${formatWriter(writer, now)}`)),
	];
	const counts = ["blocked", "failed", "interrupted", "done", "killed"].map(
		(state) => `${state}=${finished.filter((writer) => writer.state === state).length}`,
	);

	return [
		"Neta writers",
		...writerSection("Finished:", previews),
		`  total: ${finished.length} (${counts.join(" | ")})`,
		...(finished.length > previews.length
			? [`  ... ${finished.length - previews.length} finished writer previews omitted`]
			: []),
		...writerSection("Active:", active),
		...writerSection("Queued:", queued),
	].join("\n");
}

/** Render a full status snapshot for either Neta control-plane door. */
export function formatStatusSnapshot(snapshot: WorkerStatusSnapshot, now = Date.now()): string {
	return [
		"Neta status",
		...section("Writer slot:", snapshot.writerSlot ? [snapshot.writerSlot] : [], now),
		...section("Writer queue:", snapshot.writerQueue, now),
		...section("Running:", snapshot.workers.running, now),
		...section("Queued:", snapshot.workers.queued, now),
		...section("Waiting (legacy active state):", snapshot.workers.waiting, now),
		...terminalSection(snapshot.workers.terminal, now),
		...formatGoal(snapshot.goal),
		...formatAllOpenNotesLines(snapshot.openNotes),
	].join("\n");
}
