// End-to-end proof for workstream 05: a real Node on a temp NETA_DIR, a
// folder workspace, a leader session on the fake agent with --launch-mcp,
// and the stdio proxy driven the way a provider drives it.
//
// The socket's `tools.*` methods and the router's token table are wired here,
// not in production code: 06 (closeout, leases, git worktrees) and 07 (modes)
// have not landed yet, so their ports are test-local. What IS production is
// the path itself: session config, token minting, proxy, socket, router,
// handlers, store, ACP launches.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "../src/acp/settings.ts";
import type { Agent, Mission } from "../src/core/types.ts";
import { connectNode } from "../src/node/client.ts";
import { type AdaptedAcp, adaptAcp, adaptStore, allHandlers } from "../src/node/lifecycle.ts";
import { writeDescriptor } from "../src/node/lockfile.ts";
import { NodeError, PROTOCOL_VERSION, type TurnNotification } from "../src/node/protocol.ts";
import type { NodeStore } from "../src/node/server.ts";
import { createServer } from "../src/node/server.ts";
import { openStore, type Store } from "../src/store/index.ts";
import type { SessionLaunch } from "../src/tools/handlers/mission.ts";
import { toolHandlers } from "../src/tools/launch.ts";
import { createRouter, type TokenTable } from "../src/tools/router.ts";

const FAKE = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;
const RUNNER = new URL("./fixtures/mcp-proxy-runner.mjs", import.meta.url).pathname;
const CLIENT_TOKEN = "e2e-client-token";
const WORKSPACE = "e2e-w";
const LEADER_TOOLS = [
	"neta_agent",
	"neta_ask",
	"neta_close",
	"neta_history",
	"neta_mission",
	"neta_mode",
	"neta_pin",
	"neta_ready",
	"neta_scope",
	"neta_send",
	"neta_status",
];

let dir = "";
let folderCwd = "";
let savedNetadir: string | undefined;
let savedNetaBin: string | undefined;
const closers: Array<() => Promise<void>> = [];
const children: ChildProcess[] = [];

beforeEach(async () => {
	savedNetadir = process.env.NETA_DIR;
	savedNetaBin = process.env.NETA_BIN;
	dir = await mkdtemp(join(tmpdir(), "neta-e2e-"));
	folderCwd = await mkdtemp(join(tmpdir(), "neta-e2e-ws-"));
	process.env.NETA_DIR = dir;
	process.env.NETA_BIN = RUNNER;
});

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
	}
	for (const close of closers.splice(0)) {
		await close().catch(() => undefined);
	}
	if (savedNetadir === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = savedNetadir;
	}
	if (savedNetaBin === undefined) {
		delete process.env.NETA_BIN;
	} else {
		process.env.NETA_BIN = savedNetaBin;
	}
	await rm(dir, { recursive: true, force: true });
	await rm(folderCwd, { recursive: true, force: true });
});

function settings(): Settings {
	return {
		providers: {
			fake: { command: process.execPath, args: [FAKE, "--launch-mcp"], resume: true, defaultModel: "" },
		},
		leader: { provider: "fake" },
		forbiddenModels: [],
	};
}

async function waitFor<T>(what: string, poll: () => T | undefined, timeoutMs = 30000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = poll();
		if (found !== undefined) {
			return found;
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((done) => setTimeout(done, 25));
	}
}

interface DrivenProxy {
	call(method: string, params: unknown, id: number): Promise<{ result?: unknown; error?: { code: number } }>;
}

// Spawn the proxy the way a provider does and speak MCP NDJSON to it. 05:
// "env carries NETA_SOCKET only", so NETA_DIR is dropped here — the socket
// alone has to be enough to find the node and the token it answers to.
async function spawnProxy(actorId: string, token: string, socketPath: string): Promise<DrivenProxy> {
	const env: NodeJS.ProcessEnv = { ...process.env, NETA_SOCKET: socketPath };
	delete env.NETA_DIR;
	const child = spawn(RUNNER, ["mcp", "--actor", actorId, "--token", token], {
		env,
		stdio: ["pipe", "pipe", "ignore"],
	});
	children.push(child);
	const pending = new Map<number, (message: { result?: unknown; error?: { code: number } }) => void>();
	let buffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const raw = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (raw !== "") {
				const message = JSON.parse(raw) as { id?: unknown; result?: unknown; error?: { code: number } };
				if (typeof message.id === "number") {
					pending.get(message.id)?.({ result: message.result, error: message.error });
					pending.delete(message.id);
				}
			}
			newline = buffer.indexOf("\n");
		}
	});
	return {
		call: (method, params, id) => {
			const task = new Promise<{ result?: unknown; error?: { code: number } }>((resolve) =>
				pending.set(id, resolve),
			);
			child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return task;
		},
	};
}

test("session tool wiring and end-to-end mission creation", async () => {
	const real: Store = await openStore();
	closers.push(() => real.close());
	const acp: AdaptedAcp = adaptAcp(settings());
	closers.push(() => acp.closeAll());

	// The leader session first: its session id becomes the leader's actor id,
	// and adaptAcp mints the actor token at launch.
	const created = await acp.createSession({
		workspaceId: WORKSPACE,
		cwd: folderCwd,
		provider: "fake",
		model: "test-model",
		access: "readWrite",
		netaTools: true,
	});
	const leaderSession = created.sessionId;
	const leaderToken = acp.actorToken(leaderSession);
	if (leaderToken === undefined) {
		throw new Error("the node minted no actor token for the leader session");
	}

	await real.workspaces.save({
		id: WORKSPACE,
		kind: "folder",
		name: "e2e",
		roots: [{ machineId: "m", path: folderCwd }],
		createdAt: new Date(0).toISOString(),
	});
	await real.leaders.save({
		workspaceId: WORKSPACE,
		machineId: "e2e-machine",
		name: "Halden",
		sessionId: leaderSession,
		provider: "fake",
		model: "test-model",
		mode: "lead",
		modeSince: new Date(0).toISOString(),
		modeActiveMs: 0,
		state: "running",
	});
	const base = await adaptStore(real);

	// Prompt MCP: the fake agent echoes the config it was given.
	const seen: TurnNotification[] = [];
	acp.onTurn((notification) => seen.push(notification));
	await acp.prompt(leaderSession, "MCP please");
	const echo = await waitFor("the MCP echo", () => {
		for (const notification of seen) {
			const text = notification.block?.text ?? "";
			if (text.startsWith("mcp:")) {
				return text.slice("mcp:".length);
			}
		}
		return undefined;
	});
	const servers = JSON.parse(echo) as Array<{
		name: string;
		command: string;
		args: string[];
		env: Array<{ name: string; value: string }>;
	}>;
	const neta = servers.find((server) => server.name === "neta");
	if (neta === undefined) {
		throw new Error("no neta MCP server in the echoed config");
	}
	expect(neta.command).toBe(RUNNER);
	expect(neta.args).toEqual(["mcp", "--actor", leaderSession, "--token", leaderToken]);
	const socketPath = join(dir, "node.sock");
	expect(neta.env).toEqual([{ name: "NETA_SOCKET", value: socketPath }]);

	// The router over the adapted store. Missions overlay the mirror (which
	// cannot take new missions) while also persisting to the real registry;
	// the token table is seeded with the node-minted leader token.
	const overlay = new Map<string, Mission>();
	const store: NodeStore = {
		...base,
		listMissions: (workspaceId) => [
			...base.listMissions(workspaceId),
			...[...overlay.values()].filter((m: Mission) => workspaceId === undefined || m.workspaceId === workspaceId),
		],
		getMission: (id) => overlay.get(id) ?? base.getMission(id),
	};
	const backing = new Map<string, string>([[leaderSession, leaderToken]]);
	const tokens: TokenTable = {
		mint: (actorId) => {
			const token = randomBytes(32).toString("hex");
			backing.set(actorId, token);
			return token;
		},
		verify: (actorId, token) => {
			const expected = backing.get(actorId);
			if (expected === undefined) {
				return false;
			}
			const a = Buffer.from(expected, "utf8");
			const b = Buffer.from(token, "utf8");
			return a.length === b.length && timingSafeEqual(a, b);
		},
		revoke: (actorId) => {
			backing.delete(actorId);
		},
	};
	const deps = {
		store,
		numbers: { allocateNumber: (workspaceId: string) => real.missions.allocateNumber(workspaceId) },
		missions: {
			save: async (mission: Mission) => {
				const existing = await real.missions.get(mission.workspaceId, mission.id);
				if (existing === undefined) {
					await real.missions.create(mission);
				} else {
					await real.missions.update(mission);
				}
				overlay.set(mission.id, mission);
			},
		},
		sessions: {
			launch: async (input: SessionLaunch) => {
				const session = await acp.createSession({
					workspaceId: input.workspaceId,
					cwd: input.worktreePath ?? folderCwd,
					provider: input.provider,
					model: input.model,
					access: input.access,
					netaTools: true,
					actorId: input.agentId,
				});
				return { sessionId: session.sessionId };
			},
			brief: async (input: SessionLaunch & { sessionId: string }) => {
				await acp.prompt(input.sessionId, input.task);
			},
			close: (id: string) => acp.close(id),
			failed: () => Promise.resolve(),
			cancel: (id: string) => acp.cancel(id),
			prompt: (id: string, text: string) => acp.prompt(id, text).then(() => undefined),
		},
		worktrees: {
			prepare: async (mission: Mission) => mission,
			close: () => Promise.reject(new Error("closeout lands in 06")),
		},
		skills: { check: () => ({ ok: true as const }) },
		leases: { acquire: () => Promise.resolve("active" as const), release: () => Promise.resolve() },
		modes: { requestMode: () => Promise.resolve({ approved: true as const }) },
	};
	const router = createRouter(deps, toolHandlers(), tokens);
	const { close } = await createServer({
		socketPath,
		token: CLIENT_TOKEN,
		handlers: {
			...allHandlers,
			"tools.list": (_ctx, params) => {
				const { actorId, token } = params as { actorId: string; token: string };
				const listed = router.list(actorId, token);
				if (Array.isArray(listed)) {
					return Promise.resolve({
						tools: listed.map((tool) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema,
						})),
					});
				}
				if (!listed.ok) {
					return Promise.reject(new NodeError("UNAUTHORIZED", listed.message));
				}
				return Promise.reject(new NodeError("INTERNAL", "unexpected tool list"));
			},
			"tools.call": (_ctx, params) => {
				const {
					actorId,
					token,
					name,
					arguments: args,
				} = params as {
					actorId: string;
					token: string;
					name: string;
					arguments: Record<string, unknown>;
				};
				return router.call(actorId, token, name, args);
			},
		},
		ctx: { store, acp, nodeVersion: "0.0.0-test", stop: () => Promise.resolve() },
	});
	closers.push(close);
	await writeDescriptor({
		socket: socketPath,
		token: CLIENT_TOKEN,
		pid: process.pid,
		protocolVersion: PROTOCOL_VERSION,
		startedAt: new Date(0).toISOString(),
	});

	// Drive the proxy as a provider would.
	const proxy = await spawnProxy(leaderSession, leaderToken, socketPath);
	const hello = await proxy.call(
		"initialize",
		{ protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
		1,
	);
	expect((hello.result as { serverInfo: { name: string } }).serverInfo.name).toBe("neta");
	const listed = await proxy.call("tools/list", {}, 2);
	const tools = (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort();
	expect(tools).toEqual([...LEADER_TOOLS].sort());
	const called = await proxy.call(
		"tools/call",
		{
			name: "neta_mission",
			arguments: {
				name: "lens port",
				objective: "port the lens",
				access: "readOnly",
				lead: "self",
				agents: [
					{ task: "one", access: "readOnly" },
					{ task: "two", access: "readOnly" },
				],
			},
		},
		3,
	);
	const payload = JSON.parse(
		(
			(called.result as { content: Array<{ text: string }>; isError: boolean }).content[0] as { text: string }
		).text.split("\n")[0] as string,
	) as { number: number; id: string; worktree: null };
	expect((called.result as { isError: boolean }).isError).toBe(false);
	expect(payload.number).toBe(1);
	expect(typeof payload.id).toBe("string");
	expect(payload.worktree).toBeNull();

	// The mission is in the snapshot with two agents...
	const client = await connectNode();
	closers.push(() => client.close());
	const snapshot = await client.request<{ missions: Mission[]; agents: Agent[] }>("snapshot", {
		workspaceId: WORKSPACE,
	});
	expect(snapshot.missions.map((m) => m.number)).toEqual([1]);
	expect(snapshot.agents.filter((a) => a.missionId === payload.id)).toHaveLength(2);
	await client.close();

	// ...and the log holds mission.created and two agent.spawned.
	const page = await real.events.list(WORKSPACE, { limit: 100 });
	expect(page.events.slice(-3).map((event) => event.kind)).toEqual([
		"mission.created",
		"agent.spawned",
		"agent.spawned",
	]);

	// A revoked token is refused.
	tokens.revoke(leaderSession);
	const refused = await proxy.call("tools/call", { name: "neta_status", arguments: {} }, 4);
	const refusedResult = refused.result as { content: Array<{ text: string }>; isError: boolean };
	expect(refusedResult.isError).toBe(true);
	expect(refusedResult.content[0]?.text.startsWith("error notAuthorised:")).toBe(true);
}, 120000);
