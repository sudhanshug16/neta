/**
 * The leader's tools.
 *
 * Everything the leader can do to a worker goes through here: spawn, look,
 * wait, talk, answer, kill. Anything cleverer belongs in a flavor, where the
 * user can read and change it.
 *
 * `neta_wait` is the one that matters for how a leader behaves. It blocks until
 * the workers it names finish, which is how an idle leader wakes up with real
 * results instead of polling.
 */

import type { WorkerManager } from "../orchestrator/manager.ts";
import { roleNames } from "../prompts/roles.ts";
import { formatUsage, isTier, TIERS, type WorkerLogEntry, type WorkerSummary } from "../types.ts";
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

function clip(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n… ${text.length - limit} more characters`;
}

function describe(summary: WorkerSummary): string {
	const named = summary.name === summary.role ? summary.id : `${summary.id} "${summary.name}"`;
	const parts = [`${named} ${summary.role}/${summary.tier}`, `backend=${summary.backend}`, summary.state];
	if (summary.writer) parts.push("writer");
	if (summary.room) parts.push(`room=${summary.room}`);
	if (summary.model) parts.push(`model=${summary.model}`);
	if (summary.mode) parts.push(`mode=${summary.mode}`);
	const usage = formatUsage(summary.usage);
	if (usage) parts.push(usage);
	if (summary.pendingQuestion) parts.push(`asking: ${summary.pendingQuestion}`);
	return parts.join(" | ");
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
			if (summary.result) lines.push(`  result: ${clip(summary.result, maxResultChars)}`);
			return lines.join("\n");
		})
		.join("\n\n");
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
		},
		required: ["role", "tier", "task"],
	};

	return [
		{
			name: "neta_spawn",
			description:
				"Spawn a worker agent to do a piece of work. Give it everything it needs in the task: it cannot see this " +
				`conversation. Roles: ${roles}. Tiers: junior (exact spec), senior (scoped work), staff (ambiguity). ` +
				"Returns immediately; use neta_wait to collect the result.",
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
						description: "Grant the writer slot (edit/write access). Only one writer at a time.",
					},
					backend: { type: "string", description: "Override the backend. Normally leave this alone." },
					room: { type: "string", description: "Join a room and share its transcript with the other members." },
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
				});
				return text(`Spawned ${describe(summary)}\nScratch: ${summary.scratchDir}`);
			},
		},
		{
			name: "neta_plan",
			description:
				"Compute backend assignments for proposed workers without spawning them. Returns a numbered staffing " +
				"plan showing which backend each worker would run on, given current tier mappings and the spread/diversity " +
				"policy. Use this to present the plan to the user before spawning.",
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
				"to know what is happening; it does not interrupt the workers. For a worker's running commentary, use " +
				"neta_log. When called with a specific workerId, the full result is returned unclipped; when listing all " +
				"workers, results are clipped to 3000 characters.",
			inputSchema: {
				type: "object",
				properties: { workerId: { type: "string", description: "Only this worker. Omit for all." } },
			},
			async run(args) {
				const workerId = optionalString(args, "workerId");
				const summaries = workerId ? [manager.get(workerId)] : manager.list();
				if (summaries.length === 0) return text("No workers have been spawned.");
				const maxChars = workerId ? 20000 : MAX_RESULT_CHARS;
				return text(statusReport(summaries, maxChars));
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
					workerId: { type: "string" },
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
				"Block until the named workers finish, then return their results. This is how you collect work: end your " +
				"turn with it rather than polling. Returns early with current state if the timeout expires. Results are " +
				"clipped to 3000 characters; use neta_workers with a specific workerId to retrieve the full result.",
			inputSchema: {
				type: "object",
				properties: {
					workerIds: { type: "array", items: { type: "string" }, description: "Omit to wait for all running." },
					timeoutSeconds: {
						type: "number",
						description: `Default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}.`,
					},
				},
			},
			async run(args) {
				const ids =
					optionalStringArray(args, "workerIds") ??
					manager
						.list()
						.filter((summary) => !["done", "failed", "killed"].includes(summary.state))
						.map((summary) => summary.id);
				if (ids.length === 0) return text("Nothing to wait for.");
				const seconds = Math.min(optionalNumber(args, "timeoutSeconds") ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
				const summaries = await manager.waitFor(ids, seconds * 1000);
				const stillRunning = summaries.filter((summary) => !["done", "failed", "killed"].includes(summary.state));
				const note = stillRunning.length
					? `\n\nStill running after ${seconds}s: ${stillRunning.map((s) => s.id).join(", ")}. ` +
						"Call neta_wait again to keep waiting; they are not lost."
					: "";
				return text(statusReport(summaries) + note);
			},
		},
		{
			name: "neta_send",
			description: "Send a follow-up instruction to a worker that has finished its current turn.",
			inputSchema: {
				type: "object",
				properties: { workerId: { type: "string" }, message: { type: "string" } },
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
					workerId: { type: "string" },
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
				properties: { workerId: { type: "string" } },
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
				await persistTierOverride(manager["options"].cwd, tierValue, override);

				const modelText = modelValue ? ` (model: ${modelValue})` : "";
				return text(`Persisted: ${tierValue} -> ${backendValue}${modelText}\nWritten to .neta/settings.json`);
			},
		},
	];
}
