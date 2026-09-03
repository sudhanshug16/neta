import { describe, expect, test } from "bun:test";
import { ulid } from "../src/core/ids.ts";
import type { Agent, EventKind, Leader, Mission, Workspace } from "../src/core/types.ts";
import type { NodeStore } from "../src/node/server.ts";
import {
	type MissionPorts,
	type MissionToolContext,
	missionHandlers,
	type SessionLaunch,
} from "../src/tools/handlers/mission.ts";
import type { Actor } from "../src/tools/router.ts";

function workspace(id: string, kind: Workspace["kind"]): Workspace {
	return { id, kind, name: id, roots: [{ machineId: "m", path: `/tmp/${id}` }], createdAt: new Date(0).toISOString() };
}

function leader(workspaceId: string, sessionId: string): Leader {
	return {
		workspaceId,
		machineId: "m",
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
			check: (names) => {
				const known = new Set(opts?.skills ?? ["git", "notes"]);
				for (const name of names) {
					if (!known.has(name)) {
						return { ok: false, missing: name, available: [...known] };
					}
				}
				return { ok: true };
			},
		},
		leases: {
			acquire: () => Promise.resolve(opts?.lease ?? "active"),
		},
	};
	return {
		store,
		ports,
		events,
		launches,
		prepares,
		saved,
		leaderActor: { kind: "leader", workspaceId: ws.id, sessionId: leaderId },
	};
}

function ctx(f: Fixture, actor: Actor): MissionToolContext {
	return { actor, deps: { store: f.store, ...f.ports } };
}

describe("neta_mission", () => {
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
		expect(f.saved.map((m) => m.number)).toEqual([1, 2]);
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

	test("a readWrite folder mission that cannot take the lease is created and queued", async () => {
		const f = fixture("folder", { lease: "queued" });
		const result = await missionHandlers.neta_mission(ctx(f, f.leaderActor), {
			name: "queued work",
			objective: "o",
			access: "readWrite",
			lead: "self",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.queued).toBe(true);
			expect(result.data.worktree).toBeNull();
		}
		expect(f.saved).toHaveLength(1);
		expect(f.events).toEqual(["mission.created"]);
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
			expect(result.data.missionId).toBe(missionId);
			expect(typeof result.data.agentId).toBe("string");
			expect(typeof result.data.name).toBe("string");
		}
		expect(f.events.at(-1)).toBe("agent.spawned");
	});

	test("a lead naming another mission is refused", async () => {
		const f = fixture("folder");
		const missionId = await withMission(f);
		const other = ulid();
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
