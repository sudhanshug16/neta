// `neta events` and `neta events --follow` (08, T8.6): a thin client of
// `events.list` plus the `event` notification stream. Only `neta` and
// `neta open` start the Node, so this connects with `start: false` and
// reports an unreachable Node as exit 2. Text goes to stdout, `--json` prints
// one JSON value (NDJSON under `--follow`), errors to stderr as
// `neta: <msg>`.
import type { Event } from "../../core/types.ts";
import type {
	EventNotification,
	EventsListResult,
	MissionsListResult,
	WorkspaceOpenResult,
} from "../../node/protocol.ts";
import { CliError, type NodeClient } from "../client.ts";

const LIST_LIMIT = 200;
const DAY_MS = 86400000;

function termWidth(): number {
	return process.stdout.columns ?? 100;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fail(error: unknown): number {
	if (error instanceof CliError) {
		process.stderr.write(`neta: ${error.message}\n`);
		return error.code;
	}
	process.stderr.write(`neta: ${messageOf(error)}\n`);
	return 1;
}

const DUR_MS: Record<string, number> = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };

// The parser (T8.1) already rejects a bad `--since`, so this only guards
// direct callers.
function sinceCutoff(since: string): string {
	const match = /^([0-9]+)([mhdw])$/.exec(since);
	const unit = match?.[2] === undefined ? undefined : DUR_MS[match[2]];
	if (match?.[1] === undefined || unit === undefined) {
		throw new CliError(1, `bad duration: ${since}`);
	}
	return new Date(Date.now() - Number.parseInt(match[1], 10) * unit).toISOString();
}

function eventSummary(event: Event): string {
	const raw = event.data.name ?? event.data.text ?? event.data.reason ?? "";
	return typeof raw === "string" ? raw : String(raw);
}

function missionLabel(
	numberById: Map<string, number>,
	missionId: string | undefined,
	dataNumber: string | number | boolean | null,
): string {
	if (missionId !== undefined) {
		const known = numberById.get(missionId);
		if (known !== undefined) {
			return `#${known}`;
		}
	}
	if (typeof dataNumber === "number" && Number.isInteger(dataNumber)) {
		return `#${dataNumber}`;
	}
	return "-";
}

// `<at>  <seq right 6>  <kind left 20>  <#number or - left 5>  <summary>`,
// cut to the terminal width, 100 off a TTY.
function formatEventLine(event: Event, numberById: Map<string, number>, width: number): string {
	const mission = missionLabel(numberById, event.missionId, event.data.number);
	const line = `${event.at}  ${String(event.seq).padStart(6)}  ${event.kind.padEnd(20)}  ${mission.padEnd(5)}  ${eventSummary(event)}`;
	return line.length > width ? line.slice(0, width) : line;
}

export function formatEvent(e: Event): string {
	return formatEventLine(e, new Map(), termWidth());
}

function isEventNotification(params: unknown): params is EventNotification {
	if (typeof params !== "object" || params === null) {
		return false;
	}
	const event = (params as { event?: unknown }).event;
	if (typeof event !== "object" || event === null) {
		return false;
	}
	const record = event as { workspaceId?: unknown; seq?: unknown };
	return typeof record.workspaceId === "string" && typeof record.seq === "number";
}

async function openWorkspaceId(client: NodeClient): Promise<string> {
	const opened = await client.request<WorkspaceOpenResult>("workspace.open", { path: process.cwd() });
	return opened.workspace.id;
}

// Every mission number of the workspace, for the `#<number>` column.
async function loadNumbers(client: NodeClient, workspaceId: string): Promise<Map<string, number>> {
	const numbers = new Map<string, number>();
	let cursor: string | undefined;
	for (;;) {
		const page = await client.request<MissionsListResult>("missions.list", {
			workspaceId,
			limit: LIST_LIMIT,
			...(cursor === undefined ? {} : { cursor }),
		});
		for (const mission of page.missions) {
			numbers.set(mission.id, mission.number);
		}
		if (page.nextCursor === undefined) {
			return numbers;
		}
		cursor = page.nextCursor;
	}
}

async function listWindow(client: NodeClient, workspaceId: string, from: string): Promise<Event[]> {
	const page = await client.request<EventsListResult>("events.list", {
		workspaceId,
		from,
		limit: LIST_LIMIT,
	});
	return [...page.events].sort((a, b) => a.seq - b.seq);
}

export async function eventsCommand(client: NodeClient, flags: Record<string, string | true>): Promise<number> {
	const follow = flags.follow === true;
	const json = flags.json === true;
	let from: string;
	try {
		from = typeof flags.since === "string" ? sinceCutoff(flags.since) : new Date(Date.now() - DAY_MS).toISOString();
	} catch (error) {
		return fail(error);
	}
	let workspaceId: string;
	try {
		workspaceId = await openWorkspaceId(client);
	} catch (error) {
		return fail(error);
	}
	// Under `--follow` subscribe before reading the window, buffering what
	// arrives mid-read so nothing is lost; once the window is printed the
	// same subscription prints live. The drain skips whatever the window
	// already covered.
	const buffered: Event[] = [];
	let draining = true;
	let printLive: ((event: Event) => void) | undefined;
	const off =
		follow === true
			? client.on("event", (params: unknown) => {
					if (isEventNotification(params) && params.event.workspaceId === workspaceId) {
						if (draining || printLive === undefined) {
							buffered.push(params.event);
						} else {
							printLive(params.event);
						}
					}
				})
			: () => undefined;
	let sigint = false;
	let resolveSigint: (() => void) | undefined;
	const onSigint = (): void => {
		sigint = true;
		resolveSigint?.();
	};
	if (follow === true) {
		process.once("SIGINT", onSigint);
	}
	try {
		let numbers: Map<string, number>;
		let window: Event[];
		try {
			numbers = await loadNumbers(client, workspaceId);
			window = await listWindow(client, workspaceId, from);
		} catch (error) {
			return fail(error);
		}
		const width = termWidth();
		const printed = new Set<number>();
		const printText = (event: Event): void => {
			if (printed.has(event.seq)) {
				return;
			}
			printed.add(event.seq);
			process.stdout.write(`${formatEventLine(event, numbers, width)}\n`);
		};
		const printJson = (event: Event): void => {
			if (printed.has(event.seq)) {
				return;
			}
			printed.add(event.seq);
			process.stdout.write(`${JSON.stringify(event)}\n`);
		};
		if (json === true && follow !== true) {
			process.stdout.write(`${JSON.stringify(window)}\n`);
			return 0;
		}
		// Text always goes line by line (flushing each line); `--follow
		// --json` is NDJSON, one event per line, window first.
		for (const event of window) {
			printed.add(event.seq);
			if (json === true) {
				process.stdout.write(`${JSON.stringify(event)}\n`);
			} else {
				process.stdout.write(`${formatEventLine(event, numbers, width)}\n`);
			}
		}
		if (follow !== true) {
			return 0;
		}
		printLive = json === true ? printJson : printText;
		for (const event of buffered) {
			printLive(event);
		}
		buffered.length = 0;
		draining = false;
		await new Promise<void>((resolve) => {
			if (sigint) {
				resolve();
			} else {
				resolveSigint = resolve;
			}
		});
		return 0;
	} finally {
		if (follow === true) {
			process.removeListener("SIGINT", onSigint);
		}
		off();
	}
}
