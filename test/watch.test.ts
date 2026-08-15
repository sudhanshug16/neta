/**
 * `neta watch` against a real socket and a real manager: this is what runs in
 * every worker pane.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NETA_LEADER_ENV, NETA_SOCKET_ENV } from "../src/channel/protocol.ts";
import { ChannelServer } from "../src/channel/server.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { writeSessionRecord } from "../src/session.ts";
import { NetaConfig } from "../src/settings.ts";
import { watchWorker } from "../src/watch.ts";
import { EnvStub } from "./helpers.ts";

const env = new EnvStub();

class FakeTransport implements WorkerTransportDriver {
	private pending: Array<(outcome: PromptOutcome) => void> = [];
	readonly options: TransportOptions;

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

describe("watch", () => {
	let dir: string;
	let agentDir: string;
	let address: string;
	let server: ChannelServer;
	let manager: WorkerManager;
	let transports: FakeTransport[];
	let lines: string[];

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "neta-watch-"));
		agentDir = mkdtempSync(join(tmpdir(), "neta-watch-home-"));
		address = join(dir, "channel.sock");
		lines = [];
		transports = [];
		manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config: new NetaConfig(),
			channelAddress: address,
			leaderToken: "tok",
			onEvent: () => {},
			createTransport: (options) => {
				const transport = new FakeTransport(options);
				transports.push(transport);
				return transport;
			},
		});
		server = new ChannelServer(address, manager);
		await server.start();
		env.set(NETA_SOCKET_ENV, address);
		env.set(NETA_LEADER_ENV, "tok");
	});

	afterEach(async () => {
		env.restore();
		await manager.dispose();
		await server.stop();
		rmSync(dir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	const write = (line: string) => {
		lines.push(line);
	};

	// A pane is read at a glance: it has to say who this worker is and what it
	// was asked to do, not just stream unlabelled lines.
	it("introduces the worker, then prints its log", async () => {
		const worker = await manager.spawn({ role: "scout", tier: "senior", task: "map the auth flow" });
		manager.notify(worker.id, "reading auth.ts");

		const code = await watchWorker({ workerId: worker.id, once: true, hold: false, write });

		expect(code).toBe(0);
		expect(lines[0]).toBe(`${worker.id} · scout/senior · claude · read-only`);
		expect(lines[1]).toBe("task: map the auth flow");
		expect(lines).toContain("» reading auth.ts");
		// The tag-per-line noise is gone.
		expect(lines.join("\n")).not.toContain("[notify]");
	});

	// The leader reads its log by draining it. If a pane drained the same log,
	// lines would vanish before the leader ever saw them.
	it("does not consume the lines the leader has not read", async () => {
		const worker = await manager.spawn({ role: "scout", tier: "senior", task: "look" });
		manager.notify(worker.id, "found the bug");

		await watchWorker({ workerId: worker.id, once: true, hold: false, write });

		expect(manager.drainLog(worker.id).map((entry) => entry.text)).toContain("found the bug");
	});

	it("follows until the worker finishes and says how it ended", async () => {
		const worker = await manager.spawn({ role: "scout", tier: "senior", task: "look" });
		const watching = watchWorker({ workerId: worker.id, hold: false, write });
		manager.notify(worker.id, "halfway");
		transports[0].finish({ ok: true, summary: "done looking" });

		expect(await watching).toBe(0);
		expect(lines).toContain("» halfway");
		expect(lines.at(-1)).toBe(`── ${worker.id} done ──`);
	});

	it("reports an unknown worker instead of hanging", async () => {
		const code = await watchWorker({ workerId: "w42", once: true, hold: false, write });

		expect(code).toBe(1);
		expect(lines.join(" ")).toContain('Unknown worker "w42"');
	});

	// A pane is started by the multiplexer's own process, which does not inherit
	// our environment, so watch looks the session up in the registry instead.
	it("finds its session in the registry when the environment says nothing", async () => {
		const worker = await manager.spawn({ role: "scout", tier: "senior", task: "look" });
		manager.notify(worker.id, "from the registry");
		env.set(NETA_SOCKET_ENV, "");
		env.set(NETA_LEADER_ENV, "");
		env.set("NETA_DIR", agentDir);
		writeSessionRecord(
			{
				id: "s7",
				socket: address,
				token: "tok",
				cwd: process.cwd(),
				leader: "claude",
				pid: process.pid,
				startedAt: Date.now(),
			},
			agentDir,
		);

		const code = await watchWorker({ workerId: worker.id, sessionId: "s7", once: true, hold: false, write });

		expect(code).toBe(0);
		expect(lines).toContain("» from the registry");
	});

	it("says so when there is no session to watch", async () => {
		env.set(NETA_SOCKET_ENV, "");
		env.set(NETA_LEADER_ENV, "");
		env.set("NETA_DIR", agentDir);

		const code = await watchWorker({ workerId: "w1", once: true, hold: false, write, cwd: "/nowhere" });

		expect(code).toBe(1);
		expect(lines.join(" ")).toContain("No Neta session found");
	});
});
