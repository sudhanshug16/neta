import { OUTPUT_LIMIT_BYTES } from "../orchestrator/exec.ts";
import type { WorkerManager } from "../orchestrator/manager.ts";
import {
	formatInspection,
	formatLastProgress,
	formatSteerResult,
	formatWorkerSummary,
} from "../orchestrator/status.ts";
import { roleNames } from "../prompts/roles.ts";
import { isTerminalState, isTier, type Note, TIERS, type Tier, type WaitResult, type WorkerSummary } from "../types.ts";
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

function formatExecResult(result: Awaited<ReturnType<WorkerManager["exec"]>>): string {
	const header = [
		`Exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`,
		`Duration: ${result.durationMs} ms`,
		`Cwd: ${result.cwd}`,
		`Output file: ${result.outputPath}`,
		"Output:",
	].join("\n");
	const output = result.output || "(no output)";
	const sections = [`${header}\n${output}`];
	if (result.truncated) {
		sections.push(
			`This output was too large for you to inspect here: it exceeded the ${OUTPUT_LIMIT_BYTES}-byte cap on what neta_exec returns, so only its head and tail are shown above. Do not try to read around this truncation yourself — delegate inspecting the full output to an apprentice or scout. Full output: ${result.outputPath}`,
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

function describe(summary: WorkerSummary): string {
	return formatWorkerSummary(summary);
}

function statusReport(summaries: WorkerSummary[], maxResultChars = MAX_RESULT_CHARS): string {
	return summaries
		.map((summary) => {
			const lines = [describe(summary)];
			const progress = formatLastProgress(summary);
			if (progress) lines.push(`  ${progress}`);
			if (summary.result) lines.push(`  result: ${clip(summary.result, maxResultChars)}`);
			if (summary.laterFailure) lines.push(`  after its report: ${clip(summary.laterFailure, maxResultChars)}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

function formatWaitResult(result: WaitResult, seconds: number): string {
	const active = result.workers.filter((worker) => !isTerminalState(worker.state));
	if (result.reason === "blocked" && result.wokeBy) {
		return `${result.wokeBy.id} blocked and stopped: ${result.wokeBy.pendingQuestion ?? "(no question)"}\nAnswer with neta_send to resume this exact conversation.\n${statusReport(result.workers)}`;
	}
	if (result.reason === "room" && result.roomActivity) {
		const posts = result.roomActivity.posts.slice(-ROOM_WAKE_TAIL);
		return `New team activity in "${result.roomActivity.room}":\n${posts.map((post) => `[${post.label}] ${post.text}`).join("\n")}\n\n${statusReport(result.workers)}`;
	}
	if (result.reason === "first") {
		const terminal = result.workers.filter((worker) => isTerminalState(worker.state));
		return `${statusReport(terminal)}${active.length ? `\n\nStill running: ${active.map((worker) => worker.id).join(", ")}. Call neta_wait again.` : ""}`;
	}
	if (result.reason === "timeout") {
		return `${statusReport(result.workers)}${active.length ? `\n\nStill running after ${seconds}s: ${active.map((worker) => worker.id).join(", ")}. Call neta_wait again.` : ""}`;
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

function noteWorkersLabel(note: Note): string {
	return note.workers.length
		? ` (${note.workers.map((worker) => `${worker.workerId} ${worker.state}`).join(", ")})`
		: " (unworked)";
}

function formatOpenNotes(manager: WorkerManager): string {
	const notes = manager.getOpenNotes();
	return notes.length
		? `\n\nOpen notes: ${notes.map((note) => `${note.id} "${clip(note.text, 80)}"${noteWorkersLabel(note)}`).join(" | ")}`
		: "";
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
				const plannedAssignments = manager.planAssignments(requests);
				if (seed && team) manager.postToRoom(team, "leader", "leader", seed);
				const results: Array<{ summary: WorkerSummary } | { failure: string }> = [];
				const startupFailures = new Map<string, string>();
				for (const [index, request] of requests.entries()) {
					const before = new Set(manager.list().map((worker) => worker.id));
					try {
						results.push({ summary: await manager.spawn(request) });
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
					return `${summary.id}: ${summary.role}/${summary.tier} -> ${summary.backend} (${summary.writer ? "writer" : "read-only"}, ${summary.state})${summary.state === "queued" ? " — Queued" : ""}${startupFailures.has(summary.id) ? `\n  Startup failure: ${startupFailures.get(summary.id)}` : ""}${summary.headlessReason ? `\n  Worker view: headless — ${summary.headlessReason}` : ""}`;
				});
				return text(
					`${team ? `Team "${team}"\n` : ""}${assignments.join("\n")}\nCollect with neta_wait before ending your turn.`,
				);
			},
		},
		{
			name: "neta_exec",
			description:
				'Run any command directly, without a worker: any executable name or absolute/relative path, any arguments — including shell or interpreter flags and inline shell source strings such as ["sh","-c","..."] — and Git or Bun with any options. There is no command allowlist and the working directory may be any existing directory, not only the session repository. Full combined stdout+stderr is always captured to a session-owned mode-0600 file; the text this tool returns is capped and, when the command\'s output was too large to return in full, the result says so and names that file so you can delegate reading it. From the second call in a session onward, the result also names the call number and says to delegate repeated discovery to workers instead of calling this again yourself.',
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
					timeoutSeconds: { type: "number", description: "Timeout from 0.001 to 600 seconds; default 60." },
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
				return text(
					formatExecResult(
						await manager.exec({
							argv: args.argv as string[],
							cwd: optionalString(args, "cwd"),
							timeoutMs: timeoutSeconds === undefined ? undefined : Math.round(timeoutSeconds * 1000),
							userApproved: args.userApproved === true,
						}),
					),
				);
			},
		},
		{
			name: "neta_workers",
			description: "List workers, latest milestone, usage and results. Safe and non-interrupting.",
			inputSchema: { type: "object", properties: { workerId: { type: "string" } } },
			async run(args) {
				const id = optionalString(args, "workerId");
				const workers = id ? [manager.get(id)] : manager.list();
				return text(
					workers.length
						? statusReport(workers, id ? 20_000 : MAX_RESULT_CHARS) + formatOpenNotes(manager)
						: "No workers have been delegated.",
				);
			},
		},
		{
			name: "neta_status",
			description: "Show writer slot, queue, grouped worker states and open notes.",
			inputSchema: { type: "object" },
			async run() {
				return text(manager.status());
			},
		},
		{
			name: "neta_attach",
			description:
				"Open a terminal worker's exact native vendor session in a fresh multiplexer tab. Refuses active, queued, headless, or concurrently owned sessions.",
			inputSchema: { type: "object", properties: { workerId: { type: "string" } }, required: ["workerId"] },
			async run(args) {
				const summary = manager.reopenWorkerTui(requireString(args, "workerId"));
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
				"Block until workers finish, the first finishes, one blocks, a watched team posts, or timeout. Call again while work remains.",
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
			description: "Create, close, or list session-scoped open notes.",
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
				return text(
					notes.length
						? notes.map((note) => `${note.id} "${note.text}"${noteWorkersLabel(note)}`).join("\n")
						: "No open notes.",
				);
			},
		},
	];
}
