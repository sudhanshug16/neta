import type {
	ContentBlock,
	RequestPermissionResponse,
	SessionConfigOption,
	SessionNotification,
	Usage,
} from "@agentclientprotocol/sdk";
import { ulid } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import type { Access, Block, PromptAttachment, SessionId, Turn, TurnId } from "../core/types.ts";
import { type BlockDraft, blocksFromUpdate, canCoalesce, signalFromUpdate } from "./blocks.ts";
import type { McpServerSpec } from "./mcp.ts";
import { type ModelOption, type ModelState, modelStateFrom, planModel } from "./models.ts";
import { type ExitInfo, type ProviderProcess, spawnProvider } from "./process.ts";
import { providerFor, type Settings } from "./settings.ts";

export interface StartOptions {
	settings: Settings;
	provider: string;
	access: Access;
	unsandboxed?: boolean;
	cwd: string;
	model?: string;
	mcpServers?: McpServerSpec[];
	resumeVendorSessionId?: string;
	sessionId?: SessionId;
	steeringSafe?: boolean;
}

export type SessionEvent =
	| { type: "turn"; turn: Turn }
	| { type: "block"; block: Block }
	| { type: "turnEnd"; turnId: TurnId; stopReason: string; cancelled: boolean }
	| { type: "model"; model: string }
	| { type: "mode"; modeId: string }
	| { type: "interrupted"; turnId?: TurnId; exit: ExitInfo };

export interface AcpSession {
	readonly sessionId: SessionId;
	readonly vendorSessionId: string;
	readonly provider: string;
	readonly cwd: string;
	readonly access: Access;
	readonly unsandboxed: boolean;
	readonly model: string;
	readonly openTurnId?: TurnId;
	readonly configOptions: readonly SessionConfigOption[];
	readonly promptCapabilities: { image: boolean; embeddedContext: boolean };
	readonly steeringSupported: boolean;
	prompt(text: string, attachments?: PromptAttachment[]): TurnId;
	steer(
		messageId: string,
		text: string,
		attachments?: PromptAttachment[],
	): Promise<"injected" | "promptRequired" | "failed">;
	cancel(): Promise<void>;
	listModels(): ModelOption[];
	setModel(model: string): Promise<void>;
	setConfigOption(configId: string, value: string | boolean): Promise<void>;
	relaunch(access: Access): Promise<void>;
	close(): Promise<void>;
	events(): AsyncIterableIterator<SessionEvent>;
}

export function startSession(opts: StartOptions): Promise<AcpSession> {
	return startInner(opts);
}

export class TurnInProgressError extends Error {
	readonly turnId: TurnId;

	constructor(turnId: TurnId) {
		super(`a turn is already in progress: ${turnId}`);
		this.name = "TurnInProgressError";
		this.turnId = turnId;
	}
}

export class ResumeFailedError extends Error {
	readonly vendorSessionId: string;

	constructor(vendorSessionId: string) {
		super(`resume failed for vendor session: ${vendorSessionId}`);
		this.name = "ResumeFailedError";
		this.vendorSessionId = vendorSessionId;
	}
}

export class SessionClosedError extends Error {
	constructor() {
		super("session is closed");
		this.name = "SessionClosedError";
	}
}

interface LastBlock {
	draft: BlockDraft;
	block: Block;
}

async function startInner(opts: StartOptions): Promise<AcpSession> {
	const provider = providerFor(opts.settings, opts.provider);
	const sessionId = opts.sessionId ?? ulid();
	const mcpServers = opts.mcpServers ?? [];

	let proc: ProviderProcess | undefined;
	let access = opts.access;
	let model = "";
	let modelState: ModelState = { source: "none", options: [] };
	let configOptions: SessionConfigOption[] = [];
	let promptCapabilities = { image: false, embeddedContext: false };
	let steeringSupported = false;
	let openTurnId: TurnId | undefined;
	const turnEndWaiters: Array<() => void> = [];
	let seq = 0;
	let last: LastBlock | undefined;
	let keyed = new Map<string, LastBlock>();
	let pendingUsage: BlockDraft | undefined;
	let closed = false;
	let iteratorTaken = false;

	const queue: SessionEvent[] = [];
	const takers: Array<(result: IteratorResult<SessionEvent>) => void> = [];
	let streamEnded = false;

	function push(event: SessionEvent): void {
		if (streamEnded) {
			return;
		}
		const taker = takers.shift();
		if (taker !== undefined) {
			taker({ value: event, done: false });
		} else {
			queue.push(event);
		}
	}

	function endStream(): void {
		if (streamEnded) {
			return;
		}
		streamEnded = true;
		for (const taker of takers.splice(0)) {
			taker({ value: undefined, done: true });
		}
	}

	function clearTurn(): void {
		openTurnId = undefined;
		const waiters = turnEndWaiters.splice(0);
		for (const done of waiters) {
			done();
		}
	}

	function emitBlock(draft: BlockDraft, targetTurnId: TurnId | undefined = openTurnId): void {
		if (targetTurnId === undefined) {
			return;
		}
		const prior = draft.key === undefined ? undefined : keyed.get(draft.key);
		if (prior !== undefined) {
			const next = { ...draft, text: draft.text === "" ? prior.block.text : draft.text };
			prior.draft = next;
			prior.block = {
				...prior.block,
				text: next.text,
				...(next.data === undefined ? {} : { data: { ...prior.block.data, ...next.data } }),
			};
			last = prior;
			push({ type: "block", block: prior.block });
			return;
		}
		if (last !== undefined && canCoalesce(last.draft, draft)) {
			last.draft.text += draft.text;
			// A snapshot, not a mutation: earlier emissions keep their text
			// while the re-emit carries the grown text at the same seq.
			last.block = { ...last.block, text: last.draft.text };
			push({ type: "block", block: last.block });
			return;
		}
		seq += 1;
		const block: Block = {
			turnId: targetTurnId,
			seq,
			at: nowIso(),
			role: draft.role,
			kind: draft.kind,
			text: draft.text,
			...(draft.data === undefined ? {} : { data: draft.data }),
		};
		last = { draft: { ...draft }, block };
		if (draft.key !== undefined) keyed.set(draft.key, last);
		push({ type: "block", block });
	}

	function onUpdate(notification: SessionNotification): void {
		if (proc === undefined || notification.sessionId !== vendorSessionId) {
			return;
		}
		for (const draft of blocksFromUpdate(notification.update)) {
			if (draft.kind === "usage") pendingUsage = draft;
			else emitBlock(draft);
		}
		const signal = signalFromUpdate(notification.update);
		if (signal?.kind === "model") {
			model = signal.model;
			modelState = { ...modelState, current: signal.model };
			push({ type: "model", model: signal.model });
		} else if (signal?.kind === "mode") {
			push({ type: "mode", modeId: signal.modeId });
		}
		if (notification.update.sessionUpdate === "config_option_update") {
			configOptions = notification.update.configOptions;
			modelState = modelStateFrom({ configOptions });
			if (modelState.current !== undefined) model = modelState.current;
		}
	}

	function permissionFor(options: Array<{ kind: string; optionId: string }>): RequestPermissionResponse {
		const kinds =
			opts.unsandboxed === true || access === "readWrite" ? ["allow_once", "allow_always"] : ["reject_once"];
		for (const kind of kinds) {
			const found = options.find((option) => option.kind === kind);
			if (found !== undefined) {
				return { outcome: { outcome: "selected", optionId: found.optionId } };
			}
		}
		return { outcome: { outcome: "cancelled" } };
	}

	let vendorSessionId = "";

	function watchExit(next: ProviderProcess): void {
		void next.exited.then((exit) => {
			if (closed || proc !== next) {
				return;
			}
			closed = true;
			const interruptedTurnId = openTurnId;
			clearTurn();
			push({ type: "interrupted", turnId: interruptedTurnId, exit });
			endStream();
			try {
				next.connection.close();
			} catch {
				// Already closed.
			}
		});
	}

	async function launch(resumeId: string | undefined): Promise<{ vendor: string; response: unknown }> {
		const next = await spawnProvider({
			provider,
			access,
			cwd: opts.cwd,
			handlers: {
				onSessionUpdate: onUpdate,
				requestPermission: async (p) => permissionFor(p.options ?? []),
			},
		});
		promptCapabilities = {
			image: next.initialize.agentCapabilities?.promptCapabilities?.image ?? false,
			embeddedContext: next.initialize.agentCapabilities?.promptCapabilities?.embeddedContext ?? false,
		};
		const meta = next.initialize._meta as { steering?: { supported?: unknown } } | null | undefined;
		steeringSupported = opts.steeringSafe === true && meta?.steering?.supported === true;
		let vendor: string;
		let response: unknown;
		if (resumeId !== undefined && provider.resume) {
			try {
				response = await next.connection.agent.request("session/resume", {
					sessionId: resumeId,
					cwd: opts.cwd,
					mcpServers,
				});
			} catch {
				await next.kill();
				throw new ResumeFailedError(resumeId);
			}
			vendor = resumeId;
		} else {
			response = await next.connection.agent.request("session/new", { cwd: opts.cwd, mcpServers });
			vendor = (response as { sessionId: string }).sessionId;
		}
		proc = next;
		watchExit(next);
		return { vendor, response };
	}

	function absorbResponse(response: unknown): void {
		modelState = modelStateFrom(response);
		if (
			typeof response === "object" &&
			response !== null &&
			Array.isArray((response as { configOptions?: unknown }).configOptions)
		) {
			configOptions = (response as { configOptions: SessionConfigOption[] }).configOptions;
		}
	}

	function promptBlocks(text: string, attachments: readonly PromptAttachment[]): ContentBlock[] {
		const blocks: ContentBlock[] = text === "" ? [] : [{ type: "text", text }];
		for (const attachment of attachments) {
			if (attachment.kind === "image") {
				blocks.push({ type: "image", data: attachment.dataBase64, mimeType: attachment.mimeType });
			} else {
				blocks.push({
					type: "resource",
					resource: {
						uri: `attachment:${encodeURIComponent(attachment.id)}/${encodeURIComponent(attachment.name)}`,
						mimeType: attachment.mimeType,
						blob: attachment.dataBase64,
					},
				});
			}
		}
		return blocks;
	}

	async function applyModelPlan(wanted: string | undefined): Promise<void> {
		const plan = planModel(modelState, wanted, opts.settings.forbiddenModels);
		if (plan.call !== undefined && proc !== undefined) {
			if (plan.call.method === "session/set_config_option") {
				const response = await proc.connection.agent.request("session/set_config_option", {
					sessionId: vendorSessionId,
					configId: plan.call.params.configId,
					value: plan.call.params.value,
				});
				if (response.configOptions !== undefined && response.configOptions !== null) {
					configOptions = response.configOptions;
				}
			} else {
				await proc.connection.agent.request("session/set_model", {
					modelId: plan.call.params.modelId,
				});
			}
		}
		if (plan.model !== undefined) {
			model = plan.model;
			modelState = { ...modelState, current: plan.model };
		}
	}

	async function applySandboxPolicy(): Promise<void> {
		const wanted = opts.unsandboxed === true ? provider.unsandboxedMode : undefined;
		if (wanted === undefined || proc === undefined) return;
		const mode = configOptions.find(
			(option): option is SessionConfigOption & { type: "select" } =>
				option.id === "mode" && option.type === "select",
		);
		const advertised = mode?.options.some((option) =>
			"value" in option ? option.value === wanted : option.options.some((nested) => nested.value === wanted),
		);
		if (mode === undefined || advertised !== true) {
			throw new Error(`provider ${opts.provider} does not advertise unsandboxed mode ${wanted}`);
		}
		const response = await proc.connection.agent.request("session/set_config_option", {
			sessionId: vendorSessionId,
			configId: "mode",
			value: wanted,
		});
		if (response.configOptions !== undefined && response.configOptions !== null) {
			configOptions = response.configOptions;
		}
	}

	// --- boot ---
	const first = await launch(opts.resumeVendorSessionId);
	vendorSessionId = first.vendor;
	absorbResponse(first.response);
	await applySandboxPolicy();
	const wanted = opts.model ?? (provider.defaultModel === "" ? undefined : provider.defaultModel);
	await applyModelPlan(wanted);
	if (model === "" && wanted !== undefined) {
		model = wanted;
	}

	const session: AcpSession = {
		get sessionId() {
			return sessionId;
		},
		get vendorSessionId() {
			return vendorSessionId;
		},
		get provider() {
			return opts.provider;
		},
		get cwd() {
			return opts.cwd;
		},
		get access() {
			return access;
		},
		get unsandboxed() {
			return opts.unsandboxed === true;
		},
		get model() {
			return model;
		},
		get openTurnId() {
			return openTurnId;
		},
		get configOptions() {
			return configOptions;
		},
		get promptCapabilities() {
			return promptCapabilities;
		},
		get steeringSupported() {
			return steeringSupported;
		},

		prompt(text: string, attachments: PromptAttachment[] = []): TurnId {
			if (closed) {
				throw new SessionClosedError();
			}
			if (openTurnId !== undefined) {
				throw new TurnInProgressError(openTurnId);
			}
			const turnId = ulid();
			const turn: Turn = { id: turnId, sessionId, startedAt: nowIso(), role: "user" };
			openTurnId = turnId;
			last = undefined;
			keyed = new Map();
			pendingUsage = undefined;
			push({ type: "turn", turn });
			void (async (): Promise<void> => {
				const current = proc;
				if (current === undefined) {
					return;
				}
				let response: { stopReason: string; usage?: Usage | null };
				try {
					response = await current.connection.agent.request("session/prompt", {
						sessionId: vendorSessionId,
						prompt: promptBlocks(text, attachments),
					});
				} catch (error) {
					if (openTurnId !== turnId || closed) {
						return;
					}
					emitBlock({
						role: "agent",
						kind: "status",
						text: error instanceof Error ? error.message : String(error),
					});
					push({ type: "turnEnd", turnId, stopReason: "error", cancelled: false });
					clearTurn();
					return;
				}
				if (openTurnId !== turnId || closed) {
					return;
				}
				if (response.usage !== undefined && response.usage !== null) {
					const usage = response.usage;
					const finalUsage: BlockDraft = {
						role: "agent",
						kind: "usage",
						text: `${usage.totalTokens} tokens`,
						data: {
							...(pendingUsage as BlockDraft | undefined)?.data,
							inputTokens: usage.inputTokens,
							outputTokens: usage.outputTokens,
							totalTokens: usage.totalTokens,
							thoughtTokens: usage.thoughtTokens ?? null,
							cachedReadTokens: usage.cachedReadTokens ?? null,
							cachedWriteTokens: usage.cachedWriteTokens ?? null,
						},
						key: "usage",
					};
					emitBlock(finalUsage);
				} else if (pendingUsage !== undefined) {
					emitBlock(pendingUsage);
				}
				pendingUsage = undefined;
				push({
					type: "turnEnd",
					turnId,
					stopReason: response.stopReason,
					cancelled: response.stopReason === "cancelled",
				});
				clearTurn();
			})();
			return turnId;
		},

		steer: async (messageId, text, attachments = []) => {
			if (closed || proc === undefined) throw new SessionClosedError();
			if (!steeringSupported || openTurnId === undefined) return "promptRequired";
			const turnId = openTurnId;
			const agent = proc.connection.agent as unknown as {
				request(method: string, params: unknown): Promise<unknown>;
			};
			const response = (await agent.request("_session/steering", {
				sessionId: vendorSessionId,
				prompt: promptBlocks(text, attachments),
				_meta: { steering: { idleBehavior: "promptRequired" } },
			})) as { outcome?: unknown };
			if (response.outcome === "promptRequired") return "promptRequired";
			if (response.outcome !== "injected") return "failed";
			if (text !== "") emitBlock({ role: "user", kind: "text", text, data: { messageId } }, turnId);
			for (const attachment of attachments)
				emitBlock(
					{
						role: "user",
						kind: "status",
						text: attachment.name,
						data: {
							messageId,
							attachmentId: attachment.id,
							attachmentKind: attachment.kind,
							name: attachment.name,
							mimeType: attachment.mimeType,
							size: Buffer.from(attachment.dataBase64, "base64").byteLength,
						},
					},
					turnId,
				);
			return "injected";
		},

		cancel: async (): Promise<void> => {
			const current = proc;
			if (current === undefined || openTurnId === undefined) {
				return;
			}
			try {
				await current.connection.agent.notify("session/cancel", { sessionId: vendorSessionId });
			} catch {
				// The process may already be gone; the turn still ends via the
				// prompt rejection or the exit watch.
			}
		},

		listModels: (): ModelOption[] => [...modelState.options],

		setModel: async (wantedModel: string): Promise<void> => {
			if (closed || proc === undefined) {
				throw new SessionClosedError();
			}
			await applyModelPlan(wantedModel);
		},

		setConfigOption: async (configId: string, value: string | boolean): Promise<void> => {
			if (closed || proc === undefined) {
				throw new SessionClosedError();
			}
			const response = (await proc.connection.agent.request("session/set_config_option", {
				sessionId: vendorSessionId,
				configId,
				value,
			})) as { configOptions?: SessionConfigOption[] | null };
			if (response.configOptions !== undefined && response.configOptions !== null) {
				configOptions = response.configOptions;
			}
			if (configId === modelState.configId && typeof value === "string") {
				model = value;
				modelState = { ...modelState, current: value };
			}
		},

		relaunch: async (nextAccess: Access): Promise<void> => {
			if (closed) {
				throw new SessionClosedError();
			}
			if (openTurnId !== undefined) {
				await session.cancel();
				await new Promise<void>((done) => {
					turnEndWaiters.push(done);
				});
			}
			const old = proc;
			if (old !== undefined) {
				proc = undefined;
				await old.kill();
				try {
					old.connection.close();
				} catch {
					// Already closed.
				}
			}
			access = nextAccess;
			const relaunched = await launch(vendorSessionId);
			vendorSessionId = relaunched.vendor;
			absorbResponse(relaunched.response);
			await applySandboxPolicy();
		},

		close: async (): Promise<void> => {
			if (closed) {
				return;
			}
			closed = true;
			const current = proc;
			proc = undefined;
			if (current !== undefined) {
				let exit: ExitInfo | undefined;
				try {
					exit = await current.kill();
				} catch {
					// Already gone.
				}
				try {
					current.connection.close();
				} catch {
					// Already closed.
				}
				if (openTurnId !== undefined && exit !== undefined) {
					push({ type: "interrupted", turnId: openTurnId, exit });
				}
			}
			endStream();
		},

		events: (): AsyncIterableIterator<SessionEvent> => {
			if (iteratorTaken) {
				throw new SessionClosedError();
			}
			iteratorTaken = true;
			return {
				next: async (): Promise<IteratorResult<SessionEvent>> => {
					const queued = queue.shift();
					if (queued !== undefined) {
						return { value: queued, done: false };
					}
					if (streamEnded) {
						return { value: undefined, done: true };
					}
					return new Promise<IteratorResult<SessionEvent>>((done) => {
						takers.push(done);
					});
				},
				[Symbol.asyncIterator]() {
					return this;
				},
			};
		},
	};

	return session;
}
