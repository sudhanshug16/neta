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
import type { Access, Agent, AgentId, InboxMessage, Leader, Mission, Workspace, WorkspaceId } from "../core/types.ts";
import { canDeliverNetaNotice } from "../me/notice-delivery.ts";
import { openMeStore } from "../me/store.ts";

import { routingCredential } from "../routing/auth.ts";
import { createCatalog } from "../routing/catalog.ts";
import { loadRoutingConfig } from "../routing/config.ts";
import { loadModelPreferences, requireAllowedModel } from "../routing/preferences.ts";
import { createModelRouter } from "../routing/router.ts";
import type { Settings } from "../session/settings.ts";
import type { Store } from "../store/index.ts";
import { openParentReportStore } from "../store/parent-reports.ts";
import { composeContext, loadCharter, loadSkills } from "../tools/context.ts";
import type { CloseMissionInput, CloseOutcome } from "../tools/handlers/lifecycle.ts";
import type { MissionPorts, SessionLaunch } from "../tools/handlers/mission.ts";
import type { ModelPorts } from "../tools/handlers/model.ts";
import { toolHandlers } from "../tools/launch.ts";
import { createRouter, type SessionToolBridge, type ToolDeps } from "../tools/router.ts";
import {
	BASE_LEASE,
	createFileLeaseStore,
	createWorktreeService,
	LeaseManager,
	WorktrunkDriver,
} from "../worktrees/index.ts";
import { createAgentModelChanger } from "./agent-model.ts";
import { type ReportPorts, recordAgentRuntime } from "./agent-runtime.ts";
import { createFollowupSender } from "./followup.ts";
import { conversationHandlers } from "./handlers-conversation.ts";
import { asOptionalBoolean, asString, parseParams } from "./handlers-registry.ts";
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
	netaTools?: SessionToolBridge | ((actorId: string) => SessionToolBridge | undefined);
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

export function toolMount(o: ToolMountOptions): {
	handlers: NodeHandlers;
	stop(): void;
	recordTurn(notification: TurnNotification): Promise<void>;
	recover(): Promise<void>;
	canDeliverInbox(message: InboxMessage): Promise<boolean>;
	beforeTurn(sessionId: string): Promise<boolean>;
	afterTurn(sessionId: string): Promise<void>;
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
	function leaderOf(workspaceId: WorkspaceId): Leader {
		const leader = o.store.getLeader(workspaceId);
		if (leader === undefined) {
			throw new NodeError("NOT_FOUND", `no leader for workspace: ${workspaceId}`);
		}
		return leader;
	}

	// `announce` is what tells clients; it is off for 06's own saves, which
	// are mid-operation checkpoints the tool handler always follows with a
	// complete record (`prepare` then `dispatch_mission`'s save, `close` then
	// `close`'s). A mission created with a worktree would otherwise
	// reach the spine twice: once half-built by `prepare`, once whole. The
	// one 06 call with no announcing follow-up is `refreshIntegration`, which
	// nothing calls yet; whoever wires it announces its own save.
	async function saveMission(mission: Mission, announce = true): Promise<void> {
		const existing = await o.real.missions.get(mission.workspaceId, mission.id);
		if (mission.lead.kind === "agent") {
			const leader = o.store.getLeader(mission.workspaceId);
			const lead = o.store.getAgent(mission.lead.agentId);
			// Both the worktree close callback and close save the terminal record.
			// A saved historical alias may pass through those saves without assigning
			// or reviving its lead; every active save still requires distinct identities.
			const historicalClose =
				mission.state === "closed" &&
				existing?.lead.kind === "agent" &&
				existing.lead.agentId === mission.lead.agentId;
			if (
				!historicalClose &&
				(!lead ||
					lead.missionId !== mission.id ||
					lead.workspaceId !== mission.workspaceId ||
					!lead.canSpawn ||
					!mission.agentIds.includes(lead.id) ||
					!distinctMissionLead(mission, leader, lead))
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
			// `dispatch_mission` checked these names against this same root before
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

	const admittedWriters = new Map<string, { workspaceId: string; holder: string }>();

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
			if (runtimeStopped) return;
			const promoted = pending.shift()?.promoted;
			if (promoted === undefined) continue;
			const leader = o.store.listLeaders().find((l) => l.sessionId === promoted);
			if (leader) {
				o.runtime.wakeInbox(leader.sessionId);
				continue;
			}
			const next = o.store.getAgent(promoted);
			const mission = next === undefined ? undefined : o.store.getMission(next.missionId);
			if (next === undefined || mission === undefined || next.state === "archived" || mission.state === "closed") {
				if (next !== undefined) pending.push(...(await worktrees.releaseWriter(next.workspaceId, next.id)));
				continue;
			}
			if (next.state !== "queued") {
				o.runtime.wakeInbox(next.sessionId);
				continue;
			}
			let sessionId = next.sessionId;
			let createdSession = false;
			try {
				const request = {
					deferInbox: true,
					sessionId,
					workspaceId: next.workspaceId,
					cwd: mission.worktree?.path ?? rootFor(next.workspaceId),
					provider: next.provider,
					model: next.model,
					variant: next.variant,
					fallbackModels: next.fallbackModels ?? [],
					access: next.access,
					unsandboxed: next.canSpawn,
					netaTools: true,
					actorId: next.id,
				};
				const created =
					next.stateBefore !== undefined
						? await o.runtime.ensureSession({ ...request, deferInbox: false, allowFresh: false })
						: await o.runtime.createSession(request);
				sessionId = created.sessionId;
				createdSession = true;
				const starting = { ...next, sessionId, state: "starting" as const };
				await o.store.putAgent(starting);
				o.hub().broadcast("state", { kind: "agent", record: starting });
				if (next.stateBefore !== undefined) {
					o.runtime.wakeInbox(sessionId);
					continue;
				}
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
				if (runtimeStopped) {
					const stopped = {
						...next,
						sessionId,
						state: createdSession ? ("interrupted" as const) : ("queued" as const),
						...(createdSession ? { stateBefore: "starting" as const } : {}),
						runtimeError: undefined,
					};
					await o.store.putAgent(stopped);
					await leases.interrupt(next.workspaceId, next.id);
					continue;
				}
				const failed = {
					...next,
					sessionId,
					state: "failed" as const,
					endedAt: nowIso(),
					runtimeError: String(error),
				};
				await o.store.putAgent(failed);
				o.hub().broadcast("state", { kind: "agent", record: failed });
				pending.push(...(await worktrees.releaseWriter(failed.workspaceId, failed.id)));
			}
		}
	}
	async function releaseHolder(workspaceId: WorkspaceId, holder: string): Promise<void> {
		if (runtimeStopped) {
			await leases.interrupt(workspaceId, holder);
			return;
		}
		if (resetting.has(workspaceId)) {
			await worktrees.releaseWriter(workspaceId, holder);
			return;
		}
		const leave = o.runtimeAdmission?.enter();
		try {
			await promote(await worktrees.releaseWriter(workspaceId, holder));
		} finally {
			leave?.();
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
			await o.real.inbox.enqueue(sessionId, text, [], { readerDirected: false, sourceId });
			const parentMission = parentAgent ? o.store.getMission(parentAgent.missionId) : undefined;
			const selected = await o.runtime.ensureSession({
				sessionId,
				workspaceId: parent.workspaceId,
				cwd: parentMission?.worktree?.path ?? rootFor(parent.workspaceId),
				provider: parent.provider,
				model: parent.model,
				variant: parentAgent?.variant,
				...(parentAgent ? { fallbackModels: parentAgent.fallbackModels ?? [] } : {}),
				access: parentAgent?.access ?? "readWrite",
				unsandboxed: true,
				netaTools: true,
				actorId: parentAgent?.id,
				allowFresh: false,
			});
			sessionId = selected.sessionId;
			// The durable inbox admits during an active turn, or wakes an idle parent.
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
		if (receipt?.sourceId?.startsWith("neta-notice:")) {
			const store = openMeStore();
			const id = receipt.sourceId.slice("neta-notice:".length);
			void store
				.getNotice(id)
				.then((n) => n && store.recordNoticeDelivery(id, receipt))
				.catch((error) =>
					o.hub().broadcast("error", { message: `Could not record filter delivery: ${String(error)}` }),
				);
		}
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

	const missions: MissionPorts["missions"] = { save: (mission) => saveMission(mission) };

	const deps: ToolDeps &
		MissionPorts &
		ModelPorts & {
			sessions: {
				context(sessionId: string): Promise<{ turnId?: string; incoming: string[] }>;
				send(agent: Agent, text: string, sourceId: string): Promise<InboxMessage>;
				release(agent: Agent): Promise<void>;
				resume(agent: Agent): Promise<Agent>;
				failed(agent: Agent): Promise<void>;
				cancel(sessionId: string): Promise<void>;
				prompt(sessionId: string, text: string): Promise<void>;
			};
			worktrees: { close(input: CloseMissionInput): Promise<CloseOutcome> };
			modelCatalog(
				workspaceId: WorkspaceId,
			): Promise<{ provider: string; id: string; name: string; variants?: string[] }[]>;
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
				apply: async (agent, model, variant) => {
					const mission = o.store.getMission(agent.missionId);
					if (!mission) throw new NodeError("NOT_FOUND", "No mission for this agent.");
					const live = await o.runtime.ensureSession({
						sessionId: agent.sessionId,
						workspaceId: agent.workspaceId,
						cwd: mission.worktree?.path ?? rootFor(agent.workspaceId),
						provider: agent.provider,
						model: agent.model,
						variant: agent.variant,
						fallbackModels: [],
						access: agent.access,
						unsandboxed: agent.canSpawn,
						netaTools: true,
						actorId: agent.id,
						allowFresh: false,
					});
					if (live.sessionId !== agent.sessionId)
						throw new NodeError("PROVIDER_ERROR", "Model changes must keep the original conversation.");
					try {
						if (agent.model !== model) await o.runtime.setModel(agent.sessionId, model);
						if (agent.variant !== variant || (agent.model !== model && variant !== undefined)) {
							if (!o.runtime.setNativeVariant)
								throw new NodeError("PROVIDER_ERROR", "OpenCode thinking level control is unavailable.");
							await o.runtime.setNativeVariant(agent.sessionId, variant);
						}
					} catch (error) {
						if (agent.model !== model) {
							try {
								await o.runtime.setModel(agent.sessionId, agent.model);
								if (agent.variant !== undefined)
									await o.runtime.setNativeVariant?.(agent.sessionId, agent.variant);
							} catch {
								throw new NodeError(
									"PROVIDER_ERROR",
									"Changing the thinking level failed and the previous model could not be restored. Inspect the native session before retrying.",
								);
							}
						}
						throw error;
					}
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
		numbers: {
			allocateNumber: (workspaceId) => o.real.missions.allocateNumber(workspaceId),
			isAllocated: (workspaceId, number) => o.real.missions.isAllocated(workspaceId, number),
		},
		missions,
		// Against the workspace root, never `process.cwd()`: the Node is
		// detached from wherever it was started, and a skill lives in
		// `<root>/.neta/skills`. `contextFor` resolves the same way, so what
		// `dispatch_mission` accepts is what the agent is briefed with.
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
				return worktrees.close({
					...input,
					writerSessionId: o.store.getLeader(input.mission.workspaceId)?.sessionId,
					repositoryRoot: rootFor(input.mission.workspaceId),
				});
			},
		},
		sessions: {
			context: async (sessionId) => {
				const turnId = (await o.runtime.runtimeDiagnostics?.(sessionId))?.turnId;
				const incoming = ((await o.runtime.listInbox?.(sessionId)) ?? []).filter(
					(m) =>
						m.turnId === turnId &&
						(m.readerDirected === true ||
							m.sourceId?.startsWith("message:") ||
							m.sourceId?.startsWith("followup:")),
				);
				return { turnId, incoming: incoming.map((m) => m.text) };
			},
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
							`Mission #${mission.number} cannot resume: its lead aliases the coordinator. Close it and create a new mission with a separate lead task and effort.`,
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
			failed: releaseAndPromote,
			resume: async (agent) => {
				const mission = o.store.getMission(agent.missionId);
				if (mission === undefined) throw new NodeError("NOT_FOUND", `no mission for agent: ${agent.id}`);
				try {
					const live = await o.runtime.ensureSession({
						sessionId: agent.sessionId,
						workspaceId: agent.workspaceId,
						cwd: mission.worktree?.path ?? rootFor(agent.workspaceId),
						provider: agent.provider,
						model: agent.model,
						variant: agent.variant,
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
				await releaseAndPromote(agent);
			},
			// The session only: 05 writes the Agent record next, and `brief`
			// sends the context prompt after it. The token is minted under
			// the agent id, which is the actor id the router resolves.
			//
			// The context is composed here, before anything launches, and
			// held for `brief`: it is what resolves the skill files, and 05
			// T5.8 is "a `missingSkill` error and the agent is not spawned".
			// Resolving it in `brief` instead left a file that vanished
			// between `dispatch_mission`'s check and the brief throwing after the
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
					variant: input.variant,
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
	};

	const router = createRouter(deps, toolHandlers(), o.runtime.tokens, o.netaTools);

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
				await archiveWorkspace(ctx, parsed.workspaceId, {
					save: missions.save,
					release: releaseHolder,
					close: (input) => worktrees.close(input),
				});
				const reset = conversationHandlers["conversation.reset"];
				if (!reset) throw new NodeError("PROVIDER_ERROR", "chat reset is unavailable");
				return await reset(ctx, { sessionId: leaderOf(parsed.workspaceId).sessionId }, conn);
			} finally {
				resetting.delete(parsed.workspaceId);
				// Reset can promote a queued coordinator writer without starting it.
				// Once the reset is over, let its saved inbox continue.
				const leader = o.store.getLeader(parsed.workspaceId);
				if (leader) o.runtime.wakeInbox(leader.sessionId);
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
			if (actorWorkspace && ["dispatch_mission", "spawn_agent", "change_model"].includes(parsed.name)) {
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
		beforeTurn: async (sessionId) => {
			const agent = o.store.listAgents().find((a) => a.sessionId === sessionId);
			const leader = o.store.listLeaders().find((l) => l.sessionId === sessionId);
			if (agent?.access === "readOnly" || (!agent && !leader)) return true;
			if (agent) {
				const mission = o.store.getMission(agent.missionId);
				const workspace = o.store.getWorkspace(agent.workspaceId);
				if (!mission || !workspace || mission.state === "closed" || agent.state === "archived")
					throw new Error("Actor is archived");
				const active = (await worktrees.acquireWriter(mission, workspace, agent.id)) === "active";
				if (active) admittedWriters.set(sessionId, { workspaceId: agent.workspaceId, holder: agent.id });
				return active;
			}
			if (!leader) return true;
			const workspace = o.store.getWorkspace(leader.workspaceId);
			const key = workspace?.kind === "git" ? BASE_LEASE : rootFor(leader.workspaceId);
			const active = (await leases.acquire(leader.workspaceId, leader.sessionId, key)) === "active";
			if (active) admittedWriters.set(sessionId, { workspaceId: leader.workspaceId, holder: leader.sessionId });
			return active;
		},
		afterTurn: async (sessionId) => {
			const writer = admittedWriters.get(sessionId);
			if (!writer) return;
			admittedWriters.delete(sessionId);
			await releaseHolder(writer.workspaceId, writer.holder);
		},
		canDeliverInbox: async (message) => {
			if (message.readerDirected !== false || !message.sourceId) return true;
			if (message.sourceId.startsWith("filter-context:") || message.sourceId.startsWith("filter-decision:")) {
				const filter = await openMeStore().filterBySession(message.sessionId);
				if (!filter || runtimeStopped) return false;
				if (message.sourceId.startsWith("filter-context:")) return true;
				const notice = await openMeStore().getNotice(
					message.sourceId.slice("filter-decision:".length).split(":")[0] ?? "",
				);
				return (
					notice?.workspaceId === filter.workspaceId &&
					(notice.state === "awaiting filter" ||
						(notice.state === "deferred" &&
							notice.decision?.action === "defer" &&
							Date.parse(notice.decision.until) <= Date.now()))
				);
			}
			if (message.sourceId.startsWith("neta-notice:"))
				return !runtimeStopped && canDeliverNetaNotice(message, openMeStore(), o.store.machine().id);
			if (message.sourceId.startsWith("message:"))
				return !runtimeStopped && o.store.listLeaders().some((l) => l.sessionId === message.sessionId);
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
			if (!report || report.createdAt < (await openMeStore().cutoverAt())) return false;
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
			const cutoff = await openMeStore().cutoverAt();
			await recoverActorResults(o.store, o.real.conversations, (notification) =>
				notification.turn && notification.turn.startedAt < cutoff ? Promise.resolve() : recordTurn(notification),
			);
			for (const agent of o.store.listAgents()) {
				if (agent.state !== "queued") continue;
				const mission = o.store.getMission(agent.missionId);
				const workspace = o.store.getWorkspace(agent.workspaceId);
				if (!mission || !workspace || mission.state === "closed") continue;
				if ((await worktrees.acquireWriter(mission, workspace, agent.id)) === "active")
					await promote([{ promoted: agent.id }]);
			}
			for (const report of await resultStore.pending()) {
				if (report.createdAt < cutoff) await resultStore.settle(report.id, "suppressed");
				else dispatcher.enqueue(report);
			}
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
		},
	};
}
