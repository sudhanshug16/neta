// workspace.open: a path yields a workspace, a root on this machine, and a
// live leader. Git identity comes from `git` over execFile, never a shell;
// the id from `workspaceIdFor`, so equivalent SSH and HTTPS remotes group
// into one workspace.
//
// One narrow exception to the ports rule lives here: the leader needs the
// settings provider and model, which do not fit through
// `NodeStore`/`NodeAcp`, so this module imports two leaf builders from 03
// (`loadSettings`, `providerFor`). They start no process, open no store and
// hold no state — `lifecycle.ts` still owns every stateful adaptation, and
// tests still stub the ports.
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { providerErrorMessage, redactProviderText } from "../acp/errors.ts";
import { loadSettings, providerFor } from "../acp/settings.ts";
import { ulid } from "../core/ids.ts";
import { pickName } from "../core/names.ts";
import { nowIso } from "../core/time.ts";
import type { Leader, Workspace, WorkspaceKind } from "../core/types.ts";
import { canonicalRemote, workspaceIdFor } from "../core/workspace-id.ts";
import { createFileLeaseStore, LeaseManager, leaseKeyFor } from "../worktrees/index.ts";
import { asOptionalString, asString, parseParams } from "./handlers-registry.ts";
import { netaDir } from "./lockfile.ts";
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

// Names already spoken for in this workspace: every agent on every mission
// it has. A fresh workspace has none; a workspace whose leader record was
// lost keeps the live agents' names off the leader.
function takenNames(ctx: NodeContext, workspaceId: string): Set<string> {
	const taken = new Set<string>();
	for (const mission of ctx.store.listMissions(workspaceId)) {
		for (const agent of ctx.store.listAgents(mission.id)) {
			taken.add(agent.name);
		}
	}
	return taken;
}

// The leader is a person to talk to, not the workspace: it gets its own name
// from the pool, seeded by the workspace id so the same workspace always draws
// the same one. `leader.name` in settings overrides it, and the workspace's
// own `<root>/.neta/settings.json` layer wins over the user's. The name is
// written into the record and never picked again.
function leaderName(ctx: NodeContext, workspaceId: string, workspaceRoot: string): string {
	const { settings } = loadSettings({ netaDir: netaDir(), workspaceRoot });
	const override = settings.leader.name?.trim() ?? "";
	return override === "" ? pickName(takenNames(ctx, workspaceId), workspaceId) : override;
}

// A leader record written before `name` existed decodes as a `Leader` with the
// field missing, and the desktop's `Leader` requires it: the whole snapshot
// then fails to decode and the app shows an empty window. Read the field back
// as unknown so a record off disk is judged by what it holds, not by its type.
function storedName(leader: Leader): string {
	const raw: unknown = leader.name;
	return typeof raw === "string" ? raw.trim() : "";
}

async function createLeader(
	ctx: NodeContext,
	workspaceId: string,
	machineId: string,
	cwd: string,
	preferredProvider?: string,
): Promise<Leader> {
	const { settings } = loadSettings({ netaDir: netaDir(), workspaceRoot: cwd });
	const providerName = preferredProvider ?? (ctx.pi === undefined ? settings.leader.provider : "pi");
	const model =
		(preferredProvider === undefined ? settings.leader.model : undefined) ??
		settings.providers[providerName]?.defaultModel ??
		"";
	const name = leaderName(ctx, workspaceId, cwd);
	// The leader is an actor: 03 mints its token under the session id it is
	// about to create and builds the `neta` MCP entry from it, so nothing
	// here has to guess an actor id.
	const sessionId = ulid();
	const candidate: Leader = {
		workspaceId,
		machineId,
		name,
		sessionId,
		provider: providerName,
		model,
		mode: "lead",
		modeSince: nowIso(),
		modeActiveMs: 0,
		state: "failed",
	};
	let leader = candidate;
	if (ctx.pi !== undefined && providerName === "pi") {
		ctx.acp.prepareExternalActor?.(sessionId);
		leader = { ...candidate, state: "idle" };
		await ctx.store.putLeader(leader);
		ctx.hub.broadcast("state", { kind: "leader", record: leader });
		return leader;
	}
	try {
		providerFor(settings, providerName);
		const created = await ctx.acp.createSession({
			sessionId,
			workspaceId,
			cwd,
			provider: providerName,
			model,
			access: "readOnly",
			unsandboxed: true,
			netaTools: true,
		});
		leader = {
			...candidate,
			sessionId: created.sessionId,
			provider: created.provider,
			model: created.model,
			state: "idle",
		};
	} catch (error) {
		// Opening a project and starting its provider are separate durable
		// outcomes. Keep a failed leader beside the already-saved workspace so
		// the desktop can select it immediately and offer provider recovery;
		// reopening the workspace retries it through `reviveLeader`.
		leader = { ...candidate, startupError: redactProviderText(providerErrorMessage(error)).slice(0, 8000) };
	}
	await ctx.store.putLeader(leader);
	ctx.hub.broadcast("state", { kind: "leader", record: leader });
	return leader;
}

// A leader outlives the Node, its ACP session does not: after a restart the
// stored `sessionId` names a session no provider has any more, and every
// prompt fails with `no such session`. Opening the workspace brings the
// session back — resumed through the provider when the vendor session allows
// it, else re-created under a fresh id, which is recorded on the leader and
// announced so open clients follow the new conversation.
async function reviveLeader(ctx: NodeContext, leader: Leader, workspace: Workspace, cwd: string): Promise<Leader> {
	let effective = leader;
	if (leader.provider === "pi" && ctx.pi !== undefined) {
		ctx.acp.prepareExternalActor?.(leader.sessionId);
		if (leader.state === "idle") return leader;
		const revived = { ...leader, state: "idle" as const };
		await ctx.store.putLeader(revived);
		ctx.hub.broadcast("state", { kind: "leader", record: revived });
		return revived;
	}
	let sessionCwd = cwd;
	if (leader.mode === "leadPlus") {
		const mission = leader.activeMissionId === undefined ? undefined : ctx.store.getMission(leader.activeMissionId);
		if (mission === undefined || mission.state === "closed") {
			effective = { ...leader, mode: "lead", modeSince: nowIso(), modeActiveMs: 0 };
			await ctx.store.putLeader(effective);
			ctx.hub.broadcast("state", { kind: "leader", record: effective });
		} else {
			sessionCwd = mission.worktree?.path ?? cwd;
			const leases = new LeaseManager(createFileLeaseStore(netaDir()));
			const key = leaseKeyFor({ kind: workspace.kind, worktreePath: mission.worktree?.path, root: cwd });
			if ((await leases.acquire(workspace.id, mission.id, key)) !== "active") {
				await leases.release(workspace.id, mission.id);
				effective = { ...leader, mode: "lead", modeSince: nowIso(), modeActiveMs: 0 };
				await ctx.store.putLeader(effective);
				ctx.hub.broadcast("state", { kind: "leader", record: effective });
			}
		}
	}
	let live: { sessionId: string; provider: string; model: string };
	try {
		live = await ctx.acp.ensureSession({
			sessionId: effective.sessionId,
			workspaceId: effective.workspaceId,
			cwd: sessionCwd,
			provider: effective.provider,
			model: effective.model,
			access: effective.mode === "leadPlus" ? "readWrite" : "readOnly",
			unsandboxed: true,
			netaTools: true,
		});
	} catch (error) {
		// The provider is gone from settings, or will not start: the
		// workspace still opens, and the mute leader says so on the next
		// prompt rather than failing the open.
		if (effective.mode === "leadPlus" && effective.activeMissionId !== undefined) {
			await new LeaseManager(createFileLeaseStore(netaDir())).release(workspace.id, effective.activeMissionId);
			effective = { ...effective, mode: "lead", modeSince: nowIso(), modeActiveMs: 0, state: "failed" };
			await ctx.store.putLeader(effective);
			ctx.hub.broadcast("state", { kind: "leader", record: effective });
		}
		effective = {
			...effective,
			state: "failed",
			startupError: redactProviderText(providerErrorMessage(error)).slice(0, 8000),
		};
		await ctx.store.putLeader(effective);
		ctx.hub.broadcast("state", { kind: "leader", record: effective });
		return effective;
	}
	if (live.sessionId === effective.sessionId && live.model === effective.model && effective.state !== "failed") {
		return effective;
	}
	const updated: Leader = {
		...effective,
		sessionId: live.sessionId,
		provider: live.provider,
		model: live.model,
		state: "idle",
		startupError: undefined,
	};
	await ctx.store.putLeader(updated);
	ctx.hub.broadcast("state", { kind: "leader", record: updated });
	return updated;
}

const opening = new Map<string, Promise<void>>();

async function withWorkspaceLock<T>(id: string, run: () => Promise<T>): Promise<T> {
	const previous = opening.get(id) ?? Promise.resolve();
	let release = (): void => undefined;
	const current = new Promise<void>((done) => {
		release = done;
	});
	const tail = previous.then(() => current);
	opening.set(id, tail);
	await previous;
	try {
		return await run();
	} finally {
		release();
		if (opening.get(id) === tail) {
			opening.delete(id);
		}
	}
}

export async function openWorkspace(
	ctx: NodeContext,
	path: string,
	preferredProvider?: string,
): Promise<{ workspace: Workspace; leader: Leader }> {
	const detected = await detectWorkspace(path);
	const id = workspaceIdFor({ kind: detected.kind, remote: detected.remote, path: detected.root });
	return withWorkspaceLock(id, async () => {
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
			leader = await createLeader(ctx, id, machineId, detected.root, preferredProvider);
		} else {
			if (storedName(leader) === "") {
				// Backfill on read: a record from before the field existed keeps
				// its session, mode and counters and gains a name here, once, so
				// nothing downstream ever sees a leader without one.
				leader = { ...leader, name: leaderName(ctx, id, detected.root) };
				await ctx.store.putLeader(leader);
				ctx.hub.broadcast("state", { kind: "leader", record: leader });
			}
			leader = await reviveLeader(ctx, leader, workspace, detected.root);
		}
		return { workspace, leader };
	});
}

export const workspaceHandlers: NodeHandlers = {
	"workspace.open": (ctx, params) => {
		const parsed = parseParams({ path: asString, provider: asOptionalString }, params);
		return openWorkspace(ctx, parsed.path, parsed.provider);
	},
};
