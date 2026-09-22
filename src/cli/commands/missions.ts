// `neta missions` and `neta mission <number>` (08, T8.5): thin clients of
// `missions.list` / `missions.get` plus formatting. Only `neta` and
// `neta open` start the Node, so these connect with `start: false` and report
// an unreachable Node as exit 2. Text goes to stdout, errors to stderr as
// `neta: <msg>`.
import type { Agent, Event, Mission } from "../../core/types.ts";
import type {
	EventsListResult,
	MissionsGetResult,
	MissionsListResult,
	WorkspaceOpenResult,
} from "../../node/protocol.ts";
import type { NodeClient } from "../client.ts";
import { CliError } from "../client.ts";

const LIST_LIMIT = 200;
const DETAIL_EVENT_LIMIT = 200;
const DETAIL_EVENT_SHOWN = 10;

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

// `3h ago` for three hours; `7m` under an hour, `9s` under a minute.
function relativeAge(createdAt: string, nowMs: number = Date.now()): string {
	const elapsed = Math.max(0, nowMs - Date.parse(createdAt));
	const minutes = Math.floor(elapsed / 60000);
	if (minutes < 1) {
		return `${Math.floor(elapsed / 1000)}s ago`;
	}
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.floor(hours / 24);
	if (days < 7) {
		return `${days}d ago`;
	}
	return `${Math.floor(days / 7)}w ago`;
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

async function openWorkspaceId(client: NodeClient): Promise<string> {
	const opened = await client.request<WorkspaceOpenResult>("workspace.open", { path: process.cwd() });
	return opened.workspace.id;
}

// Every mission of the workspace, oldest page first; callers sort.
async function listWorkspaceMissions(client: NodeClient, workspaceId: string): Promise<Mission[]> {
	const out: Mission[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await client.request<MissionsListResult>("missions.list", {
			workspaceId,
			limit: LIST_LIMIT,
			...(cursor === undefined ? {} : { cursor }),
		});
		out.push(...page.missions);
		if (page.nextCursor === undefined) {
			return out;
		}
		cursor = page.nextCursor;
	}
}

function newestFirst(missions: Mission[]): Mission[] {
	return [...missions].sort((a, b) => {
		if (a.createdAt !== b.createdAt) {
			return a.createdAt < b.createdAt ? 1 : -1;
		}
		return b.number - a.number;
	});
}

// One line per mission, columns two spaces apart: `#<number>` right in 5,
// state left in 15, name left in 32 (truncated with `…`), `<n> agents` left
// in 9, relative age, then `— <attention>` when set. Cut to the terminal
// width, 100 off a TTY.
function formatMissionLine(mission: Mission, width: number): string {
	const number = `#${mission.number}`.padStart(5);
	const state = mission.state.padEnd(15);
	const name = mission.name.length > 32 ? `${mission.name.slice(0, 31)}…` : mission.name.padEnd(32);
	const agents = `${mission.agentIds.length} agents`.padEnd(9);
	let line = `${number}  ${state}  ${name}  ${agents}  ${relativeAge(mission.createdAt)}`;
	if (mission.attention !== undefined && mission.attention !== "") {
		line += `  — ${mission.attention}`;
	}
	return line.length > width ? line.slice(0, width) : line;
}

export async function missionsCommand(client: NodeClient, flags: Record<string, string | true>): Promise<number> {
	try {
		const workspaceId = await openWorkspaceId(client);
		let missions = newestFirst(await listWorkspaceMissions(client, workspaceId));
		if (flags.all !== true) {
			missions = missions.filter((mission) => mission.state !== "closed");
		}
		if (typeof flags.since === "string") {
			const cutoff = sinceCutoff(flags.since);
			missions = missions.filter((mission) => mission.createdAt >= cutoff);
		}
		if (flags.json === true) {
			process.stdout.write(`${JSON.stringify(missions)}\n`);
			return 0;
		}
		if (missions.length === 0) {
			process.stdout.write("no missions\n");
			return 0;
		}
		const width = termWidth();
		for (const mission of missions) {
			process.stdout.write(`${formatMissionLine(mission, width)}\n`);
		}
		return 0;
	} catch (error) {
		return fail(error);
	}
}

function eventSummary(event: Event): string {
	const raw = event.data.name ?? event.data.text ?? event.data.reason ?? "";
	return typeof raw === "string" ? raw : String(raw);
}

// T8.6's line format, reused here for the detail's Events section:
// `<at>  <seq right 6>  <kind left 20>  <#number or - left 5>  <summary>`,
// cut to the terminal width.
function formatEvent(event: Event, numberOf: (missionId?: string) => string, width: number): string {
	const mission = numberOf(event.missionId);
	const line = `${event.at}  ${String(event.seq).padStart(6)}  ${event.kind.padEnd(20)}  ${mission.padEnd(5)}  ${eventSummary(event)}`;
	return line.length > width ? line.slice(0, width) : line;
}

function formatDetail(
	mission: Mission,
	agents: Agent[],
	events: Event[],
	numberOf: (missionId?: string) => string,
	width: number,
): string {
	const lines: string[] = [];
	lines.push(`Mission ${mission.number} · ${mission.name}`);
	lines.push(`State: ${mission.state}`);
	lines.push(`Access: ${mission.access}`);
	const lead = mission.lead;
	lines.push(
		lead.kind === "leader"
			? "Lead: workspace leader (shared conversation)"
			: `Lead: agent ${agents.find((agent) => agent.id === lead.agentId)?.name ?? lead.agentId}`,
	);
	if (mission.worktree !== undefined) {
		lines.push(`Worktree: ${mission.worktree.path}  ${mission.worktree.branch} off ${mission.worktree.base}`);
	}
	lines.push(`Objective: ${mission.objective}`);
	if (mission.changes.length === 0) {
		lines.push("Changes: none");
	} else {
		lines.push("Changes:");
		for (const change of mission.changes) {
			lines.push(`  ${change.at}  ${change.text}`);
		}
	}
	if (agents.length === 0) {
		lines.push("Agents: none");
	} else {
		lines.push("Agents:");
		for (const agent of agents) {
			lines.push(
				`  ${agent.name.padEnd(12)}  ${agent.state.padEnd(12)}  ${agent.access.padEnd(10)}  ${agent.provider}/${agent.model}  ${agent.task}`,
			);
		}
	}
	if (events.length === 0) {
		lines.push("Events: none");
	} else {
		lines.push("Events:");
		for (const event of events) {
			lines.push(`  ${formatEvent(event, numberOf, Math.max(width - 2, 0))}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

export async function missionCommand(
	client: NodeClient,
	number: number,
	flags: Record<string, string | true>,
): Promise<number> {
	try {
		const workspaceId = await openWorkspaceId(client);
		const missions = await listWorkspaceMissions(client, workspaceId);
		const found = missions.find((mission) => mission.number === number);
		if (found === undefined) {
			process.stderr.write(`neta: no mission #${number} in this workspace\n`);
			return 1;
		}
		const detail = await client.request<MissionsGetResult>("missions.get", { missionId: found.id });
		const page = await client.request<EventsListResult>("events.list", {
			workspaceId,
			limit: DETAIL_EVENT_LIMIT,
		});
		const events = page.events.filter((event) => event.missionId === detail.mission.id).slice(-DETAIL_EVENT_SHOWN);
		if (flags.json === true) {
			process.stdout.write(`${JSON.stringify({ mission: detail.mission, agents: detail.agents, events })}\n`);
			return 0;
		}
		const numbers = new Map(missions.map((mission) => [mission.id, mission.number] as const));
		const numberOf = (missionId?: string): string => {
			const n = missionId === undefined ? undefined : numbers.get(missionId);
			return n === undefined ? "-" : `#${n}`;
		};
		process.stdout.write(formatDetail(detail.mission, detail.agents, events, numberOf, termWidth()));
		return 0;
	} catch (error) {
		return fail(error);
	}
}
