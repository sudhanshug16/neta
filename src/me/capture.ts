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

const relevantKinds = new Set<Event["kind"]>(["mission.failed", "worktree.setupFailed", "routing.failed"]);

export async function captureMeEvent(store: MeStore, event: Event, context: MeEventSourceContext): Promise<boolean> {
	if (!relevantKinds.has(event.kind)) return false;
	const workspace = context.workspaces.find((w) => w.id === event.workspaceId);
	const leader = context.leaders.find((l) => l.workspaceId === event.workspaceId);
	if (!workspace || !leader) return false;
	const saved = await store.capture({
		id: "",
		workspaceId: workspace.id,
		workspaceName: workspace.name,
		machineId: context.machineId,
		sessionId: event.sessionId ?? leader.sessionId,
		actorKind: "leader",
		kind: "failure",
		at: event.at,
		text: `Runtime failure: ${event.kind}\n${JSON.stringify(event.data)}`,
		eventId: `${event.workspaceId}:${event.seq}`,
		missionId: event.missionId,
	});
	return !!saved.id;
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
	if (!input.turn.endedAt || input.turn.sessionId !== input.sessionId) return false;
	const blocks = input.blocks.filter(
		(block) => block.turnId === input.turn.id && block.role === "agent" && block.kind === "text",
	);
	const text = input.turn.finalReply ?? "";
	if (!text.trim() && !input.turn.failed && !input.turn.cancelled) return false;
	const firstSeq = blocks[0]?.seq;
	const lastSeq = blocks.at(-1)?.seq;
	const sourceText =
		(input.turn.failed
			? `Coordinator turn failed.\n${text}`
			: input.turn.cancelled
				? `Coordinator turn interrupted.\n${text}`
				: text) ||
		(input.turn.failed
			? "Coordinator runtime turn failed."
			: "Coordinator turn completed without a text report. Work outcome is unknown.");
	const sourceHash = createHash("sha256").update(sourceText).digest("hex");
	const captured = await input.store.capture({
		id: "",
		workspaceId: input.workspace.id,
		...(input.machineId ? { machineId: input.machineId } : {}),
		workspaceName: input.workspace.name,
		sessionId: input.sessionId,
		actorKind: "leader",
		kind: input.turn.failed || input.turn.cancelled ? "failure" : "message",
		at: input.turn.endedAt,
		text: sourceText,
		turnId: input.turn.id,

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
	// Block sequences can restart with a new native provider binding. A byte
	// cursor tracks the durable conversation file across those resets.
	let pageCursor = Math.max(
		0,
		...cursors.filter((item) => item.sessionId === input.sessionId).map((item) => item.fileCursor ?? 0),
	);
	const initialCursor = pageCursor;
	let pendingStartCursor = pageCursor;
	let pending: Block[] = [];
	let pendingTurn: Turn | undefined;
	let captured = 0;
	let lastTurnId: string | undefined;
	let endCursor = pageCursor;
	for (;;) {
		const pageStart = pageCursor;
		const page = await input.read(pageCursor);
		for (const block of page.blocks) {
			if (pendingTurn && pendingTurn.id !== block.turnId) {
				const didCapture = await captureMeLeaderTurn({
					store: input.store,
					workspace: input.workspace,
					machineId: input.machineId,
					sessionId: input.sessionId,
					turn: pendingTurn,
					blocks: pending,
				});
				lastTurnId = pendingTurn.id;
				if (didCapture) captured++;
				pending = [];
				pendingTurn = undefined;
			}
			if (!pendingTurn) {
				pendingTurn = await input.getTurn(block.turnId);
				pendingStartCursor = pageStart;
			}
			if (pendingTurn) pending.push(block);
		}
		endCursor = page.cursor;
		if (!page.more) break;
		if (page.cursor <= pageCursor) throw new Error("conversation replay did not advance");
		pageCursor = page.cursor;
	}
	if (pendingTurn && pending.length && pendingTurn.endedAt) {
		const didCapture = await captureMeLeaderTurn({
			store: input.store,
			workspace: input.workspace,
			machineId: input.machineId,
			sessionId: input.sessionId,
			turn: pendingTurn,
			blocks: pending,
		});
		lastTurnId = pendingTurn.id;
		if (didCapture) captured++;
	}
	const safeCursor = pendingTurn && !pendingTurn.endedAt ? pendingStartCursor : endCursor;
	if (safeCursor > initialCursor && lastTurnId) {
		await input.store.setCheckpoint({
			workspaces: [
				{
					workspaceId: input.workspace.id,
					eventSeq: 0,
					turns: [{ sessionId: input.sessionId, turnId: lastTurnId, fileCursor: safeCursor }],
				},
			],
		});
	}
	return captured;
}
