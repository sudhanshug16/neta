import type { Mission, MissionState } from "../core/types.ts";

export interface ReminderInput {
	missions: Mission[];
}
export function missionStateLabel(state: MissionState): string {
	return state;
}
export function reminder(input: ReminderInput): string {
	const open = input.missions.filter((mission) => mission.state === "open").sort((a, b) => b.number - a.number);
	return open.length
		? `[neta] open: ${open
				.slice(0, 8)
				.map((m) => `#${m.number} ${m.name}`)
				.join(" · ")}${open.length > 8 ? ` · +${open.length - 8} more` : ""}`
		: "";
}
export function preamble(input: ReminderInput): string {
	const body = reminder(input);
	return body ? `Current mission state:\n${body}` : "";
}
