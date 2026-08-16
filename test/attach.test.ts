/**
 * `neta attach` against a real socket and a real manager.
 *
 * The premise is verified against the shipped bridges: the id ACP hands back at
 * session/new is the id the vendor files the conversation under, so
 * `claude --resume <id>` opens the very conversation a worker had.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachWorker } from "../src/attach.ts";
import { NETA_LEADER_ENV, NETA_SOCKET_ENV } from "../src/channel/protocol.ts";
import { ChannelServer } from "../src/channel/server.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { NetaConfig } from "../src/settings.ts";
import { EnvStub, fixtureBackendConfig } from "./helpers.ts";

const env = new EnvStub();

/** Reports a backend session id the way a real ACP handshake does. */
class FakeTransport implements WorkerTransportDriver {
	private pending: Array<(outcome: PromptOutcome) => void> = [];
	readonly options: TransportOptions;
	private readonly vendorSessionId: string | undefined;

	constructor(options: TransportOptions, vendorSessionId?: string) {
		this.options = options;
		this.vendorSessionId = vendorSessionId;
	}

	start(): Promise<void> {
		if (this.vendorSessionId) this.options.events.vendorSession(this.vendorSessionId);
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

describe("attach", () => {
	let dir: string;
	let address: string;
	let server: ChannelServer;
	let manager: WorkerManager;
	let transports: FakeTransport[];
	let lines: string[];
	let vendorSessionId: string | undefined;

	const write = (line: string) => {
		lines.push(line);
	};

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "neta-attach-"));
		address = join(dir, "channel.sock");
		lines = [];
		transports = [];
		vendorSessionId = "4f692d5c-165f-4dc6-a758-1e5f3c8ab7a3";
		manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config: fixtureBackendConfig(),
			channelAddress: address,
			leaderToken: "tok",
			onEvent: () => {},
			createTransport: (options) => {
				const transport = new FakeTransport(options, vendorSessionId);
				transports.push(transport);
				return transport;
			},
		});
		server = new ChannelServer(address, manager);
		await server.start();
		env.set(NETA_SOCKET_ENV, address);
		env.set(NETA_LEADER_ENV, "tok");
		env.set("NETA_DIR", dir);
	});

	afterEach(async () => {
		env.restore();
		await manager.dispose();
		await server.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("opens the worker's own session in the backend's CLI", async () => {
		await manager.spawn({ role: "scout", tier: "expert", task: "look", name: "auth flow" });
		transports[0].finish({ ok: true, summary: "done" });
		await manager.waitFor(["ro1"], 5000);

		const code = await attachWorker({ workerId: "ro1", dryRun: true, write });

		expect(code).toBe(0);
		expect(lines).toContain(`claude --resume ${vendorSessionId}`);
	});

	// Neta keeps driving a running worker, so two clients would take turns in one
	// conversation. That is the user's call, but they should know they made it.
	it("warns when the worker is still being driven by the leader", async () => {
		await manager.spawn({ role: "scout", tier: "expert", task: "look" });

		await attachWorker({ workerId: "ro1", dryRun: true, write });

		expect(lines.join(" ")).toContain("still running");
		expect(lines.join(" ")).toContain("interleave");
	});

	it("says so when the backend has not opened a session yet", async () => {
		vendorSessionId = undefined;
		await manager.spawn({ role: "scout", tier: "expert", task: "look" });

		const code = await attachWorker({ workerId: "ro1", dryRun: true, write });

		expect(code).toBe(1);
		expect(lines.join(" ")).toContain("has not opened a backend session yet");
	});

	it("reports an unknown worker", async () => {
		const code = await attachWorker({ workerId: "ro9", dryRun: true, write });

		expect(code).toBe(1);
		expect(lines.join(" ")).toContain('Unknown worker "ro9"');
	});
});

describe("resume commands", () => {
	// The ids and flags were read off the running CLIs, not guessed.
	it("knows how each backend reopens one of its sessions", () => {
		const config = new NetaConfig();

		expect(config.resumeCommand("claude", "abc")).toEqual({ command: "claude", args: ["--resume", "abc"] });
		expect(config.resumeCommand("codex", "abc")).toEqual({ command: "codex", args: ["resume", "abc"] });
		expect(config.resumeCommand("opencode", "abc")).toEqual({ command: "opencode", args: ["--session", "abc"] });
	});

	it("has nothing to offer for a backend the user invented", () => {
		const config = new NetaConfig({ backends: { mine: { command: "my-agent" } } });

		expect(config.resumeCommand("mine", "abc")).toBeUndefined();
	});
});
