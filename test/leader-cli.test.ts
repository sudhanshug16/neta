/**
 * End-to-end test of the socket door: a process that holds the leader token
 * drives workers by running the `neta` CLI from its shell. This exercises the
 * real shim, a real subprocess, a real socket and a real WorkerManager, with a
 * fake worker transport standing in for the backend CLI.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createChannelAddress,
	NETA_LEADER_ENV,
	NETA_SOCKET_ENV,
	NETA_WORKER_ENV,
	NETA_WORKER_TOKEN_ENV,
} from "../src/channel/protocol.ts";
import { ChannelServer } from "../src/channel/server.ts";
import { createLeaderCliShim, prependToPath } from "../src/cli-shim.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { writeSessionRecord } from "../src/session.ts";
import { fixtureBackendConfig, waitFor } from "./helpers.ts";

class FakeTransport implements WorkerTransportDriver {
	readonly options: TransportOptions;
	readonly prompts: string[] = [];
	private pending: Array<(outcome: PromptOutcome) => void> = [];

	constructor(options: TransportOptions) {
		this.options = options;
	}

	start(): Promise<void> {
		return Promise.resolve();
	}

	prompt(text: string): Promise<PromptOutcome> {
		this.prompts.push(text);
		return new Promise((resolve) => this.pending.push(resolve));
	}

	async kill(): Promise<void> {}

	cancels = 0;

	/** A real ACP agent answers a cancel by resolving the in-flight prompt. */
	cancel(): boolean {
		this.cancels += 1;
		const resolve = this.pending.shift();
		if (resolve) queueMicrotask(() => resolve({ ok: false, cancelled: true, summary: "Turn cancelled." }));
		return true;
	}

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
	const config = fixtureBackendConfig();
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
		[NETA_WORKER_ENV]: "",
		[NETA_WORKER_TOKEN_ENV]: "",
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
		const spawned = await neta(["spawn", "--role", "scout", "--tier", "expert", "map the auth flow"], asLeader());

		expect(spawned.code).toBe(0);
		expect(spawned.stdout).toContain("scout/expert, read-only");
		expect(transports).toHaveLength(1);

		const listed = await neta(["workers"], asLeader());
		expect(listed.stdout).toContain(
			"ro1 [scout/expert, read-only, model unknown — backend default] running — map the auth flow",
		);
	});

	// The socket is the second door onto the same operations. `send` steers here
	// exactly as the leader's tool does, and says which of the two things it did.
	it("steers a running worker from the shell", async () => {
		await neta(["spawn", "--role", "scout", "--tier", "expert", "map the auth flow"], asLeader());
		await waitFor(() => expect(transports[0].prompts.length).toBe(1));

		const sent = await neta(["send", "ro1", "look at the session store instead"], asLeader());
		expect(sent.code).toBe(0);
		expect(sent.stdout).toContain("Interrupted ro1's running turn");
		expect(transports[0].cancels).toBe(1);
		expect(transports[0].prompts[1]).toBe("look at the session store instead");
	});

	// Bounded, non-consuming, and available for a worker with no pane — this is
	// the expand path a status row points at.
	it("expands a worker's recent input and output from the shell", async () => {
		await neta(["spawn", "--role", "scout", "--tier", "expert", "map the auth flow"], asLeader());
		await waitFor(() => expect(transports[0].prompts.length).toBe(1));

		manager.progress("ro1", "reading session.ts");

		const inspected = await neta(["inspect", "ro1"], asLeader());
		expect(inspected.code).toBe(0);
		expect(inspected.stdout).toContain("task: map the auth flow");
		expect(inspected.stdout).toContain("reading session.ts");

		// Looking did not steal the leader's unread lines.
		expect(manager.drainLog("ro1").map((entry) => entry.text)).toContain("reading session.ts");
	});

	it("says how to call inspect when the worker id is missing", async () => {
		const result = await neta(["inspect"], asLeader());
		expect(result.stderr).toContain("Usage: neta inspect <worker-id>");
	});

	it("carries --name and --note through the socket spawn", async () => {
		const note = manager.createNote("wire the auth flow");
		const result = await neta(
			[
				"spawn",
				"--role",
				"scout",
				"--tier",
				"expert",
				"--name",
				"auth flow",
				"--note",
				note.id,
				"map the auth flow",
			],
			asLeader(),
		);

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(manager.get("ro1").name).toBe("auth flow");
		expect(manager.getOpenNotes()[0].workers.map((worker) => worker.workerId)).toEqual(["ro1"]);
	});

	it("answers spawn --help without a session", async () => {
		// An empty NETA_DIR means no session registry, and blank channel
		// variables mean no leader environment: nothing to resolve a target from.
		const emptyDir = mkdtempSync(join(tmpdir(), "neta-empty-"));
		try {
			const result = await neta(["spawn", "--help"], {
				NETA_DIR: emptyDir,
				[NETA_SOCKET_ENV]: "",
				[NETA_LEADER_ENV]: "",
				[NETA_WORKER_ENV]: "",
				[NETA_WORKER_TOKEN_ENV]: "",
			});

			expect(result.code).toBe(0);
			expect(result.stdout).toContain("spawn --role <role> --tier <tier>");
			expect(result.stderr).not.toContain("No Neta session found");
		} finally {
			await rm(emptyDir, { recursive: true, force: true });
		}
	});

	it("carries the worker's own reply back to the leader", async () => {
		await neta(["spawn", "--role", "scout", "--tier", "expert", "look around"], asLeader());
		const waiting = neta(["wait", "ro1", "--timeout", "10"], asLeader());
		transports[0].finish({ ok: true, summary: "auth lives in src/auth.ts" });

		const result = await waiting;
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("auth lives in src/auth.ts");
	});

	it("lets a worker report progress through the same shim", async () => {
		await neta(["spawn", "--role", "scout", "--tier", "expert", "look"], asLeader());

		const progressed = await neta(["progress", "reading auth.ts"], {
			[NETA_SOCKET_ENV]: address,
			[NETA_WORKER_ENV]: "ro1",
			[NETA_WORKER_TOKEN_ENV]: transports[0].options.env[NETA_WORKER_TOKEN_ENV],
		});

		expect(progressed.code).toBe(0);
		expect(manager.drainLog("ro1").map((entry) => entry.text)).toContain("reading auth.ts");
	});

	it("rejects the removed notify worker subcommand", async () => {
		const result = await neta(["notify", "reading auth.ts"], {
			[NETA_SOCKET_ENV]: address,
			[NETA_WORKER_ENV]: "ro1",
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Unknown command "notify"');
	});

	it("refuses leader words from a worker and skips the session registry", async () => {
		const registry = mkdtempSync(join(tmpdir(), "neta-worker-registry-"));
		writeSessionRecord(
			{
				id: "leader-session",
				socket: address,
				token: manager.leaderToken,
				cwd: process.cwd(),
				leader: "claude",
				pid: process.pid,
				startedAt: Date.now(),
			},
			registry,
		);
		const result = await neta(["spawn", "--role", "scout", "--tier", "expert", "escalate"], {
			NETA_DIR: registry,
			[NETA_SOCKET_ENV]: address,
			[NETA_WORKER_ENV]: "ro1",
			[NETA_WORKER_TOKEN_ENV]: "worker-token",
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Workers cannot run leader command `spawn`");
		expect(result.stderr).toContain("progress, ask, say, room, status --writers");
		expect(transports).toHaveLength(0);
		await rm(registry, { recursive: true, force: true });
	});

	it("reports an unknown worker instead of failing silently", async () => {
		const result = await neta(["log", "ro42"], asLeader());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Unknown worker "ro42"');
	});
});
