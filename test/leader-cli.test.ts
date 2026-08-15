/**
 * End-to-end test of the socket door: a process that holds the leader token
 * drives workers by running the `neta` CLI from its shell. This exercises the
 * real shim, a real subprocess, a real socket and a real WorkerManager, with a
 * fake worker transport standing in for the backend CLI.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChannelAddress, NETA_LEADER_ENV, NETA_SOCKET_ENV, NETA_WORKER_ENV } from "../src/channel/protocol.ts";
import { ChannelServer } from "../src/channel/server.ts";
import { createLeaderCliShim, prependToPath } from "../src/cli-shim.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { NetaConfig } from "../src/settings.ts";

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

	async kill(): Promise<void> {}

	markTerminal(): void {}

	finish(outcome: PromptOutcome): void {
		this.pending.shift()?.(outcome);
	}
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

describe("leader CLI over the real shim", () => {
	const config = new NetaConfig();
	let shimDir: string;
	let address: string;
	let server: ChannelServer;
	let manager: WorkerManager;
	let transports: FakeTransport[];

	/** Run the shim exactly as the leader's backend would, through its shell. */
	function neta(args: string[], env: Record<string, string>): Promise<RunResult> {
		return new Promise((resolve) => {
			const child = spawn(join(shimDir, "neta"), args, {
				env: { ...process.env, PATH: prependToPath(shimDir, process.env.PATH), ...env },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
		});
	}

	const asLeader = (): Record<string, string> => ({
		[NETA_SOCKET_ENV]: address,
		[NETA_LEADER_ENV]: manager.leaderToken,
	});

	// Under vitest, process.argv[1] is the test runner, so name our CLI directly.
	const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

	beforeEach(async () => {
		transports = [];
		shimDir = await createLeaderCliShim({ command: process.execPath, prefixArgs: [CLI] });
		address = createChannelAddress();
		manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config,
			channelAddress: address,
			onEvent: () => {},
			createTransport: (options) => {
				const transport = new FakeTransport(options);
				transports.push(transport);
				return transport;
			},
		});
		server = new ChannelServer(address, manager);
		await server.start();
	});

	afterEach(async () => {
		await manager.dispose();
		await server.stop();
		await rm(shimDir, { recursive: true, force: true });
	});

	it("runs as a working `neta` command from a directory on PATH", async () => {
		const result = await neta(["workers"], asLeader());

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("No workers.");
	});

	it("spawns a worker the leader can then see and instruct", async () => {
		const spawned = await neta(["spawn", "--role", "scout", "--tier", "senior", "map the auth flow"], asLeader());

		expect(spawned.code).toBe(0);
		expect(spawned.stdout).toContain("scout/senior, read-only");
		expect(transports).toHaveLength(1);

		const listed = await neta(["workers"], asLeader());
		expect(listed.stdout).toContain("w1 [scout/senior, read-only] running — map the auth flow");
	});

	it("carries the worker's own reply back to the leader", async () => {
		await neta(["spawn", "--role", "scout", "--tier", "senior", "look around"], asLeader());
		const waiting = neta(["wait", "w1", "--timeout", "10"], asLeader());
		transports[0].finish({ ok: true, summary: "auth lives in src/auth.ts" });

		const result = await waiting;
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("auth lives in src/auth.ts");
	});

	it("lets a worker report back through the same shim", async () => {
		await neta(["spawn", "--role", "scout", "--tier", "senior", "look"], asLeader());

		const notified = await neta(["notify", "reading auth.ts"], {
			[NETA_SOCKET_ENV]: address,
			[NETA_WORKER_ENV]: "w1",
		});

		expect(notified.code).toBe(0);
		expect(manager.drainLog("w1").map((entry) => entry.text)).toContain("reading auth.ts");
	});

	it("refuses leader commands from a worker, which never holds the token", async () => {
		const result = await neta(["spawn", "--role", "scout", "--tier", "senior", "escalate"], {
			[NETA_SOCKET_ENV]: address,
			[NETA_WORKER_ENV]: "w1",
			[NETA_LEADER_ENV]: "guessed-token",
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Invalid leader token");
		expect(transports).toHaveLength(0);
	});

	it("reports an unknown worker instead of failing silently", async () => {
		const result = await neta(["log", "w42"], asLeader());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Unknown worker "w42"');
	});
});
