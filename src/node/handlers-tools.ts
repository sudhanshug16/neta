// `tools.list` and `tools.call` on the socket: the Node half of 05. The stdio
// proxy one ACP session holds forwards every MCP call here with the actor id
// and the token this Node minted when it launched that session, so the tools
// are reachable from a leader, a lead and an agent and from nowhere else.
//
// This module is the only place the tool handlers' ports meet the real
// modules: 02's registry for numbers and mission records, 03 (through the
// adapted ACP port) for sessions, 05's context builders for what a new agent
// is told, and 06's worktree service and leases. Everything stateful still
// comes in through `lifecycle.ts`.
import { homedir } from "node:os";
import type { Settings } from "../acp/settings.ts";
import { nowIso } from "../core/time.ts";
import type {
	Agent,
	AgentId,
	DecisionRecord,
	Leader,
	LeaderMode,
	Mission,
	MissionId,
	Workspace,
	WorkspaceId,
} from "../core/types.ts";
import { evaluateRequest, parseReservations } from "../modes/approval.ts";
import { modeEventData } from "../modes/records.ts";
import type { Store } from "../store/index.ts";
import { composeContext, loadCharter, loadSkills } from "../tools/context.ts";
import type { CloseMissionInput, CloseOutcome, ModeApproval, ModeSubject } from "../tools/handlers/lifecycle.ts";
import type { MissionPorts, SessionLaunch } from "../tools/handlers/mission.ts";
import { toolHandlers } from "../tools/launch.ts";
import { createRouter, type ToolDeps } from "../tools/router.ts";
import { createFileLeaseStore, createWorktreeService, LeaseManager, WorktrunkDriver } from "../worktrees/index.ts";
import { asString, parseParams } from "./handlers-registry.ts";
import type { AdaptedAcp, AdaptedStore } from "./lifecycle.ts";
import { netaDir } from "./lockfile.ts";
import { NodeError } from "./protocol.ts";
import type { Hub, NodeContext, NodeHandlers, NodeStore } from "./server.ts";

// How often a `neta_wait` sweeps the agent records. The Node has no agent
// state bus: every writer goes through `putAgent`, and the tool's contract is
// "return when one is terminal or blocked", so a short sweep is enough.
const WAIT_POLL_MS = 250;

export interface ToolMountOptions {
	real: Store;
	store: AdaptedStore;
	acp: AdaptedAcp;
	settings: Settings;
	hub(): Hub;
}

// The workspace copy on this machine: the root recorded for our machine, else
// the first one on record.
function rootOf(store: NodeStore, workspace: Workspace): string {
	const machineId = store.machine().id;
	const mine = workspace.roots.find((root) => root.machineId === machineId);
	return mine?.path ?? workspace.roots[0]?.path ?? process.cwd();
}

function isSettled(agent: Agent): boolean {
	return (
		agent.state === "blocked" ||
		agent.state === "failed" ||
		agent.state === "completed" ||
		agent.state === "interrupted"
	);
}

// What `neta_mode` needs to decide and to record a Lead++ grant. Narrow on
// purpose: the gate is 07's rule, and it is the one thing in this file worth
// testing without a Node.
export interface ModeGrantPorts {
	getMission(id: MissionId): Mission | undefined;
	getLeader(id: WorkspaceId): Leader | undefined;
	putLeader(leader: Leader): Promise<void>;
	appendEvent(event: {
		workspaceId: WorkspaceId;
		kind: "leader.modeChanged";
		data: Record<string, string | number | boolean | null>;
	}): Promise<unknown>;
	announce(leader: Leader): void;
	// The workspace's `CHARTER.md` text, empty when it has none. 07 parses
	// only its `## Reserved for the user` section.
	charter(workspaceId: WorkspaceId): string;
	now(): string;
}

// 07's grant rule as far as this Node can honour it: the charter's
// reservations are real, and only the subject that asked is moved. A mission
// lead's mode is a `LeadMode` record keyed by its `agentId` (07, T7.1) that
// nothing here can write, so a lead's request is refused rather than applied
// to the workspace leader — granting it there would escalate a different
// actor, whose next session would come up `readWrite`.
//
// Both directions are real writes. A return to Lead needs no record and no
// charter check (it takes access away), but it must land: it is the leader's
// only route out of Lead++, and Lead++ outlives a restart, so answering
// `approved: true` without writing would leave the workspace in build access
// until a person flipped it in the UI.
export async function grantMode(
	ports: ModeGrantPorts,
	input: { subject: ModeSubject; mode: LeaderMode; record?: DecisionRecord },
): Promise<ModeApproval> {
	const subject = input.subject;
	if (subject.kind !== "leader") {
		return {
			approved: false,
			reason: "unavailable",
			detail: "a mission lead's mode needs 07's mode service, which this node does not run yet",
		};
	}
	const leader = ports.getLeader(subject.workspaceId);
	if (leader === undefined) {
		return { approved: false, reason: "notAuthorised", detail: `no leader for workspace ${subject.workspaceId}` };
	}
	const record = input.record;
	if (input.mode === "leadPlus") {
		if (record === undefined) {
			return { approved: false, reason: "incompleteRecord", detail: "record is missing" };
		}
		const approval = evaluateRequest({
			record,
			mission: ports.getMission(record.missionId),
			caller: subject,
			reservations: parseReservations(ports.charter(subject.workspaceId)),
		});
		if (!approval.approved) {
			return approval;
		}
	}
	if (leader.mode === input.mode) {
		// Already there: 07 emits one event per change, so asking twice is
		// not a second change and does not restart the Lead++ clock.
		return { approved: true };
	}
	const updated: Leader = { ...leader, mode: input.mode, modeSince: ports.now() };
	await ports.putLeader(updated);
	await ports.appendEvent({
		workspaceId: leader.workspaceId,
		kind: "leader.modeChanged",
		data: modeEventData({
			from: leader.mode,
			to: input.mode,
			cause: "tool",
			...(record === undefined ? {} : { missionId: record.missionId, record }),
		}),
	});
	ports.announce(updated);
	return { approved: true };
}

export function toolMount(o: ToolMountOptions): {
	handlers: NodeHandlers;
} {
	const leases = new LeaseManager(createFileLeaseStore(netaDir()));

	// `announce` is what tells clients; it is off for 06's own saves, which
	// are mid-operation checkpoints the tool handler always follows with a
	// complete record (`prepare` then `neta_mission`'s save, `close` then
	// `neta_close`'s). A mission created with a worktree would otherwise
	// reach the spine twice: once half-built by `prepare`, once whole. The
	// one 06 call with no announcing follow-up is `refreshIntegration`, which
	// nothing calls yet; whoever wires it announces its own save.
	async function saveMission(mission: Mission, announce = true): Promise<void> {
		const existing = await o.real.missions.get(mission.workspaceId, mission.id);
		if (existing === undefined) {
			await o.real.missions.create(mission);
		} else {
			await o.real.missions.update(mission);
		}
		// The Node serves missions from a memory mirror; without this the
		// mission it just wrote is invisible to the next call.
		await o.store.refreshMissions(mission.workspaceId);
		if (announce) {
			o.hub().broadcast("state", { kind: "mission", record: mission });
		}
	}

	const worktrees = createWorktreeService({
		driver: new WorktrunkDriver(),
		leases,
		netaDir: netaDir(),
		now: nowIso,
		emit: (kind, missionId, data) => {
			const mission = o.store.getMission(missionId);
			if (mission === undefined) {
				return;
			}
			void o.store.appendEvent({ workspaceId: mission.workspaceId, kind, missionId, data });
		},
		saveMission: (mission) => saveMission(mission, false),
		onMissionClosed: async (mission) => {
			const leader = o.store.getLeader(mission.workspaceId);
			if (leader?.activeMissionId === mission.id) {
				await o.store.putLeader({ ...leader, activeMissionId: undefined });
				o.hub().broadcast("state", { kind: "leader", record: { ...leader, activeMissionId: undefined } });
			}
		},
	});

	// A new agent's first prompt is its context: the working agreement for its
	// kind, the charter (lead and leader only), its skills and its task. The
	// mission brief is not in it — the mission record is not saved until every
	// session in it has launched — so the task carries the objective.
	function contextFor(input: { canSpawn: boolean; task: string; skills: string[]; root: string }): string {
		const kind = input.canSpawn ? ("lead" as const) : ("agent" as const);
		const charter = loadCharter(input.root, homedir());
		const skills = loadSkills(input.skills, input.root, homedir());
		if (!skills.ok) {
			// 05 T5.8: a missing skill is `missingSkill` and no spawn.
			// `neta_mission` checked these names against this same root before
			// anything launched, so getting here means the file went away in
			// between. This runs before the session is created, so the throw
			// costs nothing that has to be unwound.
			throw new NodeError("NOT_FOUND", `unknown skill: ${skills.missing}`);
		}
		return composeContext({
			kind,
			...(charter === undefined ? {} : { charter }),
			skills: skills.skills,
			task: input.task,
		});
	}

	// The context each launched session is waiting to be briefed with,
	// composed by `launch` before that session existed and consumed by the
	// `brief` that follows it.
	const briefs = new Map<AgentId, string>();

	const missions: MissionPorts["missions"] = { save: (mission) => saveMission(mission) };

	// The workspace root a subject works in, for the charter and for a
	// session's cwd.
	function rootFor(workspaceId: string): string {
		const workspace = o.store.getWorkspace(workspaceId);
		return workspace === undefined ? process.cwd() : rootOf(o.store, workspace);
	}

	const deps: ToolDeps &
		MissionPorts & {
			sessions: {
				cancel(sessionId: string): Promise<void>;
				prompt(sessionId: string, text: string): Promise<void>;
				wait(input: {
					missionId: MissionId;
					agentIds?: AgentId[];
					timeoutMs: number;
				}): Promise<{ changed: Agent[]; timedOut: boolean }>;
			};
			worktrees: { close(input: CloseMissionInput): Promise<CloseOutcome> };
			modes: {
				requestMode(input: {
					subject: ModeSubject;
					mode: LeaderMode;
					record?: DecisionRecord;
				}): Promise<ModeApproval>;
			};
		} = {
		store: o.store,
		numbers: { allocateNumber: (workspaceId) => o.real.missions.allocateNumber(workspaceId) },
		missions,
		// Against the workspace root, never `process.cwd()`: the Node is
		// detached from wherever it was started, and a skill lives in
		// `<root>/.neta/skills`. `contextFor` resolves the same way, so what
		// `neta_mission` accepts is what the agent is briefed with.
		skills: { check: (input) => loadSkills(input.names, rootFor(input.workspaceId), homedir()) },
		// 06 owns the key: the worktree path for a Git mission, the workspace
		// root otherwise. Going through `acquireWriter` keeps that one rule in
		// one place instead of re-deriving it here.
		leases: {
			acquire: (input) => worktrees.acquireWriter(input.mission, input.workspace, input.holder),
		},
		worktrees: {
			prepare: (mission, workspace) => worktrees.prepare(mission, workspace),
			close: (input) => worktrees.close(input),
		},
		sessions: {
			// The session only: 05 writes the Agent record next, and `brief`
			// sends the context prompt after it. The token is minted under
			// the agent id, which is the actor id the router resolves.
			//
			// The context is composed here, before anything launches, and
			// held for `brief`: it is what resolves the skill files, and 05
			// T5.8 is "a `missingSkill` error and the agent is not spawned".
			// Resolving it in `brief` instead left a file that vanished
			// between `neta_mission`'s check and the brief throwing after the
			// session was live and the Agent record was on file — a live
			// orphan session and a half-built mission.
			launch: async (input: SessionLaunch) => {
				const context = contextFor({
					canSpawn: input.canSpawn,
					task: input.task,
					skills: input.skills,
					root: rootFor(input.workspaceId),
				});
				const created = await o.acp.createSession({
					workspaceId: input.workspaceId,
					cwd: input.worktreePath ?? rootFor(input.workspaceId),
					provider: input.provider,
					model: input.model,
					access: input.access,
					netaTools: true,
					actorId: input.agentId,
				});
				briefs.set(input.agentId, context);
				return { sessionId: created.sessionId };
			},
			brief: async (input) => {
				const context = briefs.get(input.agentId);
				briefs.delete(input.agentId);
				await o.acp.prompt(
					input.sessionId,
					context ??
						contextFor({
							canSpawn: input.canSpawn,
							task: input.task,
							skills: input.skills,
							root: rootFor(input.workspaceId),
						}),
				);
			},
			cancel: (sessionId) => o.acp.cancel(sessionId),
			prompt: async (sessionId, text) => {
				await o.acp.prompt(sessionId, text);
			},
			wait: async (input) => {
				const deadline = Date.now() + input.timeoutMs;
				for (;;) {
					const agents = o.store
						.listAgents(input.missionId)
						.filter((agent) => input.agentIds === undefined || input.agentIds.includes(agent.id));
					const settled = agents.filter(isSettled);
					if (settled.length > 0) {
						return { changed: settled, timedOut: false };
					}
					if (Date.now() >= deadline) {
						return { changed: agents, timedOut: true };
					}
					await new Promise((done) => setTimeout(done, WAIT_POLL_MS));
				}
			},
		},
		modes: {
			// 07's `ModeService` owns the clock and the reminders; what is
			// wired here is its gate and its record. A switch in either
			// direction moves the leader and announces it, the way
			// `leader.setMode` does; the session keeps the access it is
			// running at until `workspace.open` relaunches it at the recorded
			// mode (`ensureSession`).
			requestMode: (input) =>
				grantMode(
					{
						getMission: (id) => o.store.getMission(id),
						getLeader: (id) => o.store.getLeader(id),
						putLeader: (leader) => o.store.putLeader(leader),
						appendEvent: (event) => o.store.appendEvent(event),
						announce: (leader) => o.hub().broadcast("state", { kind: "leader", record: leader }),
						charter: (workspaceId) => loadCharter(rootFor(workspaceId), homedir())?.text ?? "",
						now: nowIso,
					},
					input,
				),
		},
	};

	const router = createRouter(deps, toolHandlers(), o.acp.tokens);

	const handlers: NodeHandlers = {
		"tools.list": (_ctx: NodeContext, params: unknown) => {
			const parsed = parseParams({ actorId: asString, token: asString }, params);
			const listed = router.list(parsed.actorId, parsed.token);
			if (!Array.isArray(listed)) {
				throw new NodeError("UNAUTHORIZED", listed.ok ? "unexpected tool list" : listed.message);
			}
			return Promise.resolve({
				tools: listed.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
				})),
			});
		},

		"tools.call": async (_ctx: NodeContext, params: unknown) => {
			// `arguments` is whatever the named tool's schema says, so it is
			// passed through: the router validates it against that schema.
			const parsed = parseParams({ actorId: asString, token: asString, name: asString }, params);
			const args = (params as { arguments?: unknown }).arguments ?? {};
			return router.call(parsed.actorId, parsed.token, parsed.name, args);
		},
	};
	return { handlers };
}
