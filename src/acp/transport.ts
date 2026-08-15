/**
 * ACP worker transport: drives any Agent Client Protocol agent as a worker.
 *
 * The protocol mechanics (spawn, initialize, permission policy, cancel) live
 * in AcpConnection; this file adapts them to the worker contract: role prompt
 * on the first message, narration into the worker log, and a PromptOutcome
 * the orchestrator can act on.
 */

import {
	composeFirstPrompt,
	type PromptOutcome,
	type TransportOptions,
	type WorkerTransportDriver,
} from "../orchestrator/transport.ts";
import type { WorkerUsage } from "../types.ts";
import { AcpConnection, type AcpSessionUpdate } from "./connection.ts";

export class AcpWorkerTransport implements WorkerTransportDriver {
	private readonly options: TransportOptions;
	private connection: AcpConnection | undefined;
	private assistantText = "";
	private firstPrompt = true;
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
			onUpdate: (update) => this.sessionUpdate(update),
			onStderr: (text) => this.options.events.log("error", text),
			onDenied: (kind, title) =>
				this.options.events.log(
					"error",
					`Denied ${kind}: ${title} (this worker is read-only; ask the leader for the writer slot)`,
				),
		});
		await this.connection.start();
	}

	async prompt(text: string): Promise<PromptOutcome> {
		const connection = this.connection;
		if (!connection) return { ok: false, summary: "Worker is not connected." };

		const message = this.firstPrompt ? composeFirstPrompt(this.options.systemPrompt, text) : text;
		this.firstPrompt = false;
		this.assistantText = "";

		try {
			const response = await connection.prompt(message);
			if (response.usage) {
				this.usage.inputTokens = response.usage.inputTokens;
				this.usage.outputTokens = response.usage.outputTokens;
				this.usage.totalTokens = response.usage.totalTokens;
				this.options.events.usage({ ...this.usage });
			}
			const summary = this.assistantText.trim() || "(no output)";
			if (response.stopReason === "end_turn" || response.stopReason === "max_tokens") {
				return { ok: true, summary };
			}
			return { ok: false, summary: `Stopped early (${response.stopReason}). ${summary}` };
		} catch (error) {
			if (connection.killed) return { ok: false, summary: "Worker was killed." };
			return { ok: false, summary: error instanceof Error ? error.message : String(error) };
		}
	}

	kill(): void {
		this.connection?.kill();
	}

	private sessionUpdate(update: AcpSessionUpdate): void {
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text") this.assistantText += update.content.text;
				break;
			case "tool_call":
				this.options.events.log("output", `${update.title}`);
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
}
