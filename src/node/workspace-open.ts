// workspace.open: a path yields a workspace, a root on this machine, and a
// live leader. Git identity comes from `git` over execFile, never a shell;
// the id from `workspaceIdFor`, so equivalent SSH and HTTPS remotes group
// into one workspace.
//
// One narrow exception to the ports rule lives here: the leader needs the
// settings provider/model and the Neta tools server spec, and neither fits
// through `NodeStore`/`NodeAcp`, so this module imports three leaf builders
// from 03 (`loadSettings`, `providerFor`, `netaMcpServer`). They start no
// process, open no store and hold no state — `lifecycle.ts` still owns every
// stateful adaptation, and tests still stub the ports.
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { netaMcpServer } from "../acp/mcp.ts";
import { loadSettings, providerFor } from "../acp/settings.ts";
import { ulid } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import type { Leader, Workspace, WorkspaceKind } from "../core/types.ts";
import { canonicalRemote, workspaceIdFor } from "../core/workspace-id.ts";
import { asString, parseParams } from "./handlers-registry.ts";
import { netaDir, newToken } from "./lockfile.ts";
import { NodeError } from "./protocol.ts";
import type { NodeContext, NodeHandlers } from "./server.ts";

export interface DetectedWorkspace {
	kind: WorkspaceKind;
	// Raw origin URL for git; absent for folders. `workspaceIdFor`
	// canonicalises it for the id, `openWorkspace` for the record.
	remote?: string;
	name: string;
	// Real path of the checkout: the repo top level for git.
	root: string;
}

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

export async function detectWorkspace(path: string): Promise<DetectedWorkspace> {
	try {
		const found = await stat(path);
		if (!found.isDirectory()) {
			throw new NodeError("NOT_FOUND", `not a directory: ${path}`);
		}
	} catch (error) {
		if (error instanceof NodeError) {
			throw error;
		}
		if ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR") {
			throw new NodeError("NOT_FOUND", `no such directory: ${path}`);
		}
		throw error;
	}
	const root = await realpath(path);
	let toplevel: string;
	try {
		toplevel = await realpath(await runGit(["rev-parse", "--show-toplevel"], root));
	} catch {
		return { kind: "folder", name: basename(root), root };
	}
	let rawRemote: string;
	try {
		rawRemote = await runGit(["remote", "get-url", "origin"], toplevel);
	} catch {
		return { kind: "folder", name: basename(toplevel), root: toplevel };
	}
	if (rawRemote === "") {
		return { kind: "folder", name: basename(toplevel), root: toplevel };
	}
	return { kind: "git", remote: rawRemote, name: basename(toplevel), root: toplevel };
}

async function createLeader(ctx: NodeContext, workspaceId: string, machineId: string, cwd: string): Promise<Leader> {
	const { settings } = loadSettings({ netaDir: netaDir() });
	const providerName = settings.leader.provider;
	const provider = providerFor(settings, providerName);
	const model = settings.leader.model ?? provider.defaultModel;
	// Provisional actor identity: 05's token table mints the real actor token
	// when the leader session is (re-)launched, so this entry carries the
	// right shape (name neta, mcp --actor/--token) until then. The session id
	// only exists after creation, so it cannot be the actor id yet.
	const created = await ctx.acp.createSession({
		workspaceId,
		cwd,
		provider: providerName,
		model,
		access: "readOnly",
		mcpServers: [netaMcpServer({ actorId: ulid(), token: newToken() })],
	});
	const leader: Leader = {
		workspaceId,
		machineId,
		sessionId: created.sessionId,
		provider: created.provider,
		model: created.model,
		mode: "lead",
		modeSince: nowIso(),
		modeActiveMs: 0,
		state: "idle",
	};
	await ctx.store.putLeader(leader);
	ctx.hub.broadcast("state", { kind: "leader", record: leader });
	return leader;
}

export async function openWorkspace(ctx: NodeContext, path: string): Promise<{ workspace: Workspace; leader: Leader }> {
	const detected = await detectWorkspace(path);
	const id = workspaceIdFor({ kind: detected.kind, remote: detected.remote, path: detected.root });
	const machineId = ctx.store.machine().id;
	let workspace = ctx.store.getWorkspace(id);
	if (workspace === undefined) {
		workspace = {
			id,
			kind: detected.kind,
			name: detected.name,
			...(detected.remote === undefined ? {} : { remote: canonicalRemote(detected.remote) }),
			roots: [{ machineId, path: detected.root }],
			createdAt: nowIso(),
		};
		await ctx.store.putWorkspace(workspace);
	} else if (!workspace.roots.some((root) => root.machineId === machineId && root.path === detected.root)) {
		workspace = { ...workspace, roots: [...workspace.roots, { machineId, path: detected.root }] };
		await ctx.store.putWorkspace(workspace);
	}
	let leader = ctx.store.getLeader(id);
	if (leader === undefined) {
		leader = await createLeader(ctx, id, machineId, detected.root);
	}
	return { workspace, leader };
}

export const workspaceHandlers: NodeHandlers = {
	"workspace.open": (ctx, params) => {
		const parsed = parseParams({ path: asString }, params);
		return openWorkspace(ctx, parsed.path);
	},
};
