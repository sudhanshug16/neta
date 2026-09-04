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
	Event,
	IsoTime,
	Leader,
	LeaderMode,
	Mission,
	MissionId,
	Workspace,
	WorkspaceId,
} from "../core/types.ts";
import {
	ActiveClock,
	type LeadMode,
	type LeadModeStore,
	ModeService,
	type ModeSubject as ModeServiceSubject,
	ReminderTracker,
	subjectKey,
} from "../modes/index.ts";
import type { Store } from "../store/index.ts";
import { composeContext, loadCharter, loadSkills } from "../tools/context.ts";
import type { CloseMissionInput, CloseOutcome, ModeApproval, ModeSubject } from "../tools/handlers/lifecycle.ts";
import type { MissionPorts, SessionLaunch } from "../tools/handlers/mission.ts";
import { toolHandlers } from "../tools/launch.ts";
import { type Actor, createRouter, type ToolDeps } from "../tools/router.ts";
import { createFileLeaseStore, createWorktreeService, LeaseManager, WorktrunkDriver } from "../worktrees/index.ts";
import { asOptionalString, asString, parseParams } from "./handlers-registry.ts";
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

// How often the Node drives 07's clock and reminder tracker. `src/modes/`
// owns no timers — it accrues from the time it is handed — so this interval
// only decides how promptly a persisted total and a due reminder land.
const MODE_TICK_MS = 5_000;

// What 07's `ModeService` needs from a Node, narrowed to the parts worth
// driving without one: the leader file it writes modes into, the missions
// and charter the grant rule reads, and how many clients are connected —
// `modeActiveMs` counts only connected time.
export interface ModeMountPorts {
	store: LeadModeStore;
	getMission(id: MissionId): Mission | undefined;
	charter(workspaceId: WorkspaceId): string;
	connectedClients(): number;
	emit(event: Omit<Event, "seq">): void;
	now?(): number;
	nowIso?(): IsoTime;
}

export interface ModeMount {
	// `neta_mode`'s port (05) and `leader.setMode`'s body (04) both land
	// here, so a tool grant and a click in the UI get the same record, the
	// same clock and the same reminders.
	requestMode(input: { subject: ModeSubject; mode: LeaderMode; record?: DecisionRecord }): Promise<ModeApproval>;
	// One tool response, decorated for the subject that made the call: the
	// Lead++ banner, plus the reminder saying why when one falls due.
	// The manual path (04's `leader.setMode`): the user's own choice, so no
	// record and no charter gate — that rule is for a leader granting itself
	// Lead++, not for the person whose machine it is.
	setMode(subject: ModeSubject, mode: LeaderMode): Promise<void>;
	// The subject's own mode and its running active time — a mission lead's
	// from its own record, not the workspace leader's.
	snapshot(subject: ModeSubject): Promise<{ mode: LeaderMode; modeActiveMs: number }>;
	// One tool response, decorated for the subject that made the call: the
	// Lead++ banner, plus the reminder saying why when one falls due.
	decorate(subject: ModeSubject, response: string): Promise<string>;
	// Accrue active time, persist it, and emit the ten-minute warning. The
	// Node calls this on a timer; the service itself has none.
	tick(): void;
	onMissionClosed(mission: Mission): Promise<void>;
}

// 05's subject (which carries the mission a lead is running) as 07's, which
// keys a mission lead's mode by `agentId` alone.
function modeSubjectOf(subject: ModeSubject): ModeServiceSubject {
	return subject.kind === "leader"
		? { kind: "leader", workspaceId: subject.workspaceId }
		: { kind: "lead", workspaceId: subject.workspaceId, agentId: subject.agentId };
}

// 07's `ModeService`, wired to a Node. Both directions are real writes: a
// return to Lead needs no record and no charter check, but it must land —
// it is the only route out of Lead++, which outlives a restart.
export function modeMount(ports: ModeMountPorts): ModeMount {
	const now = ports.now ?? ((): number => Date.now());
	const iso = ports.nowIso ?? nowIso;
	// Every clock key the service holds was resumed from a subject one of
	// the entry points below passed in, so this map can name it again when
	// the clock asks for a persist.
	const subjects = new Map<string, ModeServiceSubject>();
	// The granting record lives flat on the `leader.modeChanged` event and
	// nowhere else (07), so the reminder's "why" is kept from the event this
	// Node emitted. A Node restart forgets it and the reminder falls back to
	// saying the mode was set by the user until the next change.
	const lastChange = new Map<string, Event>();
	let pendingChange: Event | undefined;
	let switching = 0;

	async function writeActive(subject: ModeServiceSubject, activeMs: number): Promise<void> {
		const file = await ports.store.read(subject.workspaceId);
		if (subject.kind === "leader") {
			if (file.leader.mode !== "leadPlus") {
				return;
			}
			await ports.store.writeLeader(subject.workspaceId, { ...file.leader, modeActiveMs: activeMs });
			return;
		}
		const stored = file.leadModes[subject.agentId];
		if (stored === undefined || stored.mode !== "leadPlus") {
			return;
		}
		await ports.store.writeLeadMode(subject.workspaceId, subject.agentId, { ...stored, modeActiveMs: activeMs });
	}

	const clock = new ActiveClock({
		connectedClients: () => ports.connectedClients(),
		// A switch writes the final total itself, and it suspends the clock
		// before it writes: a persist racing that write could read the old
		// mode and put the subject back in the one it just left, so persists
		// stand aside while a switch is in flight.
		persist: (key, activeMs) => {
			const subject = subjects.get(key);
			if (subject === undefined || switching > 0) {
				return;
			}
			void writeActive(subject, activeMs).catch(() => undefined);
		},
	});

	const service = new ModeService({
		store: ports.store,
		clock,
		reminders: new ReminderTracker(),
		// 07's switch path needs 03's live access switch, which the Node does
		// not expose: a session keeps the access it launched at until
		// `workspace.open` relaunches it at the recorded mode
		// (`ensureSession`). Naming no session also keeps `neta_mode` from
		// cancelling the very turn that called it — the tool runs inside the
		// caller's own turn, and that turn is still waiting for its result.
		switchDeps: {
			isTurnActive: () => false,
			steer: () => Promise.resolve(),
			switchAccess: () => Promise.resolve(),
		},
		mission: (id) => ports.getMission(id),
		sessionFor: () => undefined,
		charter: (workspaceId) => ports.charter(workspaceId),
		lastModeChange: (subject) => lastChange.get(subjectKey(subject)),
		emit: (event) => {
			if (event.kind === "leader.modeChanged") {
				pendingChange = { ...event, seq: 0 };
			}
			ports.emit(event);
		},
		now,
		nowIso: iso,
	});

	async function guarded<T>(subject: ModeServiceSubject, run: () => Promise<T>): Promise<T> {
		const key = subjectKey(subject);
		subjects.set(key, subject);
		switching++;
		pendingChange = undefined;
		try {
			const out = await run();
			if (pendingChange !== undefined) {
				lastChange.set(key, pendingChange);
			}
			return out;
		} finally {
			switching--;
		}
	}

	return {
		requestMode: async (input) => {
			const subject = modeSubjectOf(input.subject);
			if (input.mode === "lead") {
				await guarded(subject, () => service.setMode(subject, "lead"));
				return { approved: true };
			}
			const record = input.record;
			if (record === undefined) {
				return { approved: false, reason: "incompleteRecord", detail: "record is missing" };
			}
			const { result } = await guarded(subject, () => service.requestLeadPlus(subject, record));
			return result;
		},
		setMode: async (subject, mode) => {
			const target = modeSubjectOf(subject);
			await guarded(target, () => service.setMode(target, mode));
		},
		snapshot: async (subject) => {
			const target = modeSubjectOf(subject);
			const key = subjectKey(target);
			subjects.set(key, target);
			const snap = await service.snapshot(target);
			// The clock's running total, which is ahead of the record between
			// its thirty-second persists.
			const activeMs = clock.keys().includes(key) ? clock.activeMs(key) : snap.modeActiveMs;
			return { mode: snap.mode, modeActiveMs: activeMs };
		},
		decorate: async (subject, response) => {
			const target = modeSubjectOf(subject);
			subjects.set(subjectKey(target), target);
			try {
				// 05 puts compact JSON on the first line and the reminder
				// after it, so 07's banner and its due reminder go at the end
				// of that block rather than ahead of the payload: they are
				// taken from an empty response and appended.
				const lines = (await service.decorate(target, "")).split("\n").filter((line) => line !== "");
				return lines.length === 0 ? response : `${response}\n${lines.join("\n")}`;
			} catch {
				// A banner is never worth losing a tool result over.
				return response;
			}
		},
		tick: () => {
			service.onClientsChanged(ports.connectedClients());
			service.tick();
		},
		onMissionClosed: async (mission) => {
			if (mission.lead.kind !== "agent") {
				return;
			}
			const subject: ModeServiceSubject = {
				kind: "lead",
				workspaceId: mission.workspaceId,
				agentId: mission.lead.agentId,
			};
			await guarded(subject, () => service.onMissionClosed(mission));
		},
	};
}

export function toolMount(o: ToolMountOptions): {
	handlers: NodeHandlers;
	// Stops the mode ticker. The Node calls it on the way down; nothing else
	// in this mount holds a timer.
	stop(): void;
} {
	const leases = new LeaseManager(createFileLeaseStore(netaDir()));

	// The workspace root a subject works in, for the charter and for a
	// session's cwd.
	function rootFor(workspaceId: string): string {
		const workspace = o.store.getWorkspace(workspaceId);
		return workspace === undefined ? process.cwd() : rootOf(o.store, workspace);
	}

	// 07 keeps a mission lead's mode in the same `leaders/<workspaceId>.json`
	// as the workspace leader's, under `leadModes`. The Node serves leaders
	// from a memory mirror that holds the `Leader` alone, so the lead modes
	// are read from and written to the file beside it and never broadcast.
	function leaderOf(workspaceId: WorkspaceId): Leader {
		const leader = o.store.getLeader(workspaceId);
		if (leader === undefined) {
			throw new NodeError("NOT_FOUND", `no leader for workspace: ${workspaceId}`);
		}
		return leader;
	}

	async function saveLeaderFile(leader: Leader, leadModes: Record<AgentId, LeadMode>): Promise<void> {
		// The document first, naming the lead modes explicitly (02 replaces
		// the field only for a caller that names it), then the mirror, whose
		// plain `Leader` save merges the same field back.
		await o.real.leaders.save({ ...leader, leadModes });
		await o.store.putLeader(leader);
		o.hub().broadcast("state", { kind: "leader", record: leader });
	}

	const leadModeStore: LeadModeStore = {
		read: async (workspaceId) => {
			const mirror = leaderOf(workspaceId);
			const doc = await o.real.leaders.load(workspaceId, () => mirror);
			const { leadModes, ...leader } = doc;
			return { leader, leadModes: leadModes ?? {} };
		},
		writeLeader: async (workspaceId, leader) => {
			const doc = await o.real.leaders.load(workspaceId, () => leader);
			await saveLeaderFile(leader, doc.leadModes ?? {});
		},
		writeLeadMode: async (workspaceId, agentId, mode) => {
			const doc = await o.real.leaders.load(workspaceId, () => leaderOf(workspaceId));
			const { leadModes: stored, ...leader } = doc;
			const leadModes = { ...(stored ?? {}) };
			if (mode === undefined) {
				delete leadModes[agentId];
			} else {
				leadModes[agentId] = mode;
			}
			await saveLeaderFile(leader, leadModes);
		},
	};

	// The hub exists only once the server is listening, and this mount is
	// built before it: nothing is connected until then, so an absent hub is
	// nobody watching rather than an error.
	function connectedClients(): number {
		const hub = o.hub() as Hub | undefined;
		return hub === undefined ? 0 : hub.connections().length;
	}

	const modes = modeMount({
		store: leadModeStore,
		getMission: (id) => o.store.getMission(id),
		charter: (workspaceId) => loadCharter(rootFor(workspaceId), homedir())?.text ?? "",
		connectedClients,
		emit: (event) => {
			const { at: _at, ...rest } = event;
			void o.store.appendEvent(rest).catch(() => undefined);
		},
	});

	// 07 has no timers: the Node drives the clock, and the connected-client
	// count comes from the hub on the same beat, so `modeActiveMs` counts
	// only the time somebody was watching.
	const ticker = setInterval(() => {
		modes.tick();
	}, MODE_TICK_MS);
	ticker.unref();

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
			// 07: closing or abandoning a mission returns its lead to Lead,
			// with the cause the disposition implies.
			await modes.onMissionClosed(mission).catch(() => undefined);
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
				snapshot(subject: ModeSubject): Promise<{ mode: LeaderMode; modeActiveMs: number }>;
			};
		} = {
		store: o.store,
		// 05: every leader and lead tool response passes through 07's
		// `decorate`, so a subject in Lead++ is told, on every single call,
		// how long it has been active and why.
		decorate: (actor: Actor, response: string) =>
			actor.kind === "agent"
				? Promise.resolve(response)
				: modes.decorate(
						actor.kind === "leader"
							? { kind: "leader", workspaceId: actor.workspaceId }
							: {
									kind: "lead",
									workspaceId: actor.workspaceId,
									missionId: actor.missionId,
									agentId: actor.agentId,
								},
						response,
					),
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
			// 07's `ModeService`, wired above: it owns the record, the
			// charter gate, the active-time clock and the reminders, and a
			// mission lead is a subject of its own — its mode never touches
			// the workspace leader's.
			requestMode: (input) => modes.requestMode(input),
			snapshot: (subject) => modes.snapshot(subject),
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

		// 04's manual path, over the stub in `handlers-registry.ts`: on a
		// real Node it is 07's `setMode`, so a mode set from the UI starts
		// the same clock and the same reminders a `neta_mode` grant does.
		// `missionId` names that mission's lead as the subject (07); without
		// one the subject is the workspace leader.
		"leader.setMode": async (_ctx: NodeContext, params: unknown) => {
			const parsed = parseParams({ workspaceId: asString, mode: asString, missionId: asOptionalString }, params);
			if (parsed.mode !== "lead" && parsed.mode !== "leadPlus") {
				throw new NodeError("INVALID_PARAMS", "leader.setMode mode is lead or leadPlus");
			}
			const leader = leaderOf(parsed.workspaceId);
			const mission = parsed.missionId === undefined ? undefined : o.store.getMission(parsed.missionId);
			if (parsed.missionId !== undefined && mission === undefined) {
				throw new NodeError("NOT_FOUND", `no such mission: ${parsed.missionId}`);
			}
			const subject: ModeSubject =
				mission !== undefined && mission.lead.kind === "agent"
					? {
							kind: "lead",
							workspaceId: mission.workspaceId,
							missionId: mission.id,
							agentId: mission.lead.agentId,
						}
					: { kind: "leader", workspaceId: parsed.workspaceId };
			await modes.setMode(subject, parsed.mode);
			return { leader: o.store.getLeader(parsed.workspaceId) ?? leader };
		},
	};
	return {
		handlers,
		stop: () => {
			clearInterval(ticker);
		},
	};
}
