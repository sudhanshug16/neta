/**
 * One ACP client connection to an agent CLI over stdio.
 *
 * Every worker sits on this: Neta drives Claude Code, Codex and OpenCode as
 * workers through the Agent Client Protocol, so there is one code path instead
 * of one conditional per vendor.
 *
 * A permission gate lives here. The agent asks the client (us) before a tool
 * call; unless mutations are allowed we reject anything that edits files. That
 * is protocol enforcement, identical across backends, rather than a line in a
 * prompt a model may ignore. It is not a sandbox: an agent that writes files
 * through its shell tool is only breaking its role. Kernel-level restriction is
 * the backend's own sandbox, configured per vendor when the worker is launched.
 *
 * Bash-style tool calls (kind "execute") stay allowed: agents need to run
 * tests, inspect git, and call the `neta` CLI.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { VERSION } from "../config.ts";

/** Tool kinds a read-only agent may not perform. */
export const MUTATING_TOOL_KINDS = new Set(["edit", "delete", "move"]);

const AUTH_REQUIRED_CODE = -32000;

/**
 * Variables that describe an *ancestor* agent session rather than the one we
 * are starting: its messaging socket, its session id, its pid.
 *
 * Neta is an ACP host, so it launches these CLIs as fresh subprocesses the way
 * an editor does. When Neta itself was started from inside one of these agents,
 * the ancestor's variables are still in `process.env`, and passing them down
 * points the new session at another session's runtime. Claude Code detects that
 * and refuses to start ("cannot be launched inside another Claude Code
 * session"), which is the correct call on its part — the values are simply not
 * ours to forward.
 *
 * Anything a user or our own settings set deliberately is applied after this
 * and therefore survives.
 */
const INHERITED_SESSION_PREFIXES = ["CLAUDE_CODE_"];
const INHERITED_SESSION_VARS = new Set(["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"]);

export function sanitizeInheritedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const clean: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (INHERITED_SESSION_VARS.has(name)) continue;
		if (INHERITED_SESSION_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
		clean[name] = value;
	}
	return clean;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function pickOption(options: acp.PermissionOption[], kinds: string[]): acp.PermissionOption | undefined {
	for (const kind of kinds) {
		const match = options.find((option) => option.kind === kind);
		if (match) return match;
	}
	return undefined;
}

export type AcpSessionUpdate = acp.SessionNotification["update"];

export interface AcpMcpServer {
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
}

export interface AcpConnectionOptions {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	/** File-mutating permission requests are denied unless true. */
	allowMutations: boolean;
	/** MCP servers the agent starts for this session. */
	mcpServers?: AcpMcpServer[];
	/** Model id this backend advertises, e.g. "haiku" or "gpt-5.6-sol[xhigh]". */
	model?: string;
	onUpdate: (update: AcpSessionUpdate) => void;
	onStderr: (text: string) => void;
	onDenied: (kind: string, title: string) => void;
	/** What the session ended up running as, once negotiated. */
	onSession?: (description: string) => void;
	/**
	 * The backend's own session id. Claude Code and Codex both hand back the id
	 * they file the conversation under, so this is what a person needs to open
	 * the worker in that CLI's own interface.
	 */
	onVendorSession?: (sessionId: string) => void;
}

/**
 * Selecting a model is `session/set_model`, which both shipped bridges answer
 * but the 1.3 SDK has no constant for.
 */
const SET_MODEL = "session/set_model";

/**
 * Modes a worker should run in, best first.
 *
 * Codex's "read-only" is a kernel sandbox, which is stronger than anything Neta
 * can enforce from the client side; where a backend offers one, take it. Where
 * it does not, "default" leaves permission requests coming to us, which is what
 * the client-side gate is for — so never pick a mode that silently bypasses it.
 */
const MODE_PREFERENCE = {
	writer: ["agent", "acceptEdits", "default"],
	readOnly: ["read-only", "default"],
};

/** What a session tells us it can be, beyond what the SDK's types describe. */
interface SessionNegotiation {
	models?: { availableModels?: { modelId: string }[]; currentModelId?: string } | null;
	modes?: { availableModes?: { id: string }[]; currentModeId?: string } | null;
}

/** Exact id first, then the family — "gpt-5.6-sol" should find "gpt-5.6-sol[xhigh]". */
export function chooseModel(available: string[], wanted: string): string | undefined {
	if (available.includes(wanted)) return wanted;
	return available.find((id) => id.startsWith(`${wanted}[`));
}

export class AcpConnection {
	private readonly options: AcpConnectionOptions;
	private child: ChildProcess | undefined;
	private connection: acp.ClientConnection | undefined;
	private sessionId: string | undefined;
	/** What this backend offered when the session opened. */
	offered: { models: string[]; currentModel?: string; modes: string[]; currentMode?: string } = {
		models: [],
		modes: [],
	};
	killed = false;

	constructor(options: AcpConnectionOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		const { command, args } = this.options;
		const child = spawn(command, args, {
			cwd: this.options.cwd,
			env: { ...sanitizeInheritedEnv(process.env), ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		child.on("error", (error) => {
			this.options.onStderr(`Backend "${command}" failed to start: ${error.message}`);
		});
		child.stderr?.on("data", (chunk) => {
			const text = chunk.toString().trim();
			if (text) this.options.onStderr(text);
		});

		if (!child.stdin || !child.stdout) throw new Error(`Backend "${command}" did not provide stdio pipes.`);
		const stream = acp.ndJsonStream(
			Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
			Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
		);

		this.connection = acp
			.client({ name: "neta" })
			.onRequest(acp.methods.client.session.requestPermission, (ctx) => this.requestPermission(ctx.params))
			.onNotification(acp.methods.client.session.update, (ctx) => this.options.onUpdate(ctx.params.update))
			.connect(stream);

		try {
			await this.connection.agent.request(acp.methods.agent.initialize, {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: "neta", version: VERSION },
			});
			const mcpServers: acp.McpServer[] = (this.options.mcpServers ?? []).map((server) => ({
				name: server.name,
				command: server.command,
				args: server.args,
				env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
			}));
			const session = await this.connection.agent.request(acp.methods.agent.session.new, {
				cwd: this.options.cwd,
				mcpServers,
			});
			this.sessionId = session.sessionId;
			this.options.onVendorSession?.(session.sessionId);
			await this.negotiate(session);
		} catch (error) {
			this.kill();
			throw this.describeStartupError(command, error);
		}
	}

	/**
	 * Ask the session to be what this worker needs: the tier's model, and the
	 * strictest mode that still lets the work happen.
	 *
	 * Both are best-effort. A backend that offers neither still runs the worker,
	 * and saying which model actually ran beats assuming the one we asked for —
	 * an earlier version set ANTHROPIC_MODEL and every worker quietly ran on the
	 * most expensive model there is.
	 */
	private async negotiate(response: acp.NewSessionResponse): Promise<void> {
		const connection = this.connection;
		const sessionId = this.sessionId;
		if (!connection || !sessionId) return;
		const chosen: string[] = [];
		// The 1.3 SDK's types predate model selection, which both shipped bridges
		// answer; read the fields defensively rather than pinning a newer SDK.
		const session = response as acp.NewSessionResponse & SessionNegotiation;

		const available = (session.models?.availableModels ?? []).map((model) => model.modelId);
		this.offered = {
			models: available,
			currentModel: session.models?.currentModelId,
			modes: (session.modes?.availableModes ?? []).map((mode) => mode.id),
			currentMode: session.modes?.currentModeId,
		};
		const wanted = this.options.model;
		if (wanted && available.length > 0) {
			const modelId = chooseModel(available, wanted);
			if (!modelId) {
				this.options.onStderr(`No model "${wanted}" here; running on ${session.models?.currentModelId}.`);
			} else {
				try {
					await connection.agent.request(SET_MODEL, { sessionId, modelId });
					chosen.push(`model ${modelId}`);
				} catch (error) {
					this.options.onStderr(`Could not select model "${modelId}": ${describe(error)}`);
				}
			}
		}

		const modes = (session.modes?.availableModes ?? []).map((mode) => mode.id);
		const preferred = (this.options.allowMutations ? MODE_PREFERENCE.writer : MODE_PREFERENCE.readOnly).find((mode) =>
			modes.includes(mode),
		);
		if (preferred && preferred !== session.modes?.currentModeId) {
			try {
				await connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: preferred });
				chosen.push(`mode ${preferred}`);
			} catch (error) {
				this.options.onStderr(`Could not select mode "${preferred}": ${describe(error)}`);
			}
		}

		if (chosen.length > 0) this.options.onSession?.(chosen.join(" · "));
	}

	/** Rejects on transport failure; protocol-level stops come back in the response. */
	async prompt(text: string): Promise<acp.PromptResponse> {
		const connection = this.connection;
		const sessionId = this.sessionId;
		if (!connection || !sessionId) throw new Error("Not connected.");
		return connection.agent.request(acp.methods.agent.session.prompt, {
			sessionId,
			prompt: [{ type: "text", text }],
		});
	}

	/** Ask the agent to stop the current prompt turn. The prompt call then resolves with stopReason "cancelled". */
	cancel(): void {
		const connection = this.connection;
		const sessionId = this.sessionId;
		if (!connection || !sessionId) return;
		void connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
	}

	kill(): void {
		this.killed = true;
		this.connection?.close();
		this.connection = undefined;
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		child.kill("SIGTERM");
		const timer = setTimeout(() => {
			if (!child.killed) child.kill("SIGKILL");
		}, 5000);
		timer.unref();
	}

	private requestPermission(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
		const kind = params.toolCall.kind ?? "other";
		const title = params.toolCall.title ?? params.toolCall.toolCallId;
		const denied = !this.options.allowMutations && MUTATING_TOOL_KINDS.has(kind);

		const option = denied
			? pickOption(params.options, ["reject_once", "reject_always"])
			: pickOption(params.options, ["allow_always", "allow_once"]);

		if (!option) return { outcome: { outcome: "cancelled" } };
		if (denied) this.options.onDenied(kind, title);
		return { outcome: { outcome: "selected", optionId: option.optionId } };
	}

	private describeStartupError(command: string, error: unknown): Error {
		if (error instanceof acp.RequestError && error.code === AUTH_REQUIRED_CODE) {
			return new Error(
				`Backend "${command}" needs authentication. Log in with that CLI directly (its own subscription login), then retry.`,
			);
		}
		const message = error instanceof Error ? error.message : String(error);
		return new Error(`Backend "${command}" failed to start an ACP session: ${message}`);
	}
}
