import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import type { Leader, Workspace } from "../src/core/types.ts";
import { canonicalRemote } from "../src/core/workspace-id.ts";
import type { NodeAcp, NodeContext, NodeStore } from "../src/node/server.ts";
import { detectWorkspace, openWorkspace, workspaceHandlers } from "../src/node/workspace-open.ts";

function runGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd }, (error, stdout) => {
			if (error) {
				reject(error);
			} else {
				resolve(stdout.trim());
			}
		});
	});
}

let dir = "";
let savedNetadir: string | undefined;

beforeEach(async () => {
	savedNetadir = process.env.NETA_DIR;
	dir = await mkdtemp(join(tmpdir(), "neta-wopen-"));
	process.env.NETA_DIR = join(dir, "neta");
});

afterEach(async () => {
	if (savedNetadir === undefined) {
		delete process.env.NETA_DIR;
	} else {
		process.env.NETA_DIR = savedNetadir;
	}
	await rm(dir, { recursive: true, force: true });
});

async function initRepo(path: string, remote?: string): Promise<void> {
	await mkdir(path, { recursive: true });
	await runGit(["init", "-q"], path);
	if (remote !== undefined) {
		await runGit(["remote", "add", "origin", remote], path);
	}
}

interface CreatedSession {
	workspaceId: string;
	cwd: string;
	provider: string;
	model: string;
	access: string;
	mcpServers: Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }>;
}

function testCtx(world: {
	workspaces: Map<string, Workspace>;
	leaders: Map<string, Leader>;
	sessions: CreatedSession[];
	broadcasts: unknown[];
}): NodeContext {
	const store: NodeStore = {
		machine: () => ({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "test", createdAt: "2026-01-01T00:00:00.000Z" }),
		listWorkspaces: () => [...world.workspaces.values()],
		listLeaders: () => [...world.leaders.values()],
		listMissions: () => [],
		listAgents: () => [],
		getWorkspace: (id) => world.workspaces.get(id),
		getLeader: (id) => world.leaders.get(id),
		getMission: () => undefined,
		getAgent: () => undefined,
		putWorkspace: (w) => {
			world.workspaces.set(w.id, w);
			return Promise.resolve();
		},
		putAgent: () => Promise.reject(new Error("not implemented in this test")),
		putLeader: (l) => {
			world.leaders.set(l.workspaceId, l);
			return Promise.resolve();
		},
		compact: () => Promise.reject(new Error("not implemented in this test")),
		appendEvent: () => Promise.reject(new Error("not implemented in this test")),
		listEvents: () => Promise.reject(new Error("not implemented in this test")),
		tailConversation: () => Promise.reject(new Error("not implemented in this test")),
	};
	const acp: NodeAcp = {
		createSession: (o) => {
			world.sessions.push({ ...o, mcpServers: o.mcpServers.map((s) => ({ ...s })) });
			return Promise.resolve({ sessionId: ulid(), provider: o.provider, model: o.model });
		},
		prompt: () => Promise.reject(new Error("not implemented in this test")),
		setModel: () => Promise.reject(new Error("not implemented in this test")),
		listModels: () => Promise.reject(new Error("not implemented in this test")),
		cancel: () => Promise.reject(new Error("not implemented in this test")),
		close: () => Promise.reject(new Error("not implemented in this test")),
		closeAll: () => Promise.reject(new Error("not implemented in this test")),
		onTurn: () => {
			throw new Error("not implemented in this test");
		},
	};
	return {
		store,
		acp,
		hub: {
			broadcast: (method, params) => {
				world.broadcasts.push({ method, params });
			},
			toTail: () => undefined,
			connections: () => [],
		},
		nodeVersion: "0.0.0-test",
		stop: () => Promise.resolve(),
	};
}

describe("detectWorkspace", () => {
	test("SSH and HTTPS remotes of one repo detect the same canonical remote", async () => {
		const repoA = join(dir, "a");
		const repoB = join(dir, "b");
		await initRepo(repoA, "git@github.com:acme/widget.git");
		await initRepo(repoB, "https://github.com/acme/widget.git");
		const a = await detectWorkspace(repoA);
		const b = await detectWorkspace(repoB);
		expect(a).toEqual({
			kind: "git",
			remote: "git@github.com:acme/widget.git",
			name: "a",
			root: await realpath(repoA),
		});
		expect(b.remote).toBe("https://github.com/acme/widget.git");
		expect(b.kind).toBe("git");
		expect(canonicalRemote(a.remote ?? "")).toBe("github.com/acme/widget");
		expect(canonicalRemote(b.remote ?? "")).toBe("github.com/acme/widget");
	});

	test("a plain folder and a remote-less repo are folders", async () => {
		const folder = join(dir, "plain");
		await mkdir(folder, { recursive: true });
		expect(await detectWorkspace(folder)).toEqual({ kind: "folder", name: "plain", root: await realpath(folder) });
		const repo = join(dir, "noremote");
		await initRepo(repo);
		const detected = await detectWorkspace(repo);
		expect(detected.kind).toBe("folder");
		expect(detected.remote).toBeUndefined();
	});

	test("a subdir resolves to the repo top level, a missing path gives NOT_FOUND", async () => {
		const repo = join(dir, "repo");
		await initRepo(repo, "git@github.com:acme/widget.git");
		await mkdir(join(repo, "sub"), { recursive: true });
		const detected = await detectWorkspace(join(repo, "sub"));
		expect(detected.root).toBe(await realpath(repo));
		let thrown: unknown;
		try {
			await detectWorkspace(join(dir, "missing"));
		} catch (error) {
			thrown = error;
		}
		expect((thrown as { symbol?: string }).symbol).toBe("NOT_FOUND");
	});
});

describe("openWorkspace", () => {
	test("SSH and HTTPS copies open to one workspace with two roots", async () => {
		const repoA = join(dir, "a");
		const repoB = join(dir, "b");
		await initRepo(repoA, "git@github.com:acme/widget.git");
		await initRepo(repoB, "https://github.com/acme/widget.git");
		const world = {
			workspaces: new Map(),
			leaders: new Map(),
			sessions: [] as CreatedSession[],
			broadcasts: [] as unknown[],
		};
		const ctx = testCtx(world);
		const first = await openWorkspace(ctx, repoA);
		expect(first.workspace.id).toBe("git:github.com/acme/widget");
		expect(first.workspace.remote).toBe("github.com/acme/widget");
		expect(first.workspace.roots).toEqual([{ machineId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", path: await realpath(repoA) }]);
		const second = await openWorkspace(ctx, repoB);
		expect(second.workspace.id).toBe(first.workspace.id);
		expect(second.workspace.roots).toHaveLength(2);
		expect(second.workspace.roots.map((r) => r.path).sort()).toEqual(
			[await realpath(repoA), await realpath(repoB)].sort(),
		);
	});

	test("opening twice returns the same leader and creates one ACP session carrying the tools entry", async () => {
		const repo = join(dir, "repo");
		await initRepo(repo, "git@github.com:acme/widget.git");
		const world = {
			workspaces: new Map(),
			leaders: new Map(),
			sessions: [] as CreatedSession[],
			broadcasts: [] as unknown[],
		};
		const ctx = testCtx(world);
		const first = await openWorkspace(ctx, repo);
		const second = await openWorkspace(ctx, repo);
		expect(second.leader.sessionId).toBe(first.leader.sessionId);
		expect(world.sessions).toHaveLength(1);
		// Defaults from an empty temp NETA_DIR: claude and its default model.
		expect(first.leader.provider).toBe("claude");
		expect(first.leader.model).toBe("sonnet");
		expect(first.leader.mode).toBe("lead");
		const session = world.sessions[0];
		if (session === undefined) {
			throw new Error("expected one ACP session");
		}
		expect(session.workspaceId).toBe(first.workspace.id);
		expect(session.cwd).toBe(await realpath(repo));
		const tools = session.mcpServers.find((s) => s.name === "neta");
		if (tools === undefined) {
			throw new Error("expected a neta tools entry");
		}
		const mcpIndex = tools.args.indexOf("mcp");
		expect(mcpIndex).toBeGreaterThanOrEqual(0);
		expect(tools.args.slice(mcpIndex, mcpIndex + 3)).toEqual(["mcp", "--actor", tools.args[mcpIndex + 2]]);
		expect(tools.args[mcpIndex + 3]).toBe("--token");
		expect(typeof tools.args[mcpIndex + 4]).toBe("string");
		expect(world.broadcasts).toEqual([{ method: "state", params: { kind: "leader", record: first.leader } }]);
	});

	test("a plain folder gets kind folder, a missing path gives NOT_FOUND", async () => {
		const folder = join(dir, "plain");
		await mkdir(folder, { recursive: true });
		const world = {
			workspaces: new Map(),
			leaders: new Map(),
			sessions: [] as CreatedSession[],
			broadcasts: [] as unknown[],
		};
		const opened = await openWorkspace(testCtx(world), folder);
		expect(opened.workspace.kind).toBe("folder");
		expect(opened.workspace.id.startsWith("folder:")).toBe(true);
		expect(opened.workspace.name).toBe(basename(await realpath(folder)));
		const method: string = "workspace.open";
		const handler = workspaceHandlers[method];
		if (handler === undefined) {
			throw new Error("workspace.open handler is missing");
		}
		let thrown: unknown;
		try {
			await handler(testCtx(world), { path: join(dir, "missing") }, undefined as never);
		} catch (error) {
			thrown = error;
		}
		expect((thrown as { symbol?: string }).symbol).toBe("NOT_FOUND");
	});
});
