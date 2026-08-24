import { createHash } from "node:crypto";
import { MAX_SAFE_TIMEOUT_MS, OUTPUT_LIMIT_BYTES, SPAWN_FAILURE_EXIT_CODE } from "../orchestrator/exec.ts";
import type { WorkerManager } from "../orchestrator/manager.ts";
import {
	classifyHandoff,
	formatInspection,
	formatLastProgress,
	formatNotePreview,
	formatOpenNotesLines,
	formatSteerResult,
	formatWorkerDuration,
	formatWorkerSummary,
} from "../orchestrator/status.ts";
import { roleNames } from "../prompts/roles.ts";
import {
	isTerminalState,
	isTier,
	type Note,
	type SessionGoal,
	TIERS,
	type Tier,
	type WaitResult,
	type WorkerState,
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
const MAX_WAIT_SECONDS = 900;
const MAX_RESULT_CHARS = 3000;
const ROOM_WAKE_TAIL = 5;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const PAGE_ROW_LIMIT = 5;
const WORKER_STATES: readonly WorkerState[] = [
	"starting",
	"running",
	"waiting",
	"queued",
	"blocked",
	"done",
	"failed",
	"killed",
	"interrupted",
];
/** The largest timeoutSeconds that still rounds to a millisecond value Node's timer can hold. */
const MAX_TIMEOUT_SECONDS = MAX_SAFE_TIMEOUT_MS / 1000;

function formatExecResult(result: Awaited<ReturnType<WorkerManager["exec"]>>): string {
	const exitNote =
		result.exitCode === SPAWN_FAILURE_EXIT_CODE ? " (failed to launch)" : result.timedOut ? " (timed out)" : "";
	const header = [
		`Exit code: ${result.exitCode}${exitNote}`,
		`Duration: ${result.durationMs} ms`,
		`Cwd: ${result.cwd}`,
		`Output file: ${result.outputPath}`,
		"Output:",
	].join("\n");
	const output = result.output || "(no output)";
	const sections = [`${header}\n${output}`];
	if (result.truncated) {
		sections.push(
			`The command's own output was too large for you to inspect here: it exceeded the ${OUTPUT_LIMIT_BYTES}-byte cap neta_exec keeps on that excerpt (this header and this note are not counted against it), so only a bounded excerpt is shown above with the cut marked by "…" — not the whole output, and never a silent drop. Do not try to read around this truncation yourself — delegate inspecting the full output to an apprentice or scout. Full output: ${result.outputPath}`,
		);
	}
	if (result.callNumber > 1) {
		sections.push(
			`This is neta_exec call #${result.callNumber} in this session. You should not be doing repeated discovery yourself through neta_exec — delegate discovery work to workers instead.`,
		);
	}
	return sections.join("\n\n");
}

function clip(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}\n… ${value.length - limit} more characters`;
}

function clipLine(value: string, limit: number): string {
	return clip(value.replace(/\s+/g, " ").trim(), limit);
}

function boundedIds(ids: string[], limit = PAGE_ROW_LIMIT): string {
	const shown = ids.slice(0, limit).join(", ");
	const omitted = ids.length - limit;
	return omitted > 0 ? `${shown}, ... ${omitted} worker ids omitted` : shown;
}

function describe(summary: WorkerSummary): string {
	return formatWorkerSummary(summary);
}

function statusReport(summaries: WorkerSummary[], maxResultChars = MAX_RESULT_CHARS, maxRows = PAGE_ROW_LIMIT): string {
	const shown = summaries.slice(0, maxRows);
	const report = shown
		.map((summary) => {
			const lines = [describe(summary)];
			const progress = formatLastProgress(summary);
			if (progress) lines.push(`  ${progress}`);
			if (isTerminalState(summary.state)) {
				const handoff = classifyHandoff(summary, MAX_RESULT_CHARS);
				if (handoff) lines.push(`  ${handoff.text}`);
			}
			if (summary.result)
				lines.push(`  result: ${clip(summary.result, Math.min(maxResultChars, MAX_RESULT_CHARS))}`);
			if (summary.laterFailure) lines.push(`  after its report: ${clip(summary.laterFailure, maxResultChars)}`);
			return lines.join("\n");
		})
		.join("\n\n");
	const omitted = summaries.length - shown.length;
	return omitted > 0
		? `${report}${report ? "\n\n" : ""}... ${omitted} worker rows omitted; use neta_status with view="workers" for more.`
		: report;
}

function formatWaitResult(result: WaitResult, seconds: number): string {
	const active = result.workers.filter((worker) => !isTerminalState(worker.state));
	if (result.reason === "blocked" && result.wokeBy) {
		return `${result.wokeBy.id} blocked and stopped: ${clipLine(result.wokeBy.pendingQuestion ?? "(no question)", MAX_RESULT_CHARS)}\nAnswer with neta_send to resume this exact conversation.\n${statusReport(result.workers)}`;
	}
	if (result.reason === "discovery" && result.wokeBy && result.discovery) {
		return `${result.wokeBy.id} reported goal-impact discovery ${result.discovery.id} and stopped: ${clipLine(result.discovery.finding, MAX_RESULT_CHARS)}${result.discovery.suggestion ? `\nSuggestion: ${clipLine(result.discovery.suggestion, MAX_RESULT_CHARS)}` : ""}\nResolve it with neta_goal, then use neta_send to resume this exact conversation.\n${statusReport(result.workers)}`;
	}
	if (result.reason === "room" && result.roomActivity) {
		const posts = result.roomActivity.posts.slice(-ROOM_WAKE_TAIL);
		return `New team activity in "${clipLine(result.roomActivity.room, 240)}":\n${posts.map((post) => `[${clipLine(post.label, 240)}] ${clipLine(post.text, MAX_RESULT_CHARS)}`).join("\n")}\n\n${statusReport(result.workers)}`;
	}
	if (result.reason === "first") {
		const terminal = result.workers.filter((worker) => isTerminalState(worker.state));
		return `${statusReport(terminal)}${active.length ? `\n\nStill running: ${boundedIds(active.map((worker) => worker.id))}. Call neta_wait again.` : ""}`;
	}
	if (result.reason === "timeout") {
		return `${statusReport(result.workers)}${active.length ? `\n\nStill running after ${seconds}s: ${boundedIds(active.map((worker) => worker.id))}. Call neta_wait again.` : ""}`;
	}
	return statusReport(result.workers);
}

function tier(args: Record<string, unknown>, available: readonly Tier[]): Tier {
	const value = requireString(args, "tier");
	if (!isTier(value)) throw new Error(`Unknown tier "${value}". Tiers: ${TIERS.join(", ")}.`);
	if (!available.includes(value))
		throw new Error(`Tier "${value}" is unavailable. Available: ${available.join(", ")}.`);
	return value;
}

function formatOpenNotes(manager: WorkerManager): string {
	const notes = manager.getOpenNotes();
	if (notes.length === 0) return "";
	return `\n\n${formatOpenNotesLines(notes).join("\n")}\nFor more open notes, call neta_status with view="notes".`;
}

interface PageCursor {
	view: "workers" | "notes";
	state?: WorkerState;
	offset: number;
	fingerprint: string;
}

function fingerprint(ids: string[]): string {
	return createHash("sha256").update(ids.join("\u0000")).digest("hex");
}

function encodeCursor(cursor: PageCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, view: PageCursor["view"], state: WorkerState | undefined): PageCursor {
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PageCursor>;
		if (
			parsed.view !== view ||
			(parsed.state ?? undefined) !== state ||
			!Number.isInteger(parsed.offset) ||
			(parsed.offset as number) < 0 ||
			typeof parsed.fingerprint !== "string"
		) {
			throw new Error("shape");
		}
		return parsed as PageCursor;
	} catch {
		throw new Error(`Invalid ${view} cursor.`);
	}
}

function pageLimit(args: Record<string, unknown>): number {
	const value = optionalNumber(args, "limit");
	if (value === undefined) return DEFAULT_PAGE_LIMIT;
	if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
		throw new Error(`"limit" must be an integer between 1 and ${MAX_PAGE_LIMIT}.`);
	}
	return value;
}

function workerState(args: Record<string, unknown>): WorkerState | undefined {
	const value = optionalString(args, "state");
	if (value === undefined) return undefined;
	if (!(WORKER_STATES as readonly string[]).includes(value)) {
		throw new Error(`"state" must be one of: ${WORKER_STATES.join(", ")}.`);
	}
	return value as WorkerState;
}

function workerPage(
	manager: WorkerManager,
	workerId: string | undefined,
	state: WorkerState | undefined,
	limit: number,
	cursorValue: string | undefined,
): string {
	const all = workerId ? [manager.get(workerId)] : manager.list();
	const filtered = state ? all.filter((worker) => worker.state === state) : all;
	const ids = filtered.map((worker) => worker.id);
	const cursor = cursorValue ? decodeCursor(cursorValue, "workers", state) : undefined;
	if (cursor && cursor.fingerprint !== fingerprint(ids))
		throw new Error("Stale workers cursor; request the first page again.");
	const offset = cursor?.offset ?? 0;
	if (offset > filtered.length) throw new Error("Stale workers cursor; request the first page again.");
	const rows = filtered.slice(offset, offset + limit);
	const nextOffset = offset + rows.length;
	const next =
		nextOffset < filtered.length
			? encodeCursor({
					view: "workers",
					...(state ? { state } : {}),
					offset: nextOffset,
					fingerprint: fingerprint(ids),
				})
			: undefined;
	const header = `Workers: ${filtered.length} total; showing ${rows.length}${state ? `; state=${state}` : ""}`;
	const body = rows.length
		? statusReport(rows, MAX_RESULT_CHARS, limit)
		: workerId
			? "No matching workers."
			: "No workers have been delegated.";
	return `${header}\n${body}${next ? `\n\nNext cursor: ${next}` : ""}`;
}

function orderedOpenNotes(manager: WorkerManager): Note[] {
	return manager
		.getOpenNotes()
		.map((note, index) => ({ note, index }))
		.sort((left, right) => right.note.createdAt - left.note.createdAt || right.index - left.index)
		.map(({ note }) => note);
}

function notePage(
	manager: WorkerManager,
	noteId: string | undefined,
	limit: number,
	cursorValue: string | undefined,
): string {
	if (noteId) {
		const note = manager.listNotes().find((candidate) => candidate.id === noteId);
		if (!note) throw new Error(`Unknown note id "${noteId}".`);
		return `Note: ${formatNotePreview(note)}${note.open ? "" : " (closed)"}`;
	}
	const notes = orderedOpenNotes(manager);
	const ids = notes.map((note) => note.id);
	const cursor = cursorValue ? decodeCursor(cursorValue, "notes", undefined) : undefined;
	if (cursor && cursor.fingerprint !== fingerprint(ids))
		throw new Error("Stale notes cursor; request the first page again.");
	const offset = cursor?.offset ?? 0;
	if (offset > notes.length) throw new Error("Stale notes cursor; request the first page again.");
	const rows = notes.slice(offset, offset + limit);
	const nextOffset = offset + rows.length;
	const next =
		nextOffset < notes.length
			? encodeCursor({ view: "notes", offset: nextOffset, fingerprint: fingerprint(ids) })
			: undefined;
	const header = `Notes: ${notes.length} total; showing ${rows.length}`;
	const body = rows.length ? rows.map((note) => `  ${formatNotePreview(note)}`).join("\n") : "No open notes.";
	return `${header}\n${body}${next ? `\n\nNext cursor: ${next}` : ""}`;
}

export function leaderTools(manager: WorkerManager): McpTool[] {
	const available = manager.sessionTiers;
	const roles = roleNames().join(", ");
	const workerSchema = {
		type: "object",
		properties: {
			role: { type: "string", description: `Role prompt. Built-in: ${roles}.` },
			tier: { type: "string", enum: [...available] },
			task: { type: "string", description: "Self-contained instructions and acceptance criteria." },
			name: { type: "string", description: "Two or three words naming the job." },
			writer: { type: "boolean", description: "Grant the serialized writer slot." },
			backend: { type: "string", description: "Optional explicit backend override." },
			note: { type: "string", description: "Optional open-note id." },
		},
		required: ["role", "tier", "task"],
	};

	return [
		{
			name: "neta_goal",
			description:
				"Initialize, revise, reopen, or complete the session goal with optimistic concurrency. Goal-impact discoveries remain pending until explicitly resolved; workers never revise the goal automatically.",
			inputSchema: {
				type: "object",
				properties: {
					op: {
						type: "string",
						enum: ["init", "revise", "resolve-discovery", "set-discovery-policy", "complete", "stop", "reopen"],
					},
					originalIntent: { type: "string" },
					workingObjective: { type: "string" },
					expectedRevision: { type: "number" },
					discoveryPolicy: { type: "string", enum: ["allowed", "locked"] },
					discoveryId: { type: "string" },
					resolution: { type: "string", enum: ["accept", "reject"] },
					reason: { type: "string" },
					override: { type: "boolean" },
					evidenceRefs: { type: "array", items: { type: "string" } },
				},
				required: ["op"],
			},
			async run(args) {
				const op = requireString(args, "op");
				let goal: SessionGoal;
				switch (op) {
					case "init":
						goal = manager.initGoal(requireString(args, "originalIntent"));
						break;
					case "revise":
						goal = manager.reviseGoal({
							workingObjective: requireString(args, "workingObjective"),
							expectedRevision: optionalNumber(args, "expectedRevision") as number,
							reason: optionalString(args, "reason"),
							evidenceRefs: optionalStringArray(args, "evidenceRefs"),
						});
						break;
					case "set-discovery-policy":
						goal = manager.setDiscoveryPolicy({
							discoveryPolicy: requireString(args, "discoveryPolicy") as "allowed" | "locked",
							expectedRevision: optionalNumber(args, "expectedRevision") as number,
							reason: optionalString(args, "reason"),
							evidenceRefs: optionalStringArray(args, "evidenceRefs"),
						});
						break;
					case "resolve-discovery":
						goal = manager.resolveDiscovery({
							discoveryId: requireString(args, "discoveryId"),
							resolution: requireString(args, "resolution") as "accept" | "reject",
							expectedRevision: optionalNumber(args, "expectedRevision") as number,
							reason: optionalString(args, "reason"),
							evidenceRefs: optionalStringArray(args, "evidenceRefs"),
						});
						break;
					case "complete":
						goal = manager.completeGoal({
							expectedRevision: optionalNumber(args, "expectedRevision") as number,
							override: optionalBoolean(args, "override"),
							reason: optionalString(args, "reason"),
							evidenceRefs: optionalStringArray(args, "evidenceRefs"),
						});
						break;
					case "stop":
						goal = manager.stopGoal({
							expectedRevision: optionalNumber(args, "expectedRevision") as number,
							reason: optionalString(args, "reason"),
							evidenceRefs: optionalStringArray(args, "evidenceRefs"),
						});
						break;
					case "reopen":
						goal = manager.reopenGoal({
							workingObjective: requireString(args, "workingObjective"),
							expectedRevision: optionalNumber(args, "expectedRevision") as number,
							reason: requireString(args, "reason"),
							evidenceRefs: optionalStringArray(args, "evidenceRefs"),
						});
						break;
					default:
						throw new Error(`Unknown goal op "${op}".`);
				}
				const pending = goal.discoveries.filter(
					(discovery) => discovery.impact === "goal" && discovery.status === "pending",
				);
				return text(
					`Goal revision=${goal.revision} status=${goal.status} policy=${goal.discoveryPolicy}; pending discoveries=${pending.length ? pending.map((discovery) => discovery.id).join(",") : "none"}`,
				);
			},
		},
		{
			name: "neta_delegate",
			description:
				"Delegate one or more workers. Input is prevalidated atomically. Runtime startup failures are collected per worker, do not roll back workers already started, and do not stop later workers from being attempted. Without team they are independent; team gives every worker one shared transcript. Returns every worker id, assignment, state and startup failure. Always collect workers with neta_wait.",
			inputSchema: {
				type: "object",
				properties: {
					workers: { type: "array", items: workerSchema, minItems: 1 },
					team: { type: "string", description: "Optional shared transcript name for every worker." },
					seed: { type: "string", description: "Opening team post; requires team." },
				},
				required: ["workers"],
			},
			async run(args) {
				if (!Array.isArray(args.workers) || args.workers.length === 0)
					throw new Error('"workers" must be a non-empty array.');
				const team = optionalString(args, "team");
				const seed = optionalString(args, "seed");
				if (seed && !team) throw new Error('"seed" requires "team".');
				const requests = (args.workers as Record<string, unknown>[]).map((raw) => ({
					role: requireString(raw, "role"),
					tier: tier(raw, available),
					task: requireString(raw, "task"),
					name: optionalString(raw, "name"),
					writer: optionalBoolean(raw, "writer"),
					backend: optionalString(raw, "backend"),
					note: optionalString(raw, "note"),
					room: team,
				}));
				// Resolve the complete batch before the seed or first process: invalid input has no partial side effects.
				manager.validateDelegation(requests);
				const admissionGeneration = manager.delegationAdmission();
				const plannedAssignments = manager.planAssignments(requests);
				if (seed && team) manager.postToRoom(team, "leader", "leader", seed);
				const results: Array<{ summary: WorkerSummary } | { failure: string }> = [];
				const startupFailures = new Map<string, string>();
				for (const [index, request] of requests.entries()) {
					const before = new Set(manager.list().map((worker) => worker.id));
					try {
						results.push({ summary: await manager.spawn(request, admissionGeneration) });
					} catch (error) {
						const failed = manager.list().find((worker) => !before.has(worker.id));
						const message = error instanceof Error ? error.message : String(error);
						if (!failed) {
							const assignment = plannedAssignments[index];
							const holder = request.writer ? manager.statusSnapshot().writerSlot?.id : undefined;
							results.push({
								failure: `unallocated: ${(request.name ?? request.role).trim() || request.role} (${request.role}/${request.tier}) -> ${assignment.backend} (${request.writer ? "writer" : "read-only"}, startup failed${holder ? `; writer holder: ${holder}` : ""})\n  Startup failure: ${message}`,
							});
							continue;
						}
						results.push({ summary: failed });
						startupFailures.set(failed.id, message);
					}
				}
				const assignments = results.map((result) => {
					if ("failure" in result) return result.failure;
					const summary = result.summary;
					return `${summary.id}: ${summary.role}/${summary.tier} -> ${summary.backend} (${summary.writer ? "writer" : "read-only"}, ${summary.state}) | ${formatWorkerDuration(summary)}${summary.state === "queued" ? " — Queued" : ""}${startupFailures.has(summary.id) ? `\n  Startup failure: ${startupFailures.get(summary.id)}` : ""}${summary.headlessReason ? `\n  Worker view: headless — ${summary.headlessReason}` : ""}`;
				});
				return text(
					`${team ? `Team "${team}"\n` : ""}${assignments.join("\n")}\nCollect with neta_wait before ending your turn.`,
				);
			},
		},
		{
			name: "neta_exec",
			description:
				'Run any command directly, without a worker: any executable name or absolute/relative path, any arguments — including shell or interpreter flags and inline shell source strings such as ["sh","-c","..."] — and Git or Bun with any options. There is no command allowlist and the working directory may be any existing directory, not only the session repository. Full combined stdout+stderr is always captured to a session-owned mode-0600 file; the command\'s own output excerpt in the result is capped (the surrounding header, path and warnings are not counted against that cap), and when the command\'s output was too large to return in full, the result says so and names that file so you can delegate reading it. From the second call in a session onward, the result also names the call number and says to delegate repeated discovery to workers instead of calling this again yourself. A command that cannot even be launched still comes back as a completed result, not a tool error.',
			inputSchema: {
				type: "object",
				properties: {
					argv: {
						type: "array",
						items: { type: "string" },
						minItems: 1,
						description:
							'Argument vector, for example ["git", "push", "origin", "main"] or ["sh", "-c", "some source"]. Not a shell string — to get shell semantics, pass the shell as argv[0] yourself.',
					},
					cwd: {
						type: "string",
						description:
							"Optional. Any existing directory, absolute or relative to the session's cwd; defaults to the session's cwd.",
					},
					timeoutSeconds: {
						type: "number",
						description:
							"Optional. A positive number of seconds, up to the ~24.8 days Node's timer can safely hold. Omit for no timeout at all — the command then runs until it exits or the session shuts down.",
					},
					userApproved: {
						type: "boolean",
						description:
							"Deprecated and ignored. No command is gated on this field; it is kept only for compatibility with older callers.",
					},
				},
				required: ["argv"],
			},
			async run(args) {
				if (
					!Array.isArray(args.argv) ||
					args.argv.length === 0 ||
					args.argv.some((item) => typeof item !== "string")
				) {
					throw new Error('"argv" must be a non-empty list of strings.');
				}
				const timeoutSeconds = optionalNumber(args, "timeoutSeconds");
				let timeoutMs: number | undefined;
				if (timeoutSeconds !== undefined) {
					if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
						throw new Error('"timeoutSeconds" must be a finite number greater than 0.');
					}
					timeoutMs = Math.round(timeoutSeconds * 1000);
					if (timeoutMs < 1 || timeoutMs > MAX_SAFE_TIMEOUT_MS) {
						throw new Error(
							`"timeoutSeconds" must round to between 1 ms and ${MAX_SAFE_TIMEOUT_MS} ms (about ${MAX_TIMEOUT_SECONDS.toFixed(0)} seconds) — the largest delay Node's timers can represent safely.`,
						);
					}
				}
				return text(
					formatExecResult(
						await manager.exec({
							argv: args.argv as string[],
							cwd: optionalString(args, "cwd"),
							timeoutMs,
							userApproved: args.userApproved === true,
						}),
					),
				);
			},
		},
		{
			name: "neta_workers",
			description: "List workers, latest milestone, usage and results. Safe and non-interrupting.",
			advertise: false,
			inputSchema: {
				type: "object",
				properties: {
					workerId: { type: "string" },
					limit: { type: "number" },
					cursor: { type: "string" },
					state: { type: "string", enum: [...WORKER_STATES] },
				},
			},
			async run(args) {
				const id = optionalString(args, "workerId");
				const state = workerState(args);
				const limit = pageLimit(args);
				const cursor = optionalString(args, "cursor");
				return text(
					`Deprecated: use neta_status with view="workers"${id ? ` and workerId="${id}"` : ""}.\n` +
						workerPage(manager, id, state, limit, cursor) +
						formatOpenNotes(manager),
				);
			},
		},
		{
			name: "neta_status",
			description:
				"Show the bounded session summary by default. Use view=workers or view=notes for bounded pages; workerId or noteId fetches one exact record.",
			inputSchema: {
				type: "object",
				properties: {
					view: { type: "string", enum: ["summary", "workers", "notes"] },
					workerId: { type: "string" },
					noteId: { type: "string" },
					limit: { type: "number" },
					cursor: { type: "string" },
					state: { type: "string", enum: [...WORKER_STATES] },
				},
				additionalProperties: false,
			},
			async run(args) {
				const view =
					optionalString(args, "view") ??
					(args.workerId !== undefined ? "workers" : args.noteId !== undefined ? "notes" : "summary");
				if (view !== "summary" && view !== "workers" && view !== "notes")
					throw new Error('"view" must be summary, workers or notes.');
				const id = optionalString(args, "workerId");
				const noteId = optionalString(args, "noteId");
				const cursor = optionalString(args, "cursor");
				const state = workerState(args);
				const hasLimit = args.limit !== undefined && args.limit !== null;
				if (view === "summary" && (id || noteId || cursor || state || hasLimit))
					throw new Error(
						'"workerId", "noteId", "limit", "cursor" and "state" require view="workers" or view="notes".',
					);
				if (view === "workers" && noteId) throw new Error('"noteId" requires view="notes".');
				if (view === "notes" && (id || state)) throw new Error('"workerId" and "state" require view="workers".');
				const limit = view === "summary" ? DEFAULT_PAGE_LIMIT : pageLimit(args);
				return text(
					view === "summary"
						? manager.status()
						: view === "workers"
							? workerPage(manager, id, state, limit, cursor) + formatOpenNotes(manager)
							: notePage(manager, noteId, limit, cursor),
				);
			},
		},
		{
			name: "neta_attach",
			description:
				"Open a terminal worker's exact native vendor session in a fresh multiplexer tab. Refuses active, queued, headless, or concurrently owned sessions.",
			inputSchema: { type: "object", properties: { workerId: { type: "string" } }, required: ["workerId"] },
			async run(args) {
				const summary = await manager.reopenWorkerTui(requireString(args, "workerId"));
				return text(`Opened ${summary.id} in a new ${summary.backend} TUI tab.`);
			},
		},
		{
			name: "neta_inspect",
			description:
				"Read one worker's bounded recent input/output without consuming a cursor. Works for headless workers.",
			inputSchema: { type: "object", properties: { workerId: { type: "string" } }, required: ["workerId"] },
			async run(args) {
				return text(formatInspection(manager.inspect(requireString(args, "workerId"))).join("\n"));
			},
		},
		{
			name: "neta_wait",
			description:
				"Block until workers finish, the first finishes, one blocks, a goal-impact discovery stops, a watched team posts, or timeout. Resolve discoveries before resuming with neta_send.",
			inputSchema: {
				type: "object",
				properties: {
					workerIds: { type: "array", items: { type: "string" } },
					timeoutSeconds: { type: "number" },
					first: { type: "boolean" },
					roomEvents: { type: ["boolean", "string"] },
				},
			},
			async run(args) {
				const ids =
					optionalStringArray(args, "workerIds") ??
					manager
						.list()
						.filter((worker) => !isTerminalState(worker.state) || worker.state === "blocked")
						.map((worker) => worker.id);
				if (!ids.length) return text("Nothing to wait for.");
				const seconds = Math.min(optionalNumber(args, "timeoutSeconds") ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
				const roomEvents = args.roomEvents;
				const rooms =
					typeof roomEvents === "string"
						? [roomEvents]
						: roomEvents === true
							? ids.flatMap((id) => (manager.get(id).room ? [manager.get(id).room as string] : []))
							: undefined;
				const result = await manager.wait(ids, seconds * 1000, { first: optionalBoolean(args, "first"), rooms });
				return text(formatWaitResult(result, seconds) + formatOpenNotes(manager));
			},
		},
		{
			name: "neta_send",
			description:
				"Steer a running worker, append to a queued brief, or resume a done/failed/blocked worker in its exact ACP conversation. Killed/interrupted workers refuse.",
			inputSchema: {
				type: "object",
				properties: { workerId: { type: "string" }, message: { type: "string" } },
				required: ["workerId", "message"],
			},
			async run(args) {
				const result = await manager.steer(requireString(args, "workerId"), requireString(args, "message"));
				return text(`${formatSteerResult(result)}\n${describe(result.worker)}`);
			},
		},
		{
			name: "neta_kill",
			description: "Terminate a worker and release its writer slot.",
			inputSchema: { type: "object", properties: { workerId: { type: "string" } }, required: ["workerId"] },
			async run(args) {
				return text(`Killed ${describe(await manager.kill(requireString(args, "workerId")))}`);
			},
		},
		{
			name: "neta_note",
			description:
				"Create, close, or list a bounded preview of session-scoped open notes; use neta_status with view=notes for more.",
			inputSchema: { type: "object", properties: { text: { type: "string" }, close: { type: "string" } } },
			async run(args) {
				const value = optionalString(args, "text");
				const close = optionalString(args, "close");
				if (value && close) throw new Error("Provide either text or close, not both.");
				if (value) {
					const note = manager.createNote(value);
					return text(`Created ${note.id}: ${note.text}`);
				}
				if (close) return text(`Closed ${manager.closeNote(close).id}`);
				const notes = manager.getOpenNotes();
				if (!notes.length) return text("No open notes.");
				return text(
					`${formatOpenNotesLines(notes).join("\n")}\nFor more open notes, call neta_status with view="notes".`,
				);
			},
		},
	];
}
