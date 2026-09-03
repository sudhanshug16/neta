// Records the desktop fixtures. Regenerate with:
//   bun test/fixtures/record-node-fixture.ts
// from the repo root. It starts a real Node in a fixed repo-relative temp
// dir, drives fourteen missions, snapshots through the socket, and writes
// test/fixtures/node-snapshot.json (one verbatim snapshot result) and
// test/fixtures/node-events.ndjson (one Event per line, oldest first), both
// pretty-printed. The clock, Math.random, machine record, remote and paths
// are all fixed, so a re-record in the same checkout is a byte-identical
// no-op; the temp dir is removed afterwards. This file is a script, not a
// test: its name keeps `bun test` from picking it up.
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "../../src/acp/settings.ts";
import { ulid } from "../../src/core/ids.ts";
import { pickName } from "../../src/core/names.ts";
import type { Agent, EventKind, Mission, Workspace } from "../../src/core/types.ts";
import { connectNode } from "../../src/node/client.ts";
import { type AdaptedStore, adaptAcp, adaptStore, startNode } from "../../src/node/lifecycle.ts";
import { openStore, type Store } from "../../src/store/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(REPO, ".tmp-node-fixture");
const NETA = join(WORK, "neta");
const REPO_DIR = join(WORK, "repo");
const FAKE_AGENT = join(HERE, "fake-acp-agent.mjs");
const SNAPSHOT_PATH = join(HERE, "node-snapshot.json");
const EVENTS_PATH = join(HERE, "node-events.ndjson");

const RealDate = Date;
const FIXED_NOW = RealDate.parse("2026-06-01T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function iso(offsetMs: number): string {
	return new RealDate(FIXED_NOW + offsetMs).toISOString();
}

class FixedDate extends RealDate {
	constructor();
	constructor(value: number | string);
	constructor(...args: [] | [number | string]) {
		super(...((args.length === 0 ? [FIXED_NOW] : args) as [number]));
	}

	static now(): number {
		return FIXED_NOW;
	}
}
globalThis.Date = FixedDate as unknown as DateConstructor;

let prngState = 0x12345678;
Math.random = (): number => {
	prngState |= 0;
	prngState = (prngState + 0x6d2b79f5) | 0;
	let t = Math.imul(prngState ^ (prngState >>> 15), 1 | prngState);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function runGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd }, (error, stdout) => {
			if (error) {
				reject(error);
			} else {
				resolve(stdout.trim());
			}
		});
	});
}

const MACHINE_ID = ulid();

async function main(): Promise<void> {
	process.env.NETA_DIR = NETA;
	await rm(WORK, { recursive: true, force: true });
	await mkdir(join(REPO_DIR), { recursive: true });
	await mkdir(NETA, { recursive: true });
	// Fixed machine record: no hostname, no fresh ULID at load.
	await writeFile(
		join(NETA, "machine.json"),
		JSON.stringify({ id: MACHINE_ID, name: "fixture-machine", createdAt: iso(0) }),
	);
	await writeFile(
		join(NETA, "settings.json"),
		JSON.stringify({
			providers: {
				fake: { command: process.execPath, args: [FAKE_AGENT], resume: true, defaultModel: "test-model" },
			},
			leader: { provider: "fake" },
		}),
	);
	await runGit(["init", "-q"], REPO_DIR);
	await runGit(["remote", "add", "origin", "https://github.com/acme/widget.git"], REPO_DIR);

	const real = await openStore();
	const port = await adaptStore(real);
	const acp = adaptAcp(loadSettings({ netaDir: NETA }).settings);
	const node = await startNode({ store: port, acp });
	const client = await connectNode();
	try {
		const opened = await client.request<{ workspace: Workspace }>("workspace.open", { path: REPO_DIR });
		const workspaceId = opened.workspace.id;
		await drive(real, port, workspaceId);
		await port.refreshMissions();
		const snapshot = await client.request<{ missions: unknown[]; hasOlder: boolean }>("snapshot", {});
		// Fourteen driven; the thirty-day-old closed one falls outside the
		// default window, leaving thirteen plus hasOlder.
		if (snapshot.missions.length !== 13 || snapshot.hasOlder !== true) {
			throw new Error(
				`expected thirteen missions and hasOlder, got ${snapshot.missions.length} / ${snapshot.hasOlder}`,
			);
		}
		await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
		const { events } = await port.listEvents({ workspaceId, limit: 10000 });
		if (events.length === 0) {
			throw new Error("expected events, got none");
		}
		await writeFile(EVENTS_PATH, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
	} finally {
		await client.close().catch(() => undefined);
		await node.stop().catch(() => undefined);
		await real.close().catch(() => undefined);
		await rm(WORK, { recursive: true, force: true });
	}
}

interface MissionSpec {
	state: Mission["state"];
	createdHoursAgo: number;
	attention?: string;
	closedDaysAgo?: number;
	disposition?: "merged" | "abandoned";
	closeReason?: string;
	merged?: boolean;
	agents: Array<Agent["state"]>;
}

const SPECS: MissionSpec[] = [
	{ state: "running", createdHoursAgo: 50, agents: ["running", "running"] },
	{ state: "blocked", createdHoursAgo: 5, attention: "Which API should the widget use?", agents: ["blocked"] },
	{ state: "readyToClose", createdHoursAgo: 30, agents: ["completed"] },
	{ state: "mergedNotClosed", createdHoursAgo: 40, merged: true, agents: ["running"] },
	{ state: "failed", createdHoursAgo: 20, attention: "Provider quota exhausted, retry?", agents: ["failed"] },
	{
		state: "closed",
		createdHoursAgo: 60,
		closedDaysAgo: 5,
		disposition: "merged",
		closeReason: "merged",
		merged: true,
		agents: ["completed", "completed"],
	},
	{
		state: "running",
		createdHoursAgo: 10,
		agents: [
			"completed",
			"completed",
			"completed",
			"completed",
			"completed",
			"completed",
			"completed",
			"completed",
			"completed",
			"completed",
			"completed",
			"completed",
			"running",
		],
	},
	{ state: "running", createdHoursAgo: 55, agents: ["running"] },
	{ state: "blocked", createdHoursAgo: 8, attention: "Waiting on design review.", agents: ["blocked"] },
	{ state: "failed", createdHoursAgo: 25, agents: ["failed"] },
	{ state: "readyToClose", createdHoursAgo: 35, agents: ["completed"] },
	{ state: "mergedNotClosed", createdHoursAgo: 45, merged: true, agents: ["running"] },
	{
		state: "closed",
		createdHoursAgo: 70,
		closedDaysAgo: 2,
		disposition: "abandoned",
		closeReason: "superseded",
		agents: ["failed"],
	},
	{
		state: "closed",
		createdHoursAgo: 840,
		closedDaysAgo: 30,
		disposition: "merged",
		closeReason: "merged",
		merged: true,
		agents: [],
	},
];

const STATE_EVENTS: Record<Mission["state"], EventKind | undefined> = {
	running: undefined,
	blocked: "mission.blocked",
	failed: "mission.failed",
	readyToClose: "mission.readyToClose",
	mergedNotClosed: "mission.merged",
	closed: "mission.closed",
};

async function drive(real: Store, port: AdaptedStore, workspaceId: string): Promise<void> {
	const taken = new Set<string>();
	let agentN = 0;
	for (const spec of SPECS) {
		const number = await real.missions.allocateNumber(workspaceId);
		const mission: Mission = {
			id: ulid(),
			number,
			workspaceId,
			machineId: MACHINE_ID,
			name: `mission ${number}`,
			objective: `Objective ${number}.`,
			changes: [],
			lead: { kind: "leader" },
			agentIds: [],
			access: "readOnly",
			state: spec.state,
			createdAt: iso(-spec.createdHoursAgo * HOUR),
			...(spec.attention === undefined ? {} : { attention: spec.attention }),
			...(spec.closedDaysAgo === undefined
				? {}
				: {
						closedAt: iso(-spec.closedDaysAgo * DAY),
						disposition: spec.disposition,
						closeReason: spec.closeReason,
					}),
			...(spec.merged === true
				? { integration: { mergedAt: iso(-12 * HOUR), commit: "abc1234", base: "main" } }
				: {}),
		};
		const agents: Agent[] = spec.agents.map((state, index) => {
			agentN += 1;
			const name = pickName(taken, `fixture-agent-${agentN}`);
			taken.add(name);
			const startedAt = iso(-spec.createdHoursAgo * HOUR + HOUR);
			return {
				id: ulid(),
				missionId: mission.id,
				workspaceId,
				name,
				task: `Fixture task ${agentN}.`,
				access: "readOnly",
				provider: "fake",
				model: "test-model",
				skills: [],
				sessionId: ulid(),
				canSpawn: false,
				state,
				startedAt,
				...(state === "completed" || state === "failed"
					? {
							endedAt: iso(-spec.createdHoursAgo * HOUR + (2 + index) * HOUR),
							outcome:
								state === "completed" ? "Done: the objective is met." : "Failed: provider quota exhausted.",
						}
					: {}),
			};
		});
		mission.agentIds = agents.map((agent) => agent.id);
		await real.missions.create(mission);
		for (const agent of agents) {
			await port.putAgent(agent);
		}
		await port.appendEvent({ workspaceId, kind: "mission.created", missionId: mission.id, data: {} });
		for (const agent of agents) {
			await port.appendEvent({
				workspaceId,
				kind: "agent.spawned",
				missionId: mission.id,
				agentId: agent.id,
				data: {},
			});
			if (agent.state === "completed" || agent.state === "failed") {
				await port.appendEvent({
					workspaceId,
					kind: "agent.finished",
					missionId: mission.id,
					agentId: agent.id,
					data: {},
				});
			}
		}
		const stateEvent = STATE_EVENTS[spec.state];
		if (stateEvent !== undefined) {
			await port.appendEvent({ workspaceId, kind: stateEvent, missionId: mission.id, data: {} });
		}
	}
}

await main();
