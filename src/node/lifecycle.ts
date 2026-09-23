// The Node lifecycle: exclusive lock, store load, restart marking, the
// descriptor, then listen. This is the only file that adapts the real 02
// and 03 modules to the `NodeStore`/`NodeRuntime` ports; handlers only ever see
// the ports, so their tests keep stubbing.
//
// Two gap-fills live here, both forced by the ports and documented for the
// workstreams that follow:
// - 02 persists no Agent records, but the ports (and 05/07) need them, so
//   the adapter owns `agents.json`: one {agentId: Agent} object, loaded once
//   at start (the lock rules out external writers) and written through on
//   every put. If 02 ever stores agents itself, delete this and adapt that.
// - Missions are cached in memory at start (the ports read synchronously
//   but the registry is async). In-process mission writers (05, 06, 07)
//   must call `refreshMissions` after writing the real registry, or the
//   Node keeps serving stale missions. Events, conversations, workspaces,
//   leaders and agents have no such split: events and conversations are
//   read fresh from disk per call, the rest go through the ports.
// - Conversation cursors on the ports are decimal block seqs (monotonic per
//   session, assigned by 03). The adapter translates them over the store's
//   byte-offset pages, always scanning forward from the file start: simple
//   and correct, O(history) per call. No cursor means from the start, never
//   the store's tail mode, so the conversation handlers can page through
//   the port to assemble backward and turn-anchored windows.

import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import type {
	Access,
	Agent,
	AgentId,
	Block,
	Event,
	InboxMessage,
	Leader,
	Mission,
	MissionId,
	PromptAttachment,
	SessionId,
	Turn,
	TurnId,
	WorkspaceId,
} from "../core/types.ts";
import { captureMeEvent, replayMeEvents } from "../me/capture.ts";
import { openMeStore } from "../me/store.ts";
import { nativeEndpointReady } from "../opencode/attachment.ts";
import { openCodeInvocation } from "../opencode/runtime.ts";
import { createPiTerminalManager } from "../pi/manager.ts";
import { type McpServerSpec, netaMcpServer } from "../session/mcp.ts";
import type { RuntimeSession, SessionEvent, StartOptions } from "../session/runtime.ts";
import { SessionClosedError, startSession } from "../session/runtime.ts";
import {
	loadSettings,
	providerCommandAvailable,
	providerFor,
	requireManagedOpenCode,
	type Settings,
} from "../session/settings.ts";
import { writeSystemContext } from "../session/system-context.ts";
import { SessionTable } from "../session/table.ts";
import type { ConversationStore } from "../store/conversations.ts";
import { createMutex, readJson, writeJsonAtomic } from "../store/files.ts";
import { openStore, type Store } from "../store/index.ts";
import { decodeWorkspaceId, paths, socketPathError } from "../store/paths.ts";
import { createTokenTable, type TokenTable } from "../tools/router.ts";
import { netaBuildId, netaVersion } from "../version.ts";
import { createFileLeaseStore, LeaseManager } from "../worktrees/leases.ts";
import {
	conversationHandlers,
	prepareHandoffForSession,
	sessionSystemContext,
	wireTurnStream,
} from "./handlers-conversation.ts";
import { diagnosticsHandlers } from "./handlers-diagnostics.ts";
import { glanceHandlers } from "./handlers-glance.ts";
import { meHandlers } from "./handlers-me.ts";
import { registryHandlers } from "./handlers-registry.ts";
import { routingHandlers } from "./handlers-routing.ts";
import { terminalHandlers } from "./handlers-terminal.ts";
import { toolMount } from "./handlers-tools.ts";
import {
	acquireLock,
	clearDescriptor,
	type LockHandle,
	type NodeDescriptor,
	netaDir,
	newToken,
	writeDescriptor,
} from "./lockfile.ts";
import { type ConversationTailResult, NodeError, PROTOCOL_VERSION, type TurnNotification } from "./protocol.ts";
import { RuntimeAdmission } from "./runtime-admission.ts";
import {
	createServer,
	type Hub,
	type NodeContext,
	type NodeHandlers,
	type NodeRuntime,
	type NodeStore,
} from "./server.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { snapshotHandlers } from "./snapshot.ts";
import { workspaceHandlers } from "./workspace-open.ts";

export interface AdaptedStore extends NodeStore {
	refreshMissions(workspaceId?: WorkspaceId): Promise<void>;
}

export function glanceActorForSession(
	store: NodeStore,
	sessionId: SessionId,
):
	| {
			workspaceId: WorkspaceId;
			actorKind: "leader" | "agent";
			agentId?: string;
			missionId?: string;
			agentLabel: string;
	  }
	| undefined {
	const leader = store.listLeaders().find((item) => item.sessionId === sessionId);
	if (leader !== undefined) return { workspaceId: leader.workspaceId, actorKind: "leader", agentLabel: leader.name };
	const agent = store
		.listMissions()
		.flatMap((mission) => store.listAgents(mission.id))
		.find((item) => item.sessionId === sessionId);
	if (agent === undefined) return undefined;
	return {
		workspaceId: agent.workspaceId,
		actorKind: "agent",
		agentId: agent.id,
		missionId: agent.missionId,
		agentLabel: agent.name,
	};
}

function agentsPath(): string {
	return join(netaDir(), "agents.json");
}

async function loadLeaders(): Promise<Map<WorkspaceId, Leader>> {
	const leaders = new Map<WorkspaceId, Leader>();
	let names: string[];
	try {
		names = await readdir(join(paths().root, "leaders"));
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") {
			return leaders;
		}
		throw error;
	}
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) {
			continue;
		}
		const record = await readJson<Leader & { leadModes?: unknown }>(join(paths().root, "leaders", name));
		if (record !== undefined) {
			// The mirror holds the `Leader` alone: 07's lead modes share the
			// file but not the record, and carrying them here would put them
			// on every `state` broadcast.
			const { leadModes: _leadModes, ...leader } = record;
			leaders.set(leader.workspaceId, leader);
		}
	}
	return leaders;
}

async function listAllMissions(real: Store, workspaceId: WorkspaceId): Promise<Mission[]> {
	const out: Mission[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await real.missions.list(workspaceId, cursor === undefined ? {} : { cursor, limit: 1000 });
		out.push(...page.missions);
		if (page.cursor === undefined) {
			return out;
		}
		cursor = page.cursor;
	}
}

function checkEventCursor(cursor: string): void {
	const seq = Number.parseInt(cursor, 10);
	if (!Number.isInteger(seq) || seq < 0) {
		throw new NodeError("INVALID_PARAMS", "events.list cursor is an event offset");
	}
}

function checkBlockCursor(cursor: string): number {
	const seq = Number.parseInt(cursor, 10);
	if (!Number.isInteger(seq) || seq < 0) {
		throw new NodeError("INVALID_PARAMS", "conversation.tail cursor is a block offset");
	}
	return seq;
}

// The real 02/03 modules behind the ports. Reads are served from memory
// loaded here (registries, workspaces, leaders, agents); events and
// conversations read fresh from disk per call.
export async function adaptStore(real: Store): Promise<AdaptedStore> {
	const machine = await real.machine.load();
	const workspaces = new Map((await real.workspaces.list()).map((workspace) => [workspace.id, workspace]));
	const leaders = await loadLeaders();
	const missions = new Map<MissionId, Mission>();
	for (const workspaceId of await missionWorkspaceIds()) {
		for (const mission of await listAllMissions(real, workspaceId)) {
			missions.set(mission.id, mission);
		}
	}
	const agents = new Map<AgentId, Agent>(Object.entries((await readJson<Record<AgentId, Agent>>(agentsPath())) ?? {}));
	const agentsMutex = createMutex();
	const me = openMeStore();
	const meContext = () => ({
		workspaces: [...workspaces.values()],
		leaders: [...leaders.values()],
		agents: [...agents.values()],
		missions: [...missions.values()],
	});
	const appendEvent = async (input: Omit<Event, "seq" | "at">): Promise<Event> => {
		const event = await real.events.append(input);
		await captureMeEvent(me, event, meContext());
		await me.setCheckpoint({
			workspaces: [{ workspaceId: event.workspaceId, eventSeq: event.seq, turns: [] }],
		});
		return event;
	};

	// Registry dirs with no workspace record yet (seeded out-of-band): their
	// missions still belong in the mirror.
	async function missionWorkspaceIds(): Promise<Set<WorkspaceId>> {
		const ids = new Set<WorkspaceId>(workspaces.keys());
		let names: string[];
		try {
			names = await readdir(join(paths().root, "missions"));
		} catch (error) {
			if ((error as { code?: unknown }).code === "ENOENT") {
				return ids;
			}
			throw error;
		}
		for (const name of names) {
			try {
				ids.add(decodeWorkspaceId(name));
			} catch {
				// Not a workspace dir.
			}
		}
		return ids;
	}

	async function refreshMissions(workspaceId?: WorkspaceId): Promise<void> {
		if (workspaceId === undefined) {
			for (const workspace of await real.workspaces.list()) {
				workspaces.set(workspace.id, workspace);
			}
			for (const [id, leader] of await loadLeaders()) {
				leaders.set(id, leader);
			}
		}
		const ids = workspaceId === undefined ? await missionWorkspaceIds() : new Set([workspaceId]);
		for (const id of ids) {
			for (const mission of await listAllMissions(real, id)) {
				missions.set(mission.id, mission);
			}
		}
	}

	return {
		machine: () => machine,
		listWorkspaces: () => [...workspaces.values()],
		listLeaders: () => [...leaders.values()],
		listMissions: (workspaceId) => {
			const all = [...missions.values()];
			return workspaceId === undefined ? all : all.filter((mission) => mission.workspaceId === workspaceId);
		},
		listAgents: (missionId) =>
			missionId === undefined
				? [...agents.values()]
				: [...agents.values()].filter((agent) => agent.missionId === missionId),
		getWorkspace: (id) => workspaces.get(id),
		getLeader: (id) => leaders.get(id),
		getMission: (id) => missions.get(id),
		getAgent: (id) => agents.get(id),
		putWorkspace: async (workspace) => {
			workspaces.set(workspace.id, workspace);
			await real.workspaces.save(workspace);
		},
		putAgent: async (agent) => {
			agents.set(agent.id, agent);
			await agentsMutex(() => writeJsonAtomic(agentsPath(), Object.fromEntries(agents)));
		},
		putLeader: async (leader) => {
			leaders.set(leader.workspaceId, leader);
			await real.leaders.save(leader);
		},
		compact: async () => {
			for (const workspaceId of await missionWorkspaceIds()) {
				await real.missions.compact(workspaceId);
			}
		},
		appendEvent,
		listEvents: async (query) => {
			if (query.cursor !== undefined) {
				checkEventCursor(query.cursor);
				const page = await real.events.list(query.workspaceId, {
					from: query.from,
					to: query.to,
					limit: query.limit ?? 200,
					cursor: query.cursor,
				});
				return page.cursor === undefined
					? { events: page.events }
					: { events: page.events, nextCursor: page.cursor };
			}
			// No cursor: the most recent page (tail semantics for snapshots).
			const limit = query.limit ?? 200;
			let kept: Event[] = [];
			let cursor: string | undefined;
			for (;;) {
				const page = await real.events.list(query.workspaceId, {
					from: query.from,
					to: query.to,
					limit: 2000,
					cursor,
				});
				kept = [...kept, ...page.events].slice(-limit);
				if (page.cursor === undefined) {
					return { events: kept };
				}
				cursor = page.cursor;
			}
		},
		tailConversation: async (id, query) => {
			const meta = await real.conversations.meta(id);
			if (meta === undefined) {
				throw new NodeError("NOT_FOUND", `no such session: ${id}`);
			}
			const startSeq = query.cursor === undefined ? Number.NEGATIVE_INFINITY : checkBlockCursor(query.cursor);
			const limit = query.limit;
			const blocks: Block[] = [];
			const turnIds: string[] = [];
			let byteCursor: number | undefined = 0;
			let moreAfter = false;
			for (;;) {
				const page = await real.conversations.tail({ sessionId: id, cursor: byteCursor, limit: 500 });
				let i = 0;
				for (; i < page.blocks.length; i++) {
					const block = page.blocks[i];
					if (block === undefined || block.seq <= startSeq) {
						continue;
					}
					if (blocks.length === limit) {
						break;
					}
					blocks.push(block);
					if (!turnIds.includes(block.turnId)) {
						turnIds.push(block.turnId);
					}
				}
				if (blocks.length === limit) {
					moreAfter = page.blocks.slice(i).some((block) => block.seq > startSeq) || page.more;
					break;
				}
				if (!page.more) {
					break;
				}
				byteCursor = page.cursor;
			}
			const turns: Turn[] = [];
			for (const turnId of turnIds) {
				const range = await real.conversations.turnRange(id, turnId);
				if (range !== undefined) {
					turns.push(range.turn);
				}
			}
			const result: Omit<ConversationTailResult, "sessionId"> = {
				turns,
				blocks,
				prevCursor: query.cursor ?? null,
				provider: meta.provider,
				model: meta.model,
			};
			if (moreAfter && blocks.length > 0) {
				const last = blocks[blocks.length - 1];
				if (last !== undefined) {
					return { ...result, nextCursor: String(last.seq) };
				}
			}
			return result;
		},
		recentConversation: async (id, limit) => (await real.conversations.tail({ sessionId: id, limit })).blocks,
		glanceList: (workspaceId, after, limit) => real.glance.list(workspaceId, after, limit),
		glanceGet: (workspaceId, id) => real.glance.get(workspaceId, id),
		glanceComplete: (workspaceId, id, sourceHash, result) =>
			real.glance.complete(workspaceId, id, sourceHash, result),
		glanceMarkReviewed: (workspaceId, through) => real.glance.markReviewed(workspaceId, through),
		refreshMissions,
	};
}

export interface AdaptedRuntime extends NodeRuntime {
	send(
		id: SessionId,
		text: string,
		attachments: PromptAttachment[],
		provenance: { readerDirected: boolean; sourceId?: string; sourceHash?: string },
	): Promise<InboxMessage>;
	switchProvider(
		id: SessionId,
		provider: string,
		model?: string,
		handoff?: string,
	): Promise<{ provider: string; model: string }>;
	resetSession(
		id: SessionId,
		brief: string,
		rebind: (selected: { sessionId: SessionId; provider: string; model: string }) => Promise<void>,
	): Promise<{ sessionId: SessionId; provider: string; model: string }>;
	// The node-minted actor token for a live session, for 05's authorisation.
	// Memory only: a restart wipes the table, so stale proxies fail closed.
	actorToken(sessionId: SessionId): string | undefined;
	// The same table as a `TokenTable`, so 05's router verifies against the
	// tokens this adapter minted at launch.
	tokens: TokenTable;
}

// One live session's place in the conversation it is writing.
//
// 03 numbers blocks from 1 per process and knows nothing about the person's
// own message, so the pump renumbers: `base` is the last seq already on disk
// (a resumed session continues its file), and `injected` counts the user
// blocks the pump added ahead of the provider's. The mapping
// `base + providerSeq + injected` is monotonic and stable for a re-emitted
// block, so a growing text block keeps its seq on the wire and on disk.
interface PumpState {
	base: number;
	injected: number;
	lastSeq: number;
	// The last block seen, held back so a coalesced re-emit replaces it
	// instead of appending the same block again with more text.
	pending?: Block;
	open?: Turn;
	readerText?: Map<number, Block>;
}

// `conversations` is the real 02 store when the Node runs for real. With it,
// every session starts with a conversation meta record, so `conversation.tail`
// succeeds (possibly empty) and subscribes the caller for the live `turn`
// stream; without it (stubbed tests) session creation touches no store.
class SuppressedInboxError extends Error {}

export function adaptRuntime(
	settings: Settings,
	conversations?: ConversationStore,
	settingsForCwd: (cwd: string) => Settings = () => settings,
	onReaderTurn: (sessionId: SessionId, turn: Turn, blocks: Block[]) => Promise<void> = () => Promise.resolve(),
	recoveryHandoff?: (sessionId: SessionId) => Promise<string>,
	inboxStore?: Store["inbox"],
	systemContext?: (sessionId: string) => string,
	durableTurn?: (notification: TurnNotification) => Promise<void>,
	runtimeAdmission?: RuntimeAdmission,
	inboxGuard?: (message: InboxMessage) => Promise<boolean>,
	sessionFactory: (options: StartOptions) => Promise<RuntimeSession> = startSession,
): AdaptedRuntime {
	const makeSession = sessionFactory;
	const sessionLifecycle = new SessionLifecycle();
	let closing = false;
	let pumpOperations = 0;
	const pumpPromises = new Map<RuntimeSession, Promise<void>>();
	const guarded = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
		if (closing) throw new NodeError("BUSY", "Neta is stopping; reconnect before retrying.");
		const leave = runtimeAdmission?.enter();
		try {
			return await sessionLifecycle.run(id, operation);
		} finally {
			leave?.();
		}
	};
	const table = new SessionTable({ settings, cwd: process.cwd(), access: "readOnly" });
	const listeners = new Set<(notification: TurnNotification) => void>();
	const drains = new Set<SessionId>();
	const wakeTimers = new Map<SessionId, ReturnType<typeof setTimeout>>();
	const minted = new Map<SessionId, string>();
	// The actor id each live session's token was minted under: an agent's
	// `agentId` per 05, the leader's own session id otherwise. `close` has to
	// revoke the key it minted, or a surviving proxy keeps calling tools as an
	// agent that is gone.
	const actors = new Map<SessionId, string>();
	const verifier = createTokenTable();
	const tokens: TokenTable = {
		mint: (actorId) => {
			const token = verifier.mint(actorId);
			minted.set(actorId, token);
			return token;
		},
		verify: (actorId, token) => verifier.verify(actorId, token),
		revoke: (actorId) => {
			verifier.revoke(actorId);
			minted.delete(actorId);
		},
	};
	// The text of the prompt each session is waiting to open a turn for, so
	// the pump can write the person's own message as a `user` block: 03 opens
	// the turn but never carries the text.
	const prompts = new Map<
		SessionId,
		{
			text: string;
			attachments: PromptAttachment[];
			readerDirected: boolean;
			recoveryNotice?: string;
			messageId?: string;
			messageIds?: string[];
		}
	>();
	const inboxPromptIds = new Map<SessionId, string[]>();
	let adapted: AdaptedRuntime;
	const switching = new Set<SessionId>();

	function emit(notification: TurnNotification): void {
		for (const fn of [...listeners]) {
			try {
				fn(notification);
			} catch {
				// A listener never breaks the pump.
			}
		}
		if (notification.turn?.endedAt !== undefined) void drain(notification.sessionId);
	}

	async function publishInbox(message: InboxMessage): Promise<void> {
		emit({ sessionId: message.sessionId, inbox: message });
	}

	async function drain(sessionId: SessionId): Promise<void> {
		if (
			inboxStore === undefined ||
			drains.has(sessionId) ||
			switching.has(sessionId) ||
			wakeTimers.has(sessionId) ||
			closing
		)
			return;
		drains.add(sessionId);
		try {
			for (;;) {
				if (switching.has(sessionId)) return;
				const session = table.get(sessionId)?.session;
				if (session === undefined) return;
				const queued = (await inboxStore.list(sessionId)).filter((item) => item.status === "queued");
				const next = queued[0];
				if (switching.has(sessionId) || wakeTimers.has(sessionId) || table.get(sessionId)?.session !== session)
					return;
				if (next === undefined) return;
				if (inboxGuard && !(await inboxGuard(next))) {
					await publishInbox(await inboxStore.markDiscarded(sessionId, next.id));
					continue;
				}
				if (session.openTurnId !== undefined) {
					if (next.readerDirected === false) return;
					if (!session.steeringSupported) return;
					const targetTurnId = session.openTurnId;
					const delivering = await inboxStore.markDelivering(sessionId, next.id);
					await publishInbox(delivering);
					if (switching.has(sessionId) || table.get(sessionId)?.session !== session) {
						await publishInbox(await inboxStore.markQueued(sessionId, next.id));
						return;
					}
					try {
						const outcome = await session.steer(next.id, next.text, next.attachments);
						if (outcome === "promptRequired") {
							const queued = await inboxStore.markQueued(sessionId, next.id);
							await publishInbox(queued);
							if (session.openTurnId === undefined) continue;
							return;
						}
						if (outcome === "failed") {
							const uncertain = await inboxStore.markUncertain(sessionId, next.id);
							await publishInbox(uncertain);
							return;
						}
						const delivered = await inboxStore.markDelivered(sessionId, next.id, targetTurnId);
						await publishInbox(delivered);
					} catch {
						const uncertain = await inboxStore.markUncertain(sessionId, next.id);
						await publishInbox(uncertain);
					}
					continue;
				}
				const batch: InboxMessage[] = [];
				for (const item of queued) {
					if (
						batch.length &&
						(next.readerDirected !== false || !next.sourceId || item.readerDirected !== false || !item.sourceId)
					)
						break;
					if (inboxGuard && !(await inboxGuard(item))) break;
					batch.push(item);
				}
				if (!batch.length) continue;
				const ids = batch.map((item) => item.id);
				for (const message of await inboxStore.markMany(sessionId, ids, "delivering")) await publishInbox(message);
				try {
					if (switching.has(sessionId) || table.get(sessionId)?.session !== session) {
						for (const message of await inboxStore.markMany(sessionId, ids, "queued"))
							await publishInbox(message);
						return;
					}
					inboxPromptIds.set(sessionId, ids);
					const turnId = await adapted.prompt(
						sessionId,
						batch.map((item) => item.text).join("\n\n---\n\n"),
						batch.flatMap((item) => item.attachments),
						{ readerDirected: next.readerDirected ?? !next.text.startsWith("[Neta automatic report:") },
					);
					for (const message of await inboxStore.markMany(sessionId, ids, "delivered", turnId))
						await publishInbox(message);
				} catch (error) {
					for (const message of await inboxStore.markMany(
						sessionId,
						ids,
						error instanceof SuppressedInboxError
							? "discarded"
							: error instanceof Error && error.name === "TurnInProgressError"
								? "queued"
								: "uncertain",
					))
						await publishInbox(message);
				} finally {
					inboxPromptIds.delete(sessionId);
				}
				return;
			}
		} finally {
			drains.delete(sessionId);
			const pending = (await inboxStore.list(sessionId)).some((item) => item.status === "queued");
			const current = table.get(sessionId)?.session;
			if (
				pending &&
				!closing &&
				!wakeTimers.has(sessionId) &&
				!switching.has(sessionId) &&
				current !== undefined &&
				current.openTurnId === undefined
			)
				queueMicrotask(() => {
					void drain(sessionId);
				});
		}
	}
	function releaseSwitch(sessionId: SessionId): void {
		switching.delete(sessionId);
		void drain(sessionId);
	}

	// The last seq already on disk for this session; 0 when it is new. A
	// resumed session keeps writing into the same file, so its blocks
	// continue the numbering rather than colliding with the old ones.
	async function baseSeqOf(sessionId: SessionId): Promise<number> {
		if (conversations === undefined) {
			return 0;
		}
		try {
			const page = await conversations.tail({ sessionId, limit: 1 });
			return page.blocks[page.blocks.length - 1]?.seq ?? 0;
		} catch {
			return 0;
		}
	}

	// Persistence never breaks the stream: a failed write costs history, a
	// throw here would cost the live turn as well.
	async function writeTurn(turn: Turn): Promise<void> {
		try {
			await conversations?.appendTurn(turn);
		} catch {
			// The conversation file is unwritable; the stream carries on.
		}
	}

	async function writeBlock(sessionId: SessionId, block: Block): Promise<void> {
		try {
			await conversations?.appendBlock(sessionId, block);
		} catch {
			// As above.
		}
	}

	async function flush(sessionId: SessionId, state: PumpState): Promise<void> {
		const block = state.pending;
		state.pending = undefined;
		if (block !== undefined) {
			await writeBlock(sessionId, block);
		}
	}

	// One closed Turn for the notification and for the file: the desktop and
	// the terminal both end their turn on `endedAt`, so the end of a turn is
	// never a bare ping.
	async function closeTurn(
		sessionId: SessionId,
		state: PumpState,
		turnId: TurnId,
		cancelled: boolean,
		failed = false,
	): Promise<void> {
		await flush(sessionId, state);
		const open = state.open;
		const closed: Turn = {
			...(open?.id === turnId ? open : { id: turnId, sessionId, startedAt: nowIso(), role: "user" }),
			endedAt: nowIso(),
			...(cancelled ? { cancelled: true } : {}),
			...(failed ? { failed: true } : {}),
		};
		state.open = undefined;
		await durableTurn?.({ sessionId, bindingGeneration: closed.bindingGeneration, turn: closed });
		await writeTurn(closed);
		emit({ sessionId, bindingGeneration: closed.bindingGeneration, turn: closed });
		const readerBlocks = [...(state.readerText?.values() ?? [])].sort((a, b) => a.seq - b.seq);
		state.readerText = undefined;
		if (closed.readerDirected === true && readerBlocks.length > 0) {
			try {
				await onReaderTurn(sessionId, closed, readerBlocks);
			} catch {
				// Recap persistence is supplementary; never break the turn pump.
			}
		}
	}

	async function handle(session: RuntimeSession, state: PumpState, event: SessionEvent): Promise<void> {
		const sessionId = session.sessionId;
		if (event.type === "turn") {
			// Claimed before any await. The desktop and the terminal are both
			// attached to the same session by design, so a second
			// `conversation.prompt` can land while this branch is awaiting a
			// file append; it is refused with `TurnInProgressError`, and its
			// catch used to delete the entry this turn had not read yet,
			// losing the first client's `user` block altogether.
			const prompt = prompts.get(sessionId);
			prompts.delete(sessionId);
			await flush(sessionId, state);
			const opened: Turn = {
				...event.turn,
				model: session.model,
				bindingGeneration: event.turn.bindingGeneration ?? session.bindingGeneration,
				...(prompt?.readerDirected === true ? { readerDirected: true } : {}),
			};
			state.open = opened;
			state.readerText = opened.readerDirected === true ? new Map() : undefined;
			await durableTurn?.({ sessionId, bindingGeneration: opened.bindingGeneration, turn: opened });
			await writeTurn(opened);
			emit({ sessionId, bindingGeneration: opened.bindingGeneration, turn: opened });
			if (prompt === undefined) {
				return;
			}
			const userBlocks: Array<Omit<Block, "seq">> = [];
			if (prompt.text !== "") {
				userBlocks.push({
					turnId: event.turn.id,
					at: nowIso(),
					role: "user",
					kind: "text",
					text: prompt.text,
					...(prompt.messageId === undefined
						? {}
						: {
								data: {
									messageId: prompt.messageId,
									messageIds: JSON.stringify(prompt.messageIds ?? [prompt.messageId]),
								},
							}),
				});
			}
			for (const attachment of prompt.attachments) {
				userBlocks.push({
					turnId: event.turn.id,
					at: nowIso(),
					role: "user",
					kind: "status",
					text: attachment.name,
					data: {
						...(prompt.messageId === undefined ? {} : { messageId: prompt.messageId }),
						attachmentId: attachment.id,
						attachmentKind: attachment.kind,
						name: attachment.name,
						mimeType: attachment.mimeType,
						size: Buffer.from(attachment.dataBase64, "base64").byteLength,
					},
				});
			}
			if (prompt.recoveryNotice !== undefined) {
				userBlocks.push({
					turnId: event.turn.id,
					at: nowIso(),
					role: "agent",
					kind: "status",
					text: prompt.recoveryNotice,
				});
			}
			for (const draft of userBlocks) {
				state.injected += 1;
				const block: Block = { ...draft, seq: state.base + state.lastSeq + state.injected };
				await writeBlock(sessionId, block);
				emit({ sessionId, block });
			}
			return;
		}
		if (event.type === "block") {
			const seq = state.base + event.block.seq + state.injected;
			if (state.pending !== undefined && state.pending.seq !== seq) {
				await flush(sessionId, state);
			}
			const block: Block = { ...event.block, seq };
			if (state.readerText !== undefined && block.role === "agent" && block.kind === "text")
				state.readerText.set(seq, block);
			state.pending = block;
			state.lastSeq = Math.max(state.lastSeq, event.block.seq);
			emit({ sessionId, block });
			return;
		}
		if (event.type === "turnEnd") {
			await closeTurn(sessionId, state, event.turnId, event.cancelled, event.stopReason === "error");
			return;
		}
		if (event.type === "interrupted") {
			if (event.turnId !== undefined) {
				await closeTurn(sessionId, state, event.turnId, true);
				return;
			}
			await flush(sessionId, state);
			emit({ sessionId });
			return;
		}
		if (event.type === "model") {
			if (state.open) state.open = { ...state.open, model: event.model };
			await conversations?.setMeta(sessionId, { model: event.model });
			emit({ sessionId, bindingGeneration: session.bindingGeneration, model: event.model });
			return;
		}
		// A mode change is a bare ping: something changed, re-tail
		// for the current state.
		emit({ sessionId });
	}

	function pump(session: RuntimeSession): void {
		const run = async (): Promise<void> => {
			const state: PumpState = { base: await baseSeqOf(session.sessionId), injected: 0, lastSeq: 0 };
			try {
				for await (const event of session.events()) {
					if (event.bindingGeneration && event.bindingGeneration !== session.bindingGeneration) continue;
					if (table.get(session.sessionId)?.session !== session) break;
					pumpOperations++;
					try {
						await handle(session, state, event);
					} finally {
						pumpOperations--;
					}
				}
			} catch {
				// The iterator threw: the session is done.
			}
			if (table.get(session.sessionId)?.session === session) await flush(session.sessionId, state);
		};
		const operation = run();
		pumpPromises.set(session, operation);
		void operation.finally(() => pumpPromises.delete(session)).catch(() => undefined);
	}

	function live(sessionId: SessionId): RuntimeSession {
		const record = table.get(sessionId);
		if (record === undefined) {
			throw new NodeError("NOT_FOUND", `no such session: ${sessionId}`);
		}
		return record.session;
	}

	// The Neta tools entry a session is launched with, carrying the actor id
	// and the token this Node minted for it. The caller asks for it with
	// `netaTools: true` and never builds the entry itself: the actor id and
	// the token exist only here, so a caller-built entry could only ever be a
	// placeholder for this function to overwrite.
	function netaServers(netaTools: boolean, actorId: string, token: string): McpServerSpec[] {
		if (!netaTools) {
			return [];
		}
		return [netaMcpServer({ actorId, token, socketPath: join(netaDir(), "node.sock") })];
	}

	async function register(
		session: RuntimeSession,
		provider: string,
		netaTools: boolean,
		reconcileInbox = true,
		deferInbox = false,
	): Promise<void> {
		if (conversations !== undefined) {
			await conversations.create({
				sessionId: session.sessionId,
				provider: session.provider,
				model: session.model,
				vendorSessionId: session.vendorSessionId,
				bindingGeneration: session.bindingGeneration,
				fallbackModels: session.fallbackModels === undefined ? undefined : [...session.fallbackModels],
				createdAt: nowIso(),
			});
			// A resumed or re-created session gets a new vendor id, and the
			// next resume needs the current one.
			await conversations
				.setMeta(session.sessionId, {
					provider: session.provider,
					model: session.model,
					vendorSessionId: session.vendorSessionId,
					bindingGeneration: session.bindingGeneration,
					fallbackModels: session.fallbackModels === undefined ? undefined : [...session.fallbackModels],
				})
				.catch(() => undefined);
		}
		table.set(session.sessionId, { session, provider, netaTools });
		pump(session);
		if (inboxStore !== undefined && reconcileInbox) {
			void (async () => {
				for (const item of await inboxStore.list(session.sessionId)) {
					if (item.status !== "delivering") continue;
					// A local user block proves intent, not provider admission. Do not
					// turn a crashed delivery into a false acknowledgment or replay.
					await publishInbox(await inboxStore.markUncertain(session.sessionId, item.id));
				}
				if (!deferInbox) await drain(session.sessionId);
			})();
		}
	}

	function launchSettings(
		cwd: string,
		provider: string,
		settingsAtCwd: Settings = settingsForCwd(cwd),
	): { settings: Settings; steeringSafe: boolean } {
		if (provider === "opencode" && makeSession === startSession) {
			requireManagedOpenCode(providerFor(settingsAtCwd, provider));
			openCodeInvocation();
		}
		return { settings: settingsAtCwd, steeringSafe: false };
	}

	async function start(o: {
		deferInbox?: boolean;
		sessionId: SessionId;
		workspaceId: WorkspaceId;
		cwd: string;
		provider: string;
		model: string;
		access: Access;
		unsandboxed?: boolean;
		netaTools: boolean;
		actorId?: string;
		resumeVendorSessionId?: string;
		fallbackModels?: string[];
	}): Promise<{ sessionId: SessionId; provider: string; model: string }> {
		// 05: the actor is the leader's session, or an agent's `agentId`. The
		// token is minted under whichever this is, so the proxy's `--actor`
		// and the router's `resolveActor` agree.
		const actorId = o.actorId ?? o.sessionId;
		const token = tokens.mint(actorId);
		// A provider that will not launch must not leave its token behind:
		// the actor it names has no session, and until `closeAll` nothing
		// else would ever revoke it.
		let session: RuntimeSession;
		try {
			const launch = launchSettings(o.cwd, o.provider);
			session = await makeSession({
				settings: launch.settings,
				provider: o.provider,
				access: o.access,
				unsandboxed: o.unsandboxed,
				cwd: o.cwd,
				model: o.model,
				fallbackModels: o.fallbackModels,
				mcpServers: netaServers(o.netaTools, actorId, token),
				actorId,
				sessionId: o.sessionId,
				steeringSafe: launch.steeringSafe,
				...(o.resumeVendorSessionId === undefined ? {} : { resumeVendorSessionId: o.resumeVendorSessionId }),
			});
		} catch (error) {
			tokens.revoke(actorId);
			throw error;
		}
		await register(session, o.provider, o.netaTools, true, o.deferInbox);
		actors.set(session.sessionId, actorId);
		return { sessionId: session.sessionId, provider: session.provider, model: session.model };
	}

	// Revoke tools immediately, but retain the binding until its queued final
	// events have flushed and durable completion recording has finished.
	async function closeSession(id: SessionId): Promise<void> {
		tokens.revoke(actors.get(id) ?? id);
		const record = table.get(id);
		if (record !== undefined) {
			try {
				await record.session.close();
			} catch {
				// Already gone. The owned session close ends its event stream.
			}
			await pumpPromises.get(record.session);
			pumpPromises.delete(record.session);
			if (table.get(id)?.session !== record.session) return;
			table.delete(id);
		}
		actors.delete(id);
		prompts.delete(id);
	}

	adapted = {
		prepareExternalActor: (sessionId, actorId = sessionId) => {
			const token = minted.get(actorId) ?? tokens.mint(actorId);
			actors.set(sessionId, actorId);
			return token;
		},
		send: async (id, text, attachments, _provenance) => {
			if (inboxStore === undefined) {
				const turnId = await adapted.prompt(id, text, attachments, _provenance);
				return {
					id: turnId,
					sessionId: id,
					createdAt: nowIso(),
					text,
					attachments: [],
					status: "delivered",
					deliveredAt: nowIso(),
					turnId,
				};
			}
			if (_provenance.readerDirected === false && _provenance.sourceId && !wakeTimers.has(id)) {
				const timer = setTimeout(() => {
					wakeTimers.delete(id);
					void drain(id);
				}, 100);
				timer.unref();
				wakeTimers.set(id, timer);
			}
			const item = await sessionLifecycle.run(id, async () => {
				const queued = await inboxStore.enqueue(id, text, attachments, _provenance);
				await publishInbox(queued);
				return queued;
			});
			if (_provenance.readerDirected === false && _provenance.sourceId) return item;
			await drain(id);
			return (await inboxStore.list(id)).find((candidate) => candidate.id === item.id) ?? item;
		},
		listInbox: (id) => inboxStore?.list(id) ?? Promise.resolve([]),
		createSession: async (o) => {
			// Minted up front so the leader's tools entry carries the real
			// session id; 03 reuses it. The token is node-minted per 05.
			return start({ ...o, sessionId: o.sessionId ?? ulid() });
		},
		ensureSession: async (o) => {
			const record = table.get(o.sessionId);
			if (record !== undefined && o.forceRelaunch === true) {
				await closeSession(o.sessionId);
			} else if (record !== undefined) {
				if (record.session.access === o.access) {
					return { sessionId: o.sessionId, provider: record.provider, model: record.session.model };
				}
				// 07: a mode change reaches the provider process only through
				// a relaunch. 03 relaunches in place — same session id, same
				// vendor session, same event pump — so a Lead++ grant lands on
				// the next `workspace.open` instead of waiting for a restart.
				try {
					await record.session.relaunch(o.access);
					// 03's `relaunch` reassigns `vendorSessionId` from the
					// relaunch response, and this path does not go through
					// `register`: without this patch the stored id goes stale
					// and the next Node restart resumes against an id the
					// provider no longer knows.
					await conversations
						?.setMeta(o.sessionId, {
							vendorSessionId: record.session.vendorSessionId,
							bindingGeneration: record.session.bindingGeneration,
						})
						.catch(() => undefined);
					return { sessionId: o.sessionId, provider: record.provider, model: record.session.model };
				} catch {
					// It would not come back (a vendor that forgot the session
					// it claims to resume, say). The old process is gone
					// either way, so this session is now as lost as one that
					// died with the node: drop it and make a live one below.
					await closeSession(o.sessionId);
				}
			}
			const meta = conversations === undefined ? undefined : await conversations.meta(o.sessionId);
			const vendor = meta?.vendorSessionId;
			let resumeError: unknown;
			if (
				vendor !== undefined &&
				vendor !== "" &&
				launchSettings(o.cwd, o.provider).settings.providers[o.provider]?.resume === true
			) {
				try {
					return await start({
						...o,
						fallbackModels: o.fallbackModels ?? meta?.fallbackModels,
						resumeVendorSessionId: vendor,
					});
				} catch (error) {
					resumeError = error;
					// The vendor forgot the session (or refuses resume): a
					// fresh one below, under a new id, is still a leader the
					// person can talk to. `start` has already revoked the
					// token it minted for the attempt.
				}
			}
			if (o.allowFresh === false || (o.provider === "opencode" && vendor !== undefined && vendor !== "")) {
				throw new NodeError(
					"PROVIDER_ERROR",
					`Could not restore saved conversation ${o.sessionId}: ${resumeError instanceof Error ? resumeError.message : "no resumable OpenCode session is recorded"}`,
				);
			}
			const pendingInbox =
				inboxStore === undefined
					? []
					: (await inboxStore.list(o.sessionId)).filter(
							(item) => item.status === "queued" || item.status === "delivering" || item.status === "uncertain",
						);
			// Keep the Neta identity when durable messages still point at it. A
			// session with no inbox keeps the established fresh-identity recovery.
			return start({
				...o,
				fallbackModels: o.fallbackModels ?? meta?.fallbackModels,
				sessionId: pendingInbox.length > 0 ? o.sessionId : ulid(),
			});
		},
		prompt: async (id, text, attachments = [], provenance = { readerDirected: false }) => {
			if (switching.has(id)) throw new NodeError("BUSY", "provider switch is in progress");
			const session = live(id);
			if (session.provider === "opencode" && systemContext) {
				const actorId = actors.get(id) ?? id;
				await writeSystemContext({
					sessionId: id,
					actorId,
					bindingGeneration: session.bindingGeneration,
					role: actorId === id ? "leader" : session.unsandboxed ? "lead" : "agent",
					text: systemContext(id),
				});
			}
			// Set before the turn opens: `prompt` pushes the turn event
			// synchronously, and the pump reads it a microtask later. An
			// entry the pump has not consumed belongs to another client's
			// prompt, which is still opening its turn: this one will be
			// refused, so it neither overwrites that text nor deletes it on
			// the way out.
			if (prompts.has(id)) throw new NodeError("BUSY", "a prompt is already starting");
			const claimed: {
				text: string;
				attachments: PromptAttachment[];
				readerDirected: boolean;
				recoveryNotice?: string;
				messageId?: string;
				messageIds?: string[];
			} = {
				text,
				attachments,
				readerDirected: provenance.readerDirected,
				...(inboxPromptIds.get(id) === undefined
					? {}
					: { messageId: inboxPromptIds.get(id)?.[0], messageIds: inboxPromptIds.get(id) }),
			};
			prompts.set(id, claimed);
			let ownsRecoverySwitch = false;
			try {
				const meta = conversations === undefined ? undefined : await conversations.meta(id);
				const pendingHandoff = meta?.pendingHandoff?.trim();
				const pendingBrief = meta?.pendingBrief?.trim();
				const prefix =
					pendingHandoff === undefined || pendingHandoff === ""
						? session.provider === "opencode"
							? undefined
							: pendingBrief
						: pendingHandoff;
				let delivered =
					prefix === undefined || prefix === "" ? text : `${prefix}\n\n---\n\n## Current user message\n\n${text}`;
				let turnId: TurnId;
				try {
					if (inboxStore && claimed.messageIds) {
						const messages = await inboxStore.list(id);
						for (const messageId of claimed.messageIds) {
							const message = messages.find((item) => item.id === messageId);
							if (!message || message.status !== "delivering" || (inboxGuard && !(await inboxGuard(message))))
								throw new SuppressedInboxError("Runtime result no longer belongs to this active conversation");
						}
					}
					turnId = await session.prompt(delivered, attachments);
				} catch (error) {
					if (!(error instanceof Error && error.name === SessionClosedError.name)) throw error;
					// A provider may disappear while the Node and desktop remain
					// connected. Relaunch this exact Neta session on the next prompt;
					// otherwise every later Send fails permanently with "session is
					// closed" until the whole service is restarted.
					const record = table.get(id);
					if (record === undefined || record.session !== session) throw error;
					if (switching.has(id)) throw new NodeError("BUSY", "session replacement is in progress");
					switching.add(id);
					ownsRecoverySwitch = true;
					const actorId = actors.get(id) ?? id;
					const token = minted.get(actorId);
					if (token === undefined) throw new NodeError("UNAUTHORIZED", "session actor token is unavailable");
					const recoveryLaunch = launchSettings(session.cwd, record.provider);
					const options = {
						settings: recoveryLaunch.settings,
						steeringSafe: recoveryLaunch.steeringSafe,
						provider: record.provider,
						access: session.access,
						unsandboxed: session.unsandboxed,
						cwd: session.cwd,
						model: session.model,
						fallbackModels: session.fallbackModels,
						mcpServers: netaServers(record.netaTools === true, actorId, token),
						actorId,
						sessionId: id,
					};
					const meta = conversations === undefined ? undefined : await conversations.meta(id);
					let relaunched: RuntimeSession;
					try {
						relaunched = await makeSession({
							...options,
							...(meta?.vendorSessionId === undefined ? {} : { resumeVendorSessionId: meta.vendorSessionId }),
						});
					} catch (resumeError) {
						if (record.provider === "opencode" && meta?.vendorSessionId) {
							throw new NodeError(
								"PROVIDER_ERROR",
								`Could not restore saved OpenCode session ${meta.vendorSessionId}: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`,
							);
						}
						relaunched = await makeSession(options);
						const recap = await recoveryHandoff?.(id).catch(() => "");
						if (recap !== undefined && recap.trim() !== "") {
							delivered = `${recap}\n\n---\n\n## Current user message\n\n${text}`;
							claimed.recoveryNotice =
								record.netaTools === true
									? "Provider restarted with a recap of recent messages. Earlier history is available through Neta."
									: "Provider restarted with a clipped recap of recent messages. Earlier provider context may be unavailable.";
						} else {
							claimed.recoveryNotice =
								"Provider restarted; no earlier conversation text was available to restore.";
						}
					}
					await register(relaunched, record.provider, record.netaTools === true, false);
					if (relaunched.provider === "opencode" && systemContext) {
						await writeSystemContext({
							sessionId: id,
							actorId,
							bindingGeneration: relaunched.bindingGeneration,
							role: actorId === id ? "leader" : relaunched.unsandboxed ? "lead" : "agent",
							text: systemContext(id),
						});
					}
					turnId = relaunched.prompt(delivered, attachments);
				}
				if (pendingHandoff !== undefined && pendingHandoff !== "") {
					await conversations?.setMeta(id, { pendingHandoff: undefined }).catch(() => undefined);
				}
				if (pendingBrief !== undefined && pendingBrief !== "") {
					await conversations?.setMeta(id, { pendingBrief: undefined }).catch(() => undefined);
				}
				return turnId;
			} catch (error) {
				if (prompts.get(id) === claimed) {
					prompts.delete(id);
				}
				throw error;
			} finally {
				if (ownsRecoverySwitch) releaseSwitch(id);
			}
		},
		runtimeDiagnostics: async (id) => {
			const record = table.get(id);
			if (record)
				return {
					attached: true,
					bindingGeneration: record.session.bindingGeneration,
					turnId: record.session.openTurnId,
					model: record.session.model,
					provider: record.provider,
					contract: record.session.nativeAttachment?.contract,
				};
			const meta = await conversations?.meta(id);
			return {
				attached: false,
				bindingGeneration: meta?.bindingGeneration,
				model: meta?.model,
				provider: meta?.provider,
			};
		},
		capabilities: (id) => live(id).promptCapabilities,
		nativeAttachment: (id) => live(id).nativeAttachment,
		ensureNativeAttachment: async (id) => {
			const session = live(id);
			const attachment = session.nativeAttachment;
			if (!attachment) return attachment;
			if (await nativeEndpointReady(attachment)) {
				if (attachment.apiVersion === 2) await session.setConfigOption("neta_refresh_tools", "");
				return attachment;
			}
			if (switching.has(id) || session.openTurnId !== undefined || prompts.has(id))
				throw new NodeError(
					"BUSY",
					"Chat is reconnecting while this conversation is active. Try opening it again after the reply finishes.",
				);
			switching.add(id);
			try {
				await session.relaunch(session.access);
				await conversations?.setMeta(id, {
					vendorSessionId: session.vendorSessionId,
					bindingGeneration: session.bindingGeneration,
				});
				const recovered = session.nativeAttachment;
				if (!recovered || !(await nativeEndpointReady(recovered)))
					throw new NodeError(
						"PROVIDER_ERROR",
						"The chat connection could not be restored. Your conversation is saved; try opening it again.",
					);
				if (recovered.apiVersion === 2) await session.setConfigOption("neta_refresh_tools", "");
				return recovered;
			} finally {
				releaseSwitch(id);
			}
		},
		setNativeVariant: async (id, variant) => {
			const session = live(id);
			if (!session.nativeAttachment)
				throw new NodeError("PROVIDER_ERROR", "Native effort selection requires Neta OpenCode");
			if (variant === undefined) await session.setConfigOption("neta_effort", "");
			else await session.setConfigOption("effort", variant);
		},
		setNativeAgent: async (id, agent) => {
			const session = live(id);
			if (!session.nativeAttachment)
				throw new NodeError("PROVIDER_ERROR", "Native agent selection requires Neta OpenCode");
			if (session.configOptions.find((option) => option.id === "mode")?.currentValue !== agent)
				await session.setConfigOption("mode", agent);
		},
		setModel: async (id, model) => {
			const session = live(id);
			await session.setModel(model);
			if (session.model !== model) throw new NodeError("PROVIDER_ERROR", `provider did not select model ${model}`);
			await conversations?.setMeta(id, { model: session.model }).catch(() => undefined);
		},
		setPendingHandoff: async (id, handoff) => {
			await conversations?.setMeta(id, { pendingHandoff: handoff === "" ? undefined : handoff });
		},
		switchProvider: async (id, provider, model, handoff) => {
			if (switching.has(id)) throw new NodeError("BUSY", "provider switch is already in progress");
			const record = table.get(id);
			if (record === undefined) throw new NodeError("NOT_FOUND", `no such session: ${id}`);
			if (record.session.openTurnId !== undefined)
				throw new NodeError("BUSY", "provider switch requires an idle session");
			if (prompts.has(id)) throw new NodeError("BUSY", "provider switch requires an idle session");
			const actorId = actors.get(id) ?? id;
			const token = minted.get(actorId);
			if (token === undefined) throw new NodeError("UNAUTHORIZED", "session actor token is unavailable");
			switching.add(id);
			const old = record.session;
			const targetAccess = old.access;
			let candidate: RuntimeSession;
			try {
				const targetLaunch = launchSettings(old.cwd, provider);
				candidate = await makeSession({
					settings: targetLaunch.settings,
					steeringSafe: targetLaunch.steeringSafe,
					provider,
					access: targetAccess === "readWrite" ? "readOnly" : targetAccess,
					unsandboxed: old.unsandboxed,
					cwd: old.cwd,
					...(model === undefined ? {} : { model }),
					fallbackModels: old.fallbackModels,
					mcpServers: netaServers(true, actorId, token),
					actorId,
					sessionId: id,
				});
			} catch (error) {
				releaseSwitch(id);
				throw new NodeError("PROVIDER_ERROR", `could not start provider ${provider}: ${String(error)}`);
			}
			let previousMeta: Awaited<ReturnType<ConversationStore["meta"]>>;
			try {
				previousMeta = conversations === undefined ? undefined : await conversations.meta(id);
			} catch (error) {
				await candidate.close().catch(() => undefined);
				releaseSwitch(id);
				throw new NodeError("PROVIDER_ERROR", `could not read provider handoff state: ${String(error)}`);
			}
			try {
				await conversations?.setMeta(id, {
					provider: candidate.provider,
					model: candidate.model,
					vendorSessionId: candidate.vendorSessionId,
					bindingGeneration: candidate.bindingGeneration,
					pendingHandoff: handoff === undefined || handoff === "" ? undefined : handoff,
				});
			} catch (error) {
				await candidate.close().catch(() => undefined);
				releaseSwitch(id);
				throw new NodeError("PROVIDER_ERROR", `could not persist provider handoff: ${String(error)}`);
			}
			await old.close().catch(() => undefined);
			await pumpPromises.get(old);
			try {
				if (targetAccess === "readWrite") await candidate.relaunch("readWrite");
				await register(candidate, provider, record.netaTools === true);
				actors.set(id, actorId);
				releaseSwitch(id);
				return { provider: candidate.provider, model: candidate.model };
			} catch (error) {
				await candidate.close().catch(() => undefined);
				table.delete(id);
				try {
					const restoreLaunch = launchSettings(old.cwd, record.provider);
					const restored = await makeSession({
						settings: restoreLaunch.settings,
						steeringSafe: restoreLaunch.steeringSafe,
						provider: record.provider,
						access: targetAccess,
						unsandboxed: old.unsandboxed,
						cwd: old.cwd,
						model: old.model,
						fallbackModels: old.fallbackModels,
						mcpServers: netaServers(true, actorId, token),
						actorId,
						sessionId: id,
					});
					await register(restored, record.provider, record.netaTools === true);
					actors.set(id, actorId);
					if (previousMeta !== undefined) {
						await conversations?.setMeta(id, {
							provider: restored.provider,
							model: restored.model,
							vendorSessionId: restored.vendorSessionId,
							bindingGeneration: restored.bindingGeneration,
							pendingHandoff: previousMeta.pendingHandoff,
							pendingBrief: previousMeta.pendingBrief,
						});
					}
					releaseSwitch(id);
					throw new NodeError(
						"PROVIDER_ERROR",
						`provider ${provider} could not assume session access; restored ${record.provider}: ${String(error)}`,
					);
				} catch (rollbackError) {
					releaseSwitch(id);
					if (rollbackError instanceof NodeError) throw rollbackError;
					throw new NodeError(
						"PROVIDER_ERROR",
						`provider ${provider} failed and ${record.provider} rollback failed: ${String(rollbackError)}`,
					);
				}
			}
		},
		resetSession: async (id, brief, rebind) => {
			if (switching.has(id)) throw new NodeError("BUSY", "session replacement is already in progress");
			const record = table.get(id);
			if (record === undefined) throw new NodeError("NOT_FOUND", `no such session: ${id}`);
			switching.add(id);
			const old = record.session;
			const oldActor = actors.get(id) ?? id;
			const newId = ulid();
			const workspaceLeader = oldActor === id;
			const newActor = workspaceLeader ? newId : oldActor;
			const token = workspaceLeader ? tokens.mint(newActor) : minted.get(oldActor);
			if (token === undefined) {
				releaseSwitch(id);
				throw new NodeError("UNAUTHORIZED", "session actor token is unavailable");
			}
			let candidate: RuntimeSession;
			try {
				const resetLaunch = launchSettings(old.cwd, record.provider);
				candidate = await makeSession({
					settings: resetLaunch.settings,
					steeringSafe: resetLaunch.steeringSafe,
					provider: record.provider,
					access: old.access,
					unsandboxed: old.unsandboxed,
					cwd: old.cwd,
					model: old.model,
					fallbackModels: old.fallbackModels,
					mcpServers: netaServers(record.netaTools === true, newActor, token),
					actorId: newActor,
					sessionId: newId,
				});
			} catch (error) {
				if (workspaceLeader) tokens.revoke(newActor);
				releaseSwitch(id);
				throw new NodeError("PROVIDER_ERROR", `could not reset provider session: ${String(error)}`);
			}
			try {
				switching.add(newId);
				await register(candidate, record.provider, record.netaTools === true, false);
				actors.set(newId, newActor);
				await conversations?.setMeta(newId, { pendingBrief: brief });
				const selected = { sessionId: newId, provider: candidate.provider, model: candidate.model };
				if (inboxStore !== undefined) {
					for (const message of await inboxStore.list(id)) {
						if (message.status === "delivering")
							await publishInbox(await inboxStore.markUncertain(id, message.id));
						if (message.status === "queued" && message.readerDirected === false && message.sourceId)
							await publishInbox(
								await inboxStore.enqueue(newId, message.text, message.attachments, {
									readerDirected: false,
									sourceId: message.sourceId,
								}),
							);
					}
				}
				await rebind(selected);
				if (inboxStore !== undefined)
					for (const message of await inboxStore.discardQueued(id)) await publishInbox(message);
				if (old.openTurnId !== undefined) await old.cancel().catch(() => undefined);
				await old.close().catch(() => undefined);
				await pumpPromises.get(old);
				table.delete(id);
				actors.delete(id);
				prompts.delete(id);
				if (workspaceLeader) tokens.revoke(oldActor);
				releaseSwitch(id);
				releaseSwitch(newId);
				return selected;
			} catch (error) {
				await candidate.close().catch(() => undefined);
				table.delete(newId);
				actors.delete(newId);
				releaseSwitch(newId);
				if (workspaceLeader) tokens.revoke(newActor);
				releaseSwitch(id);
				throw error;
			}
		},
		listProviders: (o) => {
			const session = o?.sessionId === undefined ? undefined : table.get(o.sessionId)?.session;
			const effectiveSettings = session === undefined ? settings : settingsForCwd(session.cwd);
			const cwd = session?.cwd ?? process.cwd();
			return Object.entries(effectiveSettings.providers)
				.filter(([id, provider]) => id === "opencode" && provider.disabled !== true)
				.map(([id, provider]) => {
					const resolved = launchSettings(cwd, id, effectiveSettings).settings.providers[id] ?? provider;
					let available = providerCommandAvailable(resolved, cwd);
					let unavailableReason = `Command not found: ${resolved.command}`;
					if (id === "opencode") {
						try {
							requireManagedOpenCode(resolved);
							available = openCodeInvocation().apiVersion === 2;
						} catch (error) {
							available = false;
							unavailableReason = error instanceof Error ? error.message : String(error);
						}
					}
					return {
						id,
						label: id.charAt(0).toUpperCase() + id.slice(1),
						defaultModel: provider.defaultModel,
						available,
						...(available ? {} : { unavailableReason }),
						...(resolved.command === "npx" ? { note: "Adapter may download on first launch" } : {}),
					};
				});
		},
		listModels: async (o) => {
			if (o.sessionId !== undefined) {
				const record = table.get(o.sessionId);
				if (record === undefined) {
					throw new NodeError("NOT_FOUND", `no such session: ${o.sessionId}`);
				}
				if (record.provider === "opencode" && record.session.nativeAttachment?.apiVersion === 2) {
					try {
						await record.session.setConfigOption("neta_refresh_models", "");
					} catch {
						throw new NodeError(
							"PROVIDER_ERROR",
							"Could not refresh connected OpenCode models. Retry in /routing; no cached catalog was used.",
						);
					}
				}
				const listed = record.session.listModels().map((model) => ({
					id: model.id,
					name: model.name,
					provider: record.provider,
					description: model.description,
				}));
				if (listed.length > 0 || record.provider === "opencode") return listed;
				const fallback = settingsForCwd(record.session.cwd).providers[record.provider]?.defaultModel;
				return fallback === undefined || fallback === ""
					? []
					: [{ id: fallback, name: fallback, provider: record.provider }];
			}
			const out: Array<{ id: string; name: string; provider: string; description?: string }> = [];
			const seen = new Set<string>();
			for (const record of table.values()) {
				if (o.provider !== undefined && record.provider !== o.provider) {
					continue;
				}
				for (const model of record.session.listModels()) {
					if (!seen.has(model.id)) {
						seen.add(model.id);
						out.push({
							id: model.id,
							name: model.name,
							provider: record.provider,
							description: model.description,
						});
					}
				}
			}
			if (
				o.provider !== undefined &&
				o.provider !== "opencode" &&
				!out.some((model) => model.provider === o.provider)
			) {
				const fallback = settings.providers[o.provider]?.defaultModel;
				if (fallback !== undefined && fallback !== "")
					out.push({ id: fallback, name: fallback, provider: o.provider });
			}
			return out;
		},
		cancel: async (id) => {
			await live(id).cancel();
		},
		close: closeSession,
		closeAll: async () => {
			for (const id of [...minted.keys()]) {
				tokens.revoke(id);
			}
			const closed = await Promise.allSettled(
				[...table.values()].map((record) => closeSession(record.session.sessionId)),
			);
			await Promise.all([...pumpPromises.values()]);
			const failure = closed.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
			actors.clear();
			prompts.clear();
		},
		onTurn: (fn) => {
			listeners.add(fn);
		},
		hasActiveWork: () =>
			pumpOperations > 0 ||
			sessionLifecycle.pendingCount > 0 ||
			prompts.size > 0 ||
			[...table.values()].some((record) => record.session.openTurnId !== undefined),
		isTurnActive: (sessionId) => table.get(sessionId)?.session.openTurnId !== undefined,
		actorToken: (sessionId) => minted.get(actors.get(sessionId) ?? sessionId),
		tokens,
	};
	const send = adapted.send;
	if (send)
		adapted.send = async (id, text, attachments, provenance) => {
			if (closing) throw new NodeError("BUSY", "Neta is stopping; the message was not admitted.");
			const leave = runtimeAdmission?.enter();
			try {
				return await send(id, text, attachments, provenance);
			} finally {
				leave?.();
			}
		};
	const ensureSession = adapted.ensureSession;
	adapted.ensureSession = (options) => guarded(options.sessionId, () => ensureSession(options));
	const createSession = adapted.createSession;
	adapted.createSession = (options) => {
		const sessionId = options.sessionId ?? ulid();
		return guarded(sessionId, () => {
			if (table.get(sessionId)) throw new NodeError("BUSY", "A conversation already owns this session identity.");
			return createSession({ ...options, sessionId });
		});
	};
	const prompt = adapted.prompt;
	adapted.prompt = (id, text, attachments, provenance) => guarded(id, () => prompt(id, text, attachments, provenance));
	const ensureNativeAttachment = adapted.ensureNativeAttachment;
	if (ensureNativeAttachment) adapted.ensureNativeAttachment = (id) => guarded(id, () => ensureNativeAttachment(id));
	const resetSession = adapted.resetSession;
	if (resetSession)
		adapted.resetSession = (id, brief, rebind) =>
			guarded(id, async () => {
				const selected = await resetSession(id, brief, rebind);
				sessionLifecycle.invalidate(id, true);
				return selected;
			});
	const switchProvider = adapted.switchProvider;
	if (switchProvider)
		adapted.switchProvider = (id, provider, model, handoff) => {
			if (prompts.has(id) || table.get(id)?.session.openTurnId !== undefined)
				return Promise.reject(new NodeError("BUSY", "provider switch requires an idle session"));
			return guarded(id, () => switchProvider(id, provider, model, handoff));
		};
	const setModel = adapted.setModel;
	adapted.setModel = (id, model) => guarded(id, () => setModel(id, model));
	const setNativeVariant = adapted.setNativeVariant;
	if (setNativeVariant) adapted.setNativeVariant = (id, variant) => guarded(id, () => setNativeVariant(id, variant));
	const setNativeAgent = adapted.setNativeAgent;
	if (setNativeAgent) adapted.setNativeAgent = (id, agent) => guarded(id, () => setNativeAgent(id, agent));
	adapted.close = (id) =>
		guarded(id, async () => {
			await closeSession(id);
			sessionLifecycle.invalidate(id);
		});
	const stopAll = adapted.closeAll;
	adapted.closeAll = async () => {
		closing = true;
		for (const timer of wakeTimers.values()) clearTimeout(timer);
		wakeTimers.clear();
		await sessionLifecycle.settled();
		await stopAll();
	};
	return adapted;
}

// Every agent in starting, running or blocked comes back interrupted,
// carrying its previous state. Completed and archived agents are untouched,
// and no events are appended here: `startNode` writes one `node.restarted`
// per affected workspace afterwards.
export async function markInterrupted(store: NodeStore): Promise<Array<{ workspaceId: WorkspaceId; agents: number }>> {
	// Active turns do not survive a Node restart. Clear stale leader activity
	// before clients can read the first snapshot, including unopened workspaces.
	for (const leader of store.listLeaders()) {
		if (leader.state !== "running") continue;
		await store.putLeader({ ...leader, state: "idle", currentTurnId: undefined, bindingGeneration: undefined });
	}
	const counts = new Map<WorkspaceId, number>();
	for (const mission of store.listMissions()) {
		for (const agent of store.listAgents(mission.id)) {
			if (agent.state !== "starting" && agent.state !== "running" && agent.state !== "blocked") {
				continue;
			}
			await store.putAgent({ ...agent, stateBefore: agent.state, state: "interrupted" });
			counts.set(agent.workspaceId, (counts.get(agent.workspaceId) ?? 0) + 1);
		}
	}
	return [...counts].map(([workspaceId, agents]) => ({ workspaceId, agents }));
}

export const allHandlers: NodeHandlers = {
	...snapshotHandlers,
	...registryHandlers,
	...conversationHandlers,
	...glanceHandlers,
	...meHandlers,
	...workspaceHandlers,
	...terminalHandlers,
	...diagnosticsHandlers,
	...routingHandlers,
};

export interface Node {
	descriptor: NodeDescriptor;
	hub: Hub;
	stop(): Promise<void>;
	stopped: Promise<void>;
}

// The six lifecycle steps in order — lock, stores, restart marking,
// restart events, descriptor, listen — so no client sees half-restored
// state. A failure after the lock releases everything it took and rethrows.
export async function startNode(o?: {
	store?: NodeStore;
	runtime?: NodeRuntime;
	sessionFactory?: (options: StartOptions) => Promise<RuntimeSession>;
}): Promise<Node> {
	// Before the lock and before the store: an unusable socket path fails the
	// start whatever else happens, and taking the lock or creating the store
	// directories first would leave them behind in a directory the Node
	// cannot serve from.
	const socketPath = join(netaDir(), "node.sock");
	const socketError = socketPathError(socketPath);
	if (socketError !== undefined) {
		throw new Error(socketError);
	}
	const lock: LockHandle = await acquireLock();
	const runtimeAdmission = new RuntimeAdmission(lock.instanceId);
	let realStore: Store | undefined;
	try {
		let storePort: NodeStore;
		let adapted: AdaptedStore | undefined;
		if (o?.store !== undefined) {
			storePort = o.store;
		} else {
			realStore = await openStore();
			adapted = await adaptStore(realStore);
			storePort = adapted;
		}
		const settings = loadSettings({ netaDir: netaDir() }).settings;
		let adaptedRuntime: AdaptedRuntime | undefined;
		let runtimePort: NodeRuntime;
		if (o?.runtime === undefined) {
			const captureGlance = async (sessionId: SessionId, turn: Turn, blocks: Block[]): Promise<void> => {
				if (realStore === undefined) return;
				const actor = glanceActorForSession(storePort, sessionId);
				if (actor === undefined) return;
				const source = blocks
					.map((block) => block.text.trim())
					.filter(Boolean)
					.join("\n\n");
				if (source === "") return;
				const card = await realStore.glance.upsert({
					id: `${sessionId}:${turn.id}`,
					workspaceId: actor.workspaceId,
					at: turn.endedAt ?? nowIso(),
					sessionId,
					turnId: turn.id,
					firstBlockSeq: blocks[0]?.seq ?? 0,
					lastBlockSeq: blocks.at(-1)?.seq ?? 0,
					sourceHash: createHash("sha256").update(source).digest("hex"),
					source,
					preview: source.slice(0, 1200),
					interrupted: turn.cancelled === true,
					actorKind: actor.actorKind,
					agentId: actor.agentId,
					missionId: actor.missionId,
					agentLabel: actor.agentLabel,
				});
				const { source: _source, ...visible } = card;
				hub.broadcast("glance.changed", { card: visible });
			};
			adaptedRuntime = adaptRuntime(
				settings,
				realStore?.conversations,
				(cwd) => loadSettings({ netaDir: netaDir(), workspaceRoot: cwd }).settings,
				captureGlance,
				(sessionId) => prepareHandoffForSession({ store: storePort }, sessionId),
				realStore?.inbox,
				(sessionId) => sessionSystemContext({ store: storePort }, sessionId),
				(notification) => mounted?.recordTurn(notification) ?? Promise.resolve(),
				runtimeAdmission,
				(message) => mounted?.canDeliverInbox(message) ?? Promise.resolve(true),
				o?.sessionFactory,
			);
			runtimePort = adaptedRuntime;
		} else {
			runtimePort = o.runtime;
		}
		const restartLeases = new LeaseManager(createFileLeaseStore(netaDir()));
		for (const mission of storePort.listMissions()) {
			// A self-led Lead++ request acquires under the mission id before the
			// provider is relaunched. If the Node died before the durable mode
			// changed, that reservation cannot represent a live writer.
			if (mission.lead.kind === "leader" && storePort.getLeader(mission.workspaceId)?.mode === "lead") {
				await restartLeases.interrupt(mission.workspaceId, mission.id);
			}
			for (const agent of storePort.listAgents(mission.id)) {
				if (agent.state !== "queued") {
					await restartLeases.interrupt(agent.workspaceId, agent.id);
				}
			}
		}
		for (const entry of await markInterrupted(storePort)) {
			await storePort.appendEvent({
				workspaceId: entry.workspaceId,
				kind: "node.restarted",
				data: { agents: entry.agents },
			});
		}
		if (realStore !== undefined) {
			const me = openMeStore();
			for (const workspace of storePort.listWorkspaces()) {
				await replayMeEvents({
					store: me,
					workspaceId: workspace.id,
					read: (sinceSeq, limit) => realStore?.events.tail(workspace.id, sinceSeq, limit) ?? Promise.resolve([]),
					context: () => ({
						workspaces: storePort.listWorkspaces(),
						leaders: storePort.listLeaders(),
						agents: storePort.listAgents(),
						missions: storePort.listMissions(),
					}),
				});
			}
		}
		const token = newToken();
		const descriptor: NodeDescriptor = {
			socket: socketPath,
			token,
			pid: process.pid,
			protocolVersion: PROTOCOL_VERSION,
			runtimeBuild: netaBuildId(),
			instanceId: lock.instanceId,
			startedAt: nowIso(),
		};
		await writeDescriptor(descriptor);
		let hub!: Hub;
		let stoppedResolve: () => void = () => undefined;
		const stopped = new Promise<void>((done) => {
			stoppedResolve = done;
		});
		const piActors = new Map<string, { actorId: string; prompt?: string }>();
		const claudeExecutable = (() => {
			const configured = process.env.NETA_CLAUDE_BIN;
			const candidates = [
				configured,
				...(process.env.PATH ?? "").split(":").map((dir) => join(dir, "claude")),
				join(process.env.HOME ?? "", ".local/bin/claude"),
				"/opt/homebrew/bin/claude",
				"/usr/local/bin/claude",
			];
			return candidates.find((candidate): candidate is string => {
				if (!candidate) return false;
				try {
					accessSync(candidate, constants.X_OK);
					return statSync(candidate).isFile();
				} catch {
					return false;
				}
			});
		})();
		const pi =
			process.env.NETA_PI_RUNTIME === "1" || process.env.NETA_RUNTIME === "pi"
				? createPiTerminalManager({
						dataDir: netaDir(),
						nodeCommand: process.env.NETA_PI_NODE,
						piCommand: process.env.NETA_PI_NODE,
						hostPath: process.env.NETA_PI_HOST,
						extensionPath: process.env.NETA_PI_EXTENSION,
						extraExtensionPath: process.env.NETA_PI_FIXTURE_EXTENSION,
						bridgePath: process.env.NETA_PI_CLAUDE_BRIDGE,
						piCliPath: process.env.NETA_PI_CLI,
						provider: process.env.NETA_PI_PROVIDER,
						model: process.env.NETA_PI_MODEL,
						claudeExecutable,
						envForSession: (sessionId) => {
							const persisted = storePort
								.listAgents()
								.find((agent) => agent.sessionId === sessionId && agent.provider === "pi");
							const actor = piActors.get(sessionId) ?? { actorId: persisted?.id ?? sessionId };
							return {
								NETA_DESCRIPTOR: join(netaDir(), "node.json"),
								NETA_ACTOR_ID: actor.actorId,
								NETA_ACTOR_TOKEN: runtimePort.prepareExternalActor?.(sessionId, actor.actorId) ?? "",
								...(actor.prompt === undefined ? {} : { NETA_INITIAL_PROMPT: actor.prompt }),
							};
						},
					})
				: undefined;
		let stopping: Promise<void> | undefined;
		const stop = async (): Promise<void> => {
			if (stopping !== undefined) {
				return stopping;
			}
			runtimeAdmission.stop();
			stopping = (async (): Promise<void> => {
				try {
					// 07's mode ticker first: it writes through the store,
					// which is about to close.
					mounted?.stop();
					hub.broadcast("node", { phase: "stopping" });
					await server.close();
					pi?.closeAll();
					await runtimePort.closeAll();
					await storePort.compact();
					if (realStore !== undefined) {
						await realStore.close();
					}
					await clearDescriptor(lock.instanceId);
					await lock.release();
				} finally {
					stoppedResolve();
				}
			})();
			return stopping;
		};
		const ctx: Omit<NodeContext, "hub"> = {
			store: storePort,
			runtime: runtimePort,
			nodeVersion: netaVersion(),
			runtimeAdmission,
			stop,
			...(pi === undefined ? {} : { pi }),
		};
		// The tools are only mounted on a real Node: the router needs 02's
		// registry for numbers and records, which the ports do not carry, so a
		// stubbed store (handler tests) serves the rest and no tools.
		const mounted =
			realStore !== undefined && adapted !== undefined && adaptedRuntime !== undefined
				? toolMount({
						real: realStore,
						store: adapted,
						runtime: adaptedRuntime,
						settings,
						runtimeAdmission,
						hub: () => hub,
						...(pi === undefined
							? {}
							: {
									pi: {
										start: async (input: {
											sessionId: string;
											actorId: string;
											cwd: string;
											prompt: string;
										}) => {
											piActors.set(input.sessionId, { actorId: input.actorId, prompt: input.prompt });
											await pi.startSession(input.sessionId, input.cwd);
										},
										close: (sessionId: string) => pi.closeSession(sessionId),
									},
								}),
					})
				: undefined;
		const tools = mounted?.handlers ?? {};
		const server = await createServer({ socketPath, token, handlers: { ...allHandlers, ...tools }, ctx });
		hub = server.hub;
		wireTurnStream({ ...ctx, hub: server.hub });
		await mounted?.recover();
		return { descriptor, hub: server.hub, stop, stopped };
	} catch (error) {
		if (realStore !== undefined) {
			await realStore.close().catch(() => undefined);
		}
		await clearDescriptor(lock.instanceId).catch(() => undefined);
		await lock.release().catch(() => undefined);
		throw error;
	}
}
