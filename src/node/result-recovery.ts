import { nowIso } from "../core/time.ts";
import type { Turn } from "../core/types.ts";
import type { ConversationStore } from "../store/conversations.ts";
import type { TurnNotification } from "./protocol.ts";
import type { NodeStore } from "./server.ts";

/** Reconcile the actor's durable current-turn pointer, never its entire old assignment. */
export async function recoverActorResults(
	store: Pick<NodeStore, "listAgents" | "getMission">,
	conversations: ConversationStore,
	record: (notification: TurnNotification) => Promise<void>,
): Promise<void> {
	for (const actor of store.listAgents()) {
		if (actor.state === "archived" || store.getMission(actor.missionId)?.state === "closed") continue;
		if (actor.pendingParentTurn) {
			await record({ sessionId: actor.sessionId, turn: actor.pendingParentTurn });
			continue;
		}
		const range = actor.currentTurnId
			? await conversations.turnRange(actor.sessionId, actor.currentTurnId)
			: undefined;
		const interruptedLaunch =
			actor.state === "interrupted" &&
			(actor.stateBefore === "starting" || actor.stateBefore === "running" || actor.stateBefore === "blocked");
		if (!range && !interruptedLaunch) continue;
		const meta = await conversations.meta(actor.sessionId);
		const turn: Turn = range?.turn.endedAt
			? range.turn
			: {
					...(range?.turn ?? {
						id:
							actor.currentTurnId ??
							`startup:${actor.bindingGeneration ?? meta?.bindingGeneration ?? actor.sessionId}`,
						sessionId: actor.sessionId,
						role: "user" as const,
						startedAt: actor.startedAt,
						model: meta?.model ?? actor.model,
						bindingGeneration: actor.bindingGeneration ?? meta?.bindingGeneration,
					}),
					endedAt: nowIso(),
					cancelled: true,
				};
		// Ordering also covers a crash after this record but before the journal append.
		await record({ sessionId: actor.sessionId, bindingGeneration: turn.bindingGeneration, turn });
		if (!range?.turn.endedAt) await conversations.appendTurn(turn);
	}
}
