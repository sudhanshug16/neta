// A mode's only route to a session: cancel the active turn at the 03
// steering boundary, switch access, then re-prompt once. With no active turn
// the cancel is a no-op and the re-prompt still happens. Lead++ grants no
// writer lease: a Lead++ leader that writes takes one from 06 like any
// writer, and this module never touches 06.
import type { Access, DecisionRecord, LeaderMode, SessionId } from "../core/types.ts";
import type { ModeCause } from "./records.ts";

export interface SwitchDeps {
	isTurnActive(sessionId: SessionId): boolean;
	steer(sessionId: SessionId, prompt: string): Promise<void>;
	switchAccess(sessionId: SessionId, access: Access): Promise<void>;
}

export function accessFor(mode: LeaderMode): Access {
	return mode === "leadPlus" ? "readWrite" : "readOnly";
}

function missionText(mission?: { number: number; name: string }): string {
	return mission === undefined ? "" : ` for mission #${mission.number} ${mission.name}`;
}

export function modeChangeText(input: {
	from: LeaderMode;
	to: LeaderMode;
	cause: ModeCause;
	mission?: { number: number; name: string };
	record?: DecisionRecord;
}): string {
	const where = missionText(input.mission);
	if (input.to === "leadPlus") {
		const why = input.cause === "user" ? " at your request" : input.cause === "tool" ? " as approved" : "";
		const objective = input.record === undefined ? "" : ` Objective: ${input.record.objective}.`;
		return `You are now in Lead++${where}${why}.${objective} Your access is now read-write.`;
	}
	const why =
		input.cause === "user"
			? " at your request"
			: input.cause === "tool"
				? " as decided"
				: input.cause === "missionClosed"
					? " because the mission closed"
					: " because the mission was abandoned";
	return `Lead++ has ended${where}${why}. You are back in Lead with read-only access.`;
}

export async function applyModeSwitch(
	deps: SwitchDeps,
	input: {
		sessionId: SessionId;
		from: LeaderMode;
		to: LeaderMode;
		cause: ModeCause;
		mission?: { number: number; name: string };
		record?: DecisionRecord;
	},
): Promise<{ cancelledTurn: boolean }> {
	if (input.from === input.to) {
		return { cancelledTurn: false };
	}
	const cancelledTurn = deps.isTurnActive(input.sessionId);
	await deps.switchAccess(input.sessionId, accessFor(input.to));
	await deps.steer(
		input.sessionId,
		modeChangeText({
			from: input.from,
			to: input.to,
			cause: input.cause,
			mission: input.mission,
			record: input.record,
		}),
	);
	return { cancelledTurn };
}
