// T8.5: `neta missions` and `neta mission <number>` through the built
// bundle against a temp `NETA_DIR` (the T8.2 harness). Missions have no
// protocol write path — 05 creates them in-process — so the test seeds them
// through the store while the Node is stopped, then restarts it: the Node
// loads missions, agents and events from disk at start.
import { afterAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "../src/core/ids.ts";
import type { Agent, Mission, MissionState } from "../src/core/types.ts";
import { openStore } from "../src/store/index.ts";
import { type Harness, nativeHarnessReady, startNode as startHarness } from "./helpers/cli-harness.ts";

const LONG_NAME = "a very long mission name that runs past thirty-two columns";
const OBJECTIVE = "Port the lens to the new runtime.";
const ATTENTION = "Which API?";
const CLOSED_NAME = "old closed mission";

let harness: Harness | undefined;
let workspaceId = "";

interface MissionSeed {
	name: string;
	objective: string;
	state: MissionState;
	createdAt: string;
	attention?: string;
	closed?: boolean;
}

async function seed(dir: string, workspace: string): Promise<void> {
	const saved = process.env.NETA_DIR;
	process.env.NETA_DIR = dir;
	try {
		const store = await openStore();
		try {
			const now = Date.now();
			const machineId = ulid();
			const specs: MissionSeed[] = [
				{
					name: "lens port",
					objective: OBJECTIVE,
					state: "running",
					createdAt: new Date(now - 2 * 3600000).toISOString(),
				},
				{
					name: LONG_NAME,
					objective: "Pick the widget API.",
					state: "blocked",
					attention: ATTENTION,
					createdAt: new Date(now - 3600000).toISOString(),
				},
				{
					name: CLOSED_NAME,
					objective: "Retire the old widget.",
					state: "closed",
					closed: true,
					createdAt: new Date(now - 3 * 86400000).toISOString(),
				},
			];
			const missions: Mission[] = [];
			for (const spec of specs) {
				const number = await store.missions.allocateNumber(workspace);
				const mission: Mission = {
					id: ulid(),
					number,
					workspaceId: workspace,
					machineId,
					name: spec.name,
					objective: spec.objective,
					changes: [],
					lead: { kind: "leader" },
					agentIds: [],
					access: "readOnly",
					state: spec.state,
					createdAt: spec.createdAt,
					...(spec.attention === undefined ? {} : { attention: spec.attention }),
					...(spec.closed === true
						? {
								closedAt: new Date(now - 2 * 86400000).toISOString(),
								disposition: "merged" as const,
								closeReason: "merged",
							}
						: {}),
				};
				missions.push(mission);
			}
			const first = missions[0];
			if (first === undefined) {
				throw new Error("expected a first mission");
			}
			const agents: Agent[] = ["bruno", "cassia"].map((name, index) => ({
				id: ulid(),
				missionId: first.id,
				workspaceId: workspace,
				name,
				task: index === 0 ? "Draft the port plan." : "Verify the fixture.",
				access: "readOnly",
				provider: "fake",
				model: "test-model",
				skills: [],
				sessionId: ulid(),
				canSpawn: false,
				state: "running",
				startedAt: new Date(now - 3600000).toISOString(),
			}));
			first.agentIds = agents.map((agent) => agent.id);
			for (const mission of missions) {
				await store.missions.create(mission);
				await store.events.append({
					workspaceId: workspace,
					kind: mission.state === "closed" ? "mission.closed" : "mission.created",
					missionId: mission.id,
					data: { number: mission.number, name: mission.name },
				});
			}
			for (const agent of agents) {
				await store.events.append({
					workspaceId: workspace,
					kind: "agent.spawned",
					missionId: agent.missionId,
					agentId: agent.id,
					data: { name: agent.name },
				});
			}
			await writeFile(
				join(dir, "agents.json"),
				JSON.stringify(Object.fromEntries(agents.map((agent) => [agent.id, agent]))),
			);
		} finally {
			await store.close();
		}
	} finally {
		if (saved === undefined) {
			delete process.env.NETA_DIR;
		} else {
			process.env.NETA_DIR = saved;
		}
	}
}

async function ensureSetup(): Promise<Harness> {
	if (harness !== undefined) {
		return harness;
	}
	const fresh = await startHarness();
	harness = fresh;
	try {
		const started = await fresh.run(["node", "start", "--detach"]);
		expect(started.code).toBe(0);
		// `run` inherits the test runner's cwd, so the missions below belong
		// to the checkout's own workspace — the same one the CLI under test
		// opens for its cwd.
		const opened = await fresh.run(["open", process.cwd()]);
		expect(opened.code).toBe(0);
		workspaceId = (opened.stdout.split("  ")[0] as string).trim();
		expect(workspaceId.length).toBeGreaterThan(0);
		const stopped = await fresh.run(["node", "stop"]);
		expect(stopped.code).toBe(0);
		await seed(fresh.dir, workspaceId);
		const restarted = await fresh.run(["node", "start", "--detach"]);
		expect(restarted.code).toBe(0);
	} catch (error) {
		await fresh.stop();
		harness = undefined;
		throw error;
	}
	return fresh;
}

afterAll(async () => {
	await harness?.stop();
	harness = undefined;
});

describe("missions list", () => {
	test.skipIf(!nativeHarnessReady)(
		"missions --json parses to open missions, newest first",
		async () => {
			const h = await ensureSetup();
			const result = await h.run(["missions", "--json"]);
			expect(result.code).toBe(0);
			const parsed = JSON.parse(result.stdout) as Array<{ number: number; state: string; name: string }>;
			expect(Array.isArray(parsed)).toBe(true);
			expect(parsed).toHaveLength(2);
			expect(parsed[0]).toMatchObject({ number: 2, state: "blocked", name: LONG_NAME });
			expect(typeof parsed[1]?.number).toBe("number");
			expect(typeof parsed[1]?.state).toBe("string");
			expect(typeof parsed[1]?.name).toBe("string");
		},
		120000,
	);

	test.skipIf(!nativeHarnessReady)(
		"text truncates a long name to 32 columns and shows attention",
		async () => {
			const h = await ensureSetup();
			const result = await h.run(["missions"]);
			expect(result.code).toBe(0);
			expect(result.stdout).not.toContain(LONG_NAME);
			expect(result.stdout).toContain(`${LONG_NAME.slice(0, 31)}…`);
			expect(result.stdout).toContain(ATTENTION);
			// Newest first: the long-named mission 2 precedes mission 1.
			expect(result.stdout.indexOf("…")).toBeLessThan(result.stdout.indexOf("lens port"));
		},
		120000,
	);

	test.skipIf(!nativeHarnessReady)(
		"--all includes the closed mission plain missions omits",
		async () => {
			const h = await ensureSetup();
			const plain = await h.run(["missions"]);
			expect(plain.code).toBe(0);
			expect(plain.stdout).not.toContain(CLOSED_NAME);
			const all = await h.run(["missions", "--all"]);
			expect(all.code).toBe(0);
			expect(all.stdout).toContain(CLOSED_NAME);
		},
		120000,
	);
});

describe("mission detail", () => {
	test.skipIf(!nativeHarnessReady)(
		"mission 1 prints the objective and its agents",
		async () => {
			const h = await ensureSetup();
			const result = await h.run(["mission", "1"]);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("Mission 1 · lens port");
			expect(result.stdout).toContain(`Objective: ${OBJECTIVE}`);
			expect(result.stdout).toContain("State: running");
			expect(result.stdout).toContain("bruno");
			expect(result.stdout).toContain("cassia");
			expect(result.stdout).toContain("Draft the port plan.");
		},
		120000,
	);

	test.skipIf(!nativeHarnessReady)(
		"mission 1 --json prints mission, agents and events",
		async () => {
			const h = await ensureSetup();
			const result = await h.run(["mission", "1", "--json"]);
			expect(result.code).toBe(0);
			const parsed = JSON.parse(result.stdout) as {
				mission: Mission;
				agents: Agent[];
				events: Array<{ kind: string }>;
			};
			expect(parsed.mission.number).toBe(1);
			expect(parsed.mission.objective).toBe(OBJECTIVE);
			expect(parsed.agents).toHaveLength(2);
			expect(parsed.events.length).toBeGreaterThan(0);
		},
		120000,
	);

	test.skipIf(!nativeHarnessReady)(
		"mission 99 exits 1",
		async () => {
			const h = await ensureSetup();
			const result = await h.run(["mission", "99"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("neta: no mission #99 in this workspace");
		},
		120000,
	);
});
