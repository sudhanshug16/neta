// The open-mission reminder on leader and lead tool responses, and the turn
// preamble. Needs-you missions (per `needsPerson`) come first, newest
// first; open running missions follow; closed missions never appear.
import { needsPerson } from "../core/state.ts";
import type { Mission, MissionState } from "../core/types.ts";

export interface ReminderInput {
	missions: Mission[];
	modeLine?: string;
}

export function missionStateLabel(state: MissionState): string {
	switch (state) {
		case "blocked":
			return "blocked";
		case "failed":
			return "failed";
		case "readyToClose":
			return "ready to close";
		case "mergedNotClosed":
			return "merged, not closed";
		case "running":
			return "running";
		case "closed":
			return "closed";
	}
}

function byNumberDesc(a: Mission, b: Mission): number {
	return b.number - a.number;
}

function cap(entries: string[]): string {
	if (entries.length <= 8) {
		return entries.join(" · ");
	}
	return `${entries.slice(0, 8).join(" · ")} · +${entries.length - 8} more`;
}

export function reminder(input: ReminderInput): string {
	const open = input.missions.filter((mission) => mission.state !== "closed");
	const needsYou = open.filter((mission) => needsPerson(mission)).sort(byNumberDesc);
	const running = open.filter((mission) => !needsPerson(mission)).sort(byNumberDesc);
	const lines: string[] = [];
	if (needsYou.length > 0) {
		lines.push(
			`[neta] needs you: ${cap(
				needsYou.map((mission) =>
					mission.attention === undefined
						? `#${mission.number} ${mission.name} — ${missionStateLabel(mission.state)}`
						: `#${mission.number} ${mission.name} — ${missionStateLabel(mission.state)}: ${mission.attention}`,
				),
			)}`,
		);
	}
	if (running.length > 0) {
		lines.push(`[neta] open: ${cap(running.map((mission) => `#${mission.number} ${mission.name}`))}`);
	}
	if (input.modeLine !== undefined && input.modeLine !== "") {
		lines.push(input.modeLine);
	}
	return lines.join("\n");
}

export function preamble(input: ReminderInput): string {
	const body = reminder(input);
	return body === "" ? "" : `Current mission state:\n${body}`;
}
