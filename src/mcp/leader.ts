/**
 * The leader's tools.
 *
 * Everything the leader can do to a worker goes through here: spawn, look,
 * wait, talk, answer, kill. Anything cleverer belongs in a flavor, where the
 * user can read and change it.
 *
 * `neta_wait` is the one that matters for how a leader behaves. It blocks until
 * something needs the leader — workers finishing (all, or the first with
 * `first`), a worker blocking on a question, opted-in room activity — which is
 * how an idle leader wakes up with real results instead of polling.
 */

import type { WorkerManager } from "../orchestrator/manager.ts";
import { formatLastProgress, formatWorkerSummary } from "../orchestrator/status.ts";
import { roleNames } from "../prompts/roles.ts";
import {
	isTerminalState,
	isTier,
	type Note,
	TIERS,
	type WaitResult,
	type WorkerLogEntry,
	type WorkerSummary,
} from "../types.ts";
import {
	type McpTool,
	optionalBoolean,
	optionalNumber,
	optionalString,
	optionalStringArray,
	requireString,
	text,
} from "./serve.ts";

const DEFAULT_WAIT_SECONDS = 240;
/** Vendor hosts time long tool calls out; staying under that is better than being killed mid-wait. */
const MAX_WAIT_SECONDS = 900;

/**
 * Tool results land in the leader's context, and five chatty workers can bury
 * it: one observed `neta_workers` call returned 120,000 characters and the
 * leader had to go read a file to find out what its own workers were doing.
 * Status views stay small; logs are read deliberately, through `neta_log`.
 */
const MAX_RESULT_CHARS = 3000;
const MAX_LOG_ENTRIES = 60;
const MAX_LOG_CHARS = 8000;
/** A room wake carries a pointer plus a short tail, not the whole transcript. */
const ROOM_WAKE_TAIL = 5;

function clip(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n… ${text.length - limit} more characters`;
}

function describe(summary: WorkerSummary): string {
	return formatWorkerSummary(summary);
}

function formatLog(entries: WorkerLogEntry[], full: boolean): string {
	if (entries.length === 0) return "(no new output)";
	const filtered = full ? entries : entries.filter((entry) => !["tool", "diff", "thought"].includes(entry.kind));
	const shown = filtered.slice(-MAX_LOG_ENTRIES);
	const dropped = filtered.length - shown.length;
	const body = clip(shown.map((entry) => `[${entry.kind}] ${entry.text}`).join("\n"), MAX_LOG_CHARS);
	return dropped > 0 ? `… ${dropped} earlier lines not shown\n${body}` : body;
}

/**
 * What a worker is and what it has said so far — deliberately without its log.
 * A worker's final message is the handoff, so that is worth carrying; its
 * running commentary is not, and `neta_log` exists for when it is.
 */
function statusReport(summaries: WorkerSummary[], maxResultChars = MAX_RESULT_CHARS): string {
	return summaries
		.map((summary) => {
			const lines = [describe(summary)];
			const lastProgress = formatLastProgress(summary);
			if (lastProgress) lines.push(`  ${lastProgress}`);
			if (summary.result) lines.push(`  result: ${clip(summary.result, maxResultChars)}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

/** One line per worker, for the workers a wait is not reporting in full. */
function oneLiners(summaries: WorkerSummary[]): string {
	return summaries.map((summary) => describe(summary)).join("\n");
}

/** Render a wait's outcome by what woke it. */
function formatWaitResult(result: WaitResult, seconds: number): string {
	const stillRunning = result.workers.filter((summary) => !isTerminalState(summary.state));
	switch (result.reason) {
		case "completed":
			return statusReport(result.workers);
		case "first": {
			const finished = result.workers.filter((summary) => isTerminalState(summary.state));
			const rest = stillRunning.length
				? `\n\nStill running (call neta_wait again to collect them):\n${oneLiners(stillRunning)}`
				: "";
			return statusReport(finished) + rest;
		}
		case "ask": {
			const asking = result.wokeBy;
			if (!asking) return statusReport(result.workers);
			const others = result.workers.filter((summary) => summary.id !== asking.id);
			const rest = others.length ? `\n\nOthers:\n${oneLiners(others)}` : "";
			return (
				`${asking.id} is blocked on a question; answer it with neta_answer, then wait again.\n` +
				statusReport([asking]) +
				rest
			);
		}
		case "room": {
			const activity = result.roomActivity;
			if (!activity) return statusReport(result.workers);
			const shown = activity.posts.slice(-ROOM_WAKE_TAIL);
			const dropped = activity.posts.length - shown.length;
			const tail = shown.map((post) => `[${post.label}] ${post.text}`).join("\n");
			return (
				`New activity in room "${activity.room}"; read the full transcript with neta_room.\n` +
				(dropped > 0 ? `… ${dropped} earlier new posts not shown\n` : "") +
				clip(tail, MAX_LOG_CHARS) +
				`\n\nWatched workers:\n${oneLiners(result.workers)}`
			);
		}
		case "timeout": {
			const note = stillRunning.length
				? `\n\nStill running after ${seconds}s: ${stillRunning.map((summary) => summary.id).join(", ")}. ` +
					"Call neta_wait again to keep waiting; they are not lost."
				: "";
			return statusReport(result.workers) + note;
		}
	}
}

/** "(unworked)", or the linked workers with their progress: "(rw7 in progress, rw8 queued)". */
function noteWorkersLabel(note: Note): string {
	if (note.workers.length === 0) return " (unworked)";
	return ` (${note.workers.map((w) => `${w.workerId} ${w.state === "running" ? "in progress" : w.state}`).join(", ")})`;
}

function formatOpenNotes(manager: WorkerManager): string {
	const openNotes = manager.getOpenNotes();
	if (openNotes.length === 0) return "";
	const lines = openNotes.map((note) => {
		const textClipped = note.text.length > 80 ? `${note.text.slice(0, 77)}...` : note.text;
		return `${note.id} "${textClipped}"${noteWorkersLabel(note)}`;
	});
	return `\n\nOpen notes: ${lines.join(" | ")}`;
}

function tier(args: Record<string, unknown>, name = "tier") {
	const value = requireString(args, name);
	if (!isTier(value)) throw new Error(`Unknown tier "${value}". Tiers: ${TIERS.join(", ")}.`);
	return value;
}

export function leaderTools(manager: WorkerManager): McpTool[] {
	const roles = roleNames().join(", ");

	const memberSchema = {
		type: "object",
		properties: {
			role: { type: "string", description: `Role prompt to run. Built-in: ${roles}.` },
			tier: { type: "string", enum: [...TIERS], description: "junior, senior or staff." },
			task: { type: "string", description: "Self-contained instructions for this member." },
			name: { type: "string", description: "Two or three words naming this member's job, for its tab." },
			writer: { type: "boolean", description: "Grant this member the writer slot." },
			note: { type: "string", description: "Link this member to a note (note id, e.g. n1)." },
		},
		required: ["role", "tier", "task"],
	};

	return [
		{
			name: "neta_spawn",
			description:
				"Spawn a worker agent to do a piece of work. Give it everything it needs in the task: it cannot see this " +
				`conversation. Roles: ${roles}. Tiers: junior (exact spec), senior (scoped work), staff (ambiguity). ` +
				"Returns immediately; use neta_wait to collect the result. If a writer is already active, the new writer " +
				"is queued and starts automatically when the slot frees.",
			inputSchema: {
				type: "object",
				properties: {
					role: { type: "string", description: `Role prompt to run. Built-in: ${roles}.` },
					tier: { type: "string", enum: [...TIERS], description: "How much judgement the task needs." },
					task: {
						type: "string",
						description: "Self-contained instructions: files, acceptance criteria, what done means.",
					},
					name: {
						type: "string",
						description:
							"Two or three words naming this worker's job, e.g. 'auth flow' or 'rails cable'. It labels the " +
							"worker's tab, so five scouts are told apart at a glance. Defaults to the role.",
					},
					writer: {
						type: "boolean",
						description: "Grant the writer slot (edit/write access). Queued if a writer is already active.",
					},
					backend: {
						type: "string",
						description:
							"Explicit backend for this worker. Use it to apply the user's staffing-plan tweaks; otherwise omit " +
							"and the assignment policy decides.",
					},
					room: { type: "string", description: "Join a room and share its transcript with the other members." },
					note: { type: "string", description: "Link this worker to a note (note id, e.g. n1)." },
				},
				required: ["role", "tier", "task"],
			},
			async run(args) {
				const summary = await manager.spawn({
					role: requireString(args, "role"),
					tier: tier(args),
					task: requireString(args, "task"),
					name: optionalString(args, "name"),
					writer: optionalBoolean(args, "writer"),
					backend: optionalString(args, "backend"),
					room: optionalString(args, "room"),
					note: optionalString(args, "note"),
				});
				const headline =
					summary.state === "queued"
						? `Queued behind ${summary.queuedBehind}; starts automatically when the writer slot frees.`
						: "Spawned";
				return text(`${headline}\n${describe(summary)}\nScratch: ${summary.scratchDir}`);
			},
		},
		{
			name: "neta_plan",
			description:
				"Compute backend assignments for proposed workers without spawning them. Returns a numbered staffing " +
				"plan showing which backend each worker would run on, given current tier mappings and the spread/diversity " +
				"policy. Debaters in the same room are automatically spread across different vendors. Use this to present " +
				"the plan to the user before spawning.",
			inputSchema: {
				type: "object",
				properties: {
					workers: {
						type: "array",
						items: {
							type: "object",
							properties: {
								role: { type: "string", description: `Role prompt to run. Built-in: ${roles}.` },
								tier: { type: "string", enum: [...TIERS], description: "How much judgement the task needs." },
								writer: { type: "boolean", description: "Whether this worker needs the writer slot." },
								backend: { type: "string", description: "Override the backend for this worker." },
								room: { type: "string", description: "Room name for workers that will share a room." },
							},
							required: ["role", "tier"],
						},
						description: "Proposed workers to plan assignments for.",
					},
				},
				required: ["workers"],
			},
			async run(args) {
				const workers = args.workers;
				if (!Array.isArray(workers) || workers.length === 0) {
					throw new Error('"workers" must be a non-empty list.');
				}

				const requests = workers.map((w: Record<string, unknown>) => ({
					role: requireString(w, "role"),
					tier: tier(w),
					writer: optionalBoolean(w, "writer"),
					backend: optionalString(w, "backend"),
					room: optionalString(w, "room"),
				}));

				const assignments = manager.planAssignments(requests);
				const lines = assignments.map((assignment, index) => {
					const access = assignment.writer ? "writer" : "read-only";
					return `${index + 1}. ${assignment.role}/${assignment.tier} -> ${assignment.backend} (${access})`;
				});

				return text(lines.join("\n"));
			},
		},
		{
			name: "neta_spawn_group",
			description:
				"Spawn several workers into one room. Members read and post to a shared transcript, so they can argue " +
				"with each other without routing every message through you. Use it for debates and for scouts that must " +
				"not duplicate work.",
			inputSchema: {
				type: "object",
				properties: {
					room: { type: "string", description: "Room name, e.g. 'auth-debate'." },
					members: { type: "array", items: memberSchema, description: "Workers to spawn into the room." },
					seed: { type: "string", description: "Opening message posted before the members start." },
				},
				required: ["room", "members"],
			},
			async run(args) {
				const room = requireString(args, "room");
				const members = args.members;
				if (!Array.isArray(members) || members.length === 0) throw new Error('"members" must be a non-empty list.');
				const seed = optionalString(args, "seed");
				if (seed) manager.postToRoom(room, "leader", "leader", seed);

				const spawned: WorkerSummary[] = [];
				const failures: string[] = [];
				for (const raw of members as Record<string, unknown>[]) {
					try {
						spawned.push(
							await manager.spawn({
								role: requireString(raw, "role"),
								tier: tier(raw),
								task: requireString(raw, "task"),
								name: optionalString(raw, "name"),
								writer: optionalBoolean(raw, "writer"),
								room,
								note: optionalString(raw, "note"),
							}),
						);
					} catch (error) {
						failures.push(`${raw.role}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				const lines = spawned.map(describe);
				if (failures.length > 0) lines.push(`Failed to spawn: ${failures.join("; ")}`);
				return text(`Room "${room}"\n${lines.join("\n")}`, spawned.length === 0);
			},
		},
		{
			name: "neta_workers",
			description:
				"List workers with their state, token usage and final results. Cheap and safe to call whenever you want " +
				"to know what is happening; it does not interrupt the workers. Each worker's most recent progress milestone shows " +
				"as a last: line. For a worker's running commentary, use neta_log. When called with a specific workerId, " +
				"the full result is returned unclipped; when listing all workers, results are clipped to 3000 " +
				"characters. Shows open notes at the end.",
			inputSchema: {
				type: "object",
				properties: {
					workerId: { type: "string", description: "Only this worker (for example, rw1 or ro2). Omit for all." },
				},
			},
			async run(args) {
				const workerId = optionalString(args, "workerId");
				const summaries = workerId ? [manager.get(workerId)] : manager.list();
				if (summaries.length === 0) return text("No workers have been spawned.");
				const maxChars = workerId ? 20000 : MAX_RESULT_CHARS;
				// Bridge identity only in the single-worker view; list lines stay compact.
				const bridge = workerId && summaries[0].agentInfo ? `\nBridge: ${summaries[0].agentInfo}` : "";
				return text(statusReport(summaries, maxChars) + bridge + formatOpenNotes(manager));
			},
		},
		{
			name: "neta_status",
			description:
				"Show one consolidated snapshot: the current writer slot, the writer queue in start order, workers grouped " +
				"by state, and open notes with linked-worker progress. Safe to call whenever you need the complete current " +
				"picture; it does not interrupt workers.",
			inputSchema: { type: "object" },
			async run() {
				return text(manager.status());
			},
		},
		{
			name: "neta_log",
			description:
				"Read a worker's new log lines since you last looked. Each line is shown once. By default, omits " +
				"low-level details (tool calls, diffs, thoughts) to reduce context waste; use full=true to see everything.",
			inputSchema: {
				type: "object",
				properties: {
					workerId: { type: "string", description: "Worker id, such as rw1 or ro2." },
					full: { type: "boolean", description: "Include all entries (tool, diff, thought). Default false." },
				},
				required: ["workerId"],
			},
			async run(args) {
				const entries = manager.drainLog(requireString(args, "workerId"));
				const full = optionalBoolean(args, "full") ?? false;
				return text(entries.length === 0 ? "(no new log entries)" : formatLog(entries, full));
			},
		},
		{
			name: "neta_wait",
			description:
				"Block until the named workers need you, then return what woke you. This is how you collect work: end " +
				"your turn with it rather than polling. Wakes on: every named worker finishing (the default); the first " +
				"one finishing, with first=true, to act on results as they land; any watched worker blocking on a " +
				"question (always on — answer it with neta_answer and wait again); a new post in a room, with " +
				"roomEvents, to referee a debate live. Returns early with current state if the timeout expires. Results " +
				"are clipped to 3000 characters; use neta_workers with a specific workerId to retrieve the full result. " +
				"Shows open notes at the end.",
			inputSchema: {
				type: "object",
				properties: {
					workerIds: {
						type: "array",
						items: { type: "string" },
						description: "Worker ids such as rw1 or ro2. Omit to wait for all running.",
					},
					timeoutSeconds: {
						type: "number",
						description: `Default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}.`,
					},
					first: {
						type: "boolean",
						description:
							"Return as soon as any watched worker finishes, with its result and one-line states of the rest. " +
							"Default: wait for all of them.",
					},
					roomEvents: {
						type: ["boolean", "string"],
						description:
							"Also wake when a new post lands in a room: true watches the watched workers' rooms, a room name " +
							"watches that room.",
					},
				},
			},
			async run(args) {
				const ids =
					optionalStringArray(args, "workerIds") ??
					manager
						.list()
						.filter((summary) => !isTerminalState(summary.state))
						.map((summary) => summary.id);
				if (ids.length === 0) return text("Nothing to wait for.");
				const seconds = Math.min(optionalNumber(args, "timeoutSeconds") ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
				const first = optionalBoolean(args, "first") ?? false;
				const roomEvents = args.roomEvents;
				let rooms: string[] | undefined;
				if (typeof roomEvents === "string" && roomEvents.trim() !== "") {
					rooms = [roomEvents];
				} else if (roomEvents === true) {
					rooms = ids.flatMap((id) => {
						const room = manager.get(id).room;
						return room ? [room] : [];
					});
				} else if (roomEvents !== undefined && roomEvents !== null && roomEvents !== false && roomEvents !== "") {
					throw new Error('"roomEvents" must be true or a room name.');
				}
				const result = await manager.wait(ids, seconds * 1000, { first, rooms });
				return text(formatWaitResult(result, seconds) + formatOpenNotes(manager));
			},
		},
		{
			name: "neta_send",
			description:
				"Send a follow-up instruction to a worker: a running worker receives it as its next prompt turn when " +
				"the current turn ends; a queued worker gets it appended to its pending brief, delivered when it " +
				"starts. A finished worker errors; spawn a new worker instead.",
			inputSchema: {
				type: "object",
				properties: {
					workerId: { type: "string", description: "Worker id, such as rw1 or ro2." },
					message: { type: "string" },
				},
				required: ["workerId", "message"],
			},
			async run(args) {
				const summary = manager.send(requireString(args, "workerId"), requireString(args, "message"));
				return text(`Sent to ${describe(summary)}`);
			},
		},
		{
			name: "neta_answer",
			description: "Answer a worker that is blocked on a question, unblocking it.",
			inputSchema: {
				type: "object",
				properties: {
					workerId: { type: "string", description: "Worker id, such as rw1 or ro2." },
					answer: { type: "string", description: "Be specific; the worker acts on it directly." },
				},
				required: ["workerId", "answer"],
			},
			async run(args) {
				const summary = manager.answer(requireString(args, "workerId"), requireString(args, "answer"));
				return text(`Answered ${describe(summary)}`);
			},
		},
		{
			name: "neta_kill",
			description:
				"Terminate a worker. Use it when the task changed or the worker is stuck; it releases the writer slot.",
			inputSchema: {
				type: "object",
				properties: { workerId: { type: "string", description: "Worker id, such as rw1 or ro2." } },
				required: ["workerId"],
			},
			async run(args) {
				return text(`Killed ${describe(await manager.kill(requireString(args, "workerId")))}`);
			},
		},
		{
			name: "neta_room",
			description: "Read a room's transcript, and optionally post to it yourself.",
			inputSchema: {
				type: "object",
				properties: {
					room: { type: "string" },
					post: { type: "string", description: "Message to post before reading." },
					tail: { type: "number", description: "Only the last N posts." },
				},
				required: ["room"],
			},
			async run(args) {
				const room = requireString(args, "room");
				const post = optionalString(args, "post");
				if (post) manager.postToRoom(room, "leader", "leader", post);
				const posts = manager.roomTranscript(room, optionalNumber(args, "tail"));
				if (posts.length === 0) return text(`Room "${room}" is empty.`);
				return text(posts.map((entry) => `[${entry.label}] ${entry.text}`).join("\n"));
			},
		},
		{
			name: "neta_note",
			description:
				"Record parked work, pending decisions, or promised follow-ups in the open-notes ledger. " +
				"Create a note with {text}, close it with {close: noteId}. Call with no args to list all open notes. " +
				"Link workers to notes via the note param on spawn; each linked worker's state is tracked on the " +
				"note from spawn to finish. Notes are session-scoped and in-memory.",
			inputSchema: {
				type: "object",
				properties: {
					text: { type: "string", description: "Create a new open note with this text." },
					close: { type: "string", description: "Close this note id (e.g. n1)." },
				},
			},
			async run(args) {
				const textArg = optionalString(args, "text");
				const closeArg = optionalString(args, "close");

				if (textArg && closeArg) {
					throw new Error("Provide either text (create) or close (close one), not both.");
				}

				if (textArg) {
					const note = manager.createNote(textArg);
					return text(`Created ${note.id}: ${note.text}`);
				}

				if (closeArg) {
					const note = manager.closeNote(closeArg);
					return text(`Closed ${note.id}`);
				}

				// List all open notes
				const openNotes = manager.getOpenNotes();
				if (openNotes.length === 0) return text("No open notes.");
				return text(openNotes.map((note) => `${note.id} "${note.text}"${noteWorkersLabel(note)}`).join("\n"));
			},
		},
		{
			name: "neta_remember",
			description:
				"Persist a tier's backend assignment to the project's .neta/settings.json file. Use this when the user " +
				'says "remember" after a backend override. This writes to the project settings file and does not ' +
				"preserve JSON comments. The setting will apply to future sessions in this project.",
			inputSchema: {
				type: "object",
				properties: {
					tier: { type: "string", enum: [...TIERS], description: "The tier to configure." },
					backend: { type: "string", description: "The backend name to assign to this tier." },
					model: { type: "string", description: "Optional model override for this tier and backend." },
				},
				required: ["tier", "backend"],
			},
			async run(args) {
				const { persistTierOverride } = await import("../settings.ts");
				const tierValue = tier(args);
				const backendValue = requireString(args, "backend");
				const modelValue = optionalString(args, "model");

				const override = modelValue ? { backend: backendValue, model: modelValue } : { backend: backendValue };
				await persistTierOverride(manager.cwd, tierValue, override);

				const modelText = modelValue ? ` (model: ${modelValue})` : "";
				return text(`Persisted: ${tierValue} -> ${backendValue}${modelText}\nWritten to .neta/settings.json`);
			},
		},
	];
}
