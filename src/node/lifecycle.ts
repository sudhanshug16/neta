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
import packageJson from "../../package.json" with { type: "json" };
import { closeAll, SessionTable } from "../acp/lifecycle.ts";
import { NETA_MCP_SERVER_NAME, netaMcpServer } from "../acp/mcp.ts";
import type { AcpSession, SessionEvent } from "../acp/session.ts";
import { startSession } from "../acp/session.ts";
import { loadSettings, type Settings } from "../acp/settings.ts";
import { ulid } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import type {
	Agent,
	AgentId,
	Block,
	Event,
	Leader,
	Mission,
	MissionId,
	SessionId,
	Turn,
	WorkspaceId,
} from "../core/types.ts";
import { createMutex, readJson, writeJsonAtomic } from "../store/files.ts";
import { openStore, type Store } from "../store/index.ts";
import { decodeWorkspaceId, paths } from "../store/paths.ts";
import { conversationHandlers } from "./handlers-conversation.ts";
import { registryHandlers } from "./handlers-registry.ts";
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

const NODE_VERSION: string = packageJson.version;

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
}

function toTurnNotification(sessionId: SessionId, event: SessionEvent): TurnNotification {
	if (event.type === "turn") {
		return { sessionId, turn: event.turn };
	}
	if (event.type === "block") {
		return { sessionId, block: event.block };
	}
	// Anything else (turn end, interruption, model/mode change) is a bare
	// ping: something changed, re-tail for the current state.
	return { sessionId };
}

export function adaptAcp(settings: Settings): AdaptedAcp {
	const table = new SessionTable({ settings, cwd: process.cwd(), access: "readOnly" });
	const listeners = new Set<(notification: TurnNotification) => void>();
	const tokens = new Map<SessionId, string>();

	function pump(session: AcpSession): void {
		const run = async (): Promise<void> => {
			try {
				for await (const event of session.events()) {
					const notification = toTurnNotification(session.sessionId, event);
					for (const fn of [...listeners]) {
						try {
							fn(notification);
						} catch {
							// A listener never breaks the pump.
						}
					}
				}
			} catch {
				// The iterator threw: the session is done.
			}
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

	return {
		createSession: async (o) => {
			// Minted up front so the leader's tools entry carries the real
			// session id; 03 reuses it. The token is node-minted per 05.
			const sessionId = ulid();
			const token = newToken();
			const mcpServers = o.mcpServers.some((server) => server.name === NETA_MCP_SERVER_NAME)
				? o.mcpServers.map((server) =>
						server.name === NETA_MCP_SERVER_NAME ? netaMcpServer({ actorId: sessionId, token }) : server,
					)
				: o.mcpServers;
			const session = await startSession({
				settings,
				provider: o.provider,
				access: o.access,
				cwd: o.cwd,
				model: o.model,
				mcpServers,
				sessionId,
			});
			table.set(session.sessionId, { session, provider: o.provider });
			tokens.set(session.sessionId, token);
			pump(session);
			return { sessionId: session.sessionId, provider: session.provider, model: session.model };
		},
		prompt: async (id, text) => live(id).prompt(text),
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
		close: async (id) => {
			tokens.delete(id);
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
		},
		closeAll: async () => {
			tokens.clear();
			await closeAll(table);
		},
		onTurn: (fn) => {
			listeners.add(fn);
		},
		actorToken: (sessionId) => tokens.get(sessionId),
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
	const lock: LockHandle = await acquireLock();
	let realStore: Store | undefined;
	try {
		let storePort: NodeStore;
		if (o?.store !== undefined) {
			storePort = o.store;
		} else {
			realStore = await openStore();
			storePort = await adaptStore(realStore);
		}
		const acpPort = o?.acp ?? adaptAcp(loadSettings({ netaDir: netaDir() }).settings);
		for (const entry of await markInterrupted(storePort)) {
			await storePort.appendEvent({
				workspaceId: entry.workspaceId,
				kind: "node.restarted",
				data: { agents: entry.agents },
			});
		}
		const token = newToken();
		const socketPath = join(netaDir(), "node.sock");
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
		const ctx: Omit<NodeContext, "hub"> = { store: storePort, acp: acpPort, nodeVersion: NODE_VERSION, stop };
		const server = await createServer({ socketPath, token, handlers: allHandlers, ctx });
		hub = server.hub;
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
