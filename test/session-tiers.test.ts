/**
 * Session tier availability is enforcement, not presentation.
 *
 * The startup checklist narrows the tool schemas and the leader prompt so the
 * leader knows the shape of the ladder it has. These tests are about the other
 * half: that a caller which ignores all of that — a hand-written tool call, the
 * Unix socket, an older prompt — is refused, and refused without leaving
 * anything half-done behind.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { leaderTools } from "../src/mcp/leader.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { buildLeaderPrompt } from "../src/prompts/leader.ts";
import { TIERS, type Tier } from "../src/types.ts";
import { fixtureBackendConfig } from "./helpers.ts";

class FakeTransport implements WorkerTransportDriver {
	readonly options: TransportOptions;
	private pending: Array<(outcome: PromptOutcome) => void> = [];
	constructor(options: TransportOptions) {
		this.options = options;
	}
	start(): Promise<void> {
		return Promise.resolve();
	}
	prompt(): Promise<PromptOutcome> {
		return new Promise((resolve) => this.pending.push(resolve));
	}
	cancel(): boolean {
		return true;
	}
	async kill(): Promise<void> {}
	markTerminal(): void {}
}

function managerWith(sessionTiers?: Tier[]): { manager: WorkerManager; transports: FakeTransport[] } {
	const transports: FakeTransport[] = [];
	const manager = new WorkerManager({
		cwd: process.cwd(),
		agentDir: "/nonexistent-agent-dir",
		config: fixtureBackendConfig(),
		sessionTiers,
		channelAddress: "/tmp/neta-tiers-test.sock",
		leaderToken: "leader-token",
		onEvent: () => {},
		createTransport: (options) => {
			const transport = new FakeTransport(options);
			transports.push(transport);
			return transport;
		},
	});
	return { manager, transports };
}

const task = "do the thing";

describe("session tier enforcement", () => {
	let manager: WorkerManager;
	let transports: FakeTransport[];

	beforeEach(() => {
		({ manager, transports } = managerWith(["journeyman", "expert"]));
	});

	it("reports the tiers it was started with, in canonical order", () => {
		expect(managerWith(["architect", "apprentice"]).manager.sessionTiers).toEqual(["apprentice", "architect"]);
	});

	it("staffs an available tier", async () => {
		const worker = await manager.spawn({ role: "scout", tier: "expert", task });
		expect(worker.tier).toBe("expert");
	});

	it("refuses an unavailable tier and names what is available", async () => {
		await expect(manager.spawn({ role: "scout", tier: "architect", task })).rejects.toThrow(
			/Tier "architect" is not available in this session\. Available: journeyman, expert/,
		);
	});

	// The refusal has to happen before anything is reserved, or a rejected spawn
	// silently costs a worker id, the writer slot, or a scratch directory.
	it("leaves nothing behind when it refuses", async () => {
		await expect(manager.spawn({ role: "worker", tier: "architect", task, writer: true })).rejects.toThrow();
		expect(manager.list()).toEqual([]);
		expect(transports).toEqual([]);
		expect(manager.statusSnapshot().writerSlot).toBeUndefined();
		// The next real spawn still gets the first id, so nothing was consumed.
		expect((await manager.spawn({ role: "scout", tier: "expert", task })).id).toBe("ro1");
	});

	it("refuses to plan work it could not staff", () => {
		expect(() =>
			manager.planAssignments([
				{ role: "scout", tier: "expert" },
				{ role: "worker", tier: "architect" },
			]),
		).toThrow(/Tier "architect" is not available/);
	});

	// A group is one call. Refusing member three after starting members one and
	// two would leave the leader a half-built room to clean up.
	it("delegates no worker when one member names an unavailable tier", async () => {
		const tools = leaderTools(manager);
		const delegate = tools.find((tool) => tool.name === "neta_delegate");
		await expect(
			delegate?.run({
				team: "debate",
				seed: "argue about the cache",
				workers: [
					{ role: "debater", tier: "expert", task },
					{ role: "debater", tier: "architect", task },
				],
			}),
		).rejects.toThrow(/Tier "architect" is unavailable/);
		expect(manager.list()).toEqual([]);
		// Not even the seed was posted: the room does not exist.
		expect(() => manager.tailRoom("debate")).toThrow(/Unknown room/);
	});

	it("delegates the whole batch when every tier is available", async () => {
		const delegate = leaderTools(manager).find((tool) => tool.name === "neta_delegate");
		await delegate?.run({
			team: "debate",
			workers: [
				{ role: "debater", tier: "expert", task },
				{ role: "debater", tier: "journeyman", task },
			],
		});
		expect(manager.list().map((worker) => worker.tier)).toEqual(["expert", "journeyman"]);
	});

	it("offers only the available tiers in the delegate schema", () => {
		const tools = leaderTools(manager);
		const schema = JSON.stringify(tools.find((tool) => tool.name === "neta_delegate")?.inputSchema);
		expect(schema).toContain('"expert"');
		expect(schema).not.toContain('"architect"');
	});

	it("does not expose the removed planning and settings tools", () => {
		const names = leaderTools(manager).map((tool) => tool.name);
		for (const name of ["neta_spawn", "neta_spawn_group", "neta_plan", "neta_remember"]) {
			expect(names).not.toContain(name);
		}
	});

	it("describes only the available rungs in the leader's instructions", () => {
		const prompt = buildLeaderPrompt({ tiers: {}, availableTiers: ["journeyman", "expert"] });
		expect(prompt).toContain("**journeyman**");
		expect(prompt).toContain("**expert**");
		expect(prompt).not.toContain("**architect**");
		expect(prompt).toContain("This session was started with only these tiers: journeyman, expert");
	});

	it("says nothing about restrictions when there are none", () => {
		const prompt = buildLeaderPrompt({ tiers: {} });
		expect(prompt).toContain("**architect**");
		expect(prompt).not.toContain("This session was started with only these tiers");
	});
});

describe("a session with no tier choice", () => {
	// Absent is not "none". A manager built by an older launcher, a test, or a
	// hand-registered `neta mcp` keeps the full ladder.
	it("staffs every tier", async () => {
		const { manager } = managerWith(undefined);
		expect(manager.sessionTiers).toEqual([...TIERS]);
		expect(manager.allTiersAvailable).toBe(true);
		for (const tier of TIERS) {
			expect((await manager.spawn({ role: "scout", tier, task })).tier).toBe(tier);
		}
	});

	it("refuses to exist with an empty ladder", () => {
		expect(() => managerWith([])).toThrow(/at least one worker tier/);
	});
});
