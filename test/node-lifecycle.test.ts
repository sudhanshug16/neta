import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import type { Agent, AgentState, Event, Leader, Mission, MissionState, Workspace } from "../src/core/types.ts";
import { connectNode, type NodeClient, startNode } from "../src/node/index.ts";
import {
	adaptStore,
	allHandlers,
	glanceActorForSession,
	markInterrupted,
	type Node as NetaNode,
} from "../src/node/lifecycle.ts";
import { readDescriptor } from "../src/node/lockfile.ts";
import { PROTOCOL_VERSION } from "../src/node/protocol.ts";
import type { NodeRuntime, NodeStore } from "../src/node/server.ts";
import { loadSettings } from "../src/session/settings.ts";
import { systemContextPath } from "../src/session/system-context.ts";
import type { ConversationStore } from "../src/store/conversations.ts";
import { openStore } from "../src/store/index.ts";
import { adaptLegacyAcp as adaptRuntime } from "./fixtures/legacy-acp-runtime.ts";

const FIXTURE = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;
const MACHINE = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "test", createdAt: "2026-01-01T00:00:00.000Z" };

let dir = "";
let savedNetadir: string | undefined;

beforeEach(async () => {
	savedNetadir = process.env.NETA_DIR;
	dir = await mkdtemp(join(tmpdir(), "neta-lifecycle-"));
	process.env.NETA_DIR = dir;
});

afterEach(async () => {
	if (savedNetadir === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = savedNetadir;
	}
	await rm(dir, { recursive: true, force: true });
});

function workspace(id: string): Workspace {
	return { id, kind: "folder", name: id, roots: [], createdAt: "2026-01-01T00:00:00.000Z" };
}

function mission(id: string, workspaceId: string, state: MissionState): Mission {
	return {
		id,
		number: 1,
		workspaceId,
		machineId: MACHINE.id,
		name: "m",
		objective: "o",
		changes: [],
		lead: { kind: "leader" },
		agentIds: [],
		access: "readOnly",
		state,
		createdAt: "2026-02-01T00:00:00.000Z",
	};
}

function agent(id: string, missionId: string, workspaceId: string, state: AgentState): Agent {
	return {
		id,
		missionId,
		workspaceId,
		name: "a",
		task: "t",
		access: "readOnly",
		provider: "test",
		model: "m",
		skills: [],
		sessionId: ulid(),
		canSpawn: false,
		state,
		startedAt: "2026-02-01T00:00:00.000Z",
	};
}

interface StubWorld {
	missions: Mission[];
	agents: Map<string, Agent>;
	workspaces: Workspace[];
	events: Array<Omit<Event, "seq" | "at">>;
	compacted: boolean;
	closedAll: boolean;
}

function stubStore(world: StubWorld): NodeStore {
	return {
		machine: () => MACHINE,
		listWorkspaces: () => world.workspaces,
		listLeaders: () => [],
		listMissions: (id) => (id === undefined ? world.missions : world.missions.filter((m) => m.workspaceId === id)),
		listAgents: (mid) => [...world.agents.values()].filter((a) => a.missionId === mid),
		getWorkspace: (id) => world.workspaces.find((w) => w.id === id),
		getLeader: () => undefined,
		getMission: (id) => world.missions.find((m) => m.id === id),
		getAgent: (id) => world.agents.get(id),
		putWorkspace: () => Promise.reject(new Error("not implemented in this test")),
		putAgent: (a) => {
			world.agents.set(a.id, a);
			return Promise.resolve();
		},
		putLeader: () => Promise.reject(new Error("not implemented in this test")),
		compact: () => {
			world.compacted = true;
			return Promise.resolve();
		},
		appendEvent: (e) => {
			world.events.push(e);
			return Promise.resolve({ ...e, seq: world.events.length, at: "2026-03-01T00:00:00.000Z" });
		},
		listEvents: () => Promise.resolve({ events: [] }),
		tailConversation: () => Promise.reject(new Error("not implemented in this test")),
	};
}

function stubAcp(world: StubWorld): NodeRuntime {
	return {
		createSession: () => Promise.reject(new Error("not implemented in this test")),
		ensureSession: () => Promise.reject(new Error("not implemented in this test")),
		prompt: () => Promise.reject(new Error("not implemented in this test")),
		setModel: () => Promise.reject(new Error("not implemented in this test")),
		listModels: () => Promise.resolve([]),
		cancel: () => Promise.reject(new Error("not implemented in this test")),
		close: () => Promise.resolve(),
		closeAll: () => {
			world.closedAll = true;
			return Promise.resolve();
		},
		onTurn: () => undefined,
	};
}

function runningWorld(): StubWorld {
	const m1 = mission(ulid(), "w1", "running");
	const m2 = mission(ulid(), "w2", "running");
	return {
		missions: [m1, m2],
		agents: new Map([
			["a1", agent("a1", m1.id, "w1", "running")],
			["a2", agent("a2", m1.id, "w1", "blocked")],
			["a3", agent("a3", m2.id, "w2", "starting")],
			["a4", agent("a4", m1.id, "w1", "completed")],
			["a5", agent("a5", m2.id, "w2", "archived")],
		]),
		workspaces: [workspace("w1"), workspace("w2")],
		events: [],
		compacted: false,
		closedAll: false,
	};
}

describe("markInterrupted", () => {
	test("a restart clears persisted running leader activity but preserves startup failures", async () => {
		const store = stubStore(runningWorld());
		const leader: Leader = {
			workspaceId: "w1",
			machineId: MACHINE.id,
			name: "Mace",
			sessionId: "session",
			provider: "fake",
			model: "test-model",
			mode: "lead",
			modeSince: MACHINE.createdAt,
			modeActiveMs: 0,
			state: "running",
			currentTurnId: "turn",
			bindingGeneration: "old-runtime",
		};
		const leaders = new Map<string, Leader>([
			["w1", leader],
			["w2", { ...leader, workspaceId: "w2", state: "failed", startupError: "sign-in expired" }],
		]);
		store.listLeaders = () => [...leaders.values()];
		store.putLeader = async (next) => {
			leaders.set(next.workspaceId, next);
		};
		await markInterrupted(store);
		expect(leaders.get("w1")).toMatchObject({ state: "idle", sessionId: "session" });
		expect(leaders.get("w1")?.currentTurnId).toBeUndefined();
		expect(leaders.get("w1")?.bindingGeneration).toBeUndefined();
		expect(leaders.get("w2")).toMatchObject({ state: "failed", startupError: "sign-in expired" });
	});
	test("Glance freezes agent identity while the session record still exists", () => {
		const world = runningWorld();
		const store = stubStore(world);
		const saved = world.agents.get("a1");
		if (saved === undefined) throw new Error("missing fixture agent");
		saved.sessionId = "reader-session";
		expect(glanceActorForSession(store, "reader-session")).toEqual({
			workspaceId: "w1",
			actorKind: "agent",
			agentId: "a1",
			missionId: saved.missionId,
			agentLabel: saved.name,
		});
		world.agents.delete("a1");
		expect(glanceActorForSession(store, "reader-session")).toBeUndefined();
	});
	test("live agents come back interrupted with stateBefore, nothing else moves, no events", async () => {
		const world = runningWorld();
		const store = stubStore(world);
		expect(await markInterrupted(store)).toEqual([
			{ workspaceId: "w1", agents: 2 },
			{ workspaceId: "w2", agents: 1 },
		]);
		expect(world.agents.get("a1")).toMatchObject({ state: "interrupted", stateBefore: "running" });
		expect(world.agents.get("a2")).toMatchObject({ state: "interrupted", stateBefore: "blocked" });
		expect(world.agents.get("a3")).toMatchObject({ state: "interrupted", stateBefore: "starting" });
		expect(world.agents.get("a4")?.state).toBe("completed");
		expect(world.agents.get("a5")?.state).toBe("archived");
		expect(world.events).toEqual([]);
	});
});

describe("startNode and stop", () => {
	test("restart events, descriptor, double start, idempotent stop clearing everything", async () => {
		const world = runningWorld();
		const node: NetaNode = await startNode({ store: stubStore(world), runtime: stubAcp(world) });
		try {
			expect(world.events).toEqual([
				{ workspaceId: "w1", kind: "node.restarted", data: { agents: 2 } },
				{ workspaceId: "w2", kind: "node.restarted", data: { agents: 1 } },
			]);
			expect(await readDescriptor()).toEqual(node.descriptor);
			expect(node.descriptor.pid).toBe(process.pid);
			expect(node.descriptor.protocolVersion).toBe(PROTOCOL_VERSION);
			let second: unknown;
			try {
				await startNode({ store: stubStore(world), runtime: stubAcp(world) });
			} catch (error) {
				second = error;
			}
			expect((second as { name?: string }).name).toBe("AlreadyRunningError");
			const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
			expect(typeof pkg.version).toBe("string");
		} finally {
			await node.stop();
			await node.stop();
		}
		expect(world.closedAll).toBe(true);
		expect(world.compacted).toBe(true);
		expect(node.hub.connections()).toEqual([]);
		await expect(stat(node.descriptor.socket)).rejects.toThrow();
		await expect(stat(join(dir, "node.json"))).rejects.toThrow();
		await expect(stat(join(dir, "node.lock"))).rejects.toThrow();
		await expect(readDescriptor()).resolves.toBeUndefined();
	});

	test("connecting in a loop while starting, the first snapshot already shows interrupted", async () => {
		const m1 = mission(ulid(), "w1", "running");
		const world: StubWorld = {
			missions: [m1],
			agents: new Map([["a1", agent("a1", m1.id, "w1", "running")]]),
			workspaces: [workspace("w1")],
			events: [],
			compacted: false,
			closedAll: false,
		};
		const started = startNode({ store: stubStore(world), runtime: stubAcp(world) });
		let client: NodeClient | undefined;
		const deadline = Date.now() + 5000;
		for (;;) {
			try {
				client = await connectNode();
				break;
			} catch {
				if (Date.now() > deadline) {
					throw new Error("the node never came up");
				}
				await new Promise((done) => setTimeout(done, 20));
			}
		}
		if (client === undefined) {
			throw new Error("the node never came up");
		}
		try {
			const snapshot = await client.request<{ agents: Array<{ state: string; stateBefore?: string }> }>(
				"snapshot",
				{},
			);
			expect(snapshot.agents).toHaveLength(1);
			expect(snapshot.agents[0]).toMatchObject({ state: "interrupted", stateBefore: "running" });
		} finally {
			await client.close();
			await (await started).stop();
		}
	});

	test("no timers, servers or sockets survive stop", async () => {
		const handlesByKind = (): Map<string, number> => {
			const counts = new Map<string, number>();
			const get = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
			if (typeof get !== "function") {
				return counts;
			}
			for (const handle of get.call(process)) {
				const kind = (handle as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
				counts.set(kind, (counts.get(kind) ?? 0) + 1);
			}
			return counts;
		};
		const world = runningWorld();
		const before = handlesByKind();
		const node = await startNode({ store: stubStore(world), runtime: stubAcp(world) });
		const client = await connectNode();
		await client.close();
		await node.stop();
		const after = handlesByKind();
		const growth: Record<string, { before: number; after: number }> = {};
		for (const kind of ["Timeout", "Server", "Socket"]) {
			const beforeCount = before.get(kind) ?? 0;
			const afterCount = after.get(kind) ?? 0;
			if (afterCount > beforeCount) {
				growth[kind] = { before: beforeCount, after: afterCount };
			}
		}
		expect(growth).toEqual({});
	});
});

describe("allHandlers", () => {
	test("it merges the handler maps with no collisions", () => {
		expect(Object.keys(allHandlers).sort()).toEqual(
			[
				"agent.archive",
				"conversation.cancel",
				"conversation.capabilities",
				"conversation.inbox",
				"conversation.native",
				"conversation.prompt",
				"conversation.reset",
				"conversation.prepareHandoff",
				"conversation.setProvider",
				"conversation.setModel",
				"conversation.tail",
				"conversation.untail",
				"diagnostics.cleanup",
				"diagnostics.files",
				"diagnostics.prepare",
				"diagnostics.read",
				"diagnostics.record",
				"diagnostics.runtime",
				"events.list",
				"glance.complete",
				"glance.list",
				"glance.markReviewed",
				"glance.source",
				"leader.setMode",
				"mission.pin",
				"me.list",
				"me.read",
				"me.reply",
				"me.sources",
				"missions.get",
				"missions.list",
				"models.list",
				"providers.list",
				"node.stop",
				"runtime.capabilities",
				"routing.logs",
				"routing.auth.status",
				"routing.auth.save",
				"routing.preferences.list",
				"routing.preferences.save",
				"runtime.upgrade.prepare",
				"runtime.upgrade.commit",
				"runtime.upgrade.cancel",
				"snapshot",
				"sol.open",
				"sol.prompt",
				"sol.route",
				"sol.routes",
				"sol.turns",
				"terminal.attach",
				"terminal.detach",
				"terminal.input",
				"terminal.resize",
				"workspace.list",
				"workspace.open",
			].sort(),
		);
	});
});

function fullMission(id: string, workspaceId: string, n: number): Mission {
	return {
		...mission(id, workspaceId, "running"),
		number: n,
		name: `mission ${n}`,
		objective: "test objective",
	};
}

describe("adaptStore against the real store", () => {
	test("missions, agents, events and conversations round-trip through the ports", async () => {
		const real = await openStore();
		const m1 = fullMission(ulid(), "w1", 1);
		const m2 = fullMission(ulid(), "w1", 2);
		await real.missions.create(m1);
		await real.missions.create(m2);
		const port = await adaptStore(real);
		try {
			expect(port.machine().id).toHaveLength(26);
			expect((await port.listMissions("w1")).map((m) => m.id).sort()).toEqual([m1.id, m2.id].sort());
			expect(port.getMission(m1.id)).toEqual(m1);
			const a1 = agent(ulid(), m1.id, "w1", "running");
			await port.putAgent(a1);
			expect(port.getAgent(a1.id)).toEqual(a1);
			expect(port.listAgents(m1.id)).toEqual([a1]);
			// agents.json survives a fresh adaption.
			expect((await adaptStore(real)).getAgent(a1.id)).toEqual(a1);
			for (let seq = 1; seq <= 5; seq++) {
				await port.appendEvent({ workspaceId: "w1", kind: "mission.created", missionId: m1.id, data: {} });
			}
			const tail = await port.listEvents({ workspaceId: "w1", limit: 2 });
			expect(tail.events.map((e) => e.seq)).toEqual([4, 5]);
			expect(tail.nextCursor).toBeUndefined();
			const page = await port.listEvents({ workspaceId: "w1", limit: 2, cursor: "2" });
			expect(page.events.map((e) => e.seq)).toEqual([3, 4]);
			expect(page.nextCursor).toBe("4");
			// Conversations: unknown sessions give NOT_FOUND, seq cursors page.
			let missing: unknown;
			try {
				await port.tailConversation(ulid(), { limit: 10 });
			} catch (error) {
				missing = error;
			}
			expect((missing as { symbol?: string }).symbol).toBe("NOT_FOUND");
			const sessionId = ulid();
			const turnId = ulid();
			await real.conversations.create({
				sessionId,
				provider: "p",
				model: "m",
				createdAt: "2026-01-01T00:00:00.000Z",
			});
			await real.conversations.appendTurn({
				id: turnId,
				sessionId,
				startedAt: "2026-02-01T00:00:00.000Z",
				role: "user",
			});
			for (let seq = 1; seq <= 3; seq++) {
				await real.conversations.appendBlock(sessionId, {
					turnId,
					seq,
					at: "2026-02-01T00:00:00.000Z",
					role: "agent",
					kind: "text",
					text: `b${seq}`,
				});
			}
			const full = await port.tailConversation(sessionId, { limit: 10 });
			expect(full.blocks.map((b) => b.seq)).toEqual([1, 2, 3]);
			expect(full.turns.map((t) => t.id)).toEqual([turnId]);
			expect(full.provider).toBe("p");
			expect(full.model).toBe("m");
			expect(full.prevCursor).toBeNull();
			expect(full.nextCursor).toBeUndefined();
			const resumed = await port.tailConversation(sessionId, { limit: 10, cursor: "1" });
			expect(resumed.blocks.map((b) => b.seq)).toEqual([2, 3]);
			expect(resumed.prevCursor).toBe("1");
			await port.compact();
			await expect(stat(join(dir, "missions", "w1", "registry.snapshot.json"))).resolves.toBeDefined();
		} finally {
			await real.close();
		}
	});

	test("missions written after adapt appear through refreshMissions", async () => {
		const real = await openStore();
		const port = await adaptStore(real);
		try {
			expect(await port.listMissions("w9")).toEqual([]);
			await real.missions.create(fullMission(ulid(), "w9", 1));
			expect(await port.listMissions("w9")).toEqual([]);
			await port.refreshMissions("w9");
			expect(await port.listMissions("w9")).toHaveLength(1);
		} finally {
			await real.close();
		}
	});

	test("event tails keep the last 200", async () => {
		const real = await openStore();
		const port = await adaptStore(real);
		try {
			for (let n = 0; n < 205; n++) {
				await port.appendEvent({ workspaceId: "w1", kind: "mission.created", data: {} });
			}
			const tail = await port.listEvents({ workspaceId: "w1", limit: 200 });
			expect(tail.events).toHaveLength(200);
			expect(tail.events[0]?.seq).toBe(6);
			expect(tail.events[199]?.seq).toBe(205);
		} finally {
			await real.close();
		}
	});
});

// The socket path is judged before the lock is taken and before the store is
// opened: a directory the node can never serve from is left exactly as it was
// found, with no `node.lock` and no store tree in it.
describe("startNode on an unusable NETA_DIR", () => {
	test("fails with the socket path error and writes nothing", async () => {
		const long = join(dir, "x".repeat(120));
		await mkdir(long, { recursive: true });
		process.env.NETA_DIR = long;
		try {
			let message = "";
			try {
				await startNode();
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message).toContain("unix socket limit");
			expect(await readdir(long)).toEqual([]);
		} finally {
			process.env.NETA_DIR = dir;
		}
	});
});

describe("adaptRuntime against the fake provider", () => {
	test("lists resolved adapters and session-relative custom commands accurately", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "neta-provider-workspace-"));
		const relative = join(workspace, "relative-acp");
		await writeFile(relative, "#!/bin/sh\n");
		await chmod(relative, 0o755);
		const configured = loadSettings({ netaDir: dir }).settings;
		configured.providers.fake = { command: process.execPath, args: [FIXTURE], resume: true, defaultModel: "" };
		configured.providers.relative = { command: "./relative-acp", args: [], resume: true, defaultModel: "" };
		configured.providers.missing = { command: "missing-custom-acp", args: [], resume: true, defaultModel: "" };
		const acp = adaptRuntime(configured, undefined, () => configured);
		try {
			expect(acp.listProviders?.().map((provider) => provider.id)).toEqual(["opencode"]);
			const created = await acp.createSession({
				workspaceId: "w1",
				cwd: workspace,
				provider: "fake",
				model: "",
				access: "readOnly",
				netaTools: false,
			});
			expect(acp.listProviders?.({ sessionId: created.sessionId }).map((provider) => provider.id)).toEqual([
				"opencode",
			]);
		} finally {
			await acp.closeAll();
			await rm(workspace, { recursive: true, force: true });
		}
	});

	test("a blank model records the provider-advertised model in conversation metadata", async () => {
		const configured = loadSettings({ netaDir: dir }).settings;
		configured.providers.fake = { command: process.execPath, args: [FIXTURE], resume: true, defaultModel: "" };
		configured.leader.provider = "fake";
		const real = await openStore();
		const acp = adaptRuntime(configured, real.conversations);
		try {
			const created = await acp.createSession({
				workspaceId: "w1",
				cwd: dir,
				provider: "fake",
				model: "",
				access: "readOnly",
				netaTools: false,
			});
			expect(created.model).toBe("test-model");
			expect(await real.conversations.meta(created.sessionId)).toMatchObject({
				sessionId: created.sessionId,
				provider: "fake",
				model: "test-model",
			});
		} finally {
			await acp.closeAll();
		}
	});

	test("durable prompts drain FIFO after an instant turn and a missing session does not spin", async () => {
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({
				providers: {
					fake: { command: process.execPath, args: [FIXTURE], resume: true, defaultModel: "test-model" },
				},
				leader: { provider: "fake" },
			}),
		);
		const real = await openStore();
		const acp = adaptRuntime(
			loadSettings({ netaDir: dir }).settings,
			real.conversations,
			undefined,
			undefined,
			undefined,
			real.inbox,
		);
		try {
			const created = await acp.createSession({
				workspaceId: "w1",
				cwd: dir,
				provider: "fake",
				model: "test-model",
				access: "readOnly",
				netaTools: false,
			});
			await acp.send(created.sessionId, "HOLD_FOREVER", [], { readerDirected: true });
			const first = await acp.send(created.sessionId, "first queued", [], { readerDirected: true });
			const second = await acp.send(created.sessionId, "second queued", [], { readerDirected: true });
			expect([first.status, second.status]).toEqual(["queued", "queued"]);
			await acp.cancel(created.sessionId);
			for (let attempts = 0; attempts < 200; attempts += 1) {
				if (
					(await real.inbox.list(created.sessionId))
						.filter((item) => item.id === first.id || item.id === second.id)
						.every((item) => item.status === "delivered")
				)
					break;
				await Bun.sleep(10);
			}
			const drained = await real.inbox.list(created.sessionId);
			expect(
				drained.filter((item) => item.id === first.id || item.id === second.id).map((item) => item.status),
			).toEqual(["delivered", "delivered"]);
			const blocks = (await real.conversations.tail({ sessionId: created.sessionId, limit: 100 })).blocks
				.filter((block) => block.role === "user")
				.map((block) => block.text);
			expect(blocks.slice(-2)).toEqual(["first queued", "second queued"]);

			const missing = await acp.send(ulid(), "orphan", [], { readerDirected: true });
			expect(missing.status).toBe("queued");
			await Bun.sleep(0);
			expect((await real.inbox.list(missing.sessionId))[0]?.status).toBe("queued");
		} finally {
			await acp.closeAll();
		}
	});

	test("a failed reset retains its paused queue and resumes it on the old session", async () => {
		const good = loadSettings({ netaDir: dir }).settings;
		good.providers.fake = { command: process.execPath, args: [FIXTURE], resume: true, defaultModel: "test-model" };
		good.leader.provider = "fake";
		let current = good;
		const real = await openStore();
		const acp = adaptRuntime(good, real.conversations, () => current, undefined, undefined, real.inbox);
		try {
			const created = await acp.createSession({
				workspaceId: "w1",
				cwd: dir,
				provider: "fake",
				model: "test-model",
				access: "readOnly",
				netaTools: false,
			});
			await acp.send(created.sessionId, "HOLD_FOREVER", [], { readerDirected: true });
			const queued = await acp.send(created.sessionId, "survives failed reset", [], { readerDirected: true });
			const fake = good.providers.fake;
			if (fake === undefined) throw new Error("fake provider missing");
			current = {
				...good,
				providers: { ...good.providers, fake: { ...fake, command: join(dir, "missing") } },
			};
			await expect(acp.resetSession(created.sessionId, "brief", () => Promise.resolve())).rejects.toThrow(
				"could not reset provider session",
			);
			expect((await real.inbox.list(created.sessionId)).find((item) => item.id === queued.id)?.status).toBe(
				"queued",
			);
			await acp.cancel(created.sessionId);
			for (
				let attempts = 0;
				attempts < 200 &&
				(await real.inbox.list(created.sessionId)).find((item) => item.id === queued.id)?.status !== "delivered";
				attempts += 1
			)
				await Bun.sleep(10);
			expect((await real.inbox.list(created.sessionId)).find((item) => item.id === queued.id)?.status).toBe(
				"delivered",
			);
		} finally {
			await acp.closeAll();
		}
	});

	test("reject-resume recovery keeps the Neta identity that owns queued messages", async () => {
		const providerSessions = join(dir, "inbox-resume.json");
		const configured = loadSettings({ netaDir: dir }).settings;
		configured.providers.fake = {
			command: process.execPath,
			args: [FIXTURE, "--session-store", providerSessions, "--reject-resume"],
			resume: true,
			defaultModel: "test-model",
		};
		configured.leader.provider = "fake";
		const real = await openStore();
		const first = adaptRuntime(configured, real.conversations, undefined, undefined, undefined, real.inbox);
		const created = await first.createSession({
			workspaceId: "w1",
			cwd: dir,
			provider: "fake",
			model: "test-model",
			access: "readOnly",
			netaTools: false,
		});
		await first.send(created.sessionId, "HOLD_FOREVER", [], { readerDirected: true });
		const queued = await first.send(created.sessionId, "after rejected resume", [], { readerDirected: true });
		await first.closeAll();
		const second = adaptRuntime(configured, real.conversations, undefined, undefined, undefined, real.inbox);
		try {
			const recovered = await second.ensureSession({
				sessionId: created.sessionId,
				workspaceId: "w1",
				cwd: dir,
				provider: "fake",
				model: "test-model",
				access: "readOnly",
				netaTools: false,
			});
			expect(recovered.sessionId).toBe(created.sessionId);
			for (
				let attempts = 0;
				attempts < 200 &&
				(await real.inbox.list(created.sessionId)).find((item) => item.id === queued.id)?.status !== "delivered";
				attempts += 1
			)
				await Bun.sleep(10);
			expect((await real.inbox.list(created.sessionId)).find((item) => item.id === queued.id)?.status).toBe(
				"delivered",
			);
		} finally {
			await second.closeAll();
		}
	});

	test("a provider switch cannot cross the owned prompt's final drain await", async () => {
		const configured = loadSettings({ netaDir: dir }).settings;
		configured.providers.fake = {
			command: process.execPath,
			args: [FIXTURE],
			resume: true,
			defaultModel: "test-model",
		};
		configured.providers.alternate = {
			command: process.execPath,
			args: [FIXTURE],
			resume: true,
			defaultModel: "test-model",
		};
		configured.leader.provider = "fake";
		const real = await openStore();
		let releaseMeta: (() => void) | undefined;
		let enteredMeta: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			enteredMeta = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			releaseMeta = resolve;
		});
		let metaCalls = 0;
		const conversations: ConversationStore = {
			...real.conversations,
			meta: async (id) => {
				metaCalls += 1;
				if (metaCalls === 1) {
					enteredMeta?.();
					await blocked;
				}
				return real.conversations.meta(id);
			},
		};
		const acp = adaptRuntime(configured, conversations, undefined, undefined, undefined, real.inbox);
		try {
			const created = await acp.createSession({
				workspaceId: "w1",
				cwd: dir,
				provider: "fake",
				model: "test-model",
				access: "readOnly",
				netaTools: false,
			});
			const sending = acp.send(created.sessionId, "crossing switch", [], { readerDirected: true });
			await entered;
			await expect(acp.switchProvider(created.sessionId, "alternate", undefined, undefined)).rejects.toThrow(
				"provider switch requires an idle session",
			);
			releaseMeta?.();
			const sent = await sending;
			for (
				let attempts = 0;
				attempts < 200 &&
				(await real.inbox.list(created.sessionId)).find((item) => item.id === sent.id)?.status !== "delivered";
				attempts += 1
			)
				await Bun.sleep(10);
			expect((await real.inbox.list(created.sessionId)).find((item) => item.id === sent.id)?.status).toBe(
				"delivered",
			);
			expect((await conversations.meta(created.sessionId))?.provider).toBe("fake");
		} finally {
			await acp.closeAll();
		}
	});
	test("sessions live, prompt, carry a rewritten tools entry, and close", async () => {
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({
				providers: {
					fake: { command: process.execPath, args: [FIXTURE], resume: true, defaultModel: "test-model" },
				},
				leader: { provider: "fake" },
			}),
		);
		const readerTurns: Array<{
			turn: { readerDirected?: boolean; cancelled?: boolean };
			blocks: Array<{ role: string; kind: string; text: string }>;
		}> = [];
		const acp = adaptRuntime(
			loadSettings({ netaDir: dir }).settings,
			undefined,
			undefined,
			async (_sessionId, turn, blocks) => {
				readerTurns.push({ turn, blocks });
			},
		);
		const created = await acp.createSession({
			workspaceId: "w1",
			cwd: dir,
			provider: "fake",
			model: "test-model",
			access: "readOnly",
			netaTools: true,
		});
		try {
			expect(typeof created.sessionId).toBe("string");
			const token = acp.actorToken(created.sessionId);
			expect(token).toMatch(/^[0-9a-f]{64}$/);
			if (token === undefined || acp.prepareExternalActor === undefined)
				throw new Error("missing external actor token");
			expect(acp.prepareExternalActor(created.sessionId)).toBe(token);
			expect(acp.actorToken(created.sessionId)).toBe(token);
			const seen: unknown[] = [];
			acp.onTurn((notification) => {
				seen.push(notification);
			});
			const turnId = await acp.prompt(created.sessionId, "MCP please", [], { readerDirected: true });
			expect(typeof turnId).toBe("string");
			const deadline = Date.now() + 5000;
			let echoed: Array<{ name: string; args: string[] }> = [];
			while (Date.now() < deadline) {
				for (const notification of seen) {
					const block = (notification as { block?: { text?: string } }).block;
					if (typeof block?.text === "string" && block.text.startsWith("mcp:")) {
						echoed = JSON.parse(block.text.slice("mcp:".length)) as Array<{ name: string; args: string[] }>;
						break;
					}
				}
				if (echoed.length > 0) {
					break;
				}
				await new Promise((done) => setTimeout(done, 25));
			}
			const entry = echoed.find((server) => server.name === "neta");
			if (entry === undefined) {
				throw new Error("the provider never echoed the tools entry");
			}
			const actorIndex = entry.args.indexOf("--actor");
			expect(entry.args[actorIndex + 1]).toBe(created.sessionId);
			while (Date.now() < deadline && readerTurns.length === 0) await new Promise((done) => setTimeout(done, 10));
			expect(readerTurns).toHaveLength(1);
			expect(readerTurns[0]?.turn.readerDirected).toBe(true);
			expect(readerTurns[0]?.blocks.every((block) => block.role === "agent" && block.kind === "text")).toBe(true);
			const models = await acp.listModels({ sessionId: created.sessionId });
			expect(Array.isArray(models)).toBe(true);
			let missing: unknown;
			try {
				await acp.prompt(ulid(), "hi");
			} catch (error) {
				missing = error;
			}
			expect((missing as { symbol?: string }).symbol).toBe("NOT_FOUND");
			await acp.close(created.sessionId);
			expect(acp.actorToken(created.sessionId)).toBeUndefined();
		} finally {
			await acp.closeAll();
		}
	});

	// 05 mints an agent's token under its `agentId`, not its session id, so
	// closing the session has to revoke that key: a surviving proxy must not
	// keep calling tools as an agent that is gone.
	test("closing an agent session revokes the token minted under its agent id", async () => {
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({
				providers: { fake: { command: process.execPath, args: [FIXTURE], defaultModel: "test-model" } },
				leader: { provider: "fake" },
			}),
		);
		const acp = adaptRuntime(loadSettings({ netaDir: dir }).settings);
		try {
			const agentId = ulid();
			const created = await acp.createSession({
				workspaceId: "w1",
				cwd: dir,
				provider: "fake",
				model: "test-model",
				access: "readOnly",
				netaTools: true,
				actorId: agentId,
			});
			const token = acp.actorToken(created.sessionId);
			expect(token).toMatch(/^[0-9a-f]{64}$/);
			expect(acp.tokens.verify(agentId, token ?? "")).toBe(true);
			await acp.close(created.sessionId);
			expect(acp.tokens.verify(agentId, token ?? "")).toBe(false);
			expect(acp.actorToken(created.sessionId)).toBeUndefined();
		} finally {
			await acp.closeAll();
		}
	});

	test("a prompt after the provider exits relaunches the same Neta session", async () => {
		const providerSessions = join(dir, "recovery-provider-sessions.json");
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({
				providers: {
					fake: {
						command: process.execPath,
						args: [FIXTURE, "--session-store", providerSessions, "--reject-resume"],
						resume: true,
						defaultModel: "test-model",
					},
				},
				leader: { provider: "fake" },
			}),
		);
		const captured: Array<{ id: string; cancelled?: boolean; failed?: boolean }> = [];
		let recoveryCalls = 0;
		const conversationStore = (await openStore()).conversations;
		const acp = adaptRuntime(
			loadSettings({ netaDir: dir }).settings,
			conversationStore,
			undefined,
			async (_session, turn) => {
				captured.push({ id: turn.id, cancelled: turn.cancelled, failed: turn.failed });
			},
			async () => {
				recoveryCalls += 1;
				return "# Recovery recap\n\nEarlier user and assistant text.";
			},
		);
		const seen: Array<{ turn?: { id: string; endedAt?: string }; block?: { text?: string } }> = [];
		acp.onTurn((notification) => seen.push(notification));
		try {
			const created = await acp.createSession({
				workspaceId: "w1",
				cwd: dir,
				provider: "fake",
				model: "test-model",
				access: "readOnly",
				netaTools: false,
			});
			const interrupted = await acp.prompt(created.sessionId, "EXIT_MID_TURN", [], { readerDirected: true });
			expect((await conversationStore.meta(created.sessionId))?.vendorSessionId).toBeTruthy();
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && !seen.some((item) => item.turn?.id === interrupted && item.turn.endedAt)) {
				await new Promise((done) => setTimeout(done, 20));
			}
			expect(seen.some((item) => item.turn?.id === interrupted && item.turn.endedAt)).toBe(true);
			while (Date.now() < deadline && !captured.some((item) => item.id === interrupted))
				await new Promise((done) => setTimeout(done, 10));
			expect(captured.find((item) => item.id === interrupted)?.failed).toBe(true);
			await new Promise((done) => setTimeout(done, 100));

			const recovered = await acp.prompt(created.sessionId, "after provider exit");
			const recoveryDeadline = Date.now() + 5000;
			while (
				Date.now() < recoveryDeadline &&
				!seen.some((item) => item.turn?.id === recovered && item.turn.endedAt)
			) {
				await new Promise((done) => setTimeout(done, 20));
			}
			expect(seen.some((item) => item.turn?.id === recovered && item.turn.endedAt)).toBe(true);
			await new Promise((done) => setTimeout(done, 50));
			expect(recoveryCalls).toBe(1);
			const recoveredBlocks = (await conversationStore.tail({ sessionId: created.sessionId, limit: 100 })).blocks;
			expect(recoveredBlocks.some((item) => item.text.includes("clipped recap"))).toBe(true);
			const providerState = JSON.parse(await Bun.file(providerSessions).text()) as {
				sessions: Record<string, { history: string[]; mcpServers: unknown[] }>;
			};
			const fresh = Object.values(providerState.sessions).find((item) =>
				item.history.some((text) => text.includes("## Current user message\n\nafter provider exit")),
			);
			expect(fresh).toBeDefined();
			expect(fresh?.history.at(-1)).toContain("# Recovery recap");
			expect(fresh?.mcpServers).toEqual([]);
			const toolsTurn = await acp.prompt(created.sessionId, "MCP please");
			const toolsDeadline = Date.now() + 5000;
			while (Date.now() < toolsDeadline && !seen.some((item) => item.turn?.id === toolsTurn && item.turn.endedAt))
				await new Promise((done) => setTimeout(done, 20));
			const toolsBlock = seen.find((item) => item.block?.text?.startsWith("mcp:"))?.block?.text ?? "";
			expect(JSON.parse(toolsBlock.slice(4))).toEqual([]);
		} finally {
			await acp.closeAll();
		}
	});
});

test("OpenCode main-agent system context is refreshed separately from user input", async () => {
	const configured = loadSettings({ netaDir: dir }).settings;
	configured.providers.opencode = { command: process.execPath, args: [FIXTURE], resume: true, defaultModel: "" };
	let instruction = "You are the workspace leader. Charter A.";
	const acp = adaptRuntime(
		configured,
		undefined,
		() => configured,
		undefined,
		undefined,
		undefined,
		() => instruction,
	);
	try {
		const created = await acp.createSession({
			workspaceId: "w1",
			cwd: dir,
			provider: "opencode",
			model: "",
			access: "readOnly",
			netaTools: false,
		});
		await acp.prompt(created.sessionId, "hello");
		expect(JSON.parse(readFileSync(systemContextPath(created.sessionId), "utf8")).text).toBe(instruction);
		for (let attempt = 0; attempt < 100 && acp.isTurnActive?.(created.sessionId); attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		instruction = "You are the workspace leader. Charter B.";
		await acp.prompt(created.sessionId, "next");
		expect(JSON.parse(readFileSync(systemContextPath(created.sessionId), "utf8")).text).toBe(instruction);
	} finally {
		await acp.closeAll();
	}
});

test("shared cold restore serializes mixed ensure callers without a second provider binding", async () => {
	const configured = loadSettings({ netaDir: dir }).settings;
	configured.providers.fake = {
		command: process.execPath,
		args: [FIXTURE, "--session-store", join(dir, "provider.json")],
		resume: true,
		defaultModel: "test-model",
	};
	const real = await openStore();
	const first = adaptRuntime(configured, real.conversations);
	const request = {
		workspaceId: "w1",
		cwd: dir,
		provider: "fake",
		model: "test-model",
		access: "readOnly" as const,
		netaTools: true,
		actorId: "fixture-owner",
	};
	const created = await first.createSession(request);
	await first.closeAll();
	let metaReads = 0;
	let unblock!: () => void;
	let entered!: () => void;
	const barrier = new Promise<void>((resolve) => {
		unblock = resolve;
	});
	const observed = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const conversations: ConversationStore = {
		...real.conversations,
		meta: async (id) => {
			metaReads++;
			entered();
			await barrier;
			return real.conversations.meta(id);
		},
	};
	const restored = adaptRuntime(configured, conversations);
	try {
		const one = restored.ensureSession({ ...request, sessionId: created.sessionId, allowFresh: false });
		await observed;
		const two = restored.ensureSession({ ...request, sessionId: created.sessionId, allowFresh: false });
		const three = restored.ensureSession({ ...request, sessionId: created.sessionId, allowFresh: false });
		unblock();
		const selected = await Promise.all([one, two, three]);
		expect(selected.every((item) => item.sessionId === created.sessionId)).toBe(true);
		expect(metaReads).toBe(1);
		expect(restored.actorToken(created.sessionId)).toBeDefined();
		expect((await real.conversations.tail({ sessionId: created.sessionId, limit: 10 })).blocks).toHaveLength(0);
	} finally {
		unblock();
		await restored.closeAll();
		await real.close();
	}
});

test("a resume queued behind reset cannot resurrect the retired conversation", async () => {
	const configured = loadSettings({ netaDir: dir }).settings;
	configured.providers.fake = {
		command: process.execPath,
		args: [FIXTURE, "--session-store", join(dir, "provider.json")],
		resume: true,
		defaultModel: "test-model",
	};
	const real = await openStore();
	const acp = adaptRuntime(configured, real.conversations);
	const request = {
		workspaceId: "w1",
		cwd: dir,
		provider: "fake",
		model: "test-model",
		access: "readOnly" as const,
		netaTools: true,
	};
	let release!: () => void;
	let entered!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const observed = new Promise<void>((resolve) => {
		entered = resolve;
	});
	try {
		const created = await acp.createSession(request);
		const reset = acp.resetSession(created.sessionId, "standing instructions", async () => {
			entered();
			await barrier;
		});
		await observed;
		const stale = acp
			.ensureSession({ ...request, sessionId: created.sessionId, allowFresh: false })
			.catch((error: unknown) => error);
		release();
		const fresh = await reset;
		expect(await stale).toBeInstanceOf(Error);
		expect(acp.actorToken(created.sessionId)).toBeUndefined();
		expect(acp.actorToken(fresh.sessionId)).toBeDefined();
		expect(fresh.sessionId).not.toBe(created.sessionId);
	} finally {
		release();
		await acp.closeAll();
		await real.close();
	}
});

test("conditional upgrade checks actual admission and refuses late work on the real socket", async () => {
	const world = runningWorld();
	let release!: () => void;
	let entered!: () => void;
	let blocked = true;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const observed = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const acp = {
		...stubAcp(world),
		hasActiveWork: () => false,
		prompt: async () => {
			if (blocked) {
				entered();
				await barrier;
			}
			return "fixture-turn";
		},
	};
	const node = await startNode({ store: stubStore(world), runtime: acp });
	const client = await connectNode();
	try {
		const caps = await client.request<{ instanceId: string; runtimeUpgrade: number }>("runtime.capabilities");
		expect(node.descriptor.instanceId).toBe(caps.instanceId);
		expect(caps.runtimeUpgrade).toBe(1);
		const work = client.request("conversation.prompt", { sessionId: "fixture", text: "work" });
		await observed;
		expect(await client.request("runtime.upgrade.prepare", { instanceId: caps.instanceId })).toMatchObject({
			prepared: false,
			reason: "active-work",
		});
		blocked = false;
		release();
		await work;
		const prepared = await client.request<{ prepared: boolean; token: string }>("runtime.upgrade.prepare", {
			instanceId: caps.instanceId,
		});
		expect(prepared.prepared).toBe(true);
		await expect(client.request("conversation.prompt", { sessionId: "fixture", text: "late work" })).rejects.toThrow(
			"request was not started",
		);
		expect(
			await client.request<{ stopping: boolean }>("runtime.upgrade.commit", {
				instanceId: "superseded",
				token: prepared.token,
			}),
		).toEqual({ stopping: false });
		await client.request("runtime.upgrade.cancel", { instanceId: caps.instanceId, token: prepared.token });
		expect(
			await client.request<{ turnId: string }>("conversation.prompt", {
				sessionId: "fixture",
				text: "after cancel",
			}),
		).toEqual({ turnId: "fixture-turn" });
	} finally {
		release();
		await client.close();
		await node.stop();
	}
});
