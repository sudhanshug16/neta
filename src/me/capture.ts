import { createHash } from "node:crypto";
import type { Agent, Block, Event, Leader, Mission, Turn, Workspace } from "../core/types.ts";
import type { MeSource, MeStore } from "./store.ts";

export interface MeEventSourceContext {
	workspaces: readonly Workspace[];
	leaders: readonly Leader[];
	agents: readonly Agent[];
	missions: readonly Mission[];
}

const relevantKinds = new Set<Event["kind"]>([
	"mission.blocked",
	"mission.failed",
	"mission.readyToClose",
	"mission.merged",
	"agent.finished",
	"routing.failed",
	"node.restarted",
]);

/** Capture only attention-relevant Neta lifecycle events; Luna makes the fallible feed decision later. */
export async function captureMeEvent(store: MeStore, event: Event, context: MeEventSourceContext): Promise<void> {
	if (!relevantKinds.has(event.kind)) return;
	const workspace = context.workspaces.find((item) => item.id === event.workspaceId);
	const leader = context.leaders.find((item) => item.workspaceId === event.workspaceId);
	if (!workspace || !leader) return;
	const agent = event.agentId ? context.agents.find((item) => item.id === event.agentId) : undefined;
	const mission = event.missionId ? context.missions.find((item) => item.id === event.missionId) : undefined;
	const sessionId = event.sessionId ?? agent?.sessionId ?? leader.sessionId;
	const actorKind = sessionId === leader.sessionId ? "leader" : agent?.canSpawn ? "missionLead" : "agent";
	const explicit = event.data.userEscalation === true || event.data.needsReply === true;
	const kind: MeSource["kind"] =
		event.kind === "mission.failed" || event.kind === "routing.failed" ? "failure" : "event";
	const text = [
		event.kind,
		mission ? `Mission #${mission.number}: ${mission.name}` : undefined,
		agent ? `Agent: ${agent.name}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	if (!text) return;
	const destinations = [...new Set([sessionId, leader.sessionId])];
	await store.capture({
		id: "",
		workspaceId: event.workspaceId,
		workspaceName: workspace.name,
		sessionId,
		actorKind,
		kind,
		at: event.at,
		text,
		eventId: `${event.workspaceId}:${event.seq}`,
		explicit,
		...(explicit ? { forceVisible: true } : {}),
		destinationSessionIds: destinations,
		...(event.missionId ? { missionId: event.missionId } : {}),
	});
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
	sessionId: string;
	turn: Turn;
	blocks: readonly Block[];
}): Promise<void> {
	if (
		!input.turn.endedAt ||
		input.turn.readerDirected !== true ||
		input.turn.cancelled ||
		input.turn.sessionId !== input.sessionId
	)
		return;
	const blocks = input.blocks.filter(
		(block) => block.turnId === input.turn.id && block.role === "agent" && block.kind === "text",
	);
	const text = blocks.map((block) => block.text).join("\n\n");
	if (!text.trim() && !input.turn.failed) return;
	const firstSeq = blocks[0]?.seq;
	const lastSeq = blocks.at(-1)?.seq;
	const sourceText = text || "Workspace leader runtime turn failed.";
	const sourceHash = createHash("sha256").update(sourceText).digest("hex");
	await input.store.capture({
		id: "",
		workspaceId: input.workspace.id,
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
}

/** Replay whole completed turns; leave a split turn buffered until its final block is read. */
export async function replayMeLeaderTurns(input: {
	store: MeStore;
	workspace: Workspace;
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
