// `tools.list` and `tools.call` on the socket: the Node half of 05. The stdio
// proxy one OpenCode actor holds forwards every MCP call here with the actor id
// and the token this Node minted when it launched that session, so the tools
// are reachable from a leader, a lead and an agent and from nowhere else.
//
// This module is the only place the tool handlers' ports meet the real
// modules: 02's registry for numbers and mission records, 03 (through the
// runtime port) for sessions, 05's context builders for what a new agent
// is told, and 06's worktree service and leases. Everything stateful still
// comes in through `lifecycle.ts`.

import { homedir } from "node:os";
import { join } from "node:path";
import { distinctMissionLead } from "../core/mission-lead.ts";
import { nowIso } from "../core/time.ts";
import type {
	Access,
	Agent,
	AgentId,
	DecisionRecord,
	Event,
	InboxMessage,
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
import { routingCredential } from "../routing/auth.ts";
import { createCatalog } from "../routing/catalog.ts";
import { loadRoutingConfig } from "../routing/config.ts";
import { loadModelPreferences, requireAllowedModel } from "../routing/preferences.ts";
import { createModelRouter } from "../routing/router.ts";
import type { Settings } from "../session/settings.ts";
import type { Store } from "../store/index.ts";
import { openParentReportStore } from "../store/parent-reports.ts";
import { composeContext, loadCharter, loadSkills } from "../tools/context.ts";
import type { CloseMissionInput, CloseOutcome, ModeApproval, ModeSubject } from "../tools/handlers/lifecycle.ts";
import type { MissionPorts, SessionLaunch } from "../tools/handlers/mission.ts";
import type { ModelPorts } from "../tools/handlers/model.ts";
import { toolHandlers } from "../tools/launch.ts";
import { type Actor, createRouter, type ToolDeps } from "../tools/router.ts";
import { createFileLeaseStore, createWorktreeService, LeaseManager, WorktrunkDriver } from "../worktrees/index.ts";
import { createAgentModelChanger } from "./agent-model.ts";
import { type ReportPorts, recordAgentRuntime } from "./agent-runtime.ts";
import { createFollowupSender } from "./followup.ts";
import { conversationHandlers } from "./handlers-conversation.ts";
import { asOptionalBoolean, asOptionalString, asString, parseParams } from "./handlers-registry.ts";
import { recordLeaderRuntime } from "./leader-runtime.ts";
import type { AdaptedRuntime, AdaptedStore } from "./lifecycle.ts";
import { netaDir } from "./lockfile.ts";
import { ParentDispatcher } from "./parent-dispatcher.ts";
import { NodeError, type TurnNotification } from "./protocol.ts";
import { recoverActorResults } from "./result-recovery.ts";
import type { RuntimeAdmission } from "./runtime-admission.ts";
import type { Hub, NodeContext, NodeHandlers, NodeStore } from "./server.ts";
import { selectWorkerModel } from "./worker-model.ts";
import { archiveWorkspace } from "./workspace-reset.ts";

export interface ToolMountOptions {
	real: Store;
	store: AdaptedStore;
	runtime: AdaptedRuntime;
	settings: Settings;
	runtimeAdmission?: RuntimeAdmission;
	hub(): Hub;
	pi?: {
		start(input: { sessionId: string; actorId: string; cwd: string; prompt: string }): Promise<void>;
		close(sessionId: string): void;
	};
}

// The workspace copy on this machine: the root recorded for our machine, else
// the first one on record.
function rootOf(store: NodeStore, workspace: Workspace): string {
	const machineId = store.machine().id;
	const mine = workspace.roots.find((root) => root.machineId === machineId);
	return mine?.path ?? workspace.roots[0]?.path ?? process.cwd();
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
	evaluateLeadPlus(subject: ModeSubject, record: DecisionRecord): Promise<ModeApproval>;
	applyApprovedLeadPlus(subject: ModeSubject, record: DecisionRecord): Promise<void>;
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
		evaluateLeadPlus: async (input, record) => service.evaluateLeadPlus(modeSubjectOf(input), record),
		applyApprovedLeadPlus: async (input, record) => {
			await guarded(modeSubjectOf(input), () => service.applyApprovedLeadPlus(modeSubjectOf(input), record));
		},
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
	recordTurn(notification: TurnNotification): Promise<void>;
	recover(): Promise<void>;
	canDeliverInbox(message: InboxMessage): Promise<boolean>;
} {
	const routeModel = createModelRouter({
		preferences: () => loadModelPreferences(netaDir()),
		catalog: createCatalog({ cachePath: join(netaDir(), "model-routing-catalog.json") }),
		apiKey: async () => (await routingCredential(netaDir())).key,
	});
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
		if (mission.lead.kind === "agent") {
			const leader = o.store.getLeader(mission.workspaceId);
			const lead = o.store.getAgent(mission.lead.agentId);
			if (
				!lead ||
				lead.missionId !== mission.id ||
				lead.workspaceId !== mission.workspaceId ||
				!lead.canSpawn ||
				!mission.agentIds.includes(lead.id) ||
				!distinctMissionLead(mission, leader, lead)
			) {
				throw new Error(
					"Mission lead must be a reserved, separate actor and session for this mission. Supply a separate lead task and effort.",
				);
			}
		}
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
			// Make closure visible before any FIFO handoff. Promotion then skips
			// queued members of this mission and may safely start another one.
			await saveMission(mission, false);
			for (const agentId of mission.agentIds) await releaseHolder(mission.workspaceId, agentId);
			await releaseHolder(mission.workspaceId, mission.id);
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
	// task carries the agent's bounded assignment; the mission and its
	// ownership are already durable before this prompt is sent.
	function contextFor(input: {
		access: Access;
		canSpawn: boolean;
		task: string;
		skills: string[];
		root: string;
	}): string {
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
			access: input.access,
			...(charter === undefined ? {} : { charter }),
			skills: skills.skills,
			task: input.task,
		});
	}

	// The context each launched session is waiting to be briefed with,
	// composed by `launch` before that session existed and consumed by the
	// `brief` that follows it.
	const briefs = new Map<AgentId, string>();
	const pendingReleases = new Map<string, Agent>();
	const pendingCloses = new Map<string, { input: CloseMissionInput; subject: ModeSubject; agent?: Agent }>();
	const pendingModes = new Map<
		string,
		{ subject: ModeSubject; mode: LeaderMode; record?: DecisionRecord; mission: Mission; holder: string }
	>();
	async function promote(changed: Array<{ promoted?: AgentId }>): Promise<void> {
		const leave = o.runtimeAdmission?.enter();
		try {
			await promoteAdmitted(changed);
		} finally {
			leave?.();
		}
	}
	async function promoteAdmitted(changed: Array<{ promoted?: AgentId }>): Promise<void> {
		const pending = [...changed];
		while (pending.length > 0) {
			const promoted = pending.shift()?.promoted;
			if (promoted === undefined) continue;
			const next = o.store.getAgent(promoted);
			const mission = next === undefined ? undefined : o.store.getMission(next.missionId);
			if (next === undefined || mission === undefined || next.state !== "queued" || mission.state === "closed") {
				if (next !== undefined) pending.push(...(await worktrees.releaseWriter(next.workspaceId, next.id)));
				continue;
			}
			let sessionId = next.sessionId;
			try {
				const request = {
					deferInbox: true,
					sessionId,
					workspaceId: next.workspaceId,
					cwd: mission.worktree?.path ?? rootFor(next.workspaceId),
					provider: next.provider,
					model: next.model,
					fallbackModels: next.fallbackModels ?? [],
					access: next.access,
					unsandboxed: next.canSpawn,
					netaTools: true,
					actorId: next.id,
				};
				const created =
					next.stateBefore === "interrupted"
						? await o.runtime.ensureSession({ ...request, allowFresh: false })
						: await o.runtime.createSession(request);
				sessionId = created.sessionId;
				const starting = { ...next, sessionId, state: "starting" as const };
				await o.store.putAgent(starting);
				o.hub().broadcast("state", { kind: "agent", record: starting });
				await o.runtime.prompt(
					sessionId,
					next.provider === "opencode"
						? next.task
						: contextFor({
								canSpawn: next.canSpawn,
								access: next.access,
								task: next.task,
								skills: next.skills,
								root: rootFor(next.workspaceId),
							}),
				);
			} catch (error) {
				await o.runtime.close(sessionId).catch(() => undefined);
				const failed = { ...next, sessionId, state: "failed" as const, endedAt: nowIso(), outcome: String(error) };
				await o.store.putAgent(failed);
				o.hub().broadcast("state", { kind: "agent", record: failed });
				pending.push(...(await worktrees.releaseWriter(failed.workspaceId, failed.id)));
			}
		}
	}
	async function releaseHolder(workspaceId: WorkspaceId, holder: string): Promise<void> {
		const leave = o.runtimeAdmission?.enter();
		try {
			await promote(await worktrees.releaseWriter(workspaceId, holder));
		} finally {
			leave?.();
		}
	}
	async function recoverStaleWorkspaceLeaderLease(
		workspaceId: WorkspaceId,
	): Promise<{ missionId: number; promoted?: string } | undefined> {
		const leader = o.store.getLeader(workspaceId);
		const workspace = o.store.getWorkspace(workspaceId);
		if (leader?.mode !== "lead" || leader.activeMissionId !== undefined || workspace === undefined) return undefined;

		const candidates: Mission[] = [];
		for (const mission of o.store.listMissions(workspaceId)) {
			if (
				mission.state === "closed" ||
				mission.lead.kind !== "agent" ||
				o.store.listAgents(mission.id).some((agent) => agent.state === "starting" || agent.state === "running")
			)
				continue;
			if (await worktrees.holdsWriter(mission, workspace, mission.id)) candidates.push(mission);
		}
		// A no-active-mission leader cannot identify which reservation to return.
		// Refuse ambiguity rather than releasing more than one worktree lease.
		if (candidates.length !== 1) return undefined;
		const mission = candidates[0];
		if (mission === undefined) return undefined;
		const release = await worktrees.releaseWriterKey(mission, workspace, mission.id);
		if (!release.released) return undefined;
		await promote(release.changed);
		const promoted = release.changed[0]?.promoted;
		return promoted === undefined ? { missionId: mission.number } : { missionId: mission.number, promoted };
	}
	async function finishPendingClose(sessionId: string): Promise<CloseOutcome> {
		const pending = pendingCloses.get(sessionId);
		if (pending === undefined) throw new NodeError("NOT_FOUND", "no pending close for session");
		const leader = leaderOf(pending.input.mission.workspaceId);
		await o.runtime.ensureSession({
			sessionId,
			workspaceId: pending.input.mission.workspaceId,
			cwd: rootFor(pending.input.mission.workspaceId),
			provider: pending.agent?.provider ?? leader.provider,
			model: pending.agent?.model ?? leader.model,
			access: "readOnly",
			unsandboxed: pending.subject.kind === "lead" || pending.agent === undefined,
			netaTools: true,
			...(pending.agent === undefined ? {} : { actorId: pending.agent.id }),
			forceRelaunch: true,
			allowFresh: false,
		});
		await modes.requestMode({ subject: pending.subject, mode: "lead" });
		const outcome = await worktrees.close(pending.input);
		if (!outcome.ok) {
			const holder = pending.agent?.id ?? pending.input.mission.id;
			await releaseHolder(pending.input.mission.workspaceId, holder);
		}
		await saveMission(outcome.mission);
		pendingCloses.delete(sessionId);
		return outcome;
	}
	async function recordDeferredCloseFailure(sessionId: string, error: unknown): Promise<void> {
		const pending = pendingCloses.get(sessionId);
		if (pending === undefined) return;
		pendingCloses.delete(sessionId);
		// A delayed callback may outlive a successful close (for example, when
		// the provider reports an old turn after the closeout persisted). Never
		// turn a terminal record back into an open one with the stale input that
		// was captured when the close was scheduled.
		const latest = o.store.getMission(pending.input.mission.id);
		if (latest?.state === "closed") return;
		const failed = { ...(latest ?? pending.input.mission), attention: `Close failed: ${String(error)}` };
		await saveMission(failed);
		await o.store.appendEvent({
			workspaceId: failed.workspaceId,
			kind: "mission.failed",
			missionId: failed.id,
			sessionId,
			data: { reason: String(error) },
		});
	}
	async function applyPendingMode(sessionId: string): Promise<void> {
		const pending = pendingModes.get(sessionId);
		if (pending === undefined) return;
		pendingModes.delete(sessionId);
		// Mode restoration is asynchronous because it waits for an old turn to
		// reach its steering boundary. Closeout can finish first. In that case
		// this callback has no mission left to restore and, crucially, must not
		// write its captured pre-close mission back to the registry.
		if (o.store.getMission(pending.mission.id)?.state === "closed") {
			await releaseHolder(pending.subject.workspaceId, pending.holder);
			return;
		}
		try {
			const agent = pending.subject.kind === "lead" ? o.store.getAgent(pending.subject.agentId) : undefined;
			await o.runtime.ensureSession({
				sessionId,
				workspaceId: pending.subject.workspaceId,
				cwd: pending.mission.worktree?.path ?? rootFor(pending.subject.workspaceId),
				provider: agent?.provider ?? leaderOf(pending.subject.workspaceId).provider,
				model: agent?.model ?? leaderOf(pending.subject.workspaceId).model,
				access: pending.mode === "leadPlus" ? "readWrite" : "readOnly",
				unsandboxed: true,
				netaTools: true,
				...(agent === undefined ? {} : { actorId: agent.id }),
				forceRelaunch: pending.mission.worktree !== undefined,
				allowFresh: false,
			});
			if (pending.mode === "leadPlus" && pending.record !== undefined) {
				await modes.applyApprovedLeadPlus(pending.subject, pending.record);
				if (pending.subject.kind === "leader") {
					const leader = leaderOf(pending.subject.workspaceId);
					await o.store.putLeader({ ...leader, activeMissionId: pending.mission.id });
					o.hub().broadcast("state", {
						kind: "leader",
						record: { ...leader, activeMissionId: pending.mission.id },
					});
				}
			} else {
				await modes.requestMode({ subject: pending.subject, mode: "lead" });
				await releaseHolder(pending.subject.workspaceId, pending.holder);
			}
			return;
		} catch (error) {
			await o.runtime.close(sessionId).catch(() => undefined);
			await releaseHolder(pending.subject.workspaceId, pending.holder);
			// Do not resurrect a closed mission if session restoration lost a race
			// with closeout. For non-terminal missions, preserve any fields written
			// since this operation was scheduled rather than restoring the snapshot.
			const latest = o.store.getMission(pending.mission.id);
			if (latest?.state === "closed") return;
			const failedMission = { ...(latest ?? pending.mission), attention: `Lead++ failed: ${String(error)}` };
			await saveMission(failedMission);
			await o.store.appendEvent({
				workspaceId: failedMission.workspaceId,
				kind: "mission.failed",
				missionId: failedMission.id,
				sessionId,
				data: { reason: String(error) },
			});
			throw error;
		}
	}

	async function releaseAndPromote(agent: Agent): Promise<void> {
		const leave = o.runtimeAdmission?.enter();
		try {
			if (agent.provider === "pi" && o.pi !== undefined) o.pi.close(agent.sessionId);
			else await o.runtime.close(agent.sessionId);
			await releaseHolder(agent.workspaceId, agent.id);
		} finally {
			leave?.();
		}
	}

	const resultStore = openParentReportStore(o.real.dir);
	let runtimeStopped = false;
	async function deliveryStatus(
		actorId: string,
		parentSessionId: string,
	): Promise<"accepted" | "pending" | "uncertain"> {
		let pending = false;
		for (const item of (await o.runtime.listInbox?.(parentSessionId)) ?? []) {
			if (item.readerDirected !== false || !item.sourceId || !/^[a-f0-9]{64}$/.test(item.sourceId)) continue;
			if ((await resultStore.get(item.sourceId))?.actorId !== actorId) continue;
			if (item.status === "uncertain") return "uncertain";
			if (item.status === "queued" || item.status === "delivering") pending = true;
		}
		return pending ? "pending" : "accepted";
	}
	const reportPorts: ReportPorts = {
		resumed: async (mission) => {
			const latest = o.store.getMission(mission.id);
			if (latest?.state === "blocked") await saveMission({ ...latest, state: "running", attention: undefined });
		},
		deliveryStatus,
		store: o.store,
		reports: resultStore,
		changed: (agent) => o.hub().broadcast("state", { kind: "agent", record: agent }),
		send: async (sessionId, text, sourceId) => {
			if (runtimeStopped) throw new Error("Runtime is stopping");
			if (!o.runtime.send) throw new Error("Parent inbox is unavailable");
			const parentAgent = o.store.listAgents().find((item) => item.sessionId === sessionId);
			const parentLeader = o.store.listLeaders().find((item) => item.sessionId === sessionId);
			const parent = parentAgent ?? parentLeader;
			if (!parent) throw new Error("Parent session owner is missing");
			const parentMission = parentAgent ? o.store.getMission(parentAgent.missionId) : undefined;
			const parentMode = await modes.snapshot(
				parentAgent
					? {
							kind: "lead",
							workspaceId: parent.workspaceId,
							missionId: parentAgent.missionId,
							agentId: parentAgent.id,
						}
					: { kind: "leader", workspaceId: parent.workspaceId },
			);
			const selected = await o.runtime.ensureSession({
				sessionId,
				workspaceId: parent.workspaceId,
				cwd: parentMission?.worktree?.path ?? rootFor(parent.workspaceId),
				provider: parent.provider,
				model: parent.model,
				...(parentAgent ? { fallbackModels: parentAgent.fallbackModels ?? [] } : {}),
				access: parentMode.mode === "leadPlus" ? "readWrite" : "readOnly",
				unsandboxed: true,
				netaTools: true,
				actorId: parentAgent?.id,
				allowFresh: false,
			});
			sessionId = selected.sessionId;
			// The durable inbox queues while the parent is busy and wakes it when idle.
			return await o.runtime.send(sessionId, text, [], { readerDirected: false, sourceId });
		},
	};
	const dispatcher = new ParentDispatcher(reportPorts, (report, error) => {
		const actor = o.store.getAgent(report.actorId);
		if (actor) {
			const updated: Agent = { ...actor, deliveryStatus: "failed", deliveryError: String(error) };
			void o.store
				.putAgent(updated)
				.then(() => reportPorts.changed(o.store.getAgent(updated.id) ?? updated))
				.catch(() => undefined);
		}
		o.hub().broadcast("error", {
			message: `Parent notification pending: ${String(error)}`,
			sessionId: report.sessionId,
		});
	});
	const recordings = new Map<string, Promise<void>>();
	function recordTurn(notification: TurnNotification): Promise<void> {
		const previous = recordings.get(notification.sessionId) ?? Promise.resolve();
		const operation = previous
			.catch(() => undefined)
			.then(async () => {
				await recordLeaderRuntime(notification, {
					store: o.store,
					changed: (leader) => o.hub().broadcast("state", { kind: "leader", record: leader }),
				});
				await recordAgentRuntime(notification, reportPorts);
			});
		recordings.set(notification.sessionId, operation);
		void operation
			.finally(() => {
				if (recordings.get(notification.sessionId) === operation) recordings.delete(notification.sessionId);
			})
			.catch(() => undefined);
		return operation;
	}
	o.runtime.onTurn((notification) => {
		const receipt = notification.inbox;
		if (receipt?.status === "uncertain") {
			o.hub().broadcast("error", {
				sessionId: receipt.sessionId,
				message: `Message ${receipt.id} has uncertain delivery. Inspect /delivery before retrying; it may have reached the provider.`,
			});
		}
		if (
			!runtimeStopped &&
			receipt?.readerDirected === false &&
			receipt.sourceId &&
			/^[a-f0-9]{64}$/.test(receipt.sourceId)
		) {
			const sourceId = receipt.sourceId;
			void (async () => {
				const report = await resultStore.get(sourceId);
				if (!report) return;
				const status = await deliveryStatus(report.actorId, receipt.sessionId);
				const actor = o.store.getAgent(report.actorId);
				if (!actor || actor.state === "archived") return;
				await o.store.putAgent({ ...actor, deliveryStatus: status, deliveryError: undefined });
				reportPorts.changed(o.store.getAgent(actor.id) ?? actor);
			})().catch(() => undefined);
		}
		if (runtimeStopped || (!notification.turn && !notification.model)) return;
		void recordTurn(notification)
			.then(async () => {
				if (!notification.turn?.endedAt || runtimeStopped) return;
				const report = await recordAgentRuntime(notification, reportPorts);
				if (report) dispatcher.enqueue(report);
			})
			.catch((error) => {
				o.hub().broadcast("error", {
					message: `Could not persist runtime result: ${String(error)}`,
					sessionId: notification.sessionId,
				});
			});
	});

	o.runtime.onTurn((notification) => {
		if (runtimeStopped || notification.turn?.endedAt === undefined) return;
		if (pendingCloses.has(notification.sessionId)) {
			void finishPendingClose(notification.sessionId).catch((error) =>
				recordDeferredCloseFailure(notification.sessionId, error),
			);
			return;
		}
		const pendingMode = pendingModes.get(notification.sessionId);
		if (pendingMode !== undefined) {
			if (notification.turn.cancelled === true) {
				pendingModes.delete(notification.sessionId);
				void releaseHolder(pendingMode.subject.workspaceId, pendingMode.holder).catch(() => undefined);
			} else {
				void applyPendingMode(notification.sessionId).catch(() => undefined);
			}
		}
		if (notification.turn.cancelled || notification.turn.failed) {
			const stopped = o.store.listAgents().find((agent) => agent.sessionId === notification.sessionId);
			if (
				stopped?.access === "readWrite" &&
				!stopped.canSpawn &&
				(!stopped.currentTurnId || stopped.currentTurnId === notification.turn.id) &&
				(!notification.bindingGeneration ||
					!stopped.bindingGeneration ||
					notification.bindingGeneration === stopped.bindingGeneration) &&
				o.runtime.isTurnActive?.(notification.sessionId) !== true
			)
				pendingReleases.set(notification.sessionId, stopped);
		}
		const agent = pendingReleases.get(notification.sessionId);
		if (agent === undefined) return;
		pendingReleases.delete(notification.sessionId);
		void releaseAndPromote(agent).catch((error) => {
			o.hub().broadcast("error", {
				message: `Worker release remains pending: ${String(error)}`,
				sessionId: agent.sessionId,
			});
		});
	});

	const missions: MissionPorts["missions"] = { save: (mission) => saveMission(mission) };

	const deps: ToolDeps &
		MissionPorts &
		ModelPorts & {
			sessions: {
				send(agent: Agent, text: string, sourceId: string): Promise<InboxMessage>;
				release(agent: Agent): Promise<void>;
				resume(agent: Agent): Promise<Agent>;
				failed(agent: Agent): Promise<void>;
				startQueued(agent: Agent, text: string): Promise<Agent>;
				cancel(sessionId: string): Promise<void>;
				prompt(sessionId: string, text: string): Promise<void>;
			};
			worktrees: { close(input: CloseMissionInput): Promise<CloseOutcome> };
			modelCatalog(workspaceId: WorkspaceId): Promise<{ provider: string; id: string; name: string }[]>;
			modes: {
				requestMode(input: {
					subject: ModeSubject;
					mode: LeaderMode;
					record?: DecisionRecord;
				}): Promise<ModeApproval>;
				snapshot(subject: ModeSubject): Promise<{ mode: LeaderMode; modeActiveMs: number }>;
			};
		} = {
		models: {
			adjust: createAgentModelChanger({
				store: o.store,
				route: async (input) =>
					routeModel(
						input,
						await deps.modelCatalog(input.workspaceId),
						loadRoutingConfig(netaDir(), rootFor(input.workspaceId)),
					),
				apply: async (agent, model) => {
					const mission = o.store.getMission(agent.missionId);
					if (!mission) throw new NodeError("NOT_FOUND", "No mission for this agent.");
					const live = await o.runtime.ensureSession({
						sessionId: agent.sessionId,
						workspaceId: agent.workspaceId,
						cwd: mission.worktree?.path ?? rootFor(agent.workspaceId),
						provider: agent.provider,
						model,
						fallbackModels: [],
						access: agent.access,
						unsandboxed: agent.canSpawn,
						netaTools: true,
						actorId: agent.id,
						allowFresh: false,
					});
					if (live.sessionId !== agent.sessionId)
						throw new NodeError("PROVIDER_ERROR", "Model changes must keep the original conversation.");
					await o.runtime.setModel(agent.sessionId, model);
				},
				publish: (agent) => o.hub().broadcast("state", { kind: "agent", record: agent }),
			}),
		},
		modelCatalog: async (workspaceId) => {
			const leader = leaderOf(workspaceId);
			return (await o.runtime.listModels({ sessionId: leader.sessionId })).filter(
				(model) =>
					!o.settings.forbiddenModels.includes(model.id) &&
					(leader.provider !== "opencode" || model.provider === "opencode"),
			);
		},
		store: {
			...o.store,
			appendEvent: async (input) => {
				const event = await o.store.appendEvent(input);
				o.hub().broadcast("event", { event });
				return event;
			},
		},
		history: async (sessionId, query) => {
			const page = await o.store.tailConversation(sessionId, query);
			return {
				messages: page.blocks
					.filter((block) => block.kind === "text" && (block.role === "user" || block.role === "agent"))
					.map((block) => ({
						turnId: block.turnId,
						role: block.role === "user" ? ("user" as const) : ("assistant" as const),
						text: block.text,
					})),
				...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
			};
		},
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
		numbers: {
			allocateNumber: (workspaceId) => o.real.missions.allocateNumber(workspaceId),
			isAllocated: (workspaceId, number) => o.real.missions.isAllocated(workspaceId, number),
		},
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
			release: releaseHolder,
		},
		worktrees: {
			prepare: (mission, workspace, opts) => worktrees.prepare(mission, workspace, opts),
			close: async (input) => {
				if ([...pendingReleases.values()].some((agent) => agent.missionId === input.mission.id)) {
					return {
						ok: false as const,
						attention: "a writer is still finishing",
						mission: input.mission,
					};
				}
				const subject: ModeSubject =
					input.mission.lead.kind === "agent"
						? {
								kind: "lead",
								workspaceId: input.mission.workspaceId,
								missionId: input.mission.id,
								agentId: input.mission.lead.agentId,
							}
						: { kind: "leader", workspaceId: input.mission.workspaceId };
				if ((await modes.snapshot(subject)).mode === "leadPlus") {
					const agent = subject.kind === "lead" ? o.store.getAgent(subject.agentId) : undefined;
					const sessionId = agent?.sessionId ?? leaderOf(input.mission.workspaceId).sessionId;
					pendingCloses.set(sessionId, {
						input: { ...input, repositoryRoot: rootFor(input.mission.workspaceId) },
						subject,
						...(agent === undefined ? {} : { agent }),
					});
					if (o.runtime.isTurnActive?.(sessionId) === true) {
						return { ok: false, attention: "close scheduled after the active turn", mission: input.mission };
					}
					try {
						return await finishPendingClose(sessionId);
					} catch (error) {
						await recordDeferredCloseFailure(sessionId, error);
						return {
							ok: false,
							attention: `Close failed: ${String(error)}`,
							mission: o.store.getMission(input.mission.id) ?? input.mission,
						};
					}
				}
				return worktrees.close({ ...input, repositoryRoot: rootFor(input.mission.workspaceId) });
			},
		},
		sessions: {
			send: createFollowupSender({
				inbox: o.real.inbox,
				getAgent: (id) => o.store.getAgent(id),
				getMission: (id) => o.store.getMission(id),
				putAgent: (agent) => o.store.putAgent(agent),
				validateMission: (mission) => {
					if (
						!distinctMissionLead(
							mission,
							o.store.getLeader(mission.workspaceId),
							mission.lead.kind === "agent" ? o.store.getAgent(mission.lead.agentId) : undefined,
						)
					)
						throw new Error(
							`Mission #${mission.number} cannot resume: its lead aliases the workspace leader. Close it and create a new mission with a separate lead task and effort.`,
						);
				},
				saveMission: (mission) => missions.save(mission),
				resume: (agent) => deps.sessions.resume(agent),
				admit: async (sessionId, text, sourceId) => {
					if (!o.runtime.send) throw new Error("Durable follow-up inbox admission is unavailable");
					return o.runtime.send(sessionId, text, [], { readerDirected: false, sourceId });
				},
				receipt: (inbox) => o.hub().broadcast("turn", { sessionId: inbox.sessionId, inbox }),
				failed: (item, error) =>
					o.hub().broadcast("error", {
						sessionId: item.sessionId,
						message: `Follow-up ${item.id} is saved but awaiting admission: ${String(error)}`,
					}),
			}),
			pi: o.pi !== undefined,
			startQueued: async (agent, text) => {
				const mission = o.store.getMission(agent.missionId);
				const workspace = o.store.getWorkspace(agent.workspaceId);
				if (mission === undefined || workspace === undefined)
					throw new NodeError("NOT_FOUND", "queued writer has no mission");
				if ((await worktrees.acquireWriter(mission, workspace, agent.id)) !== "active")
					throw new NodeError("BUSY", "writer remains queued");
				let sessionId = agent.sessionId;
				try {
					const request = {
						sessionId,
						workspaceId: agent.workspaceId,
						cwd: mission.worktree?.path ?? rootFor(agent.workspaceId),
						provider: agent.provider,
						model: agent.model,
						fallbackModels: agent.fallbackModels ?? [],
						access: agent.access,
						unsandboxed: agent.canSpawn,
						netaTools: true,
						actorId: agent.id,
					};
					const created =
						agent.stateBefore === "interrupted"
							? await o.runtime.ensureSession({ ...request, allowFresh: false })
							: await o.runtime.createSession(request);
					sessionId = created.sessionId;
					const starting = { ...agent, sessionId, state: "starting" as const };
					await o.store.putAgent(starting);
					o.hub().broadcast("state", { kind: "agent", record: starting });
					await o.runtime.prompt(
						sessionId,
						agent.provider === "opencode"
							? text
							: `${contextFor({ access: agent.access, canSpawn: agent.canSpawn, task: agent.task, skills: agent.skills, root: rootFor(agent.workspaceId) })}\n\nLeader continuation: ${text}`,
					);
					return starting;
				} catch (error) {
					await o.runtime.close(sessionId).catch(() => undefined);
					await releaseAndPromote({ ...agent, sessionId });
					throw error;
				}
			},
			failed: releaseAndPromote,
			resume: async (agent) => {
				const mission = o.store.getMission(agent.missionId);
				if (mission === undefined) throw new NodeError("NOT_FOUND", `no mission for agent: ${agent.id}`);
				if (agent.access === "readWrite") {
					const workspace = o.store.getWorkspace(agent.workspaceId);
					if (workspace === undefined) throw new NodeError("NOT_FOUND", `no workspace for agent: ${agent.id}`);
					if ((await worktrees.acquireWriter(mission, workspace, agent.id)) !== "active") {
						const queued = { ...agent, state: "queued" as const, stateBefore: "interrupted" as const };
						await o.store.putAgent(queued);
						o.hub().broadcast("state", { kind: "agent", record: queued });
						throw new NodeError("BUSY", "writer recovery is queued");
					}
				}
				try {
					const live = await o.runtime.ensureSession({
						sessionId: agent.sessionId,
						workspaceId: agent.workspaceId,
						cwd: mission.worktree?.path ?? rootFor(agent.workspaceId),
						provider: agent.provider,
						model: agent.model,
						fallbackModels: agent.fallbackModels ?? [],
						access: agent.access,
						unsandboxed: agent.canSpawn,
						netaTools: true,
						actorId: agent.id,
						allowFresh: false,
					});
					return live.sessionId === agent.sessionId ? agent : { ...agent, sessionId: live.sessionId };
				} catch (error) {
					if (agent.access === "readWrite") await releaseAndPromote(agent);
					throw error;
				}
			},
			release: async (agent) => {
				if (o.runtime.isTurnActive?.(agent.sessionId) === true) pendingReleases.set(agent.sessionId, agent);
				else await releaseAndPromote(agent);
			},
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
			routeModel: async (input) => {
				const leader = leaderOf(input.workspaceId);
				if (leader.provider !== "opencode") return undefined;
				const available = await deps.modelCatalog(input.workspaceId);

				try {
					return await routeModel(input, available, loadRoutingConfig(netaDir(), rootFor(input.workspaceId)));
				} catch (error) {
					const reason =
						error instanceof Error && error.message.startsWith("Jev returned an invalid model selection:")
							? error.message
							: "Routing failed; inspect the delegation tool result for recovery instructions.";
					await o.store.appendEvent({
						workspaceId: input.workspaceId,
						kind: "routing.failed",
						data: { reason, effort: input.effort ?? null },
					});
					throw error;
				}
			},
			selectModel: async (input) => {
				const leader = leaderOf(input.workspaceId);
				if (leader.provider !== "opencode") return input;
				const selected = selectWorkerModel(input, await deps.modelCatalog(input.workspaceId));
				requireAllowedModel(loadModelPreferences(netaDir()), selected.model);
				return selected;
			},
			launch: async (input: SessionLaunch) => {
				const context = contextFor({
					canSpawn: input.canSpawn,
					access: input.access,
					task: input.task,
					skills: input.skills,
					root: rootFor(input.workspaceId),
				});
				if (input.provider === "pi" && o.pi !== undefined) {
					briefs.set(input.agentId, context);
					await o.pi.start({
						sessionId: input.sessionId,
						actorId: input.agentId,
						cwd: input.worktreePath ?? rootFor(input.workspaceId),
						prompt: context,
					});
					return { sessionId: input.sessionId };
				}
				const created = await o.runtime.createSession({
					sessionId: input.sessionId,
					workspaceId: input.workspaceId,
					cwd: input.worktreePath ?? rootFor(input.workspaceId),
					provider: input.provider,
					model: input.model,
					fallbackModels: input.fallbackModels ?? [],
					access: input.access,
					unsandboxed: input.canSpawn,
					netaTools: true,
					actorId: input.agentId,
				});
				briefs.set(input.agentId, context);
				return { sessionId: created.sessionId };
			},
			brief: async (input) => {
				const context = briefs.get(input.agentId);
				briefs.delete(input.agentId);
				if (input.provider === "pi" && o.pi !== undefined) {
					const agent = o.store.getAgent(input.agentId);
					if (agent !== undefined) {
						const running = { ...agent, state: "running" as const };
						await o.store.putAgent(running);
						o.hub().broadcast("state", { kind: "agent", record: running });
					}
					return;
				}
				await o.runtime.prompt(
					input.sessionId,
					input.provider === "opencode"
						? input.task
						: (context ??
								contextFor({
									canSpawn: input.canSpawn,
									access: input.access,
									task: input.task,
									skills: input.skills,
									root: rootFor(input.workspaceId),
								})),
				);
			},
			close: (sessionId) => o.runtime.close(sessionId),
			cancel: (sessionId) => o.runtime.cancel(sessionId),
			prompt: async (sessionId, text) => {
				await o.runtime.prompt(sessionId, text);
			},
		},
		modes: {
			// 07's `ModeService`, wired above: it owns the record, the
			// charter gate, the active-time clock and the reminders, and a
			// mission lead is a subject of its own — its mode never touches
			// the workspace leader's.
			requestMode: async (input) => {
				if (input.mode === "lead") {
					const sessionId =
						input.subject.kind === "lead"
							? o.store.getAgent(input.subject.agentId)?.sessionId
							: leaderOf(input.subject.workspaceId).sessionId;
					const missionId =
						input.subject.kind === "lead"
							? input.subject.missionId
							: o.store.getLeader(input.subject.workspaceId)?.activeMissionId;
					const mission = missionId === undefined ? undefined : o.store.getMission(missionId);
					if (sessionId === undefined || mission === undefined) {
						if (input.subject.kind === "leader") {
							const recovered = await recoverStaleWorkspaceLeaderLease(input.subject.workspaceId);
							if (recovered !== undefined) return { approved: true, recovered };
						}
						return { approved: false, reason: "unavailable", detail: "active mission session is unavailable" };
					}
					const holder = input.subject.kind === "lead" ? input.subject.agentId : mission.id;
					pendingModes.set(sessionId, { subject: input.subject, mode: "lead", mission, holder });
					if (o.runtime.isTurnActive?.(sessionId) === true) return { approved: true };
					try {
						await applyPendingMode(sessionId);
						return { approved: true };
					} catch (error) {
						return { approved: false, reason: "unavailable", detail: String(error) };
					}
				}
				if (input.record === undefined)
					return { approved: false, reason: "incompleteRecord", detail: "record is missing" };
				const assigned = o.store.getMission(input.record.missionId);
				if (
					assigned &&
					!distinctMissionLead(
						assigned,
						o.store.getLeader(assigned.workspaceId),
						assigned.lead.kind === "agent" ? o.store.getAgent(assigned.lead.agentId) : undefined,
					)
				)
					return {
						approved: false,
						reason: "notAuthorised",
						detail:
							"Close this legacy self-led mission and create a new mission with a separate lead task and effort.",
					};
				const approval = await modes.evaluateLeadPlus(input.subject, input.record);
				if (!approval.approved) return approval;
				const mission = o.store.getMission(input.record.missionId);
				const workspace = mission === undefined ? undefined : o.store.getWorkspace(mission.workspaceId);
				if (mission === undefined || workspace === undefined)
					return { approved: false, reason: "missionMissing", detail: "mission is unavailable" };
				const holder = input.subject.kind === "lead" ? input.subject.agentId : mission.id;
				if ((await worktrees.acquireWriter(mission, workspace, holder)) !== "active") {
					return { approved: false, reason: "unavailable", detail: "writer access is queued" };
				}
				const sessionId =
					input.subject.kind === "lead"
						? o.store.getAgent(input.subject.agentId)?.sessionId
						: leaderOf(input.subject.workspaceId).sessionId;
				if (sessionId === undefined) {
					await releaseHolder(input.subject.workspaceId, holder);
					return { approved: false, reason: "unavailable", detail: "session is unavailable" };
				}
				const prior = pendingModes.get(sessionId);
				if (prior !== undefined && prior.holder !== holder)
					await releaseHolder(prior.subject.workspaceId, prior.holder);
				pendingModes.set(sessionId, {
					subject: input.subject,
					mode: "leadPlus",
					record: input.record,
					mission,
					holder,
				});
				if (o.runtime.isTurnActive?.(sessionId) === true) return { approved: true };
				try {
					await applyPendingMode(sessionId);
					return { approved: true };
				} catch (error) {
					return { approved: false, reason: "unavailable", detail: String(error) };
				}
			},
			snapshot: (subject) => modes.snapshot(subject),
		},
	};

	const router = createRouter(deps, toolHandlers(), o.runtime.tokens);

	const resetting = new Set<string>();
	const creating = new Map<string, Set<Promise<unknown>>>();
	const handlers: NodeHandlers = {
		"runtime.retryReports": async (_ctx, params) => {
			const { agentId } = parseParams({ agentId: asString }, params);
			const actor = o.store.getAgent(agentId);
			if (!actor) throw new NodeError("NOT_FOUND", "No such agent");
			const pending = (await resultStore.pending()).filter((report) => report.actorId === agentId);
			for (const report of pending) dispatcher.enqueue(report);
			return { pending: pending.length, uncertain: actor.deliveryStatus === "uncertain" };
		},
		"workspace.reset": async (ctx, params, conn) => {
			const parsed = parseParams({ workspaceId: asString, confirm: asOptionalBoolean }, params);
			if (parsed.confirm !== true) throw new NodeError("INVALID_PARAMS", "workspace reset requires confirmation");
			if (resetting.has(parsed.workspaceId)) throw new NodeError("BUSY", "workspace reset is already running");
			resetting.add(parsed.workspaceId);
			try {
				await Promise.allSettled([...(creating.get(parsed.workspaceId) ?? [])]);
				for (const [id, pending] of pendingCloses)
					if (pending.subject.workspaceId === parsed.workspaceId) pendingCloses.delete(id);
				for (const [id, pending] of pendingModes)
					if (pending.subject.workspaceId === parsed.workspaceId) pendingModes.delete(id);
				for (const [id, agent] of pendingReleases)
					if (agent.workspaceId === parsed.workspaceId) pendingReleases.delete(id);
				await archiveWorkspace(ctx, parsed.workspaceId, { save: missions.save, release: releaseHolder });
				const reset = conversationHandlers["conversation.reset"];
				if (!reset) throw new NodeError("PROVIDER_ERROR", "chat reset is unavailable");
				return await reset(ctx, { sessionId: leaderOf(parsed.workspaceId).sessionId }, conn);
			} finally {
				resetting.delete(parsed.workspaceId);
			}
		},
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
			const actorWorkspace =
				o.store.getAgent(parsed.actorId)?.workspaceId ??
				o.store.listLeaders().find((leader) => leader.sessionId === parsed.actorId)?.workspaceId;
			if (actorWorkspace && resetting.has(actorWorkspace))
				throw new NodeError("BUSY", "workspace reset is in progress");
			const args = (params as { arguments?: unknown }).arguments ?? {};
			const call = router.call(parsed.actorId, parsed.token, parsed.name, args);
			if (actorWorkspace && ["neta_mission", "neta_agent", "neta_model"].includes(parsed.name)) {
				const pending = creating.get(actorWorkspace) ?? new Set<Promise<unknown>>();
				creating.set(actorWorkspace, pending);
				pending.add(call);
				try {
					return await call;
				} finally {
					pending.delete(call);
					if (pending.size === 0) creating.delete(actorWorkspace);
				}
			}
			return call;
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
			const missionId = parsed.missionId ?? leader.activeMissionId;
			const mission = missionId === undefined ? undefined : o.store.getMission(missionId);
			if (
				parsed.mode === "leadPlus" &&
				mission &&
				!distinctMissionLead(
					mission,
					leader,
					mission.lead.kind === "agent" ? o.store.getAgent(mission.lead.agentId) : undefined,
				)
			)
				throw new NodeError(
					"INVALID_PARAMS",
					`Mission #${mission.number} cannot resume self-led work. Close it and create a new mission with a separate lead task and effort.`,
				);
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
			const agent = subject.kind === "lead" ? o.store.getAgent(subject.agentId) : undefined;
			if (agent?.provider === "pi") {
				throw new NodeError("INVALID_PARAMS", "Pi mission mode changes are unavailable in this prototype");
			}
			const sessionId = agent?.sessionId ?? leader.sessionId;
			const pending = parsed.mode === "lead" ? pendingModes.get(sessionId) : undefined;
			if (parsed.mode === "lead") pendingModes.delete(sessionId);
			if (mission === undefined) {
				if (parsed.mode === "leadPlus") throw new NodeError("INVALID_PARAMS", "Lead++ requires an active mission");
				await o.runtime.ensureSession({
					sessionId,
					workspaceId: parsed.workspaceId,
					cwd: rootFor(parsed.workspaceId),
					provider: leader.provider,
					model: leader.model,
					access: "readOnly",
					unsandboxed: true,
					netaTools: true,
					allowFresh: false,
				});
				await modes.setMode(subject, "lead");
				return { leader: o.store.getLeader(parsed.workspaceId) ?? leader };
			}
			const workspace = o.store.getWorkspace(mission.workspaceId);
			if (workspace === undefined) throw new NodeError("NOT_FOUND", `no workspace for mission: ${mission.id}`);
			const holder = agent?.id ?? mission.id;
			if (pending !== undefined) await releaseHolder(mission.workspaceId, pending.holder);
			if (parsed.mode === "leadPlus" && (await worktrees.acquireWriter(mission, workspace, holder)) !== "active") {
				throw new NodeError("BUSY", "writer access is queued");
			}
			try {
				await o.runtime.ensureSession({
					sessionId,
					workspaceId: mission.workspaceId,
					cwd: mission.worktree?.path ?? rootFor(mission.workspaceId),
					provider: agent?.provider ?? leader.provider,
					model: agent?.model ?? leader.model,
					access: parsed.mode === "leadPlus" ? "readWrite" : "readOnly",
					unsandboxed: true,
					netaTools: true,
					...(agent === undefined ? {} : { actorId: agent.id }),
					forceRelaunch: true,
					allowFresh: false,
				});
				await modes.setMode(subject, parsed.mode);
			} catch (error) {
				if (parsed.mode === "leadPlus") await releaseHolder(mission.workspaceId, holder);
				throw error;
			}
			if (parsed.mode === "lead") await releaseHolder(mission.workspaceId, holder);
			return { leader: o.store.getLeader(parsed.workspaceId) ?? leader };
		},

		"agent.archive": async (_ctx: NodeContext, params: unknown) => {
			const parsed = parseParams({ agentId: asString, confirm: asOptionalBoolean }, params);
			const agent = o.store.getAgent(parsed.agentId);
			if (agent === undefined) throw new NodeError("NOT_FOUND", `no such agent: ${parsed.agentId}`);
			if ((agent.state === "starting" || agent.state === "running") && parsed.confirm !== true) {
				throw new NodeError("CONFIRMATION_REQUIRED", "archiving a live agent needs confirm: true");
			}
			if (agent.provider === "pi" && o.pi !== undefined) o.pi.close(agent.sessionId);
			else await o.runtime.close(agent.sessionId);
			const archived = { ...agent, state: "archived" as const };
			await o.store.putAgent(archived);
			await deps.sessions.release(archived);
			await o.store.appendEvent({
				workspaceId: agent.workspaceId,
				kind: "agent.archived",
				missionId: agent.missionId,
				agentId: agent.id,
				data: {},
			});
			o.hub().broadcast("state", { kind: "agent", record: archived });
			return { agent: archived };
		},
	};
	return {
		handlers,
		recordTurn,
		canDeliverInbox: async (message) => {
			if (message.readerDirected !== false || !message.sourceId) return true;
			if (message.sourceId.startsWith("followup:")) {
				const target = o.store.listAgents().find((agent) => agent.sessionId === message.sessionId);
				return (
					!runtimeStopped &&
					target !== undefined &&
					target.state !== "archived" &&
					o.store.getMission(target.missionId)?.state !== "closed"
				);
			}
			if (!/^[a-f0-9]{64}$/.test(message.sourceId)) return false;
			const report = await resultStore.get(message.sourceId);
			if (!report) return false;
			const actor = o.store.getAgent(report.actorId);
			const mission = o.store.getMission(report.missionId);
			const parent = report.parentActorId
				? o.store.getAgent(report.parentActorId)
				: o.store.getLeader(report.workspaceId);
			return (
				!runtimeStopped &&
				actor !== undefined &&
				actor.state !== "archived" &&
				mission !== undefined &&
				mission.state !== "closed" &&
				parent?.sessionId === message.sessionId
			);
		},
		recover: async () => {
			await recoverActorResults(o.store, o.real.conversations, recordTurn);
			for (const agent of o.store.listAgents()) {
				if (agent.state !== "queued") continue;
				const mission = o.store.getMission(agent.missionId);
				const workspace = o.store.getWorkspace(agent.workspaceId);
				if (!mission || !workspace || mission.state === "closed") continue;
				if ((await worktrees.acquireWriter(mission, workspace, agent.id)) === "active")
					await promote([{ promoted: agent.id }]);
			}
			for (const report of await resultStore.pending()) dispatcher.enqueue(report);
			for (const agent of o.store.listAgents()) {
				if (agent.state === "archived" || o.store.getMission(agent.missionId)?.state === "closed") continue;
				for (const item of await o.real.inbox.list(agent.sessionId)) {
					if (item.status === "queued" && item.sourceId?.startsWith("followup:"))
						await deps.sessions.send(agent, item.text, item.sourceId);
				}
			}
		},
		stop: () => {
			runtimeStopped = true;
			dispatcher.stop();
			clearInterval(ticker);
		},
	};
}
