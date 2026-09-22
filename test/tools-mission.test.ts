import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AcpSession, startSession } from "../src/acp/session.ts";
import type { Settings } from "../src/acp/settings.ts";
import { ulid } from "../src/core/ids.ts";
import { NAME_POOL } from "../src/core/names.ts";
import type { Agent, EventKind, Leader, Mission, Workspace } from "../src/core/types.ts";
import type { NodeStore } from "../src/node/server.ts";
import {
	type MissionPorts,
	type MissionToolContext,
	missionHandlers,
	type SessionLaunch,
} from "../src/tools/handlers/mission.ts";
import type { Actor } from "../src/tools/router.ts";
import { createWorktreeService, LeaseManager, WorktrunkDriver } from "../src/worktrees/index.ts";
import { runGit } from "../src/worktrees/integration.ts";
import { WorktreeSetupError } from "../src/worktrees/setup-diagnostics.ts";
import { fakeWtEnv, makeRepo } from "./helpers/git-repo.ts";

function workspace(id: string, kind: Workspace["kind"]): Workspace {
	return { id, kind, name: id, roots: [{ machineId: "m", path: `/tmp/${id}` }], createdAt: new Date(0).toISOString() };
}

function leader(workspaceId: string, sessionId: string): Leader {
	return {
		workspaceId,
		machineId: "m",
		name: "Halden",
		sessionId,
		provider: "fake",
		model: "test-model",
		mode: "lead",
		modeSince: new Date(0).toISOString(),
		modeActiveMs: 0,
		state: "running",
	};
}

interface Fixture {
	store: NodeStore;
	ports: MissionPorts;
	events: EventKind[];
	launches: SessionLaunch[];
	briefs: string[];
	prepares: string[];
	saved: Mission[];
	leaderActor: Actor;
}

function fixture(kind: Workspace["kind"], opts?: { lease?: "active" | "queued"; skills?: string[] }): Fixture {
	const ws = workspace(kind === "git" ? "git-w" : "folder-w", kind);
	const leaders = new Map<string, Leader>();
	const agents = new Map<string, Agent>();
	const missions = new Map<string, Mission>();
	const events: EventKind[] = [];
	const launches: SessionLaunch[] = [];
	const briefs: string[] = [];
	const prepares: string[] = [];
	const saved: Mission[] = [];
	const leaderId = ulid();
	leaders.set(ws.id, leader(ws.id, leaderId));
	let next = 1;
	const store: NodeStore = {
		machine: () => ({ id: "m", name: "test", createdAt: new Date(0).toISOString() }),
		listWorkspaces: () => [ws],
		listLeaders: () => [...leaders.values()],
		listMissions: () => [...missions.values()],
		listAgents: (missionId) => [...agents.values()].filter((a) => a.missionId === missionId),
		getWorkspace: (id) => (id === ws.id ? ws : undefined),
		getLeader: (id) => leaders.get(id),
		getMission: (id) => missions.get(id),
		getAgent: (id) => agents.get(id),
		putWorkspace: () => Promise.resolve(),
		putAgent: async (agent) => {
			agents.set(agent.id, agent);
		},
		putLeader: async (l) => {
			leaders.set(l.workspaceId, l);
		},
		compact: () => Promise.resolve(),
		appendEvent: async (event) => {
			events.push(event.kind);
			return { seq: events.length, at: new Date(0).toISOString(), ...event };
		},
		listEvents: () => Promise.reject(new Error("unused")),
		tailConversation: () => Promise.reject(new Error("unused")),
	};
	const ports: MissionPorts = {
		numbers: {
			allocateNumber: () => Promise.resolve(next++),
		},
		missions: {
			save: async (mission) => {
				missions.set(mission.id, mission);
				saved.push(mission);
			},
		},
		sessions: {
			launch: async (input) => {
				launches.push(input);
				return { sessionId: ulid() };
			},
			brief: async (input) => {
				briefs.push(input.agentId);
			},
			close: () => Promise.resolve(),
			failed: () => Promise.resolve(),
		},
		worktrees: {
			prepare: async (mission) => {
				prepares.push(mission.id);
				return {
					...mission,
					worktree: {
						provider: "worktrunk",
						path: `/tmp/wt-${mission.number}`,
						branch: `neta/${mission.number}`,
						base: "main",
					},
				};
			},
		},
		skills: {
			check: (input) => {
				const known = new Set(opts?.skills ?? ["git", "notes"]);
				for (const name of input.names) {
					if (!known.has(name)) {
						return { ok: false, missing: name, available: [...known] };
					}
				}
				return { ok: true };
			},
		},
		leases: {
			acquire: () => Promise.resolve(opts?.lease ?? "active"),
			release: () => Promise.resolve(),
		},
	};
	return {
		store,
		ports,
		events,
		launches,
		briefs,
		prepares,
		saved,
		leaderActor: { kind: "leader", workspaceId: ws.id, sessionId: leaderId },
	};
}

function ctx(f: Fixture, actor: Actor): MissionToolContext {
	return { actor, deps: { store: f.store, ...f.ports } };
}

describe("neta_mission", () => {
	test("real Worktrunk runs setup in the new worktree, launches the fake agent there, and blocks launch on setup failure", async () => {
		const repo = await makeRepo();
		const temp = await mkdtemp(join(tmpdir(), "neta-real-worktrunk-"));
		const hook = join(temp, "setup-hook.sh");
		const audit = join(temp, "setup-cwd.txt");
		const sessions: AcpSession[] = [];
		try {
			await mkdir(join(repo.root, ".config"));
			await writeFile(join(repo.root, ".config", "wt.toml"), `[pre-start]\nsetup = "sh ${hook}"\n`);
			await writeFile(hook, `#!/bin/sh\nprintf '%s\\n' "$PWD" > "${audit}"\n`);
			await chmod(hook, 0o755);
			expect((await runGit(["add", ".config/wt.toml"], repo.root)).code).toBe(0);
			expect((await runGit(["commit", "-m", "worktree setup fixture"], repo.root)).code).toBe(0);

			const f = fixture("git");
			const ws = f.store.getWorkspace("git-w");
			if (ws === undefined) throw new Error("missing workspace");
			ws.roots = [{ machineId: "m", path: repo.root }];
			f.ports.worktrees = createWorktreeService({
				driver: new WorktrunkDriver(),
				netaDir: temp,
				now: () => new Date(0).toISOString(),
				leases: new LeaseManager({
					read: async (workspaceId) => ({ workspaceId, leases: {} }),
					write: async () => {},
				}),
				emit: () => {},
				saveMission: f.ports.missions.save,
				onMissionClosed: async () => {},
			});
			const settings: Settings = {
				providers: {
					fake: {
						command: process.execPath,
						args: [new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname],
						resume: true,
						defaultModel: "",
					},
				},
				leader: { provider: "fake" },
				forbiddenModels: [],
			};
			f.ports.sessions.launch = async (input) => {
				const session = await startSession({
					settings,
					provider: "fake",
					access: input.access,
					cwd: input.worktreePath ?? repo.root,
				});
				sessions.push(session);
				f.launches.push(input);
				return { sessionId: session.sessionId };
			};

			const created = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
				name: "setup cwd",
				objective: "verify actual setup cwd",
				access: "readOnly",
				lead: { task: "launch fake ACP" },
			});
			expect(created.ok).toBe(true);
			if (!created.ok) throw new Error("expected mission creation");
			const worktree = created.data.worktree;
			if (typeof worktree !== "string") throw new Error("expected worktree");
			const setupCwd = (await Bun.file(audit).text()).trim();
			expect(await realpath(setupCwd)).toBe(await realpath(worktree));
			expect(f.launches[0]?.worktreePath).toBe(worktree);
			expect(sessions[0]?.cwd).toBe(worktree);

			await writeFile(hook, "#!/bin/sh\necho intentional setup failure >&2\nexit 23\n");
			const failed = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
				name: "setup failure",
				objective: "do not launch fake ACP",
				access: "readOnly",
				lead: { task: "must not start" },
			});
			expect(failed).toMatchObject({ ok: false, code: "setupFailed" });
			expect(f.launches).toHaveLength(1);
			expect(sessions).toHaveLength(1);
		} finally {
			for (const session of sessions) await session.close();
			await rm(temp, { recursive: true, force: true });
			await repo.cleanup();
		}
	});

	test("partial setup, persistence fallback, identity refusal and concurrent legacy recovery never replay hooks", async () => {
		const repo = await makeRepo();
		const temp = await mkdtemp(join(tmpdir(), "neta-handler-recovery-"));
		const previousBin = process.env.NETA_WT_BIN;
		const previousFail = process.env.FAKE_WT_POST_START_FAIL;
		process.env.NETA_WT_BIN = fakeWtEnv().NETA_WT_BIN;
		process.env.FAKE_WT_POST_START_FAIL = "1";
		try {
			const f = fixture("git");
			const ws = f.store.getWorkspace("git-w");
			if (!ws) throw new Error("missing workspace");
			ws.roots = [{ machineId: "m", path: repo.root }];
			const blocked = join(temp, "not-a-directory");
			await writeFile(blocked, "preserve");
			const driver = new WorktrunkDriver();
			f.ports.numbers.isAllocated = async (_id, number) => number === 1;
			f.ports.worktrees = createWorktreeService({
				driver,
				netaDir: blocked,
				now: () => new Date(0).toISOString(),
				leases: new LeaseManager({
					read: async (workspaceId) => ({ workspaceId, leases: {} }),
					write: async () => {},
				}),
				emit: () => {},
				saveMission: f.ports.missions.save,
				onMissionClosed: async () => {},
			});
			const params = {
				name: "lens port",
				objective: "recover setup",
				access: "readOnly",
				lead: { task: "work" },
			} as const;
			const context = ctx(f, f.leaderActor);
			const failed = await missionHandlers.neta_mission(context, params);
			expect(failed.ok).toBe(false);
			if (failed.ok) throw new Error("unexpected success");
			expect(failed.code).toBe("setupFailed");
			const detail = JSON.parse(failed.message);
			expect(detail).toMatchObject({ exitCode: 1, missionRegistered: false, agentsLaunched: false });
			expect(detail.persistenceError).toBeString();
			expect(detail.diagnostic).toBeUndefined();
			expect(detail.stderr).toContain("intentional fixture failure");
			expect(f.launches).toHaveLength(0);
			expect(f.saved).toHaveLength(0);
			const partial = await driver.findExisting({ repoRoot: repo.root, number: 1, slug: "lens-port" });
			if (!partial) throw new Error("missing partial");
			// Use an empty valid diagnostics directory to exercise legacy adoption.
			f.ports.worktrees = createWorktreeService({
				driver,
				netaDir: temp,
				now: () => new Date(0).toISOString(),
				leases: new LeaseManager({
					read: async (workspaceId) => ({ workspaceId, leases: {} }),
					write: async () => {},
				}),
				emit: () => {},
				saveMission: f.ports.missions.save,
				onMissionClosed: async () => {},
			});
			const recoveryContext = ctx(f, f.leaderActor);
			const recovery = {
				number: 1,
				path: partial.path,
				branch: partial.branch,
				base: partial.base,
				setupDisposition: "waived",
			} as const;
			for (const mismatch of [{ path: repo.root }, { branch: "main" }, { base: "other" }, { number: 999 }]) {
				const refused = await missionHandlers.neta_mission(recoveryContext, {
					...params,
					recoverWorktree: { ...recovery, ...mismatch },
				});
				expect(refused.ok).toBe(false);
			}
			expect(f.saved).toHaveLength(0);
			const results = await Promise.all(
				[1, 2].map(() => missionHandlers.neta_mission(recoveryContext, { ...params, recoverWorktree: recovery })),
			);
			expect(results.filter((r) => r.ok)).toHaveLength(1);
			expect(f.launches).toHaveLength(1);
			expect(f.saved[0]?.worktreeRecovery).toEqual({ setupDisposition: "waived", at: new Date(0).toISOString() });
			expect(f.saved[0]?.worktree?.path).toBe(partial.path);
			expect((await driver.list(repo.root)).filter((entry) => entry.branch === partial.branch)).toHaveLength(1);
		} finally {
			if (previousBin === undefined) delete process.env.NETA_WT_BIN;
			else process.env.NETA_WT_BIN = previousBin;
			if (previousFail === undefined) delete process.env.FAKE_WT_POST_START_FAIL;
			else process.env.FAKE_WT_POST_START_FAIL = previousFail;
			await rm(temp, { recursive: true, force: true });
			await repo.cleanup();
		}
	});
	test("a git workspace creates a worktree and a folder one does not", async () => {
		const git = fixture("git");
		const gitResult = await missionHandlers.neta_mission(ctx(git, git.leaderActor), {
			name: "lens port",
			objective: "port the lens",
			access: "readOnly",
			lead: "self",
		});
		expect(gitResult.ok).toBe(true);
		expect(git.prepares).toHaveLength(1);
		if (gitResult.ok) {
			expect(gitResult.data.worktree).toBe("/tmp/wt-1");
			expect(gitResult.data.number).toBe(1);
		}

		const folder = fixture("folder");
		const folderResult = await missionHandlers.neta_mission(ctx(folder, folder.leaderActor), {
			name: "docs pass",
			objective: "pass over docs",
			access: "readOnly",
			lead: "self",
		});
		expect(folderResult.ok).toBe(true);
		expect(folder.prepares).toHaveLength(0);
		if (folderResult.ok) {
			expect(folderResult.data.worktree).toBeNull();
		}
	});

	test("a worktree setup failure is structured and starts no agents", async () => {
		const f = fixture("git");
		f.ports.worktrees.prepare = async () => {
			throw new WorktreeSetupError({
				workspaceId: "git-w",
				number: 1,
				name: "broken setup",
				objective: "prove no provider starts",
				access: "readOnly",
				repoRoot: "/repo",
				branch: "mission/1-broken-setup",
				base: "main",
				at: new Date(0).toISOString(),
				exitCode: 1,
				stdout: "hook output",
				stderr: "hook failed",
				partialWorktree: {
					provider: "worktrunk",
					path: "/repo.partial",
					branch: "mission/1-broken-setup",
					base: "main",
				},
			});
		};
		const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "broken setup",
			objective: "prove no provider starts",
			access: "readOnly",
			lead: { task: "do not start" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("setupFailed");
			expect(JSON.parse(result.message)).toMatchObject({ kind: "worktreeSetup", partialWorktree: "/repo.partial" });
		}
		expect(f.launches).toHaveLength(0);
		expect(f.saved).toHaveLength(0);
	});

	test("recovery rejects folders and passes explicit disposition without re-running setup", async () => {
		const folder = fixture("folder");
		const rejected = await missionHandlers.neta_mission(ctx(folder, folder.leaderActor), {
			name: "legacy",
			objective: "o",
			access: "readOnly",
			lead: "self",
			recoverWorktree: {
				number: 4,
				path: "/x",
				branch: "mission/4-legacy",
				base: "main",
				setupDisposition: "waived",
			},
		});
		expect(rejected).toMatchObject({ ok: false, code: "refused" });
		const git = fixture("git");
		git.ports.numbers.isAllocated = async () => true;
		let recovery: unknown;
		git.ports.worktrees.prepare = async (mission, _workspace, opts) => {
			recovery = opts?.recovery;
			return {
				...mission,
				worktree: { provider: "worktrunk", path: "/x", branch: "mission/4-legacy", base: "main" },
			};
		};
		const recovered = await missionHandlers.neta_mission(ctx(git, git.leaderActor), {
			name: "legacy",
			objective: "o",
			access: "readOnly",
			lead: "self",
			recoverWorktree: {
				number: 4,
				path: "/x",
				branch: "mission/4-legacy",
				base: "main",
				setupDisposition: "waived",
			},
		});
		expect(recovered.ok).toBe(true);
		expect(recovery).toMatchObject({ setupDisposition: "waived", path: "/x" });
	});

	test("numbers are monotonic and never reused", async () => {
		const f = fixture("folder");
		for (const name of ["one", "two"]) {
			const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
				name,
				objective: "o",
				access: "readOnly",
				lead: "self",
			});
			expect(result.ok).toBe(true);
		}
		expect(f.saved.map((m) => m.number)).toEqual([1, 1, 2, 2]);
	});

	test("mission.created precedes every agent.spawned", async () => {
		const f = fixture("folder");
		const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "team work",
			objective: "o",
			access: "readWrite",
			lead: { task: "run it" },
			agents: [
				{ task: "first", access: "readWrite" },
				{ task: "second", access: "readOnly" },
			],
		});
		expect(result.ok).toBe(true);
		expect(f.launches).toHaveLength(3);
		expect(f.launches[0]?.canSpawn).toBe(true);
		expect(f.events).toEqual(["mission.created", "agent.spawned", "agent.spawned", "agent.spawned"]);
		const mission = f.saved[0];
		expect(mission?.agentIds).toHaveLength(3);
		expect(mission?.lead).toEqual({ kind: "agent", agentId: mission?.agentIds[0] });
	});

	test("lead self sets the leader's active mission and launches nothing", async () => {
		const f = fixture("folder");
		const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "solo",
			objective: "o",
			access: "readOnly",
			lead: "self",
		});
		expect(result.ok).toBe(true);
		expect(f.launches).toHaveLength(0);
		const id = result.ok ? (result.data.id as string) : "";
		expect(f.store.getLeader("folder-w")?.activeMissionId).toBe(id);
		expect(f.saved[0]?.lead).toEqual({ kind: "leader" });
	});

	test("Pi lead self launches one distinct mission lead session", async () => {
		const f = fixture("folder");
		const leader = f.store.getLeader("folder-w");
		if (leader === undefined) throw new Error("missing leader fixture");
		await f.store.putLeader({ ...leader, provider: "pi" });
		f.ports.sessions.pi = true;
		const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "pi solo",
			objective: "run the mission objective",
			access: "readOnly",
			lead: "self",
		});
		expect(result.ok).toBe(true);
		expect(f.launches).toHaveLength(1);
		expect(f.launches[0]).toMatchObject({ provider: "pi", canSpawn: true, task: "run the mission objective" });
		expect(f.launches[0]?.sessionId).not.toBe(leader.sessionId);
		const mission = f.saved.at(-1);
		const leadId = mission?.agentIds[0];
		if (leadId === undefined) throw new Error("missing Pi mission lead");
		expect(mission?.lead).toEqual({ kind: "agent", agentId: leadId });
	});

	test("a readWrite agent in a readOnly mission is refused", async () => {
		const f = fixture("folder");
		const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "bad mix",
			objective: "o",
			access: "readOnly",
			lead: "self",
			agents: [{ task: "sneaky", access: "readWrite" }],
		});
		expect(result).toEqual({ ok: false, code: "refused", message: "a readWrite agent in a readOnly mission" });
		expect(f.launches).toHaveLength(0);
		expect(f.saved).toHaveLength(0);
	});

	test("a missing skill refuses and spawns nothing", async () => {
		const f = fixture("folder");
		const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "skilled",
			objective: "o",
			access: "readOnly",
			lead: { task: "lead it", skills: ["nope"] },
			agents: [{ task: "work", access: "readOnly" }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("missingSkill");
		}
		expect(f.launches).toHaveLength(0);
		expect(f.saved).toHaveLength(0);
	});

	test("an unknown continues mission is notFound", async () => {
		const f = fixture("folder");
		const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: " sequel",
			objective: "o",
			access: "readOnly",
			lead: "self",
			continues: ulid(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("notFound");
		}
		expect(f.saved).toHaveLength(0);
	});

	test("a self-led mission does not take writer access before Lead++", async () => {
		const f = fixture("folder", { lease: "queued" });
		const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "queued work",
			objective: "o",
			access: "readWrite",
			lead: "self",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.queued).toBeUndefined();
			expect(result.data.worktree).toBeNull();
		}
		expect(f.saved).toHaveLength(2);
		expect(f.events).toEqual(["mission.created"]);
	});

	test("a delegated lead begins readOnly and does not consume the writer lease", async () => {
		const f = fixture("git", { lease: "queued" });
		const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "serialized writer",
			objective: "wait for the worktree",
			access: "readWrite",
			lead: { task: "write only after admission" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.queued).toBeUndefined();
		expect(f.launches).toHaveLength(1);
		expect(f.launches[0]?.access).toBe("readOnly");
		expect(f.briefs).toHaveLength(1);
	});
});

describe("neta_agent", () => {
	async function withMission(f: Fixture): Promise<string> {
		const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "host mission",
			objective: "o",
			access: "readWrite",
			lead: { task: "run it" },
		});
		if (!result.ok) {
			throw new Error("setup failed");
		}
		return result.data.id as string;
	}

	test("agents never take the workspace leader's own name", async () => {
		const f = fixture("folder");
		const current = f.store.getLeader("folder-w");
		if (current === undefined) {
			throw new Error("no leader");
		}
		// The fixture leader is named off-pool; give it a pool name, since
		// the question is what happens when it competes for one.
		const leaderName = NAME_POOL[0];
		await f.store.putLeader({ ...current, name: leaderName });
		const missionId = await withMission(f);
		// One agent for every other name in the pool. With the leader's name
		// spoken for exactly 199 are free, so the names drawn must be the
		// pool minus it; were the leader not counted, its name would appear
		// here and one other name would be missing.
		for (let i = 0; i < NAME_POOL.length - 2; i++) {
			const result = await missionHandlers.neta_agent(ctx(f, f.leaderActor), {
				task: `job ${i}`,
				access: "readWrite",
				missionId,
			});
			if (!result.ok) {
				throw new Error(`spawn ${i} refused: ${result.message}`);
			}
		}
		const names = f.store.listAgents(missionId).map((agent) => agent.name);
		expect(names).toHaveLength(NAME_POOL.length - 1);
		expect(new Set(names)).toEqual(new Set(NAME_POOL.filter((name) => name !== leaderName)));
	});

	test("a lead adding to its own mission may omit missionId", async () => {
		const f = fixture("folder");
		const missionId = await withMission(f);
		const leadId = f.saved[0]?.agentIds[0] ?? "";
		const lead = f.store.getAgent(leadId);
		if (lead === undefined) {
			throw new Error("no lead");
		}
		const result = await missionHandlers.neta_agent(
			ctx(f, { kind: "lead", workspaceId: "folder-w", missionId, agentId: lead.id, sessionId: lead.sessionId }),
			{ task: "extra", access: "readOnly" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.missionId).toBe(f.store.getMission(missionId)?.number);
			expect(typeof result.data.agentId).toBe("string");
			expect(typeof result.data.name).toBe("string");
		}
		expect(f.events.at(-1)).toBe("agent.spawned");
	});

	test("a lead naming another mission is refused", async () => {
		const f = fixture("folder");
		const missionId = await withMission(f);
		const other = await withMission(f);
		const leadId = f.saved[0]?.agentIds[0] ?? "";
		const lead = f.store.getAgent(leadId);
		if (lead === undefined) {
			throw new Error("no lead");
		}
		const result = await missionHandlers.neta_agent(
			ctx(f, { kind: "lead", workspaceId: "folder-w", missionId, agentId: lead.id, sessionId: lead.sessionId }),
			{ task: "roaming", access: "readOnly", missionId: other },
		);
		expect(result).toEqual({ ok: false, code: "refused", message: "a lead adds agents to its own mission only" });
	});

	test("a readWrite agent in a readOnly mission is refused", async () => {
		const f = fixture("folder");
		const created = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "read only",
			objective: "o",
			access: "readOnly",
			lead: "self",
		});
		if (!created.ok) {
			throw new Error("setup failed");
		}
		const missionId = created.data.id as string;
		const result = await missionHandlers.neta_agent(ctx(f, f.leaderActor), {
			task: "sneaky",
			access: "readWrite",
			missionId,
		});
		expect(result).toEqual({ ok: false, code: "refused", message: "a readWrite agent in a readOnly mission" });
	});

	test("a missing skill spawns nothing", async () => {
		const f = fixture("folder");
		const missionId = await withMission(f);
		const before = f.launches.length;
		const result = await missionHandlers.neta_agent(ctx(f, f.leaderActor), {
			task: "skilled",
			access: "readOnly",
			missionId,
			skills: ["nope"],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("missingSkill");
		}
		expect(f.launches).toHaveLength(before);
	});

	test("an unknown mission is notFound", async () => {
		const f = fixture("folder");
		const result = await missionHandlers.neta_agent(ctx(f, f.leaderActor), {
			task: "lost",
			access: "readOnly",
			missionId: ulid(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("notFound");
		}
	});
});

test("worker model selection is persisted before launch and before writer queue admission", async () => {
	for (const lease of ["active", "queued"] as const) {
		const f = fixture("folder", { lease });
		f.ports.sessions.selectModel = async () => ({ provider: "opencode", model: "openai/connected" });
		const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "connected workers",
			objective: "inspect",
			access: "readWrite",
			lead: "self",
			agents: [{ task: "inspect", access: "readWrite", provider: "codex", model: "obsolete" }],
		});
		expect(result.ok).toBe(true);
		const mission = f.store.listMissions(f.leaderActor.workspaceId)[0];
		if (!mission) throw new Error("missing mission");
		const agent = f.store.listAgents(mission.id)[0];
		expect(agent?.provider).toBe("opencode");
		expect(agent?.model).toBe("openai/connected");
		if (lease === "active") expect(f.launches[0]?.model).toBe("openai/connected");
		else expect(f.launches).toHaveLength(0);
	}
});

test("unavailable staffing model leaves no mission or agent behind", async () => {
	const f = fixture("folder");
	f.ports.sessions.selectModel = async () => {
		throw new Error("requested model unavailable");
	};
	await expect(
		missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "light worker",
			objective: "inspect branch",
			access: "readOnly",
			lead: "self",
			agents: [{ task: "inspect", access: "readOnly", model: "missing-small" }],
		}),
	).rejects.toThrow("requested model unavailable");
	expect(f.store.listMissions(f.leaderActor.workspaceId)).toHaveLength(0);
	expect(f.launches).toHaveLength(0);
});

test("staffing preserves ordered permitted fallback models and rejects unavailable alternatives before reservation", async () => {
	const f = fixture("folder");
	f.ports.sessions.selectModel = async ({ provider, model }) => {
		if (model === "unavailable") throw new Error("alternative unavailable");
		return { provider, model };
	};
	await expect(
		missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "invalid plan",
			objective: "inspect",
			access: "readOnly",
			lead: "self",
			agents: [{ task: "inspect", access: "readOnly", model: "small", fallbackModels: ["unavailable"] }],
		}),
	).rejects.toThrow("alternative unavailable");
	expect(f.store.listMissions(f.leaderActor.workspaceId)).toHaveLength(0);
	const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
		name: "small models",
		objective: "inspect",
		access: "readOnly",
		lead: { task: "lead", model: "small", fallbackModels: ["second", "third"] },
		agents: [{ task: "inspect", access: "readOnly", model: "small" }],
	});
	expect(result.ok).toBe(true);
	expect(f.launches[0]?.fallbackModels).toEqual(["second", "third"]);
	expect(f.launches[1]?.fallbackModels).toEqual([]);
	const mission = f.store.listMissions(f.leaderActor.workspaceId)[0];
	if (mission === undefined) throw new Error("missing mission");
	expect(f.store.listAgents(mission.id)[0]).toMatchObject({
		requestedModel: "small",
		fallbackModels: ["second", "third"],
	});
});

test("effort routing happens once per child before mission side effects and persists through writer queues", async () => {
	for (const lease of ["active", "queued"] as const) {
		const f = fixture("git", { lease });
		const calls: { task: string; effort?: number }[] = [];
		f.ports.sessions.routeModel = async (input) => {
			expect(f.prepares).toHaveLength(0);
			expect(f.saved).toHaveLength(0);
			expect(f.launches).toHaveLength(0);
			calls.push(input);
			return {
				provider: "opencode",
				model: "openai/luna",
				routing: {
					effort: 1,
					method: "fixed",
					selectedModel: "openai/luna",
					candidates: ["openai/luna"],
					reason: "Configured effort 1",
					warnings: [],
				},
			};
		};
		f.ports.sessions.selectModel = async ({ provider, model }) => ({ provider, model });
		const response = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "response check",
			objective: "Confirm startup",
			access: "readWrite",
			lead: { task: "confirm", effort: 1 },
			agents: [{ task: "check", effort: 1, access: "readWrite" }],
		});
		expect(response.ok).toBe(true);
		expect(calls).toHaveLength(2);
		expect(calls.map((c) => c.effort)).toEqual([1, 1]);
		const agents = f.store.listAgents(f.saved[0].id);
		expect(agents).toHaveLength(2);
		for (const agent of agents) {
			expect(agent.model).toBe("openai/luna");
			expect(agent.routing?.effort).toBe(1);
		}
		expect(agents.find((a) => !a.canSpawn)?.state).toBe(lease === "queued" ? "queued" : "starting");
		if (response.ok)
			expect(response.data.agents).toEqual(
				agents.map((a) => ({ id: a.id, name: a.name, model: a.model, routing: a.routing })),
			);
	}
});

test("a routing failure leaves no mission, worktree, agents or launches behind", async () => {
	const f = fixture("git");
	let calls = 0;
	f.ports.sessions.routeModel = async () => {
		calls++;
		throw new Error("Jev abstained");
	};
	await expect(
		missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "response check",
			objective: "Confirm startup",
			access: "readOnly",
			lead: { task: "confirm", effort: 1 },
		}),
	).rejects.toThrow("Jev abstained");
	expect(calls).toBe(1);
	expect(f.saved).toHaveLength(0);
	expect(f.prepares).toHaveLength(0);
	expect(f.launches).toHaveLength(0);
});

test("adding an agent passes mission context and effort to routing exactly once", async () => {
	const f = fixture("folder");
	await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
		name: "check",
		objective: "Read repository status",
		access: "readOnly",
		lead: "self",
	});
	let calls = 0;
	f.ports.sessions.routeModel = async (input) => {
		calls++;
		expect(input).toMatchObject({ task: "inspect branch", objective: "Read repository status", effort: 2 });
		return { provider: "opencode", model: "openai/luna" };
	};
	const response = await missionHandlers.neta_agent(ctx(f, f.leaderActor), {
		task: "inspect branch",
		access: "readOnly",
		effort: 2,
	});
	expect(response.ok).toBe(true);
	expect(calls).toBe(1);
	expect(f.launches[0].model).toBe("openai/luna");
});
