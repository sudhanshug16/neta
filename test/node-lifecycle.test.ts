import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/acp/settings.ts";
import { ulid } from "../src/core/ids.ts";
import type { Agent, AgentState, Event, Mission, MissionState, Workspace } from "../src/core/types.ts";
import { connectNode, type NodeClient, startNode } from "../src/node/index.ts";
import { adaptAcp, adaptStore, allHandlers, markInterrupted, type Node as NetaNode } from "../src/node/lifecycle.ts";
import { readDescriptor } from "../src/node/lockfile.ts";
import type { NodeAcp, NodeStore } from "../src/node/server.ts";
import { openStore } from "../src/store/index.ts";

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

function stubAcp(world: StubWorld): NodeAcp {
	return {
		createSession: () => Promise.reject(new Error("not implemented in this test")),
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
		const node: NetaNode = await startNode({ store: stubStore(world), acp: stubAcp(world) });
		try {
			expect(world.events).toEqual([
				{ workspaceId: "w1", kind: "node.restarted", data: { agents: 2 } },
				{ workspaceId: "w2", kind: "node.restarted", data: { agents: 1 } },
			]);
			expect(await readDescriptor()).toEqual(node.descriptor);
			expect(node.descriptor.pid).toBe(process.pid);
			expect(node.descriptor.protocolVersion).toBe(1);
			let second: unknown;
			try {
				await startNode({ store: stubStore(world), acp: stubAcp(world) });
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
		const started = startNode({ store: stubStore(world), acp: stubAcp(world) });
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
		const node = await startNode({ store: stubStore(world), acp: stubAcp(world) });
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
	test("it merges the four maps with no collisions", () => {
		expect(Object.keys(allHandlers).sort()).toEqual(
			[
				"agent.archive",
				"conversation.cancel",
				"conversation.prompt",
				"conversation.setModel",
				"conversation.tail",
				"conversation.untail",
				"events.list",
				"leader.setMode",
				"mission.pin",
				"missions.get",
				"missions.list",
				"models.list",
				"node.stop",
				"snapshot",
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

describe("adaptAcp against the fake provider", () => {
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
		const acp = adaptAcp(loadSettings({ netaDir: dir }).settings);
		const created = await acp.createSession({
			workspaceId: "w1",
			cwd: dir,
			provider: "fake",
			model: "test-model",
			access: "readOnly",
			mcpServers: [
				{
					name: "neta",
					command: "neta",
					args: ["mcp", "--actor", "provisional", "--token", "provisional"],
					env: [],
				},
			],
		});
		try {
			expect(typeof created.sessionId).toBe("string");
			const token = acp.actorToken(created.sessionId);
			expect(token).toMatch(/^[0-9a-f]{64}$/);
			const seen: unknown[] = [];
			acp.onTurn((notification) => {
				seen.push(notification);
			});
			const turnId = await acp.prompt(created.sessionId, "MCP please");
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
});
