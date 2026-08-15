/**
 * The one interface every worker backend implements.
 *
 * Claude Code, Codex and OpenCode are all driven over ACP, so today there is a
 * single implementation. The interface stays because everything above it works
 * in terms of "start, prompt, kill" and never learns which backend it is
 * talking to — and because tests substitute a fake driver here.
 */

import type { WorkerLogEntry, WorkerUsage } from "../types.ts";

export interface TransportEvents {
	/** Narration for the worker's log. The leader pulls this; it never pushes. */
	log(kind: WorkerLogEntry["kind"], text: string): void;
	/** Tokens and cost the backend has reported so far. */
	usage(usage: WorkerUsage): void;
	/** The backend's own id for this session, once it has one. */
	vendorSession(sessionId: string): void;
	/** The model and mode the backend negotiated and is running. */
	session(model: string | undefined, mode: string | undefined): void;
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
}

export interface WorkerTransportDriver {
	start(): Promise<void>;
	prompt(text: string): Promise<PromptOutcome>;
	kill(): Promise<void>;
}

/** Text of the first prompt: role prompt, then the task. */
export function composeFirstPrompt(systemPrompt: string, task: string): string {
	return `${systemPrompt.trim()}\n\n---\n\n# Task\n\n${task.trim()}\n`;
}
