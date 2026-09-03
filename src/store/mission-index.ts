import type { IsoTime, Mission, MissionId, MissionState } from "../core/types.ts";

export interface MissionQuery {
	from?: IsoTime;
	to?: IsoTime;
	states?: MissionState[];
	limit?: number;
	cursor?: string;
}

export interface MissionPage {
	missions: Mission[];
	cursor?: string;
}

export interface MissionIndex {
	put(mission: Mission): void;
	get(id: MissionId): Mission | undefined;
	byNumber(n: number): Mission | undefined;
	list(query: MissionQuery): MissionPage;
	all(): Mission[];
	maxNumber(): number;
	size(): number;
}

// Stable, opaque, exclusive: the (createdAt, id) of the last row returned.
export function missionCursor(mission: Mission): string {
	return `${mission.createdAt}|${mission.id}`;
}

function compareAt(a: Mission, at: IsoTime, id: MissionId): number {
	if (a.createdAt < at) {
		return -1;
	}
	if (a.createdAt > at) {
		return 1;
	}
	if (a.id < id) {
		return -1;
	}
	if (a.id > id) {
		return 1;
	}
	return 0;
}

export function createMissionIndex(): MissionIndex {
	const byId = new Map<MissionId, Mission>();
	const byNum = new Map<number, Mission>();
	const sorted: Mission[] = [];

	function position(at: IsoTime, id: MissionId, exclusive: boolean): number {
		let lo = 0;
		let hi = sorted.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const cmp = compareAt(sorted[mid], at, id);
			if (cmp < 0 || (exclusive && cmp === 0)) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	return {
		put(mission: Mission): void {
			const existing = byId.get(mission.id);
			if (existing !== undefined) {
				if (existing.createdAt !== mission.createdAt) {
					throw new Error(`mission ${mission.id} changed createdAt`);
				}
				if (existing.number !== mission.number) {
					byNum.delete(existing.number);
				}
				byId.set(mission.id, mission);
				byNum.set(mission.number, mission);
				const at = position(mission.createdAt, mission.id, false);
				sorted[at] = mission;
				return;
			}
			byId.set(mission.id, mission);
			byNum.set(mission.number, mission);
			sorted.splice(position(mission.createdAt, mission.id, false), 0, mission);
		},

		get(id: MissionId): Mission | undefined {
			return byId.get(id);
		},

		byNumber(n: number): Mission | undefined {
			return byNum.get(n);
		},

		list(query: MissionQuery): MissionPage {
			const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
			let start: number;
			if (query.cursor !== undefined) {
				const bar = query.cursor.indexOf("|");
				if (bar < 0) {
					throw new Error("bad mission cursor");
				}
				start = position(query.cursor.slice(0, bar), query.cursor.slice(bar + 1), true);
			} else if (query.from !== undefined) {
				start = position(query.from, "", false);
			} else {
				start = 0;
			}
			const missions: Mission[] = [];
			let i = start;
			for (; i < sorted.length && missions.length < limit; i++) {
				const m = sorted[i];
				if (query.to !== undefined && m.createdAt > query.to) {
					break;
				}
				if (query.states !== undefined && !query.states.includes(m.state)) {
					continue;
				}
				missions.push(m);
			}
			// A cursor only when a matching row remains past this page.
			let cursor: string | undefined;
			if (missions.length === limit) {
				for (let j = i; j < sorted.length; j++) {
					const m = sorted[j];
					if (query.to !== undefined && m.createdAt > query.to) {
						break;
					}
					if (query.states !== undefined && !query.states.includes(m.state)) {
						continue;
					}
					cursor = missionCursor(missions[missions.length - 1]);
					break;
				}
			}
			return cursor === undefined ? { missions } : { missions, cursor };
		},

		all(): Mission[] {
			return [...sorted];
		},

		maxNumber(): number {
			let max = 0;
			for (const n of byNum.keys()) {
				if (n > max) {
					max = n;
				}
			}
			return max;
		},

		size(): number {
			return byId.size;
		},
	};
}
