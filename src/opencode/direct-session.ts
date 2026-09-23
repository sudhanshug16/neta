import { randomUUID } from "node:crypto";
import { ulid } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import type { Access, Block, PromptAttachment, Turn, TurnId } from "../core/types.ts";
import { type BlockDraft, canCoalesce } from "../session/block-draft.ts";
import { ForbiddenModelError, type ModelOption, UnknownModelError } from "../session/models.ts";
import {
	ResumeFailedError,
	type RuntimeSession,
	SessionClosedError,
	type SessionEvent,
	type StartOptions,
	TurnInProgressError,
} from "../session/runtime.ts";
import { providerFor, requireManagedOpenCode } from "../session/settings.ts";
import { openCodeExecutionContract } from "./contract.ts";
import { dataOf, isRecord, type NativeApi, type NativeServer, startNativeServer } from "./direct-client.ts";

interface ModelInfo {
	id: string;
	providerID: string;
	name: string;
	enabled: boolean;
	variants: Array<{ id: string }>;
	limit: { context: number };
	settings?: Record<string, unknown>;
}
interface AgentInfo {
	id: string;
	name: string;
	mode: string;
	hidden: boolean;
	description?: string;
}
interface ModelRef {
	id: string;
	providerID: string;
	variant?: string;
}
interface Catalog {
	models: ModelInfo[];
	agents: AgentInfo[];
	defaultModel: ModelRef;
	defaultAgent: string;
}
interface ToolState {
	name: string;
	input: Record<string, unknown>;
}
interface SessionConfigOption {
	id: string;
	name: string;
	category: "model" | "thought_level" | "mode";
	type: "select";
	currentValue: string;
	options: Array<{ value: string; name: string; description?: string }>;
}

const sessionPath = (id: string): string => `/api/session/${encodeURIComponent(id)}`;
const string = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const modelId = (value: ModelRef): string => `${value.providerID}/${value.id}`;

function parseModel(id: string, catalog: Catalog): ModelRef {
	const exact = catalog.models.find((item) => `${item.providerID}/${item.id}` === id);
	if (exact) return { id: exact.id, providerID: exact.providerID };
	const withVariant = catalog.models.find((item) =>
		item.variants.some((variant) => `${item.providerID}/${item.id}/${variant.id}` === id),
	);
	if (withVariant)
		return {
			id: withVariant.id,
			providerID: withVariant.providerID,
			variant: id.slice(`${withVariant.providerID}/${withVariant.id}/`.length),
		};
	throw new UnknownModelError(
		id,
		catalog.models.map((item) => ({ id: `${item.providerID}/${item.id}`, name: item.name })),
	);
}

async function loadCatalog(api: NativeApi, cwd: string, forbidden: readonly string[]): Promise<Catalog> {
	await api.request("POST", "/api/plugin/await-activation", undefined, cwd);
	const deadline = Date.now() + 5000;
	let last = "No models are available";
	while (Date.now() < deadline) {
		const [modelsResponse, defaultResponse, agentsResponse, integrationsResponse, providersResponse] =
			await Promise.all([
				api.request("GET", "/api/model", undefined, cwd),
				api.request("GET", "/api/model/default", undefined, cwd),
				api.request("GET", "/api/agent", undefined, cwd),
				api.request("GET", "/api/integration", undefined, cwd),
				api.request("GET", "/api/provider", undefined, cwd),
			]);
		const connected = new Set(
			((record(integrationsResponse).data as unknown[] | undefined) ?? [])
				.filter(isRecord)
				.filter((item) => Array.isArray(item.connections) && item.connections.length > 0)
				.flatMap((item) => string(item.id) ?? []),
		);
		const providers = new Map(
			((record(providersResponse).data as unknown[] | undefined) ?? [])
				.filter(isRecord)
				.map((item) => [string(item.id) ?? "", string(item.integrationID) ?? ""]),
		);
		const models = ((record(modelsResponse).data as unknown[] | undefined) ?? [])
			.filter(
				(value): value is ModelInfo =>
					isRecord(value) &&
					typeof value.id === "string" &&
					typeof value.providerID === "string" &&
					typeof value.name === "string" &&
					Array.isArray(value.variants) &&
					isRecord(value.limit),
			)
			.filter((item) => item.enabled && !forbidden.includes(`${item.providerID}/${item.id}`))
			.filter(
				(item) =>
					Object.values(item.settings ?? {}).some(
						(value) => typeof value === "string" && value.trim() !== "" && value.trim() !== "public",
					) || connected.has(providers.get(item.providerID) || item.providerID),
			);
		const agents = ((record(agentsResponse).data as unknown[] | undefined) ?? [])
			.filter(
				(value): value is AgentInfo =>
					isRecord(value) &&
					typeof value.id === "string" &&
					typeof value.name === "string" &&
					typeof value.mode === "string" &&
					typeof value.hidden === "boolean",
			)
			.filter((agent) => agent.mode !== "subagent" && !agent.hidden);
		const preferred = record(defaultResponse).data;
		const selected = isRecord(preferred)
			? models.find((item) => item.providerID === preferred.providerID && item.id === preferred.id)
			: undefined;
		const primary = agents.find((agent) => agent.mode === "primary") ?? agents[0];
		if (models.length && primary) {
			const fallback = selected ?? models[0];
			return {
				models,
				agents,
				defaultModel: { id: fallback.id, providerID: fallback.providerID },
				defaultAgent: primary.id,
			};
		}
		last = models.length ? "No primary agents are available" : "No connected models are available";
		await new Promise((done) => setTimeout(done, 25));
	}
	throw new Error(`${last}. Check the model connection and use /connect if authentication is required.`);
}

function configOptions(catalog: Catalog, model: ModelRef, agent: string): SessionConfigOption[] {
	const selected = catalog.models.find((item) => item.providerID === model.providerID && item.id === model.id);
	return [
		{
			id: "model",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: modelId(model),
			options: catalog.models.map((item) => ({
				value: `${item.providerID}/${item.id}`,
				name: `${item.providerID}/${item.name}`,
			})),
		},
		...(selected?.variants.length
			? [
					{
						id: "effort",
						name: "Effort",
						category: "thought_level" as const,
						type: "select" as const,
						currentValue: model.variant ?? "default",
						options: [
							...selected.variants.map((item) => ({ value: item.id, name: item.id })),
							{ value: "default", name: "Default" },
						],
					},
				]
			: []),
		{
			id: "mode",
			name: "Session Mode",
			category: "mode",
			type: "select",
			currentValue: agent,
			options: catalog.agents.map((item) => ({
				value: item.id,
				name: item.name,
				...(item.description ? { description: item.description } : {}),
			})),
		},
	];
}

function promptPayload(
	text: string,
	attachments: readonly PromptAttachment[],
	id: string,
): { path: string; body: Record<string, unknown> } {
	const native = attachments.find((item) => item.mimeType === "application/vnd.neta.opencode-prompt+json");
	if (native) {
		const parsed: unknown = JSON.parse(Buffer.from(native.dataBase64, "base64").toString("utf8"));
		if (!isRecord(parsed)) throw new Error("Invalid native OpenCode prompt");
		if (parsed.agents && Array.isArray(parsed.agents) && parsed.agents.length > 0)
			throw new Error("Use Neta missions to delegate work");
		const nativeId = typeof parsed.id === "string" ? parsed.id : id;
		const delivery = parsed.delivery === "queue" || parsed.delivery === "steer" ? parsed.delivery : "steer";
		if (typeof parsed.command === "string") return { path: "command", body: { ...parsed, id: nativeId, delivery } };
		if (typeof parsed.skill === "string") return { path: "skill", body: { ...parsed, id: nativeId, delivery } };
		return { path: "prompt", body: { ...parsed, id: nativeId, delivery } };
	}
	const files = attachments.map((item) => ({
		uri: `data:${item.mimeType};base64,${item.dataBase64}`,
		name: item.name,
	}));
	return { path: "prompt", body: { id, text, files, delivery: "steer" } };
}

/** OpenCode's native V2 API is the only transport used by new and resumed OpenCode actors. */
export async function startOpenCodeSession(opts: StartOptions): Promise<RuntimeSession> {
	const provider = providerFor(opts.settings, "opencode");
	requireManagedOpenCode(provider);
	const sessionId = opts.sessionId ?? ulid();
	const actorId = opts.actorId ?? sessionId;
	let bindingGeneration = opts.bindingGeneration ?? randomUUID();
	let access = opts.access;
	let server: NativeServer | undefined;
	let vendorSessionId = "";
	let catalog: Catalog;
	let model: ModelRef;
	let agent = "";
	let openTurnId: TurnId | undefined;
	let closed = false;
	let iteratorTaken = false;
	let seq = 0;
	let last: { draft: BlockDraft; block: Block } | undefined;
	const keyed = new Map<string, { draft: BlockDraft; block: Block }>();
	const queue: SessionEvent[] = [];
	const takers: Array<(value: IteratorResult<SessionEvent>) => void> = [];
	const turnWaiters: Array<() => void> = [];
	let streamEnded = false;
	let activeAbort: AbortController | undefined;
	let cancelled = false;
	let desiredModelId = opts.model || provider.defaultModel;
	const ownedMcp = new Set<string>();

	const push = (event: SessionEvent): void => {
		if (streamEnded) return;
		const value = { ...event, bindingGeneration: event.bindingGeneration ?? bindingGeneration };
		const taker = takers.shift();
		if (taker) taker({ value, done: false });
		else queue.push(value);
	};
	const endStream = (): void => {
		if (streamEnded) return;
		streamEnded = true;
		for (const taker of takers.splice(0)) taker({ value: undefined, done: true });
	};
	const clearTurn = (): void => {
		openTurnId = undefined;
		for (const done of turnWaiters.splice(0)) done();
	};
	const block = (draft: BlockDraft, turnId: TurnId): void => {
		const previous = draft.key ? keyed.get(draft.key) : undefined;
		if (previous) {
			previous.draft = draft;
			previous.block = {
				...previous.block,
				text: draft.text || previous.block.text,
				...(draft.data ? { data: { ...previous.block.data, ...draft.data } } : {}),
			};
			last = previous;
			push({ type: "block", block: previous.block });
			return;
		}
		if (last && canCoalesce(last.draft, draft)) {
			last.draft.text += draft.text;
			last.block = { ...last.block, text: last.draft.text };
			push({ type: "block", block: last.block });
			return;
		}
		const next: Block = {
			turnId,
			seq: ++seq,
			at: nowIso(),
			role: draft.role,
			kind: draft.kind,
			text: draft.text,
			...(draft.data ? { data: draft.data } : {}),
		};
		last = { draft: { ...draft }, block: next };
		if (draft.key) keyed.set(draft.key, last);
		push({ type: "block", block: next });
	};

	const reconcileTools = async (waitForConnection = true): Promise<void> => {
		const api = server?.api;
		if (!api) throw new SessionClosedError();
		const result = await api.request("GET", "/api/mcp", undefined, opts.cwd);
		const live = ((record(result).data as unknown[] | undefined) ?? []).filter(isRecord);
		for (const spec of opts.mcpServers ?? []) {
			const existing = live.find((item) => item.name === spec.name);
			const status = record(existing?.status).status;
			if (ownedMcp.has(spec.name) && status === "connected") continue;
			const path = `/api/mcp/${encodeURIComponent(spec.name)}`;
			if (!ownedMcp.has(spec.name) || !existing) {
				await api.request(
					"PUT",
					path,
					{
						config: {
							type: "local",
							command: [spec.command, ...spec.args],
							environment: Object.fromEntries(spec.env.map((item) => [item.name, item.value])),
						},
					},
					opts.cwd,
				);
			} else if (status !== "pending") {
				await api.request("POST", `${path}/connect`, undefined, opts.cwd);
			}
			ownedMcp.add(spec.name);
			// The Node has not published a newly started actor yet. Its MCP proxy
			// can connect only after the session enters the Node table.
			if (!waitForConnection) continue;
			const deadline = Date.now() + 15_000;
			let retried = status !== "pending";
			for (;;) {
				const check = await api.request("GET", "/api/mcp", undefined, opts.cwd);
				const current = ((record(check).data as unknown[] | undefined) ?? [])
					.filter(isRecord)
					.find((item) => item.name === spec.name);
				const status = record(current?.status).status;
				if (status === "connected") break;
				if ((status === "failed" || status === "needs_auth" || status === "disabled") && !retried) {
					retried = true;
					await api.request("POST", `${path}/connect`, undefined, opts.cwd);
					continue;
				}
				if (status === "failed" || status === "needs_auth" || status === "disabled" || Date.now() >= deadline)
					throw new Error(`OpenCode tool server ${spec.name} is not connected`);
				await new Promise((done) => setTimeout(done, 50));
			}
		}
	};

	const launch = async (resumeId?: string): Promise<void> => {
		ownedMcp.clear();
		const next = await startNativeServer({
			provider,
			cwd: opts.cwd,
			access,
			unsandboxed: opts.unsandboxed === true,
			sessionId,
			actorId,
			bindingGeneration,
		});
		try {
			const nextCatalog = await loadCatalog(next.api, opts.cwd, opts.settings.forbiddenModels);
			let info: Record<string, unknown>;
			if (resumeId) {
				try {
					info = dataOf(await next.api.request("GET", sessionPath(resumeId)));
				} catch (error) {
					throw new ResumeFailedError(resumeId, error);
				}
				if (info.id !== resumeId || record(info.location).directory !== opts.cwd)
					throw new ResumeFailedError(resumeId, new Error("OpenCode session identity or directory differs"));
			} else {
				info = dataOf(
					await next.api.request("POST", "/api/session", {
						location: { directory: opts.cwd },
						agent: nextCatalog.defaultAgent,
						model: nextCatalog.defaultModel,
					}),
				);
			}
			const id = string(info.id);
			if (!id) throw new Error("OpenCode V2 did not provide a session ID");
			let selected: ModelRef =
				isRecord(info.model) && typeof info.model.id === "string" && typeof info.model.providerID === "string"
					? {
							id: info.model.id,
							providerID: info.model.providerID,
							...(typeof info.model.variant === "string" ? { variant: info.model.variant } : {}),
						}
					: nextCatalog.defaultModel;
			if (resumeId && !desiredModelId && !isRecord(info.model))
				throw new ResumeFailedError(
					resumeId,
					new Error("Saved OpenCode model is missing; refusing a default model substitution"),
				);
			const requested = desiredModelId;
			if (requested) {
				if (opts.settings.forbiddenModels.includes(requested)) throw new ForbiddenModelError(requested);
				selected = parseModel(requested, nextCatalog);
				if (modelId(selected) !== modelId(record(info.model) as unknown as ModelRef))
					await next.api.request("POST", `${sessionPath(id)}/model`, { model: selected });
			}
			server = next;
			vendorSessionId = id;
			catalog = nextCatalog;
			model = selected;
			agent = string(info.agent) ?? nextCatalog.defaultAgent;
			await reconcileTools(false);
			void next.exited.then((exit) => {
				if (closed || server !== next) return;
				closed = true;
				const turnId = openTurnId;
				activeAbort?.abort();
				clearTurn();
				push({ type: "interrupted", ...(turnId ? { turnId } : {}), exit });
				endStream();
			});
		} catch (error) {
			await next.close().catch(() => undefined);
			throw error;
		}
	};

	await launch(opts.resumeVendorSessionId);

	async function runPrompt(turnId: TurnId, text: string, attachments: PromptAttachment[]): Promise<void> {
		const api = server?.api;
		if (!api) throw new SessionClosedError();
		const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
		const prepared = promptPayload(text, attachments, messageId);
		const abort = new AbortController();
		activeAbort = abort;
		const tools = new Map<string, ToolState>();
		let started = false;
		let assistantId: string | undefined;
		let finish: string | undefined;
		let failure: string | undefined;
		let failureType: string | undefined;
		let terminal: "succeeded" | "failed" | "interrupted" | undefined;
		let submitted = false;
		try {
			await reconcileTools();
			const stream = api.events(abort.signal)[Symbol.asyncIterator]();
			const first = await stream.next();
			if (first.done) throw new Error("OpenCode V2 event stream closed before prompt admission");
			const consume = (async () => {
				for (;;) {
					const next = await stream.next();
					if (next.done)
						throw new Error(
							"OpenCode V2 event stream disconnected during prompt execution; delivery is uncertain",
						);
					const event = next.value;
					const data = event.data;
					if (data.sessionID !== vendorSessionId) continue;
					if (event.type === "permission.asked") {
						const action = string(data.action) ?? "";
						const reply =
							opts.unsandboxed ||
							access === "readWrite" ||
							[
								"execute",
								"read",
								"search",
								"fetch",
								"external_directory",
								"bash",
								"shell",
								"grep",
								"glob",
								"webfetch",
								"websearch",
							].includes(action)
								? "once"
								: "reject";
						try {
							const message = string(data.message);
							await opts.onPermissionRequest?.(
								{
									id: string(data.id) ?? "",
									action,
									resources: Array.isArray(data.resources)
										? data.resources
												.filter((value): value is string => typeof value === "string")
												.slice(0, 32)
										: [],
									...(message === undefined ? {} : { message }),
								},
								reply,
							);
						} catch {
							// Preserve the current native permission policy if Me audit persistence is unavailable.
						}
						await api.request(
							"POST",
							`${sessionPath(vendorSessionId)}/permission/${encodeURIComponent(string(data.id) ?? "")}/reply`,
							{ reply },
						);
						continue;
					}
					if (event.type === "form.created") {
						const form = record(data.form);
						if (form.sessionID === vendorSessionId)
							await api
								.request(
									"POST",
									`${sessionPath(vendorSessionId)}/form/${encodeURIComponent(string(form.id) ?? "")}/cancel`,
								)
								.catch(() => undefined);
						continue;
					}
					if (event.type === "session.inbox.delivered" && data.inboxID === messageId) {
						started = true;
						continue;
					}
					if (!started) continue;
					if (event.type === "session.text.delta" && typeof data.delta === "string") {
						assistantId = string(data.assistantMessageID) ?? assistantId;
						block({ role: "agent", kind: "text", text: data.delta }, turnId);
					} else if (event.type === "session.reasoning.delta" && typeof data.delta === "string") {
						assistantId = string(data.assistantMessageID) ?? assistantId;
						block({ role: "agent", kind: "thought", text: data.delta }, turnId);
					} else if (event.type === "session.tool.input.started" && typeof data.id === "string") {
						const name = string(data.name) ?? "tool";
						tools.set(data.id, { name, input: {} });
						block(
							{
								role: "agent",
								kind: "tool",
								text: name,
								data: { toolCallId: data.id, status: "pending" },
								key: `tool:${data.id}`,
							},
							turnId,
						);
					} else if (event.type === "session.tool.called" && typeof data.id === "string") {
						const current = tools.get(data.id) ?? { name: "tool", input: {} };
						current.input = record(data.input);
						tools.set(data.id, current);
						block(
							{
								role: "agent",
								kind: "tool",
								text: string(current.input.command) ?? current.name,
								data: { toolCallId: data.id, status: "in_progress" },
								key: `tool:${data.id}`,
							},
							turnId,
						);
					} else if (
						(event.type === "session.tool.success" || event.type === "session.tool.failed") &&
						typeof data.id === "string"
					) {
						const current = tools.get(data.id) ?? { name: "tool", input: {} };
						tools.delete(data.id);
						block(
							{
								role: "agent",
								kind: "tool",
								text: string(current.input.command) ?? current.name,
								data: {
									toolCallId: data.id,
									status: event.type === "session.tool.success" ? "completed" : "failed",
								},
								key: `tool:${data.id}`,
							},
							turnId,
						);
					} else if (event.type === "session.step.ended") {
						assistantId = string(data.assistantMessageID) ?? assistantId;
						finish = string(data.finish);
					} else if (event.type === "session.execution.failed") {
						failure = string(record(data.error).message) ?? "OpenCode execution failed";
						failureType = string(record(data.error).type);
						terminal = "failed";
						return;
					} else if (event.type === "session.execution.interrupted") {
						terminal = "interrupted";
						return;
					} else if (event.type === "session.execution.succeeded") {
						terminal = "succeeded";
						return;
					}
				}
			})();
			void consume.catch(() => undefined);
			submitted = true;
			await api.request("POST", `${sessionPath(vendorSessionId)}/${prepared.path}`, prepared.body);
			await consume;
			if (assistantId) {
				const info = dataOf(
					await api.request("GET", `${sessionPath(vendorSessionId)}/message/${encodeURIComponent(assistantId)}`),
				);
				const tokens = record(info.tokens);
				const cache = record(tokens.cache);
				const input = number(tokens.input) ?? 0;
				const output = number(tokens.output) ?? 0;
				const reasoning = number(tokens.reasoning) ?? 0;
				const read = number(cache.read) ?? 0;
				const write = number(cache.write) ?? 0;
				if (input + output + reasoning + read + write > 0)
					block(
						{
							role: "agent",
							kind: "usage",
							text: `${input + output + reasoning + read + write} tokens`,
							data: {
								inputTokens: input,
								outputTokens: output,
								totalTokens: input + output + reasoning + read + write,
								thoughtTokens: reasoning,
								cachedReadTokens: read,
								cachedWriteTokens: write,
							},
							key: "usage",
						},
						turnId,
					);
				const error = record(info.error);
				if (typeof error.message === "string") failure = error.message;
				failureType = string(error.type) ?? failureType;
			}
			if (terminal === "failed" && !cancelled) {
				const advice = failureType === "provider.auth" ? " Use /connect to repair authentication." : "";
				block(
					{
						role: "agent",
						kind: "status",
						text: `${modelId(model)} failed: ${failure ?? failureType ?? "OpenCode execution failed"}.${advice} The selected model and session are retained; inspect the transcript before resuming.`,
					},
					turnId,
				);
			}
			const stopReason =
				cancelled || terminal === "interrupted"
					? "cancelled"
					: terminal === "failed"
						? "error"
						: finish === "length"
							? "max_tokens"
							: finish === "content-filter"
								? "refusal"
								: "end_turn";
			push({ type: "turnEnd", turnId, stopReason, cancelled: stopReason === "cancelled" });
		} catch (error) {
			if (openTurnId !== turnId || closed) return;
			const message = error instanceof Error ? error.message : String(error);
			if (submitted && terminal === undefined) {
				block(
					{
						role: "agent",
						kind: "status",
						text: `${message}. The private OpenCode server was stopped; inspect the saved conversation before retrying.`,
					},
					turnId,
				);
				push({ type: "turnEnd", turnId, stopReason: "error", cancelled: false });
				clearTurn();
				await server?.close().catch(() => undefined);
				return;
			}
			block({ role: "agent", kind: "status", text: message }, turnId);
			push({ type: "turnEnd", turnId, stopReason: "error", cancelled: false });
		} finally {
			abort.abort();
			if (activeAbort === abort) activeAbort = undefined;
			if (openTurnId === turnId) clearTurn();
		}
	}

	const session: RuntimeSession = {
		get nativeAttachment() {
			return server
				? {
						url: server.api.url,
						authorization: server.api.authorization,
						apiVersion: 2 as const,
						contract: openCodeExecutionContract({
							version: 1,
							runtime: "opencode-native",
							resume: "exact-provider-session",
							instructions: "system-per-request",
							instructionAcknowledgment: "local-request-hook",
							modelVariants: "catalog-validated",
							readiness: "configured-connection-not-authentication-proof",
							leaderAccess: "unrestricted",
							workerShellAccess: "instruction-guided",
							workerEditAccess: "assigned-permission-policy",
							delegation: "neta-owned",
						}),
						sessionId: vendorSessionId,
						directory: opts.cwd,
					}
				: undefined;
		},
		get sessionId() {
			return sessionId;
		},
		get bindingGeneration() {
			return bindingGeneration;
		},
		get vendorSessionId() {
			return vendorSessionId;
		},
		get provider() {
			return "opencode";
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
		get fallbackModels() {
			return opts.fallbackModels;
		},
		get model() {
			return modelId(model);
		},
		get openTurnId() {
			return openTurnId;
		},
		get configOptions() {
			return configOptions(catalog, model, agent);
		},
		get promptCapabilities() {
			return { image: true, embeddedContext: true };
		},
		get steeringSupported() {
			return false;
		},
		prompt(text, attachments = []) {
			if (closed) throw new SessionClosedError();
			if (openTurnId) throw new TurnInProgressError(openTurnId);
			const turnId = ulid();
			openTurnId = turnId;
			seq = 0;
			last = undefined;
			keyed.clear();
			cancelled = false;
			const turn: Turn = { id: turnId, sessionId, startedAt: nowIso(), role: "user", bindingGeneration };
			push({ type: "turn", turn });
			void runPrompt(turnId, text, attachments);
			return turnId;
		},
		async steer() {
			return "promptRequired";
		},
		async cancel() {
			if (!openTurnId || !server) return;
			cancelled = true;
			try {
				await server.api.request("POST", `${sessionPath(vendorSessionId)}/interrupt`);
			} catch {
				await server.close().catch(() => undefined);
			}
		},
		listModels(): ModelOption[] {
			return catalog.models.map((item) => ({ id: `${item.providerID}/${item.id}`, name: item.name }));
		},
		async setModel(wanted) {
			if (closed || !server) throw new SessionClosedError();
			if (opts.settings.forbiddenModels.includes(wanted)) throw new ForbiddenModelError(wanted);
			const selected = parseModel(wanted, catalog);
			await server.api.request("POST", `${sessionPath(vendorSessionId)}/model`, { model: selected });
			model = selected;
			desiredModelId = wanted;
			push({ type: "model", model: modelId(model) });
		},
		async setConfigOption(id, value) {
			if (closed || !server) throw new SessionClosedError();
			if (id === "neta_refresh_tools" && value === "") {
				await reconcileTools();
				return;
			}
			if (id === "neta_refresh_models" && value === "") {
				catalog = await loadCatalog(server.api, opts.cwd, opts.settings.forbiddenModels);
				return;
			}
			if (id === "model" && typeof value === "string") {
				await session.setModel(value);
				return;
			}
			if (id === "neta_effort" && value === "") {
				const { variant: _variant, ...base } = model;
				model = base;
				await server.api.request("POST", `${sessionPath(vendorSessionId)}/model`, { model });
				return;
			}
			if (id === "effort" && typeof value === "string") {
				const current = catalog.models.find((item) => item.providerID === model.providerID && item.id === model.id);
				if (value !== "default" && !current?.variants.some((item) => item.id === value))
					throw new Error(`Invalid effort: ${value}`);
				model = { ...model, variant: value };
				await server.api.request("POST", `${sessionPath(vendorSessionId)}/model`, { model });
				return;
			}
			if (id === "mode" && typeof value === "string") {
				if (!catalog.agents.some((item) => item.id === value)) throw new Error(`Invalid agent: ${value}`);
				await server.api.request("POST", `${sessionPath(vendorSessionId)}/agent`, { agent: value });
				agent = value;
				push({ type: "mode", modeId: agent });
				return;
			}
			throw new Error(`Invalid OpenCode configuration option: ${id}`);
		},
		async relaunch(nextAccess: Access) {
			if (closed) throw new SessionClosedError();
			if (openTurnId) {
				await session.cancel();
				await new Promise<void>((done) => turnWaiters.push(done));
			}
			const previous = server;
			server = undefined;
			await previous?.close();
			access = nextAccess;
			bindingGeneration = randomUUID();
			await launch(vendorSessionId);
		},
		async close() {
			if (closed) return;
			closed = true;
			activeAbort?.abort();
			if (openTurnId) {
				push({ type: "interrupted", turnId: openTurnId, exit: { code: null, signal: "SIGTERM", at: nowIso() } });
				clearTurn();
			}
			await server?.close().catch(() => undefined);
			endStream();
		},
		events() {
			if (iteratorTaken) throw new SessionClosedError();
			iteratorTaken = true;
			return {
				async next(): Promise<IteratorResult<SessionEvent>> {
					const value = queue.shift();
					if (value) return { value, done: false };
					if (streamEnded) return { value: undefined, done: true };
					return await new Promise((done) => takers.push(done));
				},
				[Symbol.asyncIterator]() {
					return this;
				},
			};
		},
	};
	return session;
}
