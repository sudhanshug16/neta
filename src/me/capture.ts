import { createHash } from "node:crypto";
import type { Agent, Block, Event, Leader, Mission, Turn, Workspace } from "../core/types.ts";
import type { MeSource, MeStore } from "./store.ts";

export interface MeEventSourceContext {
	machineId?: string;
	workspaces: readonly Workspace[];
	leaders: readonly Leader[];
	agents: readonly Agent[];
	missions: readonly Mission[];
}

const relevantKinds = new Set<Event["kind"]>([
	"mission.blocked",
	"mission.unblocked",
	"mission.failed",
	"worktree.setupFailed",
	"artifact.published",
	"artifact.reviewed",
	"mission.readyToClose",
	"mission.merged",
	"agent.finished",
	"routing.failed",
	"node.restarted",
]);

/** Capture only attention-relevant Neta lifecycle events; Luna makes the fallible feed decision later. */
export async function captureMeEvent(store: MeStore, event: Event, context: MeEventSourceContext): Promise<boolean> {
	if (!relevantKinds.has(event.kind)) return false;
	const workspace = context.workspaces.find((item) => item.id === event.workspaceId);
	const leader = context.leaders.find((item) => item.workspaceId === event.workspaceId);
	if (!workspace || !leader) return false;
	const agent = event.agentId ? context.agents.find((item) => item.id === event.agentId) : undefined;
	const mission = event.missionId ? context.missions.find((item) => item.id === event.missionId) : undefined;
	if (event.kind === "mission.blocked" && agent && event.data.userEscalation !== true) return false; // Questions travel through the parent chain before Neta sees them.
	if (
		event.kind === "mission.unblocked" &&
		agent &&
		!agent.canSpawn &&
		mission?.lead.kind !== "leader" &&
		(typeof event.data.questionId !== "string" ||
			!(await store.hasVisibleQuestion(event.workspaceId, event.data.questionId)))
	)
		return false;
	const sessionId = event.sessionId ?? agent?.sessionId ?? leader.sessionId;
	const actorKind = sessionId === leader.sessionId ? "leader" : agent?.canSpawn ? "missionLead" : "agent";
	const explicit = event.data.userEscalation === true || event.data.needsReply === true;
	const kind: MeSource["kind"] =
		event.kind === "mission.failed" || event.kind === "worktree.setupFailed" || event.kind === "routing.failed"
			? "failure"
			: "event";
	const text = [
		event.kind,
		event.kind === "worktree.setupFailed" && typeof event.data.number === "number"
			? `Mission setup #${event.data.number} failed before registration`
			: undefined,
		mission ? `Mission #${mission.number}: ${mission.name}` : undefined,
		agent ? `Agent: ${agent.name}` : undefined,
		event.kind === "artifact.published" && typeof event.data.artifactId === "string"
			? `Artifact ${event.data.artifactId}: ${typeof event.data.title === "string" ? event.data.title : "untitled"}`
			: undefined,
		event.kind === "artifact.reviewed" && typeof event.data.artifactId === "string"
			? `Artifact ${event.data.artifactId} review: ${String(event.data.verdict)}. ${typeof event.data.note === "string" ? event.data.note.slice(0, 1_200) : ""}`
			: undefined,
		event.kind === "worktree.setupFailed" && typeof event.data.stderr === "string"
			? event.data.stderr.slice(0, 4_096)
			: undefined,
		event.kind === "worktree.setupFailed" && typeof event.data.diagnosticPath === "string"
			? `Diagnostic: ${event.data.diagnosticPath}`
			: undefined,
		typeof event.data.question === "string"
			? `Question${typeof event.data.questionId === "string" ? ` ${event.data.questionId}` : ""}: ${event.data.question}`
			: undefined,
		typeof event.data.resolution === "string" ? `Resolution: ${event.data.resolution.slice(0, 1_200)}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	if (!text) return false;
	const destinations = [...new Set([sessionId, leader.sessionId])];
	const captured = await store.capture({
		id: "",
		workspaceId: event.workspaceId,
		...(context.machineId
			? { machineId: context.machineId }
			: mission?.machineId
				? { machineId: mission.machineId }
				: {}),
		workspaceName: workspace.name,
		sessionId,
		actorKind,
		kind,
		at: event.at,
		text: text.slice(0, 8_000),
		eventId:
			event.kind === "artifact.reviewed" && typeof event.data.artifactId === "string"
				? `artifact-review:${event.data.artifactId}`
				: `${event.workspaceId}:${event.seq}`,
		explicit,
		...(explicit || event.kind === "worktree.setupFailed" ? { forceVisible: true } : {}),
		destinationSessionIds: destinations,
		...(event.missionId ? { missionId: event.missionId } : {}),
		...(typeof event.data.questionId === "string" ? { questionId: event.data.questionId } : {}),
		...((event.kind === "artifact.published" || event.kind === "artifact.reviewed") &&
		typeof event.data.artifactId === "string"
			? { artifactIds: [event.data.artifactId] }
			: {}),
	});
	return captured.id.length > 0;
}

/** Replay strictly after the durable high-water mark and checkpoint only after capture succeeds. */
export async function replayMeEvents(input: {
	store: MeStore;
	workspaceId: string;
	read: (sinceSeq: number, limit: number) => Promise<Event[]>;
	context: () => MeEventSourceContext;
}): Promise<number> {
	const checkpoint = (await input.store.getCheckpoint()).workspaces.find(
		(item) => item.workspaceId === input.workspaceId,
	);
	let sequence = checkpoint?.eventSeq ?? 0;
	let captured = 0;
	for (;;) {
		const events = await input.read(sequence, 200);
		if (!events.length) return captured;
		for (const event of events) {
			if (event.workspaceId !== input.workspaceId || event.seq <= sequence) continue;
			await captureMeEvent(input.store, event, input.context());
			sequence = event.seq;
			await input.store.setCheckpoint({
				workspaces: [{ workspaceId: input.workspaceId, eventSeq: sequence, turns: [] }],
			});
			if (relevantKinds.has(event.kind)) captured++;
		}
		if (events.length < 200) return captured;
	}
}

export async function captureMeLeaderTurn(input: {
	store: MeStore;
	workspace: Workspace;
	machineId?: string;
	sessionId: string;
	turn: Turn;
	blocks: readonly Block[];
}): Promise<boolean> {
	if (!input.turn.endedAt || input.turn.cancelled || input.turn.sessionId !== input.sessionId) return false;
	const blocks = input.blocks.filter(
		(block) => block.turnId === input.turn.id && block.role === "agent" && block.kind === "text",
	);
	const text = blocks.map((block) => block.text).join("\n\n");
	if (!text.trim() && !input.turn.failed && !input.turn.readerDirected) return false;
	const firstSeq = blocks[0]?.seq;
	const lastSeq = blocks.at(-1)?.seq;
	const sourceText =
		text ||
		(input.turn.failed
			? "Workspace leader runtime turn failed."
			: "Workspace leader turn completed without a text report. Work outcome is unknown.");
	const sourceHash = createHash("sha256").update(sourceText).digest("hex");
	const captured = await input.store.capture({
		id: "",
		workspaceId: input.workspace.id,
		...(input.machineId ? { machineId: input.machineId } : {}),
		workspaceName: input.workspace.name,
		sessionId: input.sessionId,
		actorKind: "leader",
		kind: input.turn.failed ? "failure" : "message",
		at: input.turn.endedAt,
		text: sourceText.slice(0, 8_000),
		turnId: input.turn.id,
		explicit: false,
		destinationSessionIds: [input.sessionId],
		...(firstSeq === undefined || lastSeq === undefined
			? {}
			: { transcriptPointer: { sessionId: input.sessionId, turnId: input.turn.id, firstSeq, lastSeq, sourceHash } }),
	});
	return captured.id.length > 0;
}

export async function captureMePermissionRequest(input: {
	store: MeStore;
	workspace: Workspace;
	machineId?: string;
	sessionId: string;
	actorKind: MeSource["actorKind"];
	missionId?: string;
	request: { id: string; action: string; resources: string[]; message?: string };
	disposition: "once" | "reject";
}): Promise<MeSource> {
	const resources = input.request.resources.slice(0, 12).map((resource) => resource.slice(0, 240));
	const text = [
		`OpenCode permission request for ${input.request.action}.`,
		resources.length ? `Resources: ${resources.join(", ")}` : undefined,
		input.request.message ? `Request message: ${input.request.message.slice(0, 1_000)}` : undefined,
		`Existing runtime policy disposition: ${input.disposition === "once" ? "accepted once" : "rejected"}.`,
	]
		.filter((part): part is string => part !== undefined)
		.join("\n");
	return input.store.capture({
		id: "",
		workspaceId: input.workspace.id,
		...(input.machineId ? { machineId: input.machineId } : {}),
		workspaceName: input.workspace.name,
		sessionId: input.sessionId,
		actorKind: input.actorKind,
		kind: "permission",
		at: new Date().toISOString(),
		text: text.slice(0, 8_000),
		eventId: `permission:${input.request.id}`,
		explicit: true,
		forceVisible: true,
		destinationSessionIds: [input.sessionId],
		...(input.missionId ? { missionId: input.missionId } : {}),
	});
}

/** Replay whole completed turns; leave a split turn buffered until its final block is read. */
export async function replayMeLeaderTurns(input: {
	store: MeStore;
	workspace: Workspace;
	machineId?: string;
	sessionId: string;
	read: (byteCursor: number) => Promise<{ blocks: Block[]; cursor: number; more: boolean }>;
	getTurn: (turnId: string) => Promise<Turn | undefined>;
}): Promise<number> {
	const cursors =
		(await input.store.getCheckpoint()).workspaces.find((item) => item.workspaceId === input.workspace.id)?.turns ??
		[];
	let cursor = Math.max(
		0,
		...cursors.filter((item) => item.sessionId === input.sessionId).map((item) => item.blockSeq ?? 0),
	);
	let pageCursor = 0;
	let pending: Block[] = [];
	let pendingTurn: Turn | undefined;
	let captured = 0;
	for (;;) {
		const page = await input.read(pageCursor);
		for (const block of page.blocks) {
			if (block.seq <= cursor) continue;
			if (pendingTurn && pendingTurn.id !== block.turnId) {
				await captureMeLeaderTurn({
					store: input.store,
					workspace: input.workspace,
					machineId: input.machineId,
					sessionId: input.sessionId,
					turn: pendingTurn,
					blocks: pending,
				});
				cursor = pending.at(-1)?.seq ?? cursor;
				await input.store.setCheckpoint({
					workspaces: [
						{
							workspaceId: input.workspace.id,
							eventSeq: 0,
							turns: [{ sessionId: input.sessionId, turnId: pendingTurn.id, blockSeq: cursor }],
						},
					],
				});
				captured++;
				pending = [];
				pendingTurn = undefined;
			}
			if (!pendingTurn) pendingTurn = await input.getTurn(block.turnId);
			if (pendingTurn) pending.push(block);
		}
		if (!page.more) break;
		pageCursor = page.cursor;
	}
	if (pendingTurn && pending.length) {
		await captureMeLeaderTurn({
			store: input.store,
			workspace: input.workspace,
			machineId: input.machineId,
			sessionId: input.sessionId,
			turn: pendingTurn,
			blocks: pending,
		});
		cursor = pending.at(-1)?.seq ?? cursor;
		await input.store.setCheckpoint({
			workspaces: [
				{
					workspaceId: input.workspace.id,
					eventSeq: 0,
					turns: [{ sessionId: input.sessionId, turnId: pendingTurn.id, blockSeq: cursor }],
				},
			],
		});
		captured++;
	}
	return captured;
}
