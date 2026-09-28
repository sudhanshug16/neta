// Conversation handlers: tail, prompt, cancel, models, and `turn`
// subscriptions. The store port pages forward only, so `tail` with a `turnId`
// or `direction: "backward"` pages through the port and assembles the window.
// Port cursors are decimal block seqs, minted by the store and passed back
// verbatim; the adapter in `lifecycle.ts` honors the same convention.

import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { distinctMissionLead } from "../core/mission-lead.ts";
import type { Block, PromptAttachment, Turn } from "../core/types.ts";
import { ME_CURATOR_INSTRUCTIONS } from "../me/curator.ts";
import { openMeStore } from "../me/store.ts";
import { startOpenCodeGateway } from "../opencode/gateway.ts";
import { composeContext, loadCharter, loadSkills } from "../tools/context.ts";
import { netaBuildId } from "../version.ts";
import {
	filterSessionIds,
	meHandlers,
	openFilterSession,
	WORKSPACE_LEADER_EFFORT,
	workspaceForLeaderSession,
} from "./handlers-me.ts";
import { asOptionalNumber, asOptionalString, asString, parseParams } from "./handlers-registry.ts";
import { NodeError } from "./protocol.ts";
import type { NodeContext, NodeHandlers } from "./server.ts";

const READ_PAGE = 200;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES = 5 * 1024 * 1024;

function asAttachments(value: unknown, name: string): PromptAttachment[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS)
		throw new NodeError("INVALID_PARAMS", `${name} must contain at most ${MAX_ATTACHMENTS} attachments`);
	const out: PromptAttachment[] = [];
	const ids = new Set<string>();
	let total = 0;
	for (const [index, raw] of value.entries()) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw))
			throw new NodeError("INVALID_PARAMS", `${name}[${index}] must be an object`);
		const item = raw as Record<string, unknown>;
		const id = asString(item.id, `${name}[${index}].id`);
		const kind = asString(item.kind, `${name}[${index}].kind`);
		const attachmentName = asString(item.name, `${name}[${index}].name`);
		const mimeType = asString(item.mimeType, `${name}[${index}].mimeType`);
		const dataBase64 = asString(item.dataBase64, `${name}[${index}].dataBase64`);
		if (id === "" || ids.has(id)) throw new NodeError("INVALID_PARAMS", `${name} ids must be unique and non-empty`);
		if (kind !== "image" && kind !== "file")
			throw new NodeError("INVALID_PARAMS", `${name}[${index}].kind is invalid`);
		if (
			attachmentName === "" ||
			attachmentName.length > 255 ||
			[...attachmentName].some((character) => character.charCodeAt(0) < 32)
		)
			throw new NodeError("INVALID_PARAMS", `${name}[${index}].name is invalid`);
		if (!/^[\w.+-]+\/[\w.+-]+$/u.test(mimeType))
			throw new NodeError("INVALID_PARAMS", `${name}[${index}].mimeType is invalid`);
		if (kind === "image" && !mimeType.startsWith("image/"))
			throw new NodeError("INVALID_PARAMS", `${name}[${index}] image must have an image MIME type`);
		if (dataBase64 === "" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(dataBase64))
			throw new NodeError("INVALID_PARAMS", `${name}[${index}].dataBase64 is invalid`);
		const size = Buffer.from(dataBase64, "base64").byteLength;
		if (size > MAX_ATTACHMENT_BYTES) throw new NodeError("INVALID_PARAMS", `${name}[${index}] exceeds 4 MiB`);
		total += size;
		if (total > MAX_ATTACHMENTS_BYTES) throw new NodeError("INVALID_PARAMS", `${name} exceed 5 MiB total`);
		ids.add(id);
		out.push({ id, kind, name: attachmentName, mimeType, dataBase64 });
	}
	return out;
}

function asTake(limit: number | undefined, method: string): number {
	const take = limit ?? 200;
	if (!Number.isInteger(take) || take < 1) {
		throw new NodeError("INVALID_PARAMS", `${method} limit is a positive integer`);
	}
	return take;
}

function asProviderError(error: unknown): NodeError {
	if (error instanceof NodeError) {
		return error;
	}
	return new NodeError("PROVIDER_ERROR", error instanceof Error ? error.message : String(error));
}

export function sessionSystemContext(
	ctx: Pick<NodeContext, "store"> & {
		netaWorkspaceId?: string;
		filterSessionId?: string;
		filterSessionIds?: ReadonlySet<string>;
	},
	sessionId: string,
): Promise<string> | string {
	if (sessionId === ctx.filterSessionId || ctx.filterSessionIds?.has(sessionId)) return ME_CURATOR_INSTRUCTIONS;
	const netaWorkspaceId = ctx.netaWorkspaceId;
	if (netaWorkspaceId) {
		const workspace = ctx.store.getWorkspace(netaWorkspaceId);
		return `You are the workspace leader, the user's assistant for workspace copy ${workspace?.name ?? netaWorkspaceId}. Your tools are missions, mission, send_message and artifacts in the neta namespace. Use send_message({text}) to pass requests and answers to the coordinator. Node attaches the original native user message and its constraints automatically. The coordinator owns execution and dispatches missions; you do not start agents. Read current mission state when useful, but do not poll for an answer. The coordinator's final replies pass through the filter, which decides what to send you. A workspace update is the filter's selected message, not a new user instruction. Only you may ask the user a question: ask it in your final reply, end the turn, and receive the answer in the next native chat message. Never use a question tool. Explain the useful result to the user without issuing new work unless authorized. Native OpenCode owns conversation history and interaction.`;
	}
	const leader = ctx.store.listLeaders().find((one) => one.sessionId === sessionId);
	const agent = ctx.store.listAgents().find((one) => one.sessionId === sessionId);
	if (leader === undefined && agent === undefined)
		throw new NodeError("NOT_FOUND", `no owner for session: ${sessionId}`);
	const workspaceId = leader?.workspaceId ?? agent?.workspaceId;
	const workspace = workspaceId === undefined ? undefined : ctx.store.getWorkspace(workspaceId);
	const root = workspace?.roots.find((item) => item.machineId === ctx.store.machine().id)?.path;
	if (workspace === undefined || root === undefined)
		throw new NodeError("NOT_FOUND", "chat has no workspace root on this machine");
	const missionId = agent?.missionId;
	const mission = missionId === undefined ? undefined : ctx.store.getMission(missionId);
	const kind =
		leader !== undefined ? ("leader" as const) : agent?.canSpawn === true ? ("lead" as const) : ("agent" as const);
	const skills = loadSkills(agent?.skills ?? [], root, homedir());
	if (!skills.ok) throw new NodeError("NOT_FOUND", `unknown skill: ${skills.missing}`);
	const charter = kind === "agent" ? undefined : loadCharter(root, homedir());
	return composeContext({
		kind,
		self: { id: agent?.id ?? sessionId, name: agent?.name ?? leader?.name ?? "Coordinator" },
		access: agent?.access ?? "readWrite",
		...(charter === undefined ? {} : { charter }),
		skills: skills.skills,
		...(mission === undefined ? {} : { mission }),
		...(agent === undefined ? {} : { task: agent.task }),
	});
}

// Restoring a tab must not prompt the actor or create a replacement conversation.
const restoringNative = new Map<string, Promise<void>>();
export async function restoreNativeOwner(ctx: NodeContext, sessionId: string): Promise<void> {
	const pending = restoringNative.get(sessionId);
	if (pending) return pending;
	const restore = (async () => {
		const savedAgent = ctx.store.listAgents().find((item) => item.sessionId === sessionId);
		const savedMissionId = savedAgent?.missionId;
		const savedMission = savedMissionId ? ctx.store.getMission(savedMissionId) : undefined;
		const workspaceLeader = savedMission ? ctx.store.getLeader(savedMission.workspaceId) : undefined;
		if (
			savedAgent &&
			savedMission &&
			savedMission.state !== "closed" &&
			!distinctMissionLead(
				savedMission,
				workspaceLeader,
				savedMission.lead.kind === "agent" ? ctx.store.getAgent(savedMission.lead.agentId) : undefined,
			)
		) {
			throw new NodeError(
				"INVALID_PARAMS",
				`Mission #${savedMission.number} has the coordinator assigned as mission lead. Close it and create a new mission with a separate lead task and effort; its saved history remains available.`,
			);
		}
		try {
			if (ctx.runtime.nativeAttachment?.(sessionId)) return;
		} catch (error) {
			if (!(error instanceof NodeError) || error.symbol !== "NOT_FOUND") throw error;
		}
		const leader = ctx.store.listLeaders().find((item) => item.sessionId === sessionId);
		const agent = ctx.store.listAgents().find((item) => item.sessionId === sessionId);
		const owner = agent ?? leader;
		if (!owner)
			throw new NodeError("NOT_FOUND", "This saved conversation no longer has an owner. Open the coordinator.");
		if (agent?.state === "queued") throw new NodeError("BUSY", `${agent.name} is queued and has not started yet.`);
		const workspace = ctx.store.getWorkspace(owner.workspaceId);
		const root = workspace?.roots.find((item) => item.machineId === ctx.store.machine().id)?.path;
		if (!root) throw new NodeError("NOT_FOUND", "The conversation's workspace is unavailable on this machine.");
		const missionId = agent?.missionId;
		const mission = missionId ? ctx.store.getMission(missionId) : undefined;
		const cwd = agent ? (mission?.worktree?.path ?? root) : root;
		if (cwd === mission?.worktree?.path) {
			const directory = await stat(cwd).catch((error: unknown) => {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
				throw error;
			});
			if (!directory?.isDirectory())
				throw new NodeError(
					"NOT_FOUND",
					`${owner.name}'s worktree is no longer available: ${cwd}. Its saved conversation has been retained.`,
				);
		}
		await ctx.runtime.ensureSession({
			sessionId,
			workspaceId: owner.workspaceId,
			cwd,
			provider: owner.provider,
			model: owner.model,
			variant: agent?.variant,
			access: agent?.access ?? "readWrite",
			unsandboxed: !agent || agent.canSpawn,
			netaTools: true,
			actorId: agent?.id,
			allowFresh: false,
		});
	})();
	restoringNative.set(sessionId, restore);
	try {
		await restore;
	} finally {
		if (restoringNative.get(sessionId) === restore) restoringNative.delete(sessionId);
	}
}

export async function prepareHandoffForSession(ctx: Pick<NodeContext, "store">, sessionId: string): Promise<string> {
	const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);
	const leader = ctx.store.listLeaders().find((one) => one.sessionId === sessionId);
	const agent = ctx.store.listAgents().find((one) => one.sessionId === sessionId);
	if (leader === undefined && agent === undefined)
		throw new NodeError("NOT_FOUND", `no owner for session: ${sessionId}`);
	const missionId = agent?.missionId;
	const mission = missionId === undefined ? undefined : ctx.store.getMission(missionId);
	const recent =
		ctx.store.recentConversation === undefined
			? (await ctx.store.tailConversation(sessionId, { limit: 40 })).blocks
			: await ctx.store.recentConversation(sessionId, 40);
	const messages = recent
		.filter((block) => block.kind === "text" && (block.role === "user" || block.role === "agent"))
		.slice(-16);
	const lines = ["# Neta provider handoff", "", `- Neta session: \`${sessionId}\``];
	if (leader !== undefined) {
		const open = ctx.store.listMissions(leader.workspaceId).filter((item) => item.state !== "closed");
		if (open.length > 0) {
			lines.push(
				"",
				"## Open workspace missions",
				"",
				...open
					.slice(0, 12)
					.map((item) => `- \`${item.id}\` #${item.number} ${clip(item.name, 80)} — ${item.state}`),
			);
		}
	}
	if (mission !== undefined) {
		lines.push(
			`- Mission: \`${mission.id}\` — ${mission.name}`,
			`- Objective: ${clip(mission.objective, 800)}`,
			`- State: ${mission.state}`,
			`- Access ceiling: ${mission.access}`,
		);
		if (mission.worktree !== undefined) lines.push(`- Worktree: \`${mission.worktree.path}\``);
	}
	lines.push(
		"",
		"## Recent conversation",
		"",
		...messages.flatMap((block) => [
			`### ${block.role === "user" ? "User" : "Assistant"} · turn \`${block.turnId}\``,
			"",
			clip(block.text, 300),
			"",
		]),
		"Use `mission_state` for current missions. Native chat contains earlier messages.",
	);
	return clip(lines.join("\n").trim(), 12_000);
}

async function prepareHandoff(ctx: NodeContext, sessionId: string): Promise<string> {
	return prepareHandoffForSession(ctx, sessionId);
}

interface Collected {
	blocks: Block[];
	turns: Turn[];
	provider: string;
	model: string;
	ended: boolean;
}

// Pages forward from the start until the whole prefix is covered: every
// block below `below` (or the whole history when `below` is undefined) plus
// `extra` blocks past it so the window end is known. An empty page with a
// nextCursor would loop forever, so it ends the scan.
async function collectPrefix(
	ctx: NodeContext,
	sessionId: string,
	below: number | undefined,
	extra: number,
): Promise<Collected> {
	const blocks: Block[] = [];
	const turns: Turn[] = [];
	let provider = "";
	let model = "";
	let cursor: string | undefined;
	let ended = false;
	for (;;) {
		const page = await ctx.store.tailConversation(sessionId, { limit: READ_PAGE, cursor });
		provider = page.provider;
		model = page.model;
		turns.push(...page.turns);
		blocks.push(...page.blocks);
		if (page.blocks.length === 0 || page.nextCursor === undefined) {
			ended = true;
			break;
		}
		if (below !== undefined) {
			const past = blocks.filter((block) => block.seq >= below).length;
			if (blocks.length > 0 && (blocks[blocks.length - 1]?.seq ?? 0) >= below && past >= extra) {
				break;
			}
		}
		cursor = page.nextCursor;
	}
	return { blocks, turns, provider, model, ended };
}

interface Window {
	turns: Turn[];
	blocks: Block[];
	prevCursor: string | null;
	nextCursor?: string;
}

// The window is `collected.blocks[start, end)`; prevCursor identifies the
// block immediately before its first block (null at the start of history) and nextCursor
// resumes a forward tail right after its last block, absent at the end.
function assembleWindow(collected: Collected, start: number, end: number): Window {
	const windowBlocks = collected.blocks.slice(start, end);
	const turnIds = new Set(windowBlocks.map((block) => block.turnId));
	const windowTurns = collected.turns.filter((turn) => turnIds.has(turn.id));
	const prevCursor = start > 0 ? String(collected.blocks[start - 1]?.seq ?? 0) : null;
	let nextCursor: string | undefined;
	if (windowBlocks.length > 0 && (end < collected.blocks.length || !collected.ended)) {
		nextCursor = String(windowBlocks[windowBlocks.length - 1]?.seq ?? 0);
	}
	return { turns: windowTurns, blocks: windowBlocks, prevCursor, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

export const conversationHandlers: NodeHandlers = {
	"runtime.capabilities": async (ctx) => ({
		runtimeBuild: netaBuildId(),
		...(ctx.runtimeAdmission ? { instanceId: ctx.runtimeAdmission.instanceId, runtimeUpgrade: 1 } : {}),
		activeSessionIds: [...ctx.store.listLeaders(), ...ctx.store.listAgents()]
			.filter((actor) => ctx.runtime.isTurnActive?.(actor.sessionId))
			.map((actor) => actor.sessionId),
		nativeOpenCode: 1,
		nativeOpenCodeVersions: [1, 2],
		nativeOpenCodeRevision: 9,
	}),
	"conversation.native": async (ctx, params, conn) => {
		const parsed = parseParams({ sessionId: asString }, params);
		const workspaceLeaderIdentity = await openMeStore().workspaceLeaderBySession(parsed.sessionId);
		const neta = workspaceLeaderIdentity?.workspaceId !== undefined;
		const filter = await openMeStore().filterBySession(parsed.sessionId);
		const leader = ctx.store.listLeaders().find((one) => one.sessionId === parsed.sessionId);
		if (leader?.state === "failed" && leader.startupError) throw new NodeError("PROVIDER_ERROR", leader.startupError);
		if (workspaceLeaderIdentity?.workspaceId)
			await meHandlers["workspace-leader.open"]?.(ctx, { workspaceId: workspaceLeaderIdentity.workspaceId }, conn);
		else if (filter) await openFilterSession(ctx, filter.workspaceId);
		else await restoreNativeOwner(ctx, parsed.sessionId);
		const attachment = ctx.runtime.ensureNativeAttachment
			? await ctx.runtime.ensureNativeAttachment(parsed.sessionId)
			: ctx.runtime.nativeAttachment?.(parsed.sessionId);
		if (attachment === undefined)
			throw new NodeError(
				"PROVIDER_ERROR",
				"This conversation uses a legacy runtime. Start an OpenCode conversation to use native chat.",
			);
		const send = conversationHandlers["conversation.prompt"];
		const cancel = conversationHandlers["conversation.cancel"];
		const setModel = conversationHandlers["conversation.setModel"];
		if (!send || !cancel || !setModel)
			throw new NodeError("INTERNAL", "Native conversation handlers are unavailable");
		const gateway = await startOpenCodeGateway({
			attachment,
			isCurrent: () => {
				try {
					return ctx.runtime.nativeAttachment?.(parsed.sessionId)?.url === attachment.url;
				} catch {
					return false;
				}
			},
			configure: async (input) => {
				if (neta) {
					const identity = workspaceLeaderIdentity;
					if (input.model && input.model !== identity.model)
						throw new NodeError("INVALID_PARAMS", "Workspace leader uses its saved model");
					if (input.variant && input.variant !== WORKSPACE_LEADER_EFFORT)
						throw new NodeError("INVALID_PARAMS", "Workspace leader uses medium effort");
					if (input.agent) await ctx.runtime.setNativeAgent?.(parsed.sessionId, input.agent);
					return;
				}
				if (filter) {
					if (input.model && input.model !== filter.model) {
						await ctx.runtime.setModel(parsed.sessionId, input.model);
						await openMeStore().bindFilterRuntime({
							workspaceId: filter.workspaceId,
							provider: "opencode",
							model: input.model,
						});
						filter.model = input.model;
					}
					if (input.model) await ctx.runtime.setNativeVariant?.(parsed.sessionId, input.variant);
					if (input.agent) await ctx.runtime.setNativeAgent?.(parsed.sessionId, input.agent);
					return;
				}
				if (input.model) {
					const model = input.model;
					const current =
						ctx.store.listLeaders().find((one) => one.sessionId === parsed.sessionId) ??
						ctx.store.listAgents().find((one) => one.sessionId === parsed.sessionId);
					if (current?.model !== model) await setModel(ctx, { sessionId: parsed.sessionId, model }, conn);
				}
				if (input.model) {
					await ctx.runtime.setNativeVariant?.(parsed.sessionId, input.variant);
					const agent = ctx.store.listAgents().find((one) => one.sessionId === parsed.sessionId);
					if (agent && agent.variant !== input.variant) {
						const updated = {
							...agent,
							variant: input.variant,
							routing: agent.routing ? { ...agent.routing, selectedVariant: input.variant } : undefined,
						};
						await ctx.store.putAgent(updated);
						ctx.hub.broadcast("state", { kind: "agent", record: updated });
					}
				}
				if (input.agent) await ctx.runtime.setNativeAgent?.(parsed.sessionId, input.agent);
			},
			prompt: async (input) => {
				if (neta || filter) {
					if (!ctx.runtime.send) throw new NodeError("METHOD_NOT_FOUND", "Chat message delivery is unavailable");
					const message = await ctx.runtime.send(parsed.sessionId, input.text, input.attachments, {
						readerDirected: true,
						sourceId: `native-user:${input.messageId ?? randomUUID()}`,
						sourceHash: input.messageHash ?? createHash("sha256").update(input.text).digest("hex"),
					});
					return {
						messageId: message.id,
						status: message.status,
						...(message.turnId ? { turnId: message.turnId } : {}),
					};
				}
				if (attachment.apiVersion !== 2) {
					if (input.model) {
						const model = input.model;
						const current =
							ctx.store.listLeaders().find((one) => one.sessionId === parsed.sessionId) ??
							ctx.store.listAgents().find((one) => one.sessionId === parsed.sessionId);
						if (current?.model !== model) await setModel(ctx, { sessionId: parsed.sessionId, model }, conn);
					}
					await ctx.runtime.setNativeVariant?.(parsed.sessionId, input.variant);
					if (input.agent) await ctx.runtime.setNativeAgent?.(parsed.sessionId, input.agent);
				}
				return send(
					ctx,
					{
						...parsed,
						text: input.text,
						attachments: input.attachments,
						messageId: input.messageId,
						messageHash: input.messageHash,
					},
					conn,
				);
			},
			cancel: () => cancel(ctx, parsed, conn),
		});
		conn.onClose?.(() => gateway.close());
		const { close: _close, ...native } = gateway;
		return { ...native, netaSessionId: parsed.sessionId, integrationVersion: attachment.apiVersion === 2 ? 2 : 1 };
	},
	"conversation.tail": async (ctx, params, conn) => {
		const parsed = parseParams(
			{
				sessionId: asString,
				limit: asOptionalNumber,
				cursor: asOptionalString,
				turnId: asOptionalString,
				direction: asOptionalString,
			},
			params,
		);
		const take = asTake(parsed.limit, "conversation.tail limit");
		const direction = parsed.direction ?? "forward";
		if (direction !== "forward" && direction !== "backward") {
			throw new NodeError("INVALID_PARAMS", "conversation.tail direction is forward or backward");
		}
		let cursorSeq: number | undefined;
		if (parsed.cursor !== undefined) {
			cursorSeq = Number.parseInt(parsed.cursor, 10);
			if (!Number.isInteger(cursorSeq) || cursorSeq < 0) {
				throw new NodeError("INVALID_PARAMS", "conversation.tail cursor is a block offset");
			}
		}
		if (parsed.turnId !== undefined) {
			const collected = await collectPrefix(ctx, parsed.sessionId, undefined, 0);
			const anchor = collected.turns.find((turn) => turn.id === parsed.turnId);
			const firstBlock = collected.blocks.findIndex((block) => block.turnId === parsed.turnId);
			if (anchor === undefined && firstBlock < 0) {
				throw new NodeError("NOT_FOUND", `no such turn: ${parsed.turnId}`);
			}
			// A turn with no blocks yet sits at the end of history, which
			// the full scan above already covers.
			const start = firstBlock < 0 ? collected.blocks.length : firstBlock;
			const window = assembleWindow(collected, start, start + take);
			conn.tailed.add(parsed.sessionId);
			return { sessionId: parsed.sessionId, provider: collected.provider, model: collected.model, ...window };
		}
		if (direction === "backward") {
			const collected = await collectPrefix(ctx, parsed.sessionId, cursorSeq, 1);
			const end =
				cursorSeq === undefined
					? collected.blocks.length
					: collected.blocks.findIndex((block) => block.seq > cursorSeq);
			const stop = end < 0 ? collected.blocks.length : end;
			const window = assembleWindow(collected, Math.max(0, stop - take), stop);
			conn.tailed.add(parsed.sessionId);
			return { sessionId: parsed.sessionId, provider: collected.provider, model: collected.model, ...window };
		}
		const page = await ctx.store.tailConversation(parsed.sessionId, { limit: take, cursor: parsed.cursor });
		// The read comes first and the subscribe second, so a block appended
		// during the read arrives as a notification instead of being lost.
		conn.tailed.add(parsed.sessionId);
		return { sessionId: parsed.sessionId, ...page };
	},

	"conversation.untail": (_ctx, params, conn) => {
		const parsed = parseParams({ sessionId: asString }, params);
		conn.tailed.delete(parsed.sessionId);
		return Promise.resolve({ sessionId: parsed.sessionId });
	},

	"conversation.prompt": async (ctx, params, conn) => {
		const parsed = parseParams(
			{
				sessionId: asString,
				text: asString,
				attachments: asAttachments,
				messageId: asOptionalString,
				messageHash: asOptionalString,
			},
			params,
		);
		const attachments = parsed.attachments ?? [];
		if (parsed.text.trim() === "" && attachments.length === 0)
			throw new NodeError("INVALID_PARAMS", "prompt needs text or an attachment");
		const capabilities = ctx.runtime.capabilities?.(parsed.sessionId) ?? { image: false, embeddedContext: false };
		if (attachments.some((item) => item.kind === "image") && !capabilities.image)
			throw new NodeError("PROVIDER_ERROR", "this provider does not support image prompts");
		if (attachments.some((item) => item.kind === "file") && !capabilities.embeddedContext)
			throw new NodeError("PROVIDER_ERROR", "this provider does not support embedded file prompts");
		try {
			if (ctx.runtime.send !== undefined) {
				const message = await ctx.runtime.send(parsed.sessionId, parsed.text, attachments, {
					readerDirected: conn.client === "desktop" || conn.client === "cli",
					...(parsed.messageId ? { sourceId: `user:${parsed.messageId}`, sourceHash: parsed.messageHash } : {}),
				});
				return {
					messageId: message.id,
					status: message.status,
					...(message.turnId === undefined ? {} : { turnId: message.turnId }),
				};
			}
			// Returns the turnId at once; blocks arrive only as notifications.
			const turnId = await ctx.runtime.prompt(parsed.sessionId, parsed.text, attachments, {
				readerDirected: conn.client === "desktop" || conn.client === "cli",
			});
			return { turnId };
		} catch (error) {
			throw asProviderError(error);
		}
	},

	"conversation.inbox": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString }, params);
		return { sessionId: parsed.sessionId, messages: (await ctx.runtime.listInbox?.(parsed.sessionId)) ?? [] };
	},

	"conversation.capabilities": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString }, params);
		return ctx.runtime.capabilities?.(parsed.sessionId) ?? { image: false, embeddedContext: false };
	},

	"conversation.cancel": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString }, params);
		try {
			await ctx.runtime.cancel(parsed.sessionId);
			return { sessionId: parsed.sessionId };
		} catch (error) {
			throw asProviderError(error);
		}
	},

	"conversation.setModel": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString, model: asString }, params);
		try {
			await ctx.runtime.setModel(parsed.sessionId, parsed.model);
			const leader = ctx.store.listLeaders().find((one) => one.sessionId === parsed.sessionId);
			if (leader !== undefined) {
				const updated = { ...leader, model: parsed.model };
				await ctx.store.putLeader(updated);
				ctx.hub.broadcast("state", { kind: "leader", record: updated });
			} else {
				const agent = ctx.store.listAgents().find((one) => one.sessionId === parsed.sessionId);
				if (agent !== undefined) {
					const updated = {
						...agent,
						model: parsed.model,
						variant: undefined,
						routing: agent.routing
							? {
									...agent.routing,
									method: "explicit" as const,
									selectedModel: parsed.model,
									selectedVariant: undefined,
									candidates: [parsed.model],
									reason: "Native model selection.",
									facts: undefined,
								}
							: undefined,
					};
					await ctx.store.putAgent(updated);
					ctx.hub.broadcast("state", { kind: "agent", record: updated });
				}
			}
			return { sessionId: parsed.sessionId, model: parsed.model };
		} catch (error) {
			throw asProviderError(error);
		}
	},

	"providers.list": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asOptionalString }, params);
		return { providers: ctx.runtime.listProviders?.(parsed) ?? [] };
	},

	"conversation.prepareHandoff": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString }, params);
		return { sessionId: parsed.sessionId, markdown: await prepareHandoff(ctx, parsed.sessionId) };
	},

	"conversation.setProvider": async (ctx, params) => {
		const parsed = parseParams(
			{ sessionId: asString, provider: asString, model: asOptionalString, handoff: asOptionalString },
			params,
		);
		const agent = ctx.store.listAgents().find((one) => one.sessionId === parsed.sessionId);
		if (agent !== undefined && (agent.state === "queued" || agent.state === "archived")) {
			throw new NodeError("INVALID_PARAMS", `cannot switch provider for ${agent.state} agent`);
		}
		const leader = ctx.store.listLeaders().find((one) => one.sessionId === parsed.sessionId);
		if (leader?.provider === "pi" && parsed.provider === "pi") {
			return {
				sessionId: leader.sessionId,
				provider: leader.provider,
				model: leader.model,
				contextReset: false as const,
			};
		}
		if (leader?.provider === "pi" && parsed.provider !== "pi" && ctx.pi !== undefined) {
			const workspace = ctx.store.getWorkspace(leader.workspaceId);
			const cwd = workspace?.roots.find((root) => root.machineId === ctx.store.machine().id)?.path;
			if (workspace === undefined || cwd === undefined)
				throw new NodeError("NOT_FOUND", "Pi leader has no workspace root on this machine");
			const target = ctx.runtime
				.listProviders?.({ sessionId: parsed.sessionId })
				.find((one) => one.id === parsed.provider);
			if (target === undefined || !target.available)
				throw new NodeError(
					"PROVIDER_ERROR",
					target?.unavailableReason ?? `provider ${parsed.provider} is unavailable`,
				);
			const selected = await ctx.runtime.createSession({
				sessionId: parsed.sessionId,
				workspaceId: leader.workspaceId,
				cwd,
				provider: parsed.provider,
				model: parsed.model ?? target.defaultModel,
				access: "readWrite",
				unsandboxed: true,
				netaTools: true,
			});
			try {
				await ctx.runtime.setPendingHandoff?.(parsed.sessionId, parsed.handoff ?? "");
				const updated = { ...leader, ...selected, state: "idle" as const };
				await ctx.store.putLeader(updated);
				ctx.hub.broadcast("state", { kind: "leader", record: updated });
			} catch (error) {
				await ctx.runtime.close(parsed.sessionId).catch(() => undefined);
				throw error;
			}
			ctx.pi.closeSession(parsed.sessionId);
			return { ...selected, contextReset: true as const };
		}
		if (ctx.runtime.switchProvider === undefined)
			throw new NodeError("PROVIDER_ERROR", "provider switching is unavailable");
		let switchAttempted = false;
		try {
			const handoff = parsed.handoff === undefined ? await prepareHandoff(ctx, parsed.sessionId) : parsed.handoff;
			switchAttempted = true;
			const selected = await ctx.runtime.switchProvider(parsed.sessionId, parsed.provider, parsed.model, handoff);
			const leader = ctx.store.listLeaders().find((one) => one.sessionId === parsed.sessionId);
			if (leader !== undefined) {
				const updated = { ...leader, provider: selected.provider, model: selected.model };
				await ctx.store.putLeader(updated);
				ctx.hub.broadcast("state", { kind: "leader", record: updated });
			} else if (agent !== undefined) {
				const updated = { ...agent, provider: selected.provider, model: selected.model };
				await ctx.store.putAgent(updated);
				ctx.hub.broadcast("state", { kind: "agent", record: updated });
			}
			return { sessionId: parsed.sessionId, ...selected, contextReset: true as const };
		} catch (error) {
			const failedLeader = ctx.store.listLeaders().find((one) => one.sessionId === parsed.sessionId);
			if (
				switchAttempted &&
				error instanceof NodeError &&
				error.symbol === "NOT_FOUND" &&
				failedLeader?.state === "failed"
			) {
				const target = ctx.runtime
					.listProviders?.({ sessionId: parsed.sessionId })
					.find((one) => one.id === parsed.provider);
				if (target === undefined || !target.available) {
					throw new NodeError(
						"PROVIDER_ERROR",
						target?.unavailableReason ?? `provider ${parsed.provider} is unavailable`,
					);
				}
				const workspace = ctx.store.getWorkspace(failedLeader.workspaceId);
				const machineId = ctx.store.machine().id;
				const cwd = workspace?.roots.find((root) => root.machineId === machineId)?.path;
				if (workspace === undefined || cwd === undefined) {
					throw new NodeError("NOT_FOUND", "failed leader has no workspace root on this machine");
				}
				try {
					const selected = await ctx.runtime.ensureSession({
						sessionId: failedLeader.sessionId,
						workspaceId: failedLeader.workspaceId,
						cwd,
						provider: parsed.provider,
						model: parsed.model ?? target.defaultModel,
						access: "readOnly",
						unsandboxed: true,
						netaTools: true,
						allowFresh: true,
						forceRelaunch: true,
					});
					const updated = { ...failedLeader, ...selected, state: "idle" as const };
					await ctx.store.putLeader(updated);
					ctx.hub.broadcast("state", { kind: "leader", record: updated });
					return { ...selected, contextReset: true as const };
				} catch (recoveryError) {
					throw asProviderError(recoveryError);
				}
			}
			throw asProviderError(error);
		}
	},

	"conversation.reset": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString }, params);
		const store = openMeStore();
		const neta = await store.workspaceLeaderBySession(parsed.sessionId);
		if (neta && !neta.workspaceId)
			throw new NodeError("INVALID_PARAMS", "This legacy workspace leader conversation has no workspace to rebind.");
		const resetSession = ctx.runtime.resetSession;
		if (resetSession === undefined) throw new NodeError("PROVIDER_ERROR", "chat reset is unavailable");
		const resetOne = async (sessionId: string) => {
			const neta = await store.workspaceLeaderBySession(sessionId);
			const filter = await store.filterBySession(sessionId);
			const leader = ctx.store.listLeaders().find((one) => one.sessionId === sessionId);
			const agent = ctx.store.listAgents().find((one) => one.sessionId === sessionId);
			if (agent !== undefined && (agent.state === "queued" || agent.state === "archived"))
				throw new NodeError("INVALID_PARAMS", `cannot reset chat for ${agent.state} agent`);
			const reset = async () =>
				resetSession(
					sessionId,
					neta ? "" : await sessionSystemContext({ ...ctx, filterSessionIds }, sessionId),
					async (next) => {
						if (neta?.workspaceId) {
							await store.resetWorkspaceLeaderSession(neta.workspaceId, sessionId, next.sessionId);
						} else if (filter) {
							await store.resetFilterSession(filter.workspaceId, sessionId, next.sessionId);
							filterSessionIds.delete(sessionId);
							filterSessionIds.add(next.sessionId);
						} else if (leader !== undefined) {
							const updated = {
								...leader,
								sessionId: next.sessionId,
								provider: next.provider,
								model: next.model,
							};
							await ctx.store.putLeader(updated);
							ctx.hub.broadcast("state", { kind: "leader", record: updated });
						} else if (agent !== undefined) {
							const updated = {
								...agent,
								sessionId: next.sessionId,
								provider: next.provider,
								model: next.model,
							};
							await ctx.store.putAgent(updated);
							ctx.hub.broadcast("state", { kind: "agent", record: updated });
						}
					},
				);
			try {
				return await reset();
			} catch (error) {
				if (neta?.workspaceId && error instanceof NodeError && error.symbol === "NOT_FOUND") {
					const open = meHandlers["workspace-leader.open"];
					if (!open) throw new NodeError("PROVIDER_ERROR", "Workspace leader session is unavailable");
					await open(ctx, { workspaceId: neta.workspaceId }, {} as never);
					return reset();
				}
				throw error;
			}
		};
		const leader = ctx.store.listLeaders().find((one) => one.sessionId === parsed.sessionId);
		const workspaceId = neta?.workspaceId ?? leader?.workspaceId;
		let resetAny = false;
		try {
			if (!workspaceId) return await resetOne(parsed.sessionId);
			const workspaceLeader = ctx.store.listLeaders().find((one) => one.workspaceId === workspaceId);
			if (!workspaceLeader) throw new NodeError("NOT_FOUND", "coordinator is unavailable");
			const workspaceNeta = (await store.listWorkspaceLeaderIdentities()).find(
				(one) => one.workspaceId === workspaceId,
			);
			const resetNeta = workspaceNeta ? await resetOne(workspaceNeta.sessionId) : undefined;
			if (resetNeta) resetAny = true;
			const resetLeader = await resetOne(workspaceLeader.sessionId);
			resetAny = true;
			return neta ? resetNeta : resetLeader;
		} catch (error) {
			throw asProviderError(error);
		} finally {
			if (workspaceId && resetAny) ctx.hub.broadcast("chats.reset", { workspaceId });
		}
	},

	"models.list": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asOptionalString, provider: asOptionalString }, params);
		try {
			const models = await ctx.runtime.listModels({ sessionId: parsed.sessionId, provider: parsed.provider });
			return { models };
		} catch (error) {
			throw asProviderError(error);
		}
	},
};

export function wireTurnStream(ctx: NodeContext): void {
	ctx.runtime.onTurn((notification) => {
		ctx.hub.toTail(notification.sessionId, notification);
		// Completion metadata must reach clients viewing another conversation too.
		if (notification.turn?.endedAt)
			ctx.hub.broadcast("conversation.ended", {
				sessionId: notification.sessionId,
				turn: notification.turn,
				workspaceId: workspaceForLeaderSession(notification.sessionId),
				role: workspaceForLeaderSession(notification.sessionId) ? "neta" : undefined,
			});
	});
}
