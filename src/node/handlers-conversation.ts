// Conversation handlers: tail, prompt, cancel, models, and `turn`
// subscriptions. The store port pages forward only, so `tail` with a `turnId`
// or `direction: "backward"` pages through the port and assembles the window.
// Port cursors are decimal block seqs, minted by the store and passed back
// verbatim; the adapter in `lifecycle.ts` honors the same convention.

import { homedir } from "node:os";
import type { Block, PromptAttachment, Turn } from "../core/types.ts";
import { composeContext, loadCharter, loadSkills } from "../tools/context.ts";
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

function resetBrief(ctx: NodeContext, sessionId: string): string {
	const leader = ctx.store.listLeaders().find((one) => one.sessionId === sessionId);
	const agent = ctx.store.listAgents().find((one) => one.sessionId === sessionId);
	if (leader === undefined && agent === undefined)
		throw new NodeError("NOT_FOUND", `no owner for session: ${sessionId}`);
	const workspaceId = leader?.workspaceId ?? agent?.workspaceId;
	const workspace = workspaceId === undefined ? undefined : ctx.store.getWorkspace(workspaceId);
	const root = workspace?.roots.find((item) => item.machineId === ctx.store.machine().id)?.path;
	if (workspace === undefined || root === undefined)
		throw new NodeError("NOT_FOUND", "chat has no workspace root on this machine");
	const missionId = agent?.missionId ?? leader?.activeMissionId;
	const mission = missionId === undefined ? undefined : ctx.store.getMission(missionId);
	const kind =
		leader !== undefined ? ("leader" as const) : agent?.canSpawn === true ? ("lead" as const) : ("agent" as const);
	const skills = loadSkills(agent?.skills ?? [], root, homedir());
	if (!skills.ok) throw new NodeError("NOT_FOUND", `unknown skill: ${skills.missing}`);
	const charter = kind === "agent" ? undefined : loadCharter(root, homedir());
	return composeContext({
		kind,
		...(charter === undefined ? {} : { charter }),
		skills: skills.skills,
		...(mission === undefined ? {} : { mission }),
		...(agent === undefined ? {} : { task: agent.task }),
	});
}

export async function prepareHandoffForSession(ctx: Pick<NodeContext, "store">, sessionId: string): Promise<string> {
	const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);
	const leader = ctx.store.listLeaders().find((one) => one.sessionId === sessionId);
	const agent = ctx.store.listAgents().find((one) => one.sessionId === sessionId);
	if (leader === undefined && agent === undefined)
		throw new NodeError("NOT_FOUND", `no owner for session: ${sessionId}`);
	const missionId = agent?.missionId ?? leader?.activeMissionId;
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
		if (mission.changes.length > 0) {
			lines.push(
				"",
				"## Accepted scope changes",
				"",
				...mission.changes.slice(-12).map((change) => `- ${clip(change.text, 250)}`),
			);
		}
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
		"Use `neta_status` for current missions and `neta_history` to inspect earlier messages when needed.",
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

// The window is `collected.blocks[start, end)`; prevCursor is the offset
// before its first block (null at the start of history) and nextCursor
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
					: collected.blocks.findIndex((block) => block.seq >= cursorSeq);
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
		const parsed = parseParams({ sessionId: asString, text: asString, attachments: asAttachments }, params);
		const attachments = parsed.attachments ?? [];
		if (parsed.text.trim() === "" && attachments.length === 0)
			throw new NodeError("INVALID_PARAMS", "prompt needs text or an attachment");
		const capabilities = ctx.acp.capabilities?.(parsed.sessionId) ?? { image: false, embeddedContext: false };
		if (attachments.some((item) => item.kind === "image") && !capabilities.image)
			throw new NodeError("PROVIDER_ERROR", "this provider does not support image prompts");
		if (attachments.some((item) => item.kind === "file") && !capabilities.embeddedContext)
			throw new NodeError("PROVIDER_ERROR", "this provider does not support embedded file prompts");
		try {
			if (ctx.acp.send !== undefined) {
				const message = await ctx.acp.send(parsed.sessionId, parsed.text, attachments, {
					readerDirected: conn.client === "desktop" || conn.client === "cli",
				});
				return {
					messageId: message.id,
					status: message.status,
					...(message.turnId === undefined ? {} : { turnId: message.turnId }),
				};
			}
			// Returns the turnId at once; blocks arrive only as notifications.
			const turnId = await ctx.acp.prompt(parsed.sessionId, parsed.text, attachments, {
				readerDirected: conn.client === "desktop" || conn.client === "cli",
			});
			return { turnId };
		} catch (error) {
			throw asProviderError(error);
		}
	},

	"conversation.inbox": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString }, params);
		return { sessionId: parsed.sessionId, messages: (await ctx.acp.listInbox?.(parsed.sessionId)) ?? [] };
	},

	"conversation.capabilities": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString }, params);
		return ctx.acp.capabilities?.(parsed.sessionId) ?? { image: false, embeddedContext: false };
	},

	"conversation.cancel": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString }, params);
		try {
			await ctx.acp.cancel(parsed.sessionId);
			return { sessionId: parsed.sessionId };
		} catch (error) {
			throw asProviderError(error);
		}
	},

	"conversation.setModel": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asString, model: asString }, params);
		try {
			await ctx.acp.setModel(parsed.sessionId, parsed.model);
			const leader = ctx.store.listLeaders().find((one) => one.sessionId === parsed.sessionId);
			if (leader !== undefined) {
				const updated = { ...leader, model: parsed.model };
				await ctx.store.putLeader(updated);
				ctx.hub.broadcast("state", { kind: "leader", record: updated });
			} else {
				const agent = ctx.store.listAgents().find((one) => one.sessionId === parsed.sessionId);
				if (agent !== undefined) {
					const updated = { ...agent, model: parsed.model };
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
		return { providers: ctx.acp.listProviders?.(parsed) ?? [] };
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
		if (ctx.acp.switchProvider === undefined)
			throw new NodeError("PROVIDER_ERROR", "provider switching is unavailable");
		let switchAttempted = false;
		try {
			const handoff = parsed.handoff === undefined ? await prepareHandoff(ctx, parsed.sessionId) : parsed.handoff;
			switchAttempted = true;
			const selected = await ctx.acp.switchProvider(parsed.sessionId, parsed.provider, parsed.model, handoff);
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
				failedLeader?.state === "failed" &&
				failedLeader.mode === "lead" &&
				failedLeader.activeMissionId === undefined
			) {
				const target = ctx.acp
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
					const selected = await ctx.acp.ensureSession({
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
		const agent = ctx.store.listAgents().find((one) => one.sessionId === parsed.sessionId);
		if (agent !== undefined && (agent.state === "queued" || agent.state === "archived"))
			throw new NodeError("INVALID_PARAMS", `cannot reset chat for ${agent.state} agent`);
		if (ctx.acp.resetSession === undefined) throw new NodeError("PROVIDER_ERROR", "chat reset is unavailable");
		try {
			const leader = ctx.store.listLeaders().find((one) => one.sessionId === parsed.sessionId);
			const selected = await ctx.acp.resetSession(
				parsed.sessionId,
				resetBrief(ctx, parsed.sessionId),
				async (next) => {
					if (leader !== undefined) {
						const updated = { ...leader, sessionId: next.sessionId, provider: next.provider, model: next.model };
						await ctx.store.putLeader(updated);
						ctx.hub.broadcast("state", { kind: "leader", record: updated });
					} else if (agent !== undefined) {
						const updated = { ...agent, sessionId: next.sessionId, provider: next.provider, model: next.model };
						await ctx.store.putAgent(updated);
						ctx.hub.broadcast("state", { kind: "agent", record: updated });
					}
				},
			);
			return selected;
		} catch (error) {
			throw asProviderError(error);
		}
	},

	"models.list": async (ctx, params) => {
		const parsed = parseParams({ sessionId: asOptionalString, provider: asOptionalString }, params);
		try {
			const models = await ctx.acp.listModels({ sessionId: parsed.sessionId, provider: parsed.provider });
			return { models };
		} catch (error) {
			throw asProviderError(error);
		}
	},
};

export function wireTurnStream(ctx: NodeContext): void {
	ctx.acp.onTurn((notification) => {
		ctx.hub.toTail(notification.sessionId, notification);
	});
}
