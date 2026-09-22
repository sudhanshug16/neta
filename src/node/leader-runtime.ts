import type { Leader } from "../core/types.ts";
import type { TurnNotification } from "./protocol.ts";
import type { NodeStore } from "./server.ts";

/** Workspace leaders consume the same turn events as mission agents. */
export async function recordLeaderRuntime(
	input: TurnNotification,
	ports: {
		store: Pick<NodeStore, "listLeaders" | "getLeader" | "putLeader">;
		changed(leader: Leader): void;
	},
): Promise<void> {
	const leader = ports.store.listLeaders().find((item) => item.sessionId === input.sessionId);
	if (!leader) return;
	const turn = input.turn;
	const generation = turn?.bindingGeneration ?? input.bindingGeneration;
	// A previous binding or turn can finish after a new execution has begun.
	if (
		(!turn || turn.endedAt !== undefined) &&
		((generation && leader.bindingGeneration && generation !== leader.bindingGeneration) ||
			(turn && leader.currentTurnId && turn.id !== leader.currentTurnId))
	)
		return;
	const updated: Leader = {
		...leader,
		...(input.model ? { model: input.model } : {}),
		...(turn
			? {
					state: turn.endedAt === undefined ? "running" : turn.failed ? "failed" : "idle",
					currentTurnId: turn.id,
					bindingGeneration: generation,
					startupError: undefined,
				}
			: {}),
	};
	if (
		updated.state === leader.state &&
		updated.model === leader.model &&
		updated.currentTurnId === leader.currentTurnId &&
		updated.bindingGeneration === leader.bindingGeneration &&
		updated.startupError === leader.startupError
	)
		return;
	await ports.store.putLeader(updated);
	ports.changed(ports.store.getLeader(leader.workspaceId) ?? updated);
}
