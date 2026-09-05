import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import { NAME_POOL } from "../src/core/names.ts";
import type { Leader, Workspace } from "../src/core/types.ts";
import { canonicalRemote } from "../src/core/workspace-id.ts";
import { adaptStore } from "../src/node/lifecycle.ts";
import type { NodeAcp, NodeContext, NodeStore } from "../src/node/server.ts";
import { detectWorkspace, openWorkspace, workspaceHandlers } from "../src/node/workspace-open.ts";
import { openStore, paths, readJson, type Store } from "../src/store/index.ts";

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

interface World {
	workspaces: Map<string, Workspace>;
	leaders: Map<string, Leader>;
	sessions: CreatedSession[];
	broadcasts: unknown[];
	// What `ensureSession` was asked for, and the session ids the fake ACP
	// still holds: anything else comes back under a fresh id, the way a
	// provider that has forgotten the vendor session does.
	ensured: Array<{ sessionId: string; cwd: string; access: string; unsandboxed?: boolean }>;
	live: Set<string>;
}

function emptyWorld(): World {
	return {
		workspaces: new Map(),
		leaders: new Map(),
		sessions: [],
		broadcasts: [],
		ensured: [],
		live: new Set<string>(),
	};
}

interface CreatedSession {
	workspaceId: string;
	cwd: string;
	provider: string;
	model: string;
	access: string;
	unsandboxed?: boolean;
	netaTools: boolean;
	actorId?: string;
}

function testCtx(world: World): NodeContext {
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
			world.sessions.push({ ...o });
			const sessionId = ulid();
			world.live.add(sessionId);
			return Promise.resolve({ sessionId, provider: o.provider, model: o.model });
		},
		ensureSession: (o) => {
			world.ensured.push({ sessionId: o.sessionId, cwd: o.cwd, access: o.access, unsandboxed: o.unsandboxed });
			if (world.live.has(o.sessionId)) {
				return Promise.resolve({ sessionId: o.sessionId, provider: o.provider, model: o.model });
			}
			const sessionId = ulid();
			world.live.add(sessionId);
			return Promise.resolve({ sessionId, provider: o.provider, model: o.model });
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

// A context whose store is the real lifecycle store over `NETA_DIR`, so
// leader records travel through leaders/<workspaceId>.json; ACP and hub stay
// fake.
async function realCtx(real: Store, world: World): Promise<NodeContext> {
	return { ...testCtx(world), store: await adaptStore(real) };
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

	test("leader creation draws a personal name from the pool, not the workspace name", async () => {
		const repo = join(dir, "widget");
		await initRepo(repo, "git@github.com:acme/widget.git");
		const world = emptyWorld();
		const opened = await openWorkspace(testCtx(world), repo);
		expect(NAME_POOL).toContain(opened.leader.name);
		expect(opened.leader.name).not.toBe(opened.workspace.name);
		expect(opened.leader.name).not.toBe(opened.workspace.id);
		// Seeded by the workspace id: a second checkout of the same repo,
		// opened into a fresh world, draws the same name.
		const other = join(dir, "widget-clone");
		await initRepo(other, "https://github.com/acme/widget.git");
		const fresh = await openWorkspace(testCtx(emptyWorld()), other);
		expect(fresh.leader.name).toBe(opened.leader.name);
	});

	test("settings leader.name overrides the pool, blank falls back to it", async () => {
		const repo = join(dir, "repo");
		await initRepo(repo, "git@github.com:acme/widget.git");
		const neta = process.env.NETA_DIR ?? "";
		await mkdir(neta, { recursive: true });
		await writeFile(join(neta, "settings.json"), JSON.stringify({ leader: { provider: "claude", name: "Halden" } }));
		const named = await openWorkspace(testCtx(emptyWorld()), repo);
		expect(named.leader.name).toBe("Halden");
		await writeFile(join(neta, "settings.json"), JSON.stringify({ leader: { provider: "claude", name: "  " } }));
		const blank = await openWorkspace(testCtx(emptyWorld()), repo);
		expect(NAME_POOL).toContain(blank.leader.name);
	});

	test("the workspace's own settings layer names the leader", async () => {
		const repo = join(dir, "repo");
		await initRepo(repo, "git@github.com:acme/widget.git");
		const neta = process.env.NETA_DIR ?? "";
		await mkdir(neta, { recursive: true });
		await writeFile(join(neta, "settings.json"), JSON.stringify({ leader: { provider: "claude", name: "Halden" } }));
		await mkdir(join(repo, ".neta"), { recursive: true });
		await writeFile(join(repo, ".neta", "settings.json"), JSON.stringify({ leader: { name: "Wren" } }));
		const opened = await openWorkspace(testCtx(emptyWorld()), repo);
		expect(opened.leader.name).toBe("Wren");
	});

	test("an existing leader whose session is gone is revived and announced", async () => {
		const repo = join(dir, "repo");
		await initRepo(repo, "git@github.com:acme/widget.git");
		const world = emptyWorld();
		const first = await openWorkspace(testCtx(world), repo);
		expect(world.ensured).toHaveLength(0);

		// The node restarted: the ACP table is empty, so the stored session
		// names nothing live.
		world.live.clear();
		world.broadcasts.length = 0;
		const again = await openWorkspace(testCtx(world), repo);
		expect(world.ensured.map((one) => one.sessionId)).toEqual([first.leader.sessionId]);
		expect(world.ensured[0]?.cwd).toBe(await realpath(repo));
		expect(again.leader.sessionId).not.toBe(first.leader.sessionId);
		expect(again.leader.name).toBe(first.leader.name);
		// Recorded, and announced so open clients follow the new session.
		expect(world.leaders.get(again.workspace.id)?.sessionId).toBe(again.leader.sessionId);
		expect(world.broadcasts).toEqual([{ method: "state", params: { kind: "leader", record: again.leader } }]);
	});

	test("a leader whose session is still live keeps it, silently", async () => {
		const repo = join(dir, "repo");
		await initRepo(repo, "git@github.com:acme/widget.git");
		const world = emptyWorld();
		const first = await openWorkspace(testCtx(world), repo);
		world.broadcasts.length = 0;
		const again = await openWorkspace(testCtx(world), repo);
		expect(again.leader.sessionId).toBe(first.leader.sessionId);
		expect(world.sessions).toHaveLength(1);
		expect(world.broadcasts).toHaveLength(0);
	});

	test("the leader name round-trips through the real store and its broadcast", async () => {
		const repo = join(dir, "repo");
		await initRepo(repo, "git@github.com:acme/widget.git");
		const world = emptyWorld();
		const real = await openStore();
		try {
			const first = await openWorkspace(await realCtx(real, world), repo);
			// Not the fake map: the JSON the lifecycle store wrote under
			// leaders/ carries the field.
			expect((await readJson<Leader>(paths().leader(first.workspace.id)))?.name).toBe(first.leader.name);
			// And the `state` notification that announced the leader carries it.
			expect(world.broadcasts).toEqual([{ method: "state", params: { kind: "leader", record: first.leader } }]);
			// A fresh adaption reads the record back off disk: same name, no
			// second session, nothing re-broadcast.
			const reloaded = await openWorkspace(await realCtx(real, world), repo);
			expect(reloaded.leader.name).toBe(first.leader.name);
			expect(world.sessions).toHaveLength(1);
			expect(world.broadcasts).toHaveLength(1);
		} finally {
			await real.close();
		}
	});

	test("a stored leader written before the field gains a name on open", async () => {
		const repo = join(dir, "repo");
		await initRepo(repo, "git@github.com:acme/widget.git");
		const world = emptyWorld();
		const real = await openStore();
		try {
			const first = await openWorkspace(await realCtx(real, world), repo);
			// The record as it was written before `name` existed.
			const legacy: Record<string, unknown> = { ...first.leader };
			delete legacy.name;
			await writeFile(paths().leader(first.workspace.id), JSON.stringify(legacy));
			world.broadcasts.length = 0;
			const reopened = await openWorkspace(await realCtx(real, world), repo);
			expect(NAME_POOL).toContain(reopened.leader.name);
			// Backfilled, not re-created: the session and mode survive.
			expect(reopened.leader.sessionId).toBe(first.leader.sessionId);
			expect(reopened.leader.modeSince).toBe(first.leader.modeSince);
			expect(world.sessions).toHaveLength(1);
			// Persisted and announced, so the next reader never sees it missing.
			expect((await readJson<Leader>(paths().leader(first.workspace.id)))?.name).toBe(reopened.leader.name);
			expect(world.broadcasts).toEqual([{ method: "state", params: { kind: "leader", record: reopened.leader } }]);
		} finally {
			await real.close();
		}
	});
});

describe("openWorkspace", () => {
	test("a fresh provider failure still returns the saved workspace and a recoverable leader", async () => {
		const folder = join(dir, "provider-down");
		await mkdir(folder, { recursive: true });
		const world = emptyWorld();
		const base = testCtx(world);
		const failedCtx = {
			...base,
			acp: {
				...base.acp,
				createSession: () => Promise.reject(new Error("adapter did not start")),
			},
		};
		const opened = await openWorkspace(failedCtx, folder);
		expect(opened.workspace.name).toBe("provider-down");
		expect(opened.leader.state).toBe("failed");
		expect(world.workspaces.get(opened.workspace.id)).toEqual(opened.workspace);
		expect(world.leaders.get(opened.workspace.id)).toEqual(opened.leader);
		expect(world.broadcasts).toEqual([{ method: "state", params: { kind: "leader", record: opened.leader } }]);
		expect(world.sessions).toEqual([]);

		// The persisted failed leader is useful, rather than a tombstone: the
		// ordinary reopen path retries its exact session and can recover it.
		world.broadcasts.length = 0;
		const recovered = await openWorkspace(base, folder);
		expect(recovered.leader.state).toBe("idle");
		expect(world.ensured[0]?.sessionId).toBe(opened.leader.sessionId);
		expect(world.ensured[0]?.unsandboxed).toBe(true);
		expect(recovered.leader.sessionId).not.toBe(opened.leader.sessionId);
	});

	test("SSH and HTTPS copies open to one workspace with two roots", async () => {
		const repoA = join(dir, "a");
		const repoB = join(dir, "b");
		await initRepo(repoA, "git@github.com:acme/widget.git");
		await initRepo(repoB, "https://github.com/acme/widget.git");
		const world = emptyWorld();
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
		const world = emptyWorld();
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
		// The leader is an actor: it asks 03 for the tools entry and never
		// builds one, so no placeholder actor id or token can leak through.
		expect(session.netaTools).toBe(true);
		expect(session.unsandboxed).toBe(true);
		expect(session.actorId).toBeUndefined();
		expect(world.broadcasts).toEqual([{ method: "state", params: { kind: "leader", record: first.leader } }]);
	});

	test("concurrent opens create exactly one leader session", async () => {
		const repo = join(dir, "concurrent");
		await initRepo(repo, "git@github.com:acme/concurrent.git");
		const world = emptyWorld();
		const ctx = testCtx(world);
		const opened = await Promise.all(Array.from({ length: 10 }, () => openWorkspace(ctx, repo)));
		expect(new Set(opened.map((result) => result.leader.sessionId)).size).toBe(1);
		expect(world.sessions).toHaveLength(1);
		expect(world.leaders).toHaveLength(1);
		expect(world.broadcasts).toHaveLength(1);
	});

	test("a plain folder gets kind folder, a missing path gives NOT_FOUND", async () => {
		const folder = join(dir, "plain");
		await mkdir(folder, { recursive: true });
		const world = emptyWorld();
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
