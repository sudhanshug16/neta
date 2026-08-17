/**
 * The one interface every worker backend implements.
 *
 * Claude Code, Codex and OpenCode are all driven over ACP, so today there is a
 * single implementation. The interface stays because everything above it works
 * in terms of "start, prompt, kill, markTerminal" and never learns which backend
 * it is talking to — and because tests substitute a fake driver here.
 */

import type { WorkerLogEntry, WorkerUsage } from "../types.ts";

/** What a worker's session negotiated, as the backend reports it. */
export interface NegotiatedSession {
	/** Model as a person should read it: the backend's label when it names one, else the id. */
	model?: string;
	/** Raw model id, for cost estimation; same as `model` when the backend names nothing. */
	modelId?: string;
	/** Mode the session runs in. */
	mode?: string;
	/** The ACP bridge in front of the backend, as "name@version". */
	agentInfo?: string;
}

export interface TransportEvents {
	/** Narration for the worker's log. The leader pulls this; it never pushes. */
	log(kind: WorkerLogEntry["kind"], text: string): void;
	/** Tokens and cost the backend has reported so far. */
	usage(usage: WorkerUsage): void;
	/** The backend's own id for this session, once it has one. */
	vendorSession(sessionId: string): void;
	/** What the backend negotiated and is running; re-fired whenever the backend reports a change. */
	session(session: NegotiatedSession): void;
	/** Detached worker process group, retained for crash cleanup. */
	processGroup?(pgid: number): void;
}

/**
 * An MCP server handed to the worker's backend. This is how a sandboxed worker
 * reaches Neta: the backend launches the server itself, outside whatever
 * sandbox its shell commands run in.
 */
export interface WorkerMcpServer {
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
}

export interface TransportOptions {
	workerId: string;
	cwd: string;
	env: Record<string, string>;
	/** Executable that speaks ACP over stdio. */
	command: string | undefined;
	args: string[];
	model: string | undefined;
	/** Policy selections must be confirmed exactly before any task prompt is sent. */
	requireExactModel?: boolean;
	/** Writers may edit and write files; everyone else is denied at the protocol layer. */
	writer: boolean;
	/** Role prompt, prepended to the worker's first message. */
	systemPrompt: string;
	scratchDir: string;
	/** MCP servers the backend should start for this worker. */
	mcpServers: WorkerMcpServer[];
	events: TransportEvents;
}

export interface PromptOutcome {
	ok: boolean;
	/** What the worker said, or why it failed. */
	summary: string;
	/**
	 * The turn ended because it was cancelled, not because the worker failed.
	 *
	 * ACP has no way to inject a message into a running prompt turn: `session/prompt`
	 * owns the turn until it resolves. Cancelling and re-prompting the same session
	 * is the protocol's supported equivalent, and this flag is what tells the
	 * orchestrator that an early stop was Neta's own doing.
	 */
	cancelled?: boolean;
}

export interface WorkerTransportDriver {
	start(): Promise<void>;
	prompt(text: string): Promise<PromptOutcome>;
	/**
	 * Ask the backend to end the current prompt turn now, keeping the session.
	 *
	 * Returns false when there is nothing to cancel. Best-effort by nature: the
	 * turn may already be resolving, and tool calls the worker has already run are
	 * not undone by it.
	 */
	cancel(): boolean | Promise<boolean>;
	kill(): Promise<void>;
	/** The worker reached a terminal state; its session must stop being honored. */
	markTerminal(): void;
}

/** Text of the first prompt: role prompt, then the task. */
export function composeFirstPrompt(systemPrompt: string, task: string): string {
	return `${systemPrompt.trim()}\n\n---\n\n# Task\n\n${task.trim()}\n`;
}
