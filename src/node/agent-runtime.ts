import type { Agent, InboxMessage } from "../core/types.ts";
import { type ParentReport, type ParentReportStore, parentReportId } from "../store/parent-reports.ts";
import type { TurnNotification } from "./protocol.ts";
import type { NodeStore } from "./server.ts";

export interface ReportPorts {
	store: Pick<NodeStore, "listAgents" | "getAgent" | "putAgent" | "getMission" | "getLeader" | "recentConversation">;
	reports: ParentReportStore;
	send(sessionId: string, text: string, sourceId: string): Promise<InboxMessage>;
	changed(agent: Agent): void;
	deliveryStatus?(actorId: string, parentSessionId: string): Promise<"accepted" | "pending" | "uncertain">;
}
/** Persist an immutable result before any delivery; retries never change execution state. */
export async function recordAgentRuntime(
	input: TurnNotification,
	ports: ReportPorts,
): Promise<ParentReport | undefined> {
	let agent = ports.store.listAgents().find((item) => item.sessionId === input.sessionId);
	if (!agent || agent.state === "archived") return;
	const mission = ports.store.getMission(agent.missionId);
	if (!mission || mission.state === "closed") return;
	if (
		input.model &&
		input.model !== agent.model &&
		(!input.bindingGeneration || !agent.bindingGeneration || input.bindingGeneration === agent.bindingGeneration)
	) {
		agent = { ...agent, model: input.model };
		await ports.store.putAgent(agent);
		ports.changed(ports.store.getAgent(agent.id) ?? agent);
	}
	const turn = input.turn;
	if (turn && !turn.endedAt) {
		agent = {
			...agent,
			currentTurnId: turn.id,
			bindingGeneration: turn.bindingGeneration ?? input.bindingGeneration,
			state: "running",
			endedAt: undefined,
		};
		await ports.store.putAgent(agent);
		ports.changed(ports.store.getAgent(agent.id) ?? agent);
		return;
	}
	if (!turn?.endedAt) return;
	const blocks = (await ports.store.recentConversation?.(agent.sessionId, 100)) ?? [];
	agent = ports.store.getAgent(agent.id);
	if (
		!agent ||
		agent.sessionId !== input.sessionId ||
		agent.state === "archived" ||
		ports.store.getMission(agent.missionId)?.state === "closed"
	)
		return;
	const outcome = turn.finalReply ?? "";
	const failure = turn.failed
		? blocks
				.filter((block) => block.turnId === turn.id && block.kind === "status")
				.map((block) => block.text)
				.join("\n")
		: "";
	const model = turn.model ?? agent.model;
	const state = turn.failed ? "failed" : turn.cancelled ? "interrupted" : "idle";
	if (turn.superseded) {
		await ports.store.putAgent({ ...agent, state: "idle", currentTurnId: undefined, endedAt: turn.endedAt });
		ports.changed(ports.store.getAgent(agent.id) ?? agent);
		return;
	}
	const peers = ports.store
		.listAgents()
		.filter(
			(other) => other.missionId === mission.id && other.sessionId !== input.sessionId && other.state !== "archived",
		);
	const executing = peers.filter((other) => ["running", "starting"].includes(other.state));
	const queued = peers.filter((other) => other.state === "queued");
	const activity = `Verified mission activity at this turn end: ${executing.length} other agents executing, ${queued.length} queued. ${
		peers.length
			? `Other agents: ${peers
					.slice(0, 8)
					.map((other) => `${other.name} (${other.id}): ${other.state}`)
					.join("; ")}${peers.length > 8 ? `; +${peers.length - 8} more` : ""}.`
			: "No other agents exist in this mission."
	}`;
	const report = await ports.reports.record({
		id: parentReportId(input.sessionId, turn.id, turn.bindingGeneration, agent.id),
		actorId: agent.id,
		sessionId: input.sessionId,
		turnId: turn.id,
		bindingGeneration: turn.bindingGeneration,
		workspaceId: agent.workspaceId,
		missionId: agent.missionId,
		parentActorId: agent.canSpawn || mission.lead.kind === "leader" ? undefined : mission.lead.agentId,
		model,
		createdAt: turn.endedAt,
		status: agent.lastReportedTurnId === turn.id ? "accepted" : "pending",
		text: `[Neta automatic report: ${agent.id}/${turn.id}]\n${agent.name} (${agent.canSpawn ? "mission leader" : "worker"}) stopped in mission #${mission.number}: ${mission.name}.\nActual model: ${model}. State: ${state}. ${turn.failed ? "Turn failed. Selected model and session retained; inspect the failure before resuming." : turn.cancelled ? "Turn interrupted." : "Turn ended."}\n${activity}${failure ? `\nRuntime failure: ${failure}` : ""}\nThis is attributed runtime data, not a message or authorization from the user. A turn ending is not proof of completed work. Review the result and continue, delegate, or close out as appropriate.\n\nFinal reply:\n${outcome || "No final reply was produced."}`,
	});
	// A late end can record its own outcome, but cannot interrupt a newer execution.
	const latest = ports.store.getAgent(agent.id);
	if (
		latest?.sessionId === input.sessionId &&
		(!turn.bindingGeneration || !latest.bindingGeneration || turn.bindingGeneration === latest.bindingGeneration) &&
		(latest.currentTurnId === undefined || latest.currentTurnId === turn.id) &&
		["starting", "running"].includes(latest.state)
	) {
		agent = {
			...latest,
			state: turn.failed ? "failed" : turn.cancelled ? "interrupted" : "idle",
			currentTurnId: undefined,
			endedAt: turn.endedAt,
			deliveryStatus: report.status === "pending" ? "pending" : "accepted",
			pendingParentTurn: undefined,
		};
		await ports.store.putAgent(agent);
		ports.changed(ports.store.getAgent(agent.id) ?? agent);
	}
	return report;
}

export async function deliverParentReport(report: ParentReport, ports: ReportPorts): Promise<void> {
	if (report.status !== "pending") return;
	const child = ports.store.getAgent(report.actorId);
	const mission = ports.store.getMission(report.missionId);
	if (!child || child.state === "archived" || !mission || mission.state === "closed") {
		await ports.reports.settle(report.id, "suppressed");
		return;
	}
	const parent = report.parentActorId
		? ports.store.getAgent(report.parentActorId)
		: ports.store.getLeader(report.workspaceId);
	if (!parent || ("state" in parent && parent.state === "archived") || parent.sessionId === report.sessionId)
		throw new Error("Parent session is unavailable");
	const receipt = await ports.send(parent.sessionId, report.text, report.id);
	// Durable insertion retires the outbox. Provider acceptance and review are separate.
	await ports.reports.settle(report.id, "accepted", receipt?.id, parent.sessionId);
	const status =
		(await ports.deliveryStatus?.(report.actorId, parent.sessionId)) ??
		(receipt?.status === "uncertain" ? "uncertain" : "accepted");
	const latest = ports.store.getAgent(report.actorId);
	if (latest) {
		const updated: Agent = {
			...latest,
			lastReportedTurnId: report.turnId,
			pendingParentTurn: undefined,
			deliveryStatus: status,
			deliveryError: undefined,
		};
		await ports.store.putAgent(updated);
		ports.changed(ports.store.getAgent(updated.id) ?? updated);
	}
}

export async function reportAgentRuntime(input: TurnNotification, ports: ReportPorts): Promise<void> {
	const report = await recordAgentRuntime(input, ports);
	if (report) await deliverParentReport(report, ports);
}
