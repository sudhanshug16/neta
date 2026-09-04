// The Node lifecycle: exclusive lock, store load, restart marking, the
// descriptor, then listen. This is the only file that adapts the real 02
// and 03 modules to the `NodeStore`/`NodeAcp` ports; handlers only ever see
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
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { closeAll, SessionTable } from "../acp/lifecycle.ts";
import { type McpServerSpec, netaMcpServer } from "../acp/mcp.ts";
import type { AcpSession, SessionEvent } from "../acp/session.ts";
import { startSession } from "../acp/session.ts";
import { loadSettings, type Settings } from "../acp/settings.ts";
import { ulid } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import type {
	Access,
	Agent,
	AgentId,
	Block,
	Event,
	Leader,
	Mission,
	MissionId,
	SessionId,
	Turn,
	TurnId,
	WorkspaceId,
} from "../core/types.ts";
import type { ConversationStore } from "../store/conversations.ts";
import { createMutex, readJson, writeJsonAtomic } from "../store/files.ts";
import { openStore, type Store } from "../store/index.ts";
import { decodeWorkspaceId, paths, socketPathError } from "../store/paths.ts";
import { createTokenTable, type TokenTable } from "../tools/router.ts";
import { netaVersion } from "../version.ts";
import { conversationHandlers, wireTurnStream } from "./handlers-conversation.ts";
import { registryHandlers } from "./handlers-registry.ts";
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
import { createServer, type Hub, type NodeAcp, type NodeContext, type NodeHandlers, type NodeStore } from "./server.ts";
import { snapshotHandlers } from "./snapshot.ts";
import { workspaceHandlers } from "./workspace-open.ts";

export interface AdaptedStore extends NodeStore {
	refreshMissions(workspaceId?: WorkspaceId): Promise<void>;
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
		const record = await readJson<Leader>(join(paths().root, "leaders", name));
		if (record !== undefined) {
			leaders.set(record.workspaceId, record);
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
		listAgents: (missionId) => [...agents.values()].filter((agent) => agent.missionId === missionId),
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
		appendEvent: (event) => real.events.append(event),
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
		refreshMissions,
	};
}

export interface AdaptedAcp extends NodeAcp {
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
}

// `conversations` is the real 02 store when the Node runs for real. With it,
// every session starts with a conversation meta record, so `conversation.tail`
// succeeds (possibly empty) and subscribes the caller for the live `turn`
// stream; without it (stubbed tests) session creation touches no store.
export function adaptAcp(settings: Settings, conversations?: ConversationStore): AdaptedAcp {
	const table = new SessionTable({ settings, cwd: process.cwd(), access: "readOnly" });
	const listeners = new Set<(notification: TurnNotification) => void>();
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
	const prompts = new Map<SessionId, string>();

	function emit(notification: TurnNotification): void {
		for (const fn of [...listeners]) {
			try {
				fn(notification);
			} catch {
				// A listener never breaks the pump.
			}
		}
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
	async function closeTurn(sessionId: SessionId, state: PumpState, turnId: TurnId, cancelled: boolean): Promise<void> {
		await flush(sessionId, state);
		const open = state.open;
		state.open = undefined;
		const closed: Turn = {
			...(open?.id === turnId ? open : { id: turnId, sessionId, startedAt: nowIso(), role: "user" }),
			endedAt: nowIso(),
			...(cancelled ? { cancelled: true } : {}),
		};
		await writeTurn(closed);
		emit({ sessionId, turn: closed });
	}

	async function handle(sessionId: SessionId, state: PumpState, event: SessionEvent): Promise<void> {
		if (event.type === "turn") {
			// Claimed before any await. The desktop and the terminal are both
			// attached to the same session by design, so a second
			// `conversation.prompt` can land while this branch is awaiting a
			// file append; it is refused with `TurnInProgressError`, and its
			// catch used to delete the entry this turn had not read yet,
			// losing the first client's `user` block altogether.
			const text = prompts.get(sessionId);
			prompts.delete(sessionId);
			await flush(sessionId, state);
			state.open = event.turn;
			await writeTurn(event.turn);
			emit({ sessionId, turn: event.turn });
			if (text === undefined) {
				return;
			}
			state.injected += 1;
			const block: Block = {
				turnId: event.turn.id,
				seq: state.base + state.lastSeq + state.injected,
				at: nowIso(),
				role: "user",
				kind: "text",
				text,
			};
			// A user block never grows, so it goes straight to the file.
			await writeBlock(sessionId, block);
			emit({ sessionId, block });
			return;
		}
		if (event.type === "block") {
			const seq = state.base + event.block.seq + state.injected;
			if (state.pending !== undefined && state.pending.seq !== seq) {
				await flush(sessionId, state);
			}
			const block: Block = { ...event.block, seq };
			state.pending = block;
			state.lastSeq = Math.max(state.lastSeq, event.block.seq);
			emit({ sessionId, block });
			return;
		}
		if (event.type === "turnEnd") {
			await closeTurn(sessionId, state, event.turnId, event.cancelled);
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
		// A model or mode change is a bare ping: something changed, re-tail
		// for the current state.
		emit({ sessionId });
	}

	function pump(session: AcpSession): void {
		const run = async (): Promise<void> => {
			const state: PumpState = { base: await baseSeqOf(session.sessionId), injected: 0, lastSeq: 0 };
			try {
				for await (const event of session.events()) {
					await handle(session.sessionId, state, event);
				}
			} catch {
				// The iterator threw: the session is done.
			}
			await flush(session.sessionId, state);
		};
		void run();
	}

	function live(sessionId: SessionId): AcpSession {
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

	async function register(session: AcpSession, provider: string): Promise<void> {
		if (conversations !== undefined) {
			await conversations.create({
				sessionId: session.sessionId,
				provider: session.provider,
				model: session.model,
				vendorSessionId: session.vendorSessionId,
				createdAt: nowIso(),
			});
			// A resumed or re-created session gets a new vendor id, and the
			// next resume needs the current one.
			await conversations
				.setMeta(session.sessionId, { model: session.model, vendorSessionId: session.vendorSessionId })
				.catch(() => undefined);
		}
		table.set(session.sessionId, { session, provider });
		pump(session);
	}

	async function start(o: {
		sessionId: SessionId;
		workspaceId: WorkspaceId;
		cwd: string;
		provider: string;
		model: string;
		access: Access;
		netaTools: boolean;
		actorId?: string;
		resumeVendorSessionId?: string;
	}): Promise<{ sessionId: SessionId; provider: string; model: string }> {
		// 05: the actor is the leader's session, or an agent's `agentId`. The
		// token is minted under whichever this is, so the proxy's `--actor`
		// and the router's `resolveActor` agree.
		const actorId = o.actorId ?? o.sessionId;
		const token = tokens.mint(actorId);
		// A provider that will not launch must not leave its token behind:
		// the actor it names has no session, and until `closeAll` nothing
		// else would ever revoke it.
		let session: Awaited<ReturnType<typeof startSession>>;
		try {
			session = await startSession({
				settings,
				provider: o.provider,
				access: o.access,
				cwd: o.cwd,
				model: o.model,
				mcpServers: netaServers(o.netaTools, actorId, token),
				sessionId: o.sessionId,
				...(o.resumeVendorSessionId === undefined ? {} : { resumeVendorSessionId: o.resumeVendorSessionId }),
			});
		} catch (error) {
			tokens.revoke(actorId);
			throw error;
		}
		await register(session, o.provider);
		actors.set(session.sessionId, actorId);
		return { sessionId: session.sessionId, provider: session.provider, model: session.model };
	}

	// Free one live session: its token first, so a proxy that outlives the
	// process cannot keep calling tools as an agent that is gone.
	async function closeSession(id: SessionId): Promise<void> {
		tokens.revoke(actors.get(id) ?? id);
		actors.delete(id);
		prompts.delete(id);
		const record = table.get(id);
		if (record === undefined) {
			// Nothing live: archiving after a restart closes these.
			return;
		}
		table.delete(id);
		try {
			await record.session.close();
		} catch {
			// Already gone.
		}
	}

	return {
		createSession: async (o) => {
			// Minted up front so the leader's tools entry carries the real
			// session id; 03 reuses it. The token is node-minted per 05.
			return start({ ...o, sessionId: ulid() });
		},
		ensureSession: async (o) => {
			const record = table.get(o.sessionId);
			if (record !== undefined) {
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
						?.setMeta(o.sessionId, { vendorSessionId: record.session.vendorSessionId })
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
			if (vendor !== undefined && vendor !== "" && settings.providers[o.provider]?.resume === true) {
				try {
					return await start({ ...o, resumeVendorSessionId: vendor });
				} catch {
					// The vendor forgot the session (or refuses resume): a
					// fresh one below, under a new id, is still a leader the
					// person can talk to. `start` has already revoked the
					// token it minted for the attempt.
				}
			}
			return start({ ...o, sessionId: ulid() });
		},
		prompt: async (id, text) => {
			const session = live(id);
			// Set before the turn opens: `prompt` pushes the turn event
			// synchronously, and the pump reads it a microtask later. An
			// entry the pump has not consumed belongs to another client's
			// prompt, which is still opening its turn: this one will be
			// refused, so it neither overwrites that text nor deletes it on
			// the way out.
			const claimed = !prompts.has(id);
			if (claimed) {
				prompts.set(id, text);
			}
			try {
				return await session.prompt(text);
			} catch (error) {
				if (claimed && prompts.get(id) === text) {
					prompts.delete(id);
				}
				throw error;
			}
		},
		setModel: async (id, model) => {
			await live(id).setModel(model);
		},
		listModels: async (o) => {
			if (o.sessionId !== undefined) {
				const record = table.get(o.sessionId);
				if (record === undefined) {
					throw new NodeError("NOT_FOUND", `no such session: ${o.sessionId}`);
				}
				return record.session
					.listModels()
					.map((model) => ({ id: model.id, name: model.name, provider: record.provider }));
			}
			const out: Array<{ id: string; name: string; provider: string }> = [];
			const seen = new Set<string>();
			for (const record of table.values()) {
				if (o.provider !== undefined && record.provider !== o.provider) {
					continue;
				}
				for (const model of record.session.listModels()) {
					if (!seen.has(model.id)) {
						seen.add(model.id);
						out.push({ id: model.id, name: model.name, provider: record.provider });
					}
				}
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
			actors.clear();
			prompts.clear();
			await closeAll(table);
		},
		onTurn: (fn) => {
			listeners.add(fn);
		},
		actorToken: (sessionId) => minted.get(actors.get(sessionId) ?? sessionId),
		tokens,
	};
}

// Every agent in starting, running or blocked comes back interrupted,
// carrying its previous state. Completed and archived agents are untouched,
// and no events are appended here: `startNode` writes one `node.restarted`
// per affected workspace afterwards.
export async function markInterrupted(store: NodeStore): Promise<Array<{ workspaceId: WorkspaceId; agents: number }>> {
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
	...workspaceHandlers,
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
export async function startNode(o?: { store?: NodeStore; acp?: NodeAcp }): Promise<Node> {
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
		let adaptedAcp: AdaptedAcp | undefined;
		let acpPort: NodeAcp;
		if (o?.acp === undefined) {
			adaptedAcp = adaptAcp(settings, realStore?.conversations);
			acpPort = adaptedAcp;
		} else {
			acpPort = o.acp;
		}
		for (const entry of await markInterrupted(storePort)) {
			await storePort.appendEvent({
				workspaceId: entry.workspaceId,
				kind: "node.restarted",
				data: { agents: entry.agents },
			});
		}
		const token = newToken();
		const descriptor: NodeDescriptor = {
			socket: socketPath,
			token,
			pid: process.pid,
			protocolVersion: PROTOCOL_VERSION,
			startedAt: nowIso(),
		};
		await writeDescriptor(descriptor);
		let hub!: Hub;
		let stoppedResolve: () => void = () => undefined;
		const stopped = new Promise<void>((done) => {
			stoppedResolve = done;
		});
		let stopping: Promise<void> | undefined;
		const stop = async (): Promise<void> => {
			if (stopping !== undefined) {
				return stopping;
			}
			stopping = (async (): Promise<void> => {
				try {
					hub.broadcast("node", { phase: "stopping" });
					await server.close();
					await acpPort.closeAll();
					await storePort.compact();
					if (realStore !== undefined) {
						await realStore.close();
					}
					await clearDescriptor();
					await lock.release();
				} finally {
					stoppedResolve();
				}
			})();
			return stopping;
		};
		const ctx: Omit<NodeContext, "hub"> = { store: storePort, acp: acpPort, nodeVersion: netaVersion(), stop };
		// The tools are only mounted on a real Node: the router needs 02's
		// registry for numbers and records, which the ports do not carry, so a
		// stubbed store (handler tests) serves the rest and no tools.
		const tools =
			realStore !== undefined && adapted !== undefined && adaptedAcp !== undefined
				? toolMount({
						real: realStore,
						store: adapted,
						acp: adaptedAcp,
						settings,
						hub: () => hub,
					}).handlers
				: {};
		const server = await createServer({ socketPath, token, handlers: { ...allHandlers, ...tools }, ctx });
		hub = server.hub;
		wireTurnStream({ ...ctx, hub: server.hub });
		return { descriptor, hub: server.hub, stop, stopped };
	} catch (error) {
		if (realStore !== undefined) {
			await realStore.close().catch(() => undefined);
		}
		await clearDescriptor().catch(() => undefined);
		await lock.release().catch(() => undefined);
		throw error;
	}
}
