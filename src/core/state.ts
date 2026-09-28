import type { Mission, MissionState } from "./types.ts";

export function deriveMissionState(mission: Mission): MissionState {
	return mission.state === "closed" || mission.closedAt !== undefined ? "closed" : "open";
}
