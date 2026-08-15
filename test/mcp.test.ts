/**
 * The control plane as a leader actually sees it: over MCP, through a real
 * client, with a fake worker backend underneath.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChannelAddress } from "../src/channel/protocol.ts";
import { ChannelServer } from "../src/channel/server.ts";
import { leaderTools } from "../src/mcp/leader.ts";
import { createMcpServer } from "../src/mcp/serve.ts";
import { workerTools } from "../src/mcp/worker.ts";
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

	kill(): void {}

	finish(outcome: PromptOutcome): void {
		this.pending.shift()?.(outcome);
	}
}

function bodyOf(result: CallToolResult): string {
	return result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
}

describe("leader MCP tools", () => {
	let manager: WorkerManager;
	let transports: FakeTransport[];
	let client: Client;

	beforeEach(async () => {
		transports = [];
		manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config: new NetaConfig(),
			channelAddress: "/tmp/neta-mcp-test.sock",
			onEvent: () => {},
			createTransport: (options) => {
				const transport = new FakeTransport(options);
				transports.push(transport);
				return transport;
			},
		});

		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await createMcpServer("neta", leaderTools(manager)).connect(serverSide);
		client = new Client({ name: "test-leader", version: "0.0.0" });
		await client.connect(clientSide);
	});

	afterEach(async () => {
		await client.close();
		await manager.dispose();
	});

	const call = async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args })) as CallToolResult;

	it("offers the whole worker vocabulary and nothing else", async () => {
		const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

		expect(names).toEqual([
			"neta_answer",
			"neta_kill",
			"neta_log",
			"neta_room",
			"neta_send",
			"neta_spawn",
			"neta_spawn_group",
			"neta_wait",
			"neta_workers",
		]);
	});

	it("spawns a worker and describes what started", async () => {
		const result = await call("neta_spawn", { role: "scout", tier: "senior", task: "map the auth flow" });

		expect(result.isError).toBeFalsy();
		expect(bodyOf(result)).toContain("w1 scout/senior");
		expect(transports[0].options.systemPrompt).toContain("You are a scout");
	});

	it("returns the refusal as a readable result rather than a protocol error", async () => {
		await call("neta_spawn", { role: "worker", tier: "senior", task: "first", writer: true });

		const second = await call("neta_spawn", { role: "worker", tier: "senior", task: "second", writer: true });

		expect(second.isError).toBe(true);
		expect(bodyOf(second)).toContain("already holds the writer slot");
	});

	it("rejects an unknown tier before spawning anything", async () => {
		const result = await call("neta_spawn", { role: "scout", tier: "principal", task: "x" });

		expect(result.isError).toBe(true);
		expect(bodyOf(result)).toContain('Unknown tier "principal"');
		expect(transports).toHaveLength(0);
	});

	// This is the wake-up: an idle leader ends its turn in neta_wait and comes
	// back with the worker's own words.
	it("blocks in neta_wait until the worker finishes, then reports its summary", async () => {
		await call("neta_spawn", { role: "scout", tier: "senior", task: "look" });
		const waiting = call("neta_wait", { workerIds: ["w1"], timeoutSeconds: 10 });
		transports[0].finish({ ok: true, summary: "auth lives in src/auth.ts" });

		expect(bodyOf(await waiting)).toContain("auth lives in src/auth.ts");
	});

	it("gives a blocked worker its answer", async () => {
		await call("neta_spawn", { role: "worker", tier: "senior", task: "do it" });
		const asking = manager.ask("w1", "which database?", new AbortController().signal);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const workers = await call("neta_workers");
		expect(bodyOf(workers)).toContain("asking: which database?");

		await call("neta_answer", { workerId: "w1", answer: "postgres" });
		expect(await asking).toEqual({ ok: true, text: "postgres" });
	});

	it("spawns a group into one room and shares the seed with them", async () => {
		const result = await call("neta_spawn_group", {
			room: "db",
			seed: "Postgres or SQLite?",
			members: [
				{ role: "debater", tier: "staff", task: "argue for postgres" },
				{ role: "debater", tier: "staff", task: "argue for sqlite" },
			],
		});

		expect(bodyOf(result)).toContain("room=db");
		expect(transports).toHaveLength(2);
		expect(bodyOf(await call("neta_room", { room: "db" }))).toContain("Postgres or SQLite?");
	});

	it("shows what a worker has cost once the backend says", async () => {
		await call("neta_spawn", { role: "scout", tier: "senior", task: "look" });
		transports[0].options.events.usage({ totalTokens: 12345, costAmount: 0.31, costCurrency: "USD" });

		expect(bodyOf(await call("neta_workers"))).toContain("12,345 tokens, 0.31 USD");
	});

	it("names the workers that exist when asked about one that does not", async () => {
		const result = await call("neta_kill", { workerId: "w9" });

		expect(result.isError).toBe(true);
		expect(bodyOf(result)).toContain('Unknown worker "w9"');
	});
});

describe("worker MCP tools", () => {
	let address: string;
	let dir: string;
	let server: ChannelServer;
	let manager: WorkerManager;
	let client: Client;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "neta-worker-mcp-"));
		address = process.platform === "win32" ? createChannelAddress() : join(dir, "channel.sock");
		manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config: new NetaConfig(),
			channelAddress: address,
			onEvent: () => {},
			createTransport: (options) => new FakeTransport(options),
		});
		server = new ChannelServer(address, manager);
		await server.start();
		await manager.spawn({ role: "scout", tier: "senior", task: "look" });

		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await createMcpServer("neta-worker", workerTools(address, "w1")).connect(serverSide);
		client = new Client({ name: "test-worker", version: "0.0.0" });
		await client.connect(clientSide);
	});

	afterEach(async () => {
		await client.close();
		await manager.dispose();
		await server.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("carries a notify into the worker's log", async () => {
		await client.callTool({ name: "neta_notify", arguments: { message: "reading auth.ts" } });

		expect(manager.drainLog("w1").map((entry) => entry.text)).toContain("reading auth.ts");
	});

	it("blocks neta_ask until the leader answers", async () => {
		const asking = client.callTool({ name: "neta_ask", arguments: { question: "which database?" } });
		await new Promise((resolve) => setTimeout(resolve, 20));

		manager.answer("w1", "postgres");

		expect(bodyOf((await asking) as CallToolResult)).toBe("postgres");
	});

	it("tells a worker with no room that it has none", async () => {
		const result = (await client.callTool({ name: "neta_say", arguments: { message: "hello" } })) as CallToolResult;

		expect(result.isError).toBe(true);
		expect(bodyOf(result)).toBe("You are not in a room.");
	});
});
