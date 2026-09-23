// T8.6: `neta events`, including `--follow`, through the built bundle
// against a temp `NETA_DIR` (the T8.2 harness). Seeds land through the store
// while the Node is stopped, then it restarts (the T8.5 pattern); the live
// notification path runs against a test-local server speaking the 04
// protocol, since no production path broadcasts `event` yet.
import { afterAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatEvent } from "../src/cli/commands/events.ts";
import { ulid } from "../src/core/ids.ts";
import type { Event, Mission } from "../src/core/types.ts";
import { newToken, writeDescriptor } from "../src/node/lockfile.ts";
import { PROTOCOL_VERSION } from "../src/node/protocol.ts";
import { createServer, type Hub, type NodeRuntime, type NodeStore } from "../src/node/server.ts";
import { openStore } from "../src/store/index.ts";
import { paths } from "../src/store/paths.ts";
import { type Harness, nativeHarnessReady, startNode as startHarness } from "./helpers/cli-harness.ts";

const MISSION_NAME = "lens port";
const AGENT_NAME = "bruno";
const PIN_TEXT = "remember this";
const OLD_REASON = "done";

let harness: Harness | undefined;
let workspaceId = "";

function withNetaDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const saved = process.env.NETA_DIR;
	process.env.NETA_DIR = dir;
	return fn().finally(() => {
		if (saved === undefined) {
			delete process.env.NETA_DIR;
		} else {
			process.env.NETA_DIR = saved;
		}
	});
}

// The store stamps `at` itself, so the old event is appended fresh like the
// rest and then backdated in its month file.
async function backdateClosedEvent(dir: string, workspace: string): Promise<void> {
	await withNetaDir(dir, async () => {
		const eventsDir = paths().eventsDir(workspace);
		const oldAt = new Date(Date.now() - 25 * 3600000).toISOString();
		for (const name of await readdir(eventsDir)) {
			if (!name.endsWith(".ndjson")) {
				continue;
			}
			const file = join(eventsDir, name);
			const lines = (await readFile(file, "utf8")).split("\n");
			let changed = false;
			const out = lines.map((line) => {
				if (line === "") {
					return line;
				}
				const record = JSON.parse(line) as { kind?: unknown };
				if (record.kind === "mission.closed") {
					changed = true;
					return JSON.stringify({ ...record, at: oldAt });
				}
				return line;
			});
			if (changed) {
				await writeFile(file, out.join("\n"));
			}
		}
	});
}

async function seed(dir: string, workspace: string): Promise<void> {
	await withNetaDir(dir, async () => {
		const store = await openStore();
		try {
			const number = await store.missions.allocateNumber(workspace);
			const mission: Mission = {
				id: ulid(),
				number,
				workspaceId: workspace,
				machineId: ulid(),
				name: MISSION_NAME,
				objective: "Port the lens to the new runtime.",
				changes: [],
				lead: { kind: "agent", agentId: `fixture-lead-${workspace}` },
				agentIds: [],
				access: "readOnly",
				state: "running",
				createdAt: new Date().toISOString(),
			};
			await store.missions.create(mission);
			await store.events.append({
				workspaceId: workspace,
				kind: "mission.created",
				missionId: mission.id,
				data: { number: mission.number, name: mission.name },
			});
			await store.events.append({
				workspaceId: workspace,
				kind: "agent.spawned",
				missionId: mission.id,
				agentId: ulid(),
				data: { name: AGENT_NAME },
			});
			await store.events.append({
				workspaceId: workspace,
				kind: "user.pinned",
				missionId: mission.id,
				data: { text: PIN_TEXT },
			});
			await store.events.append({
				workspaceId: workspace,
				kind: "leader.modeChanged",
				data: { mode: "leadPlus" },
			});
			await store.events.append({
				workspaceId: workspace,
				kind: "mission.closed",
				missionId: mission.id,
				data: { reason: OLD_REASON },
			});
		} finally {
			await store.close();
		}
	});
	await backdateClosedEvent(dir, workspace);
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
		// `run` inherits the test runner's cwd, so the events below belong
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

function sampleEvent(over: Partial<Event>): Event {
	return {
		seq: 1,
		at: "2026-09-01T00:00:00.000Z",
		workspaceId: "w",
		kind: "mission.created",
		data: {},
		...over,
	};
}

describe("formatEvent", () => {
	test("mission.created shows time, seq, kind, number and name", () => {
		expect(formatEvent(sampleEvent({ seq: 1, missionId: "m1", data: { number: 1, name: MISSION_NAME } }))).toBe(
			"2026-09-01T00:00:00.000Z       1  mission.created       #1     lens port",
		);
	});

	test("leader.modeChanged with no mission shows - and an empty summary", () => {
		expect(formatEvent(sampleEvent({ seq: 2, kind: "leader.modeChanged", data: { mode: "leadPlus" } }))).toBe(
			"2026-09-01T00:00:00.000Z       2  leader.modeChanged    -      ",
		);
	});

	test("an event with empty data shows - and an empty summary", () => {
		expect(formatEvent(sampleEvent({ seq: 3, kind: "agent.finished", missionId: "m9", data: {} }))).toBe(
			"2026-09-01T00:00:00.000Z       3  agent.finished        -      ",
		);
	});
});

describe("events list", () => {
	test.skipIf(!nativeHarnessReady)(
		"events --json returns the default window in ascending seq",
		async () => {
			const h = await ensureSetup();
			const result = await h.run(["events", "--json"]);
			expect(result.code).toBe(0);
			const parsed = JSON.parse(result.stdout) as Event[];
			expect(Array.isArray(parsed)).toBe(true);
			// The default window is the last 24 hours, so the 25-hour-old
			// mission.closed is excluded.
			expect(parsed.map((event) => event.kind)).toEqual([
				"mission.created",
				"agent.spawned",
				"user.pinned",
				"leader.modeChanged",
			]);
			const seqs = parsed.map((event) => event.seq);
			expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
			expect(parsed[0]?.data.name).toBe(MISSION_NAME);
		},
		120000,
	);

	test.skipIf(!nativeHarnessReady)(
		"text output shows numbers and summaries",
		async () => {
			const h = await ensureSetup();
			const result = await h.run(["events"]);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("mission.created");
			expect(result.stdout).toContain("#1");
			expect(result.stdout).toContain(MISSION_NAME);
			expect(result.stdout).toContain(AGENT_NAME);
			expect(result.stdout).toContain(PIN_TEXT);
			expect(result.stdout).toContain("leader.modeChanged");
			expect(result.stdout).not.toContain(OLD_REASON);
		},
		120000,
	);

	test.skipIf(!nativeHarnessReady)(
		"--since 1m excludes the older event, --since 3d keeps it",
		async () => {
			const h = await ensureSetup();
			const narrow = await h.run(["events", "--since", "1m", "--json"]);
			expect(narrow.code).toBe(0);
			const recent = JSON.parse(narrow.stdout) as Event[];
			expect(recent).toHaveLength(4);
			expect(recent.some((event) => event.data.reason === OLD_REASON)).toBe(false);
			const wide = await h.run(["events", "--since", "3d", "--json"]);
			expect(wide.code).toBe(0);
			const all = JSON.parse(wide.stdout) as Event[];
			expect(all).toHaveLength(5);
			expect(all[all.length - 1]?.kind).toBe("mission.closed");
			expect(all[all.length - 1]?.data.reason).toBe(OLD_REASON);
		},
		120000,
	);
});

interface Capture {
	stdout: string;
	stderr: string;
}

function capture(child: ChildProcess): Capture {
	const cap: Capture = { stdout: "", stderr: "" };
	child.stdout?.on("data", (chunk: Buffer) => {
		cap.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		cap.stderr += chunk.toString("utf8");
	});
	return cap;
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
	const deadline = Date.now() + ms;
	for (;;) {
		if (cond()) {
			return;
		}
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((done) => setTimeout(done, 25));
	}
}

function waitExit(child: ChildProcess, ms: number): Promise<number | null> {
	if (child.exitCode !== null) {
		return Promise.resolve(child.exitCode);
	}
	return new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("timed out waiting for events to exit"));
		}, ms);
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

function kill(child: ChildProcess): void {
	if (child.exitCode === null) {
		child.kill("SIGKILL");
	}
}

describe("events follow", () => {
	test.skipIf(!nativeHarnessReady)(
		"a spawned events --follow prints the window and exits 0 on SIGINT",
		async () => {
			const h = await ensureSetup();
			const child = h.spawn(["events", "--follow"]);
			const cap = capture(child);
			try {
				await waitFor(() => cap.stdout.includes("mission.created"), 5000, "the mission.created line");
				expect(cap.stdout).toContain("#1");
				child.kill("SIGINT");
				expect(await waitExit(child, 15000)).toBe(0);
			} finally {
				kill(child);
			}
		},
		120000,
	);

	test.skipIf(!nativeHarnessReady)(
		"follow prints live event notifications for this workspace only",
		async () => {
			// A test-local server speaking the 04 protocol: the bundle under test
			// is real, only the Node side is doubled, so the subscription,
			// workspace filter and SIGINT shutdown run for real.
			const live = await startHarness();
			let hub: Hub | undefined;
			let server: { close(): Promise<void> } | undefined;
			const saved = process.env.NETA_DIR;
			try {
				process.env.NETA_DIR = live.dir;
				const socketPath = join(live.dir, "node.sock");
				const token = newToken();
				const workspace = "test-events-ws";
				const created = await createServer({
					socketPath,
					token,
					handlers: {
						"workspace.open": () => Promise.resolve({ workspace: { id: workspace }, leader: {} }),
						"missions.list": () => Promise.resolve({ missions: [] }),
						"events.list": () => Promise.resolve({ events: [] }),
					},
					ctx: {
						store: { machine: () => ({}) } as unknown as NodeStore,
						runtime: {} as unknown as NodeRuntime,
						nodeVersion: "0.0.0-test",
						stop: () => Promise.resolve(),
					},
				});
				server = created;
				hub = created.hub;
				await writeDescriptor({
					socket: socketPath,
					token,
					pid: process.pid,
					protocolVersion: PROTOCOL_VERSION,
					startedAt: new Date().toISOString(),
				});
				const child = live.spawn(["events", "--follow"]);
				const cap = capture(child);
				try {
					// Give the CLI a moment to subscribe before broadcasting.
					await new Promise((done) => setTimeout(done, 1000));
					expect(child.exitCode).toBeNull();
					hub.broadcast("event", {
						event: {
							seq: 7,
							at: new Date().toISOString(),
							workspaceId: "another-workspace",
							kind: "mission.created",
							data: { number: 9, name: "foreign mission" },
						},
					});
					hub.broadcast("event", {
						event: {
							seq: 8,
							at: new Date().toISOString(),
							workspaceId: workspace,
							kind: "mission.created",
							missionId: "m-live",
							data: { number: 7, name: "live mission" },
						},
					});
					await waitFor(() => cap.stdout.includes("live mission"), 5000, "the live mission.created line");
					expect(cap.stdout).toContain("mission.created");
					expect(cap.stdout).toContain("#7");
					expect(cap.stdout).not.toContain("foreign mission");
					child.kill("SIGINT");
					expect(await waitExit(child, 15000)).toBe(0);
				} finally {
					kill(child);
				}
			} finally {
				await server?.close();
				// The harness stops whatever `node.json` names: never ourselves.
				await rm(join(live.dir, "node.json"), { force: true });
				if (saved === undefined) {
					delete process.env.NETA_DIR;
				} else {
					process.env.NETA_DIR = saved;
				}
				await live.stop();
			}
		},
		120000,
	);
});
