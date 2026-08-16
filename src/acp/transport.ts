/**
 * ACP worker transport: drives any Agent Client Protocol agent as a worker.
 *
 * The protocol mechanics (spawn, initialize, permission policy, cancel) live
 * in AcpConnection; this file adapts them to the worker contract: role prompt
 * on the first message, narration into the worker log, and a PromptOutcome
 * the orchestrator can act on.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { structuredPatch } from "diff";
import {
	composeFirstPrompt,
	type PromptOutcome,
	type TransportOptions,
	type WorkerTransportDriver,
} from "../orchestrator/transport.ts";
import type { WorkerUsage } from "../types.ts";
import { AcpConnection, type AcpSessionUpdate } from "./connection.ts";

/** Fields agents commonly put in a tool call, in the order that reads best. */
const DETAIL_KEYS = ["command", "pattern", "query", "file_path", "path", "url", "description"];

/**
 * Index just past the last paragraph break in a streaming buffer, or 0 when
 * nothing can be flushed yet.
 *
 * Prose is logged a paragraph at a time: chunk-per-entry would flood the log
 * with word fragments, and holding a whole turn means the pane shows nothing
 * until the worker finishes. A blank line inside a fenced code block is not a
 * paragraph break, so fences are tracked rather than splitting mid-block.
 */
export function paragraphFlushIndex(buffer: string): number {
	const lines = buffer.split("\n");
	let inFence = false;
	let offset = 0;
	let flushAt = 0;
	// The final segment has no newline yet, so it can never close a paragraph.
	for (let i = 0; i < lines.length - 1; i++) {
		const line = lines[i];
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		offset += line.length + 1;
		if (!inFence && line.trim() === "") flushAt = offset;
	}
	return flushAt;
}

const MAX_DIFF_LINES = 120;

/** A tool call's file change as printable unified-diff lines: path, then hunks. */
export function renderDiffText(path: string, oldText: string, newText: string): string {
	const patch = structuredPatch(path, path, oldText, newText, undefined, undefined, { context: 2 });
	const lines: string[] = [path];
	for (const hunk of patch.hunks) {
		lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
		lines.push(...hunk.lines);
	}
	if (lines.length > MAX_DIFF_LINES) {
		const dropped = lines.length - MAX_DIFF_LINES;
		lines.length = MAX_DIFF_LINES;
		lines.push(`… ${dropped} more lines`);
	}
	return lines.join("\n");
}

/**
 * What a tool call was actually about.
 *
 * Backends often send a title alone — "Read File", twenty times in a row — and
 * a pane full of that tells a watcher nothing. Where the call names a file or
 * carries an argument, say which.
 */
export function describeToolCall(title: string, locations?: { path: string }[] | null, rawInput?: unknown): string {
	const location = locations?.[0]?.path;
	if (location) return `${title} ${location}`;

	if (rawInput && typeof rawInput === "object") {
		const input = rawInput as Record<string, unknown>;
		for (const key of DETAIL_KEYS) {
			const value = input[key];
			if (typeof value !== "string" || value.trim() === "") continue;
			const flat = value.replace(/\s+/g, " ").trim();
			// A title that already contains the argument does not need it twice.
			if (title.includes(flat.slice(0, 40))) break;
			return `${title} ${flat.length > 120 ? `${flat.slice(0, 120)}…` : flat}`;
		}
	}
	return title;
}

export class AcpWorkerTransport implements WorkerTransportDriver {
	private readonly options: TransportOptions;
	private connection: AcpConnection | undefined;
	private assistantText = "";
	private firstPrompt = true;
	/** Streaming prose held back until a paragraph completes. */
	private readonly pending = { text: "", thought: "" };
	/** Tool calls whose diff has been logged; updates repeat content verbatim. */
	private readonly diffLogged = new Set<string>();
	/** Cumulative across turns, because backends report per-turn totals. */
	private readonly usage: WorkerUsage = {};

	constructor(options: TransportOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		const command = this.options.command;
		if (!command) throw new Error("Worker backends require a command in settings (backends.<name>.command).");
		this.connection = new AcpConnection({
			command,
			args: this.options.args,
			cwd: this.options.cwd,
			env: this.options.env,
			allowMutations: this.options.writer,
			mcpServers: this.options.mcpServers,
			model: this.options.model,
			onUpdate: (update) => this.sessionUpdate(update),
			onSession: (description) => this.options.events.log("status", `Running as ${description}.`),
			onVendorSession: (sessionId) => this.options.events.vendorSession(sessionId),
			onProcessGroup: (pgid) => this.options.events.processGroup?.(pgid),
			onStderr: (text) => this.options.events.log("error", text),
			onDenied: (kind, title, reason) =>
				this.options.events.log(
					"error",
					reason === "terminal"
						? `Denied ${kind}: ${title} (this worker has finished; Neta treats the end of a turn as the end of the worker)`
						: `Denied ${kind}: ${title} (this worker is read-only; ask the leader for the writer slot)`,
				),
		});
		await this.connection.start();
		this.emitSession();
	}

	/** Report what the session runs as; called at start and again on every backend-reported change. */
	private emitSession(): void {
		const offered = this.connection?.offered;
		if (!offered) return;
		this.options.events.session({
			model: offered.currentModel,
			modelId: offered.currentModelId,
			mode: offered.currentMode,
			agentInfo: offered.agentInfo,
		});
	}

	async prompt(text: string): Promise<PromptOutcome> {
		const connection = this.connection;
		if (!connection) return { ok: false, summary: "Worker is not connected." };

		const message = this.firstPrompt ? composeFirstPrompt(this.options.systemPrompt, text) : text;
		this.firstPrompt = false;
		this.assistantText = "";

		try {
			const response = await connection.prompt(message);
			this.flushStreaming();
			if (response.usage) {
				for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) {
					const value = response.usage[field];
					if (value !== undefined) this.usage[field] = (this.usage[field] ?? 0) + value;
				}
				this.options.events.usage({ ...this.usage });
			}
			const summary = this.assistantText.trim() || "(no output)";
			if (response.stopReason === "end_turn" || response.stopReason === "max_tokens") {
				return { ok: true, summary };
			}
			return { ok: false, summary: `Stopped early (${response.stopReason}). ${summary}` };
		} catch (error) {
			this.flushStreaming();
			if (connection.killed) return { ok: false, summary: "Worker was killed." };
			return { ok: false, summary: error instanceof Error ? error.message : String(error) };
		}
	}

	async kill(): Promise<void> {
		await this.connection?.kill();
	}

	markTerminal(): void {
		this.connection?.markTerminal();
	}

	private sessionUpdate(update: AcpSessionUpdate): void {
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text") {
					this.assistantText += update.content.text;
					this.appendStreaming("text", update.content.text);
				}
				break;
			case "agent_thought_chunk":
				if (update.content.type === "text") this.appendStreaming("thought", update.content.text);
				break;
			case "tool_call":
				// Prose that streamed before this call belongs before it in the log.
				this.flushStreaming();
				this.options.events.log("tool", describeToolCall(update.title, update.locations, update.rawInput));
				this.logDiffs(update.toolCallId, update.content);
				// Reset assistantText so the result is only the final message after the last tool call.
				this.assistantText = "";
				break;
			case "tool_call_update":
				this.logDiffs(update.toolCallId, update.content);
				break;
			case "config_option_update":
				// The record's model and mode must track what actually runs, or a
				// backend-side switch leaves every listing showing a stale model.
				this.connection?.applyConfigOptions(update.configOptions);
				this.emitSession();
				break;
			case "current_mode_update":
				this.connection?.applyCurrentMode(update.currentModeId);
				this.emitSession();
				break;
			case "usage_update":
				this.usage.contextUsed = update.used;
				this.usage.contextSize = update.size;
				if (update.cost) {
					this.usage.costAmount = update.cost.amount;
					this.usage.costCurrency = update.cost.currency;
				}
				this.options.events.usage({ ...this.usage });
				break;
			default:
				break;
		}
	}

	private appendStreaming(kind: "text" | "thought", chunk: string): void {
		const buffer = this.pending[kind] + chunk;
		const flushAt = paragraphFlushIndex(buffer);
		if (flushAt === 0) {
			this.pending[kind] = buffer;
			return;
		}
		const complete = buffer.slice(0, flushAt).trimEnd();
		this.pending[kind] = buffer.slice(flushAt);
		if (complete) this.options.events.log(kind, complete);
	}

	private flushStreaming(): void {
		for (const kind of ["text", "thought"] as const) {
			const rest = this.pending[kind].trim();
			this.pending[kind] = "";
			if (rest) this.options.events.log(kind, rest);
		}
	}

	/**
	 * A tool call's diff arrives with the call or with a later update, and a
	 * completed update repeats what the call already carried — log it once.
	 */
	private logDiffs(toolCallId: string, content: acp.ToolCallContent[] | null | undefined): void {
		if (!content || this.diffLogged.has(toolCallId)) return;
		const diffs = content.filter((item) => item.type === "diff");
		if (diffs.length === 0) return;
		this.diffLogged.add(toolCallId);
		for (const diff of diffs) {
			this.options.events.log("diff", renderDiffText(diff.path, diff.oldText ?? "", diff.newText));
		}
	}
}
