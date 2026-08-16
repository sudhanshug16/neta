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
export const MUTATING_TOOL_KINDS = new Set(["edit", "write", "delete", "move"]);
const READ_ONLY_TOOL_KINDS = new Set(["read", "search", "list"]);

const AUTH_REQUIRED_CODE = -32000;

/**
 * Variables that describe an *ancestor* agent or Neta leader session rather
 * than the worker we are starting: its messaging socket, its session id, its
 * pid, or its leader authority.
 *
 * Neta is an ACP host, so it launches these CLIs as fresh subprocesses the way
 * an editor does. When Neta itself was started from inside one of these agents,
 * the ancestor's variables are still in `process.env`, and passing them down
 * points the new session at another session's runtime. Claude Code detects that
 * and refuses to start ("cannot be launched inside another Claude Code
 * session"), which is the correct call on its part — the values are simply not
 * ours to forward.
 *
 * A worker receives its own channel identity after this filter. It must never
 * inherit the leader token, even when Neta itself was launched by a leader.
 */
const INHERITED_SESSION_PREFIXES = ["CLAUDE_CODE_"];
const INHERITED_SESSION_VARS = new Set(["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"]);
const LEADER_ENV_PREFIX = "NETA_LEADER_";
const LEADER_ENV_VARS = new Set(["NETA_SESSION_ID", "NETA_MUX", "NETA_PANES"]);

export function sanitizeInheritedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const clean: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (INHERITED_SESSION_VARS.has(name)) continue;
		if (INHERITED_SESSION_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
		if (name.startsWith(LEADER_ENV_PREFIX) || LEADER_ENV_VARS.has(name)) continue;
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
	onDenied: (kind: string, title: string, reason: "read-only" | "terminal") => void;
	/** What the session ended up running as, once negotiated. */
	onSession?: (description: string) => void;
	/**
	 * The backend's own session id. Claude Code and Codex both hand back the id
	 * they file the conversation under, so this is what a person needs to open
	 * the worker in that CLI's own interface.
	 */
	onVendorSession?: (sessionId: string) => void;
	/** The detached ACP process group, so a crashed manager can clean it up later. */
	onProcessGroup?: (pgid: number) => void;
}

/** Legacy bridges select a model through this extension method. */
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

/**
 * Extension fields bridges used to report models through before the SDK grew
 * `configOptions`. Some still do; read them as the fallback.
 */
interface SessionNegotiation {
	models?: { availableModels?: { modelId: string }[]; currentModelId?: string } | null;
	modes?: { availableModes?: { id: string }[]; currentModeId?: string } | null;
}

/** The current selection of a "select" config option: value ids and their display names. */
interface ConfigSelection {
	id: string;
	values: string[];
	names: Map<string, string>;
	currentValue: string;
}

function readSelect(option: acp.SessionConfigOption | undefined): ConfigSelection | undefined {
	if (option?.type !== "select") return undefined;
	const entries: Array<acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup> = option.options;
	const flat = entries.flatMap((entry) => ("group" in entry ? entry.options : [entry]));
	return {
		id: option.id,
		values: flat.map((value) => value.value),
		names: new Map(flat.map((value) => [value.value, value.name])),
		currentValue: option.currentValue,
	};
}

/** Codex puts its thought level in the configured model id, while ACP exposes it separately. */
function splitModelAndThoughtLevel(model: string): { model: string; thoughtLevel?: string } {
	const match = /^(.*)\[([^\]]+)]$/.exec(model);
	return match ? { model: match[1], thoughtLevel: match[2] } : { model };
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
	/** Shared so concurrent terminal paths wait for the same process-group exit. */
	private killPromise: Promise<void> | undefined;
	/** What this backend offered when the session opened, kept current as it reports changes. */
	offered: {
		models: string[];
		/** Current model for display: the backend's label when it names one, else the id. */
		currentModel?: string;
		/** Raw id of the current model, for cost estimation. */
		currentModelId?: string;
		modes: string[];
		currentMode?: string;
		/** The ACP bridge in front of the backend, as "name@version". */
		agentInfo?: string;
	} = {
		models: [],
		modes: [],
	};
	/** Display names for model and mode ids, learned from configOptions. */
	private readonly modelNames = new Map<string, string>();
	private readonly modeNames = new Map<string, string>();
	private readonly thoughtLevelNames = new Map<string, string>();
	killed = false;
	/** The worker reached a terminal state; permission requests are denied from here on. */
	terminal = false;

	constructor(options: AcpConnectionOptions) {
		this.options = options;
	}

	markTerminal(): void {
		this.terminal = true;
	}

	async start(): Promise<void> {
		const { command, args } = this.options;
		const child = spawn(command, args, {
			cwd: this.options.cwd,
			env: sanitizeInheritedEnv({ ...process.env, ...this.options.env }),
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		this.child = child;
		if (child.pid !== undefined) this.options.onProcessGroup?.(child.pid);

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
			const initialized = await this.connection.agent.request(acp.methods.agent.initialize, {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: "neta", version: VERSION },
			});
			if (initialized.agentInfo) {
				this.offered.agentInfo = `${initialized.agentInfo.name}@${initialized.agentInfo.version}`;
			}
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
			// Fire-and-forget during startup failure: we're re-throwing anyway.
			void this.kill();
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
		// configOptions is how the SDK reports models and modes now; bridges that
		// predate it used these extension fields. Prefer the former, keep the latter.
		const session = response as acp.NewSessionResponse & SessionNegotiation;

		this.offered.models = (session.models?.availableModels ?? []).map((model) => model.modelId);
		this.offered.modes = (session.modes?.availableModes ?? []).map((mode) => mode.id);
		this.offered.currentModelId = session.models?.currentModelId;
		this.offered.currentModel = session.models?.currentModelId;
		this.offered.currentMode = session.modes?.currentModeId;
		const config = this.applyConfigOptions(response.configOptions ?? []);
		if (config.model) this.offered.models = config.model.values;
		if (config.mode) this.offered.modes = config.mode.values;

		const wanted = this.options.model;
		if (wanted && config.model) {
			const desired = splitModelAndThoughtLevel(wanted);
			const modelId = chooseModel(config.model.values, wanted) ?? chooseModel(config.model.values, desired.model);
			if (!modelId) {
				this.options.onStderr(`No model "${wanted}" here; running on ${this.offered.currentModel}.`);
			} else {
				try {
					let selected = await connection.agent.request(acp.methods.agent.session.setConfigOption, {
						sessionId,
						configId: config.model.id,
						value: modelId,
					});
					let confirmed = this.applyConfigOptions(selected.configOptions);
					chosen.push(`model ${modelId}`);

					if (desired.thoughtLevel && confirmed.thoughtLevel) {
						const thoughtLevel = chooseModel(confirmed.thoughtLevel.values, desired.thoughtLevel);
						if (!thoughtLevel) {
							this.options.onStderr(
								`No thought level "${desired.thoughtLevel}" here; running on ${this.offered.currentModel}.`,
							);
						} else {
							selected = await connection.agent.request(acp.methods.agent.session.setConfigOption, {
								sessionId,
								configId: confirmed.thoughtLevel.id,
								value: thoughtLevel,
							});
							confirmed = this.applyConfigOptions(selected.configOptions);
							chosen.push(`thought level ${thoughtLevel}`);
						}
					}
					// set_config_option returns all current values. Reading its last response
					// is the confirmation, rather than recording what we merely requested.
					this.applyConfigOptions(selected.configOptions);
				} catch (error) {
					this.options.onStderr(`Could not select model "${wanted}": ${describe(error)}`);
				}
			}
		} else if (wanted && session.models?.availableModels?.length) {
			const modelId = chooseModel(this.offered.models, wanted);
			if (!modelId) {
				this.options.onStderr(`No model "${wanted}" here; running on ${this.offered.currentModel}.`);
			} else {
				try {
					await connection.agent.request(SET_MODEL, { sessionId, modelId });
					chosen.push(`model ${modelId}`);
					this.offered.currentModelId = modelId;
					this.offered.currentModel = this.modelNames.get(modelId) ?? modelId;
				} catch (error) {
					this.options.onStderr(`Could not select model "${modelId}": ${describe(error)}`);
				}
			}
		}
		if (!wanted && !this.offered.currentModel) {
			this.options.onStderr("no model requested; backend default in use");
		}

		const modes = (session.modes?.availableModes ?? []).map((mode) => mode.id);
		const preferred = (this.options.allowMutations ? MODE_PREFERENCE.writer : MODE_PREFERENCE.readOnly).find((mode) =>
			modes.includes(mode),
		);
		if (preferred && preferred !== session.modes?.currentModeId) {
			try {
				await connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: preferred });
				chosen.push(`mode ${preferred}`);
				this.offered.currentMode = this.modeNames.get(preferred) ?? preferred;
			} catch (error) {
				this.options.onStderr(`Could not select mode "${preferred}": ${describe(error)}`);
			}
		}

		if (chosen.length > 0) this.options.onSession?.(chosen.join(" · "));
	}

	/**
	 * Record what a configOptions set says the session runs. Called with the
	 * session/new offering and again on every config_option_update, which
	 * carries the full set each time.
	 */
	applyConfigOptions(options: acp.SessionConfigOption[]): {
		model?: ConfigSelection;
		mode?: ConfigSelection;
		thoughtLevel?: ConfigSelection;
	} {
		const model = readSelect(options.find((option) => option.category === "model"));
		const mode = readSelect(options.find((option) => option.category === "mode"));
		const thoughtLevel = readSelect(options.find((option) => option.category === "thought_level"));
		for (const [value, name] of model?.names ?? []) this.modelNames.set(value, name);
		for (const [value, name] of mode?.names ?? []) this.modeNames.set(value, name);
		for (const [value, name] of thoughtLevel?.names ?? []) this.thoughtLevelNames.set(value, name);
		if (model) {
			const thoughtSuffix = thoughtLevel ? `[${thoughtLevel.currentValue}]` : "";
			const thoughtDisplay = thoughtLevel
				? ` [${this.thoughtLevelNames.get(thoughtLevel.currentValue) ?? thoughtLevel.currentValue}]`
				: "";
			this.offered.currentModelId = `${model.currentValue}${thoughtSuffix}`;
			this.offered.currentModel = `${this.modelNames.get(model.currentValue) ?? model.currentValue}${thoughtDisplay}`;
		}
		if (mode) this.offered.currentMode = this.modeNames.get(mode.currentValue) ?? mode.currentValue;
		return { model, mode, thoughtLevel };
	}

	/** The session switched modes, whether the backend's own doing or our set_mode confirmed. */
	applyCurrentMode(modeId: string): void {
		this.offered.currentMode = this.modeNames.get(modeId) ?? modeId;
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

	async kill(): Promise<void> {
		this.killed = true;
		// Best-effort ACP cancel before killing the process.
		this.cancel();
		this.connection?.close();
		this.connection = undefined;
		if (this.killPromise) return this.killPromise;
		const child = this.child;
		this.child = undefined;
		// A failed spawn has no process id and no process group to stop. Do not use
		// exitCode here: npx can already be gone while the bridge it started still
		// owns the detached process group.
		if (!child || child.pid === undefined) return;

		const pgid = child.pid;
		const signalGroup = (signal: NodeJS.Signals) => {
			try {
				process.kill(-pgid, signal);
			} catch {
				child.kill(signal);
			}
		};
		const groupAlive = (): boolean => {
			try {
				process.kill(-pgid, 0);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				// Negative process-group ids are not supported everywhere. The direct
				// child is the best liveness signal on those platforms.
				return child.exitCode === null;
			}
		};

		this.killPromise = new Promise<void>((resolve) => {
			let pollTimer: ReturnType<typeof setTimeout> | undefined;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				if (pollTimer) clearTimeout(pollTimer);
				if (killTimer) clearTimeout(killTimer);
				resolve();
			};
			const poll = () => {
				if (!groupAlive()) {
					done();
					return;
				}
				pollTimer = setTimeout(poll, 25);
			};

			// Signal the whole process group (npx and the bridge it spawned), then
			// wait for the group rather than just npx. A launcher may exit immediately
			// while a descendant keeps the ACP session alive.
			signalGroup("SIGTERM");
			killTimer = setTimeout(() => {
				if (groupAlive()) signalGroup("SIGKILL");
			}, 3000);
			poll();
		});
		return this.killPromise;
	}

	private requestPermission(params: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
		const kind = params.toolCall.kind ?? "other";
		const title = params.toolCall.title ?? params.toolCall.toolCallId;
		// Once terminal (done, failed or killed), only read-like requests remain
		// valid; a finished worker has no legitimate terminal command to run.
		const terminal = this.terminal || this.killed;
		const mutation = MUTATING_TOOL_KINDS.has(kind);
		const denied = terminal ? !READ_ONLY_TOOL_KINDS.has(kind) : mutation && !this.options.allowMutations;

		const option = denied
			? pickOption(params.options, ["reject_once", "reject_always"])
			: pickOption(params.options, ["allow_always", "allow_once"]);

		if (!option) return { outcome: { outcome: "cancelled" } };
		if (denied) this.options.onDenied(kind, title, terminal ? "terminal" : "read-only");
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
