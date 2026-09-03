import { readdir } from "node:fs/promises";
import { nowIso } from "../core/time.ts";
import type { Event, EventKind, IsoTime, WorkspaceId } from "../core/types.ts";
import { appendLine, createMutex, type Mutex, readNdjson, readText, writeFileAtomic } from "./files.ts";
import { monthKey, paths } from "./paths.ts";

export interface EventQuery {
	from?: IsoTime;
	to?: IsoTime;
	kinds?: EventKind[];
	limit?: number;
	cursor?: string;
}

export interface EventPage {
	events: Event[];
	cursor?: string;
}

export interface EventLog {
	append(event: Omit<Event, "seq" | "at">): Promise<Event>;
	list(workspaceId: WorkspaceId, query: EventQuery): Promise<EventPage>;
	tail(workspaceId: WorkspaceId, sinceSeq: number, limit?: number): Promise<Event[]>;
	close(): Promise<void>;
}

interface WorkspaceLog {
	nextSeq: number;
	loaded: boolean;
	mutex: Mutex;
}

async function presentMonths(workspaceId: WorkspaceId): Promise<string[]> {
	const dir = paths().eventsDir(workspaceId);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	return names
		.filter((n) => /^\d{4}-\d{2}\.ndjson$/.test(n))
		.map((n) => n.slice(0, 7))
		.sort();
}

export function openEventLog(): EventLog {
	const logs = new Map<WorkspaceId, WorkspaceLog>();

	function logFor(workspaceId: WorkspaceId): WorkspaceLog {
		let log = logs.get(workspaceId);
		if (log === undefined) {
			log = { nextSeq: 1, loaded: false, mutex: createMutex() };
			logs.set(workspaceId, log);
		}
		return log;
	}

	async function ensureSeq(workspaceId: WorkspaceId, log: WorkspaceLog): Promise<void> {
		if (log.loaded) {
			return;
		}
		log.loaded = true;
		const p = paths();
		const raw = await readText(p.eventSeq(workspaceId));
		const filed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
		let next = Number.isInteger(filed) && filed >= 1 ? filed : 1;
		const months = await presentMonths(workspaceId);
		if (months.length > 0) {
			const newest = await readNdjson<Event>(p.eventMonth(workspaceId, months[months.length - 1]));
			for (const event of newest.records) {
				if (event.seq >= next) {
					next = event.seq + 1;
				}
			}
		}
		log.nextSeq = next;
	}

	async function listInner(workspaceId: WorkspaceId, query: EventQuery): Promise<EventPage> {
		const limit = Math.min(Math.max(query.limit ?? 200, 1), 2000);
		const cursorSeq = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
		if (!Number.isInteger(cursorSeq) || cursorSeq < 0) {
			throw new Error("bad event cursor");
		}
		const months = await presentMonths(workspaceId);
		if (months.length === 0) {
			return { events: [] };
		}
		const fromMonth = query.from === undefined ? months[0] : monthKey(query.from);
		const toMonth = query.to === undefined ? monthKey(nowIso()) : monthKey(query.to);
		const matches: Event[] = [];
		let more = false;
		const p = paths();
		for (const month of months) {
			if (month < fromMonth || month > toMonth) {
				continue;
			}
			const read = await readNdjson<Event>(p.eventMonth(workspaceId, month));
			for (const event of read.records) {
				if (event.seq <= cursorSeq) {
					continue;
				}
				if (query.from !== undefined && event.at < query.from) {
					continue;
				}
				if (query.to !== undefined && event.at > query.to) {
					continue;
				}
				if (query.kinds !== undefined && !query.kinds.includes(event.kind)) {
					continue;
				}
				if (matches.length === limit) {
					more = true;
					break;
				}
				matches.push(event);
			}
			if (more) {
				break;
			}
		}
		if (!more) {
			return { events: matches };
		}
		return { events: matches, cursor: String(matches[matches.length - 1].seq) };
	}

	return {
		append: async (event) => {
			const log = logFor(event.workspaceId);
			return log.mutex(async () => {
				await ensureSeq(event.workspaceId, log);
				const full: Event = { ...event, seq: log.nextSeq, at: nowIso() };
				log.nextSeq += 1;
				const p = paths();
				await writeFileAtomic(p.eventSeq(event.workspaceId), `${log.nextSeq}\n`);
				await appendLine(p.eventMonth(event.workspaceId, monthKey(full.at)), full);
				return full;
			});
		},

		list: async (workspaceId, query) => listInner(workspaceId, query),

		tail: async (workspaceId, sinceSeq, limit) =>
			(await listInner(workspaceId, { cursor: String(sinceSeq), limit })).events,

		close: async () => {},
	};
}
