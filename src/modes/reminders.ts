// The Lead++ banner and its reminders. At 10 active minutes
// `leader.modeReminder` is emitted once; after that a reminder falls due
// every 2 further active minutes, coalesced to one until taken.
import type { DecisionRecord } from "../core/types.ts";

export const FIRST_REMINDER_MS = 600_000;
export const REMINDER_INTERVAL_MS = 120_000;

export function bannerLine(input: { activeMs: number; missionNumber: number; missionName: string }): string {
	return `Lead++ active ${Math.floor(input.activeMs / 60_000)} min · #${input.missionNumber} ${input.missionName}`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function reminderLine(i: { activeMs: number; record?: DecisionRecord }): string {
	const mins = Math.floor(i.activeMs / 60_000);
	const line =
		i.record === undefined
			? `Lead++ active ${mins} min, set by the user`
			: `Lead++ active ${mins} min for ${oneLine(i.record.objective)}: ${oneLine(i.record.validation)}`;
	return oneLine(line).slice(0, 159);
}

export type ReminderTick = "none" | "firstEvent" | "eligible";

interface KeyState {
	fired: boolean;
	nextEligible: number;
	pending: boolean;
}

export class ReminderTracker {
	private readonly states = new Map<string, KeyState>();

	private stateFor(key: string): KeyState {
		let state = this.states.get(key);
		if (state === undefined) {
			state = { fired: false, nextEligible: FIRST_REMINDER_MS + REMINDER_INTERVAL_MS, pending: false };
			this.states.set(key, state);
		}
		return state;
	}

	observe(key: string, activeMs: number): ReminderTick {
		const state = this.stateFor(key);
		if (!state.fired) {
			if (activeMs < FIRST_REMINDER_MS) {
				return "none";
			}
			state.fired = true;
			state.pending = true;
			return "firstEvent";
		}
		if (activeMs < state.nextEligible) {
			return "none";
		}
		while (state.nextEligible <= activeMs) {
			state.nextEligible += REMINDER_INTERVAL_MS;
		}
		state.pending = true;
		return "eligible";
	}

	// True once when a reminder is pending; clears it.
	take(key: string): boolean {
		const state = this.states.get(key);
		if (state === undefined || !state.pending) {
			return false;
		}
		state.pending = false;
		return true;
	}

	// On any return to lead: a later Lead++ starts over.
	clear(key: string): void {
		this.states.delete(key);
	}
}
