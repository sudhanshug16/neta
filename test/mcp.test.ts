/**
 * The control plane as a leader actually sees it: over MCP, through a real
 * client, with a fake worker backend underneath.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createChannelAddress } from "../src/channel/protocol.ts";
import { ChannelServer } from "../src/channel/server.ts";
import { leaderTools } from "../src/mcp/leader.ts";
import { createMcpServer } from "../src/mcp/serve.ts";
import { workerTools } from "../src/mcp/worker.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
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

	async kill(): Promise<void> {}

	markTerminal(): void {}

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
			config: fixtureBackendConfig(),
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
			"neta_note",
			"neta_plan",
			"neta_remember",
			"neta_room",
			"neta_send",
			"neta_spawn",
			"neta_spawn_group",
			"neta_status",
			"neta_wait",
			"neta_workers",
		]);
	});

	it("spawns a worker and describes what started", async () => {
		const result = await call("neta_spawn", { role: "scout", tier: "apprentice", task: "map the auth flow" });

		expect(result.isError).toBeFalsy();
		expect(bodyOf(result)).toContain("ro1 scout/apprentice");
		expect(transports[0].options.systemPrompt).toContain("You are a scout");
	});

	it("queues a second writer and reports queued status", async () => {
		await call("neta_spawn", { role: "worker", tier: "expert", task: "first", writer: true });

		const second = await call("neta_spawn", { role: "worker", tier: "expert", task: "second", writer: true });

		expect(second.isError).toBe(false);
		expect(bodyOf(second)).toContain("Queued");
	});

	it("shows linked worker progress in the open-notes footer", async () => {
		await call("neta_note", { text: "auth work" });
		await call("neta_spawn", { role: "worker", tier: "expert", task: "auth", writer: true, note: "n1" });
		await call("neta_note", { text: "docs pass" });
		await call("neta_spawn", { role: "worker", tier: "expert", task: "docs", writer: true, note: "n2" });
		await call("neta_note", { text: "cost estimate" });

		const body = bodyOf(await call("neta_workers"));
		expect(body).toContain('n1 "auth work" (rw1 in progress)');
		expect(body).toContain('n2 "docs pass" (rw2 queued)');
		expect(body).toContain('n3 "cost estimate" (unworked)');

		// neta_wait carries the same footer.
		const waited = bodyOf(await call("neta_wait", { workerIds: ["rw1"], timeoutSeconds: 0 }));
		expect(waited).toContain('n1 "auth work" (rw1 in progress)');
	});

	it("returns the consolidated status through the real MCP client", async () => {
		await call("neta_note", { text: "auth work" });
		await call("neta_spawn", { role: "worker", tier: "expert", task: "auth", writer: true, note: "n1" });
		await call("neta_spawn", { role: "worker", tier: "expert", task: "docs", writer: true });

		const body = bodyOf(await call("neta_status"));

		expect(body).toContain("Writer slot:\n  rw1 worker/expert | backend=claude | running | writer");
		expect(body).toContain("Writer queue:\n  rw2 worker/expert | backend=codex | queued | writer");
		expect(body).toContain("Waiting (blocked on leader answer):\n  (none)");
		expect(body).toContain('Open notes:\n  n1 "auth work" (rw1 running)');
	});

	it("keeps the done form in the footer once a linked worker finishes", async () => {
		await call("neta_note", { text: "auth work" });
		await call("neta_spawn", { role: "worker", tier: "expert", task: "auth", note: "n1" });
		transports[0].finish({ ok: true, summary: "done" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(bodyOf(await call("neta_workers"))).toContain('n1 "auth work" (ro1 done)');
	});

	it("shows no result line for workers that have not finished", async () => {
		await call("neta_spawn", { role: "worker", tier: "expert", task: "first", writer: true });
		await call("neta_spawn", { role: "worker", tier: "expert", task: "second", writer: true });

		const body = bodyOf(await call("neta_workers"));
		expect(body).not.toContain("result:");
		expect(body).not.toContain("starts automatically");
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
		await call("neta_spawn", { role: "scout", tier: "expert", task: "look" });
		const waiting = call("neta_wait", { workerIds: ["ro1"], timeoutSeconds: 10 });
		transports[0].finish({ ok: true, summary: "auth lives in src/auth.ts" });

		expect(bodyOf(await waiting)).toContain("auth lives in src/auth.ts");
	});

	it("returns the first finished worker with first=true, listing the rest as still running", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "a" });
		await call("neta_spawn", { role: "scout", tier: "expert", task: "b" });

		const waiting = call("neta_wait", { workerIds: ["ro1", "ro2"], first: true, timeoutSeconds: 10 });
		transports[0].finish({ ok: true, summary: "found a" });

		const body = bodyOf(await waiting);
		expect(body).toContain("result: found a");
		expect(body).toContain("Still running");
		expect(body).toContain("ro2 scout/expert");
		expect(manager.get("ro2").state).toBe("running");
	});

	it("wakes neta_wait when a worker blocks on a question", async () => {
		await call("neta_spawn", { role: "worker", tier: "expert", task: "migrate" });
		await call("neta_spawn", { role: "scout", tier: "expert", task: "look" });

		const waiting = call("neta_wait", { timeoutSeconds: 10 });
		const asking = manager.ask("ro1", "which database?", new AbortController().signal);

		const body = bodyOf(await waiting);
		expect(body).toContain("blocked on a question");
		expect(body).toContain("which database?");
		expect(body).toContain("ro2 scout/expert");

		await call("neta_answer", { workerId: "ro1", answer: "postgres" });
		expect(await asking).toEqual({ ok: true, text: "postgres" });
	});

	it("wakes neta_wait on room activity when opted in with roomEvents", async () => {
		await call("neta_spawn", { role: "debater", tier: "architect", task: "argue", room: "db" });

		const waiting = call("neta_wait", { workerIds: ["ro1"], roomEvents: true, timeoutSeconds: 10 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		manager.postToRoom("db", "leader", "leader", "fresh evidence");

		const body = bodyOf(await waiting);
		expect(body).toContain('New activity in room "db"');
		expect(body).toContain("fresh evidence");
		expect(body).toContain("neta_room");
	});

	it("gives a blocked worker its answer", async () => {
		await call("neta_spawn", { role: "worker", tier: "expert", task: "do it" });
		const asking = manager.ask("ro1", "which database?", new AbortController().signal);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const workers = await call("neta_workers");
		expect(bodyOf(workers)).toContain("asking: which database?");

		await call("neta_answer", { workerId: "ro1", answer: "postgres" });
		expect(await asking).toEqual({ ok: true, text: "postgres" });
	});

	it("spawns a group into one room and shares the seed with them", async () => {
		const result = await call("neta_spawn_group", {
			room: "db",
			seed: "Postgres or SQLite?",
			members: [
				{ role: "debater", tier: "architect", task: "argue for postgres" },
				{ role: "debater", tier: "architect", task: "argue for sqlite" },
			],
		});

		expect(bodyOf(result)).toContain("room=db");
		expect(transports).toHaveLength(2);
		expect(bodyOf(await call("neta_room", { room: "db" }))).toContain("Postgres or SQLite?");
	});

	it("honors a group member's backend override", async () => {
		const result = await call("neta_spawn_group", {
			room: "db",
			members: [
				{ role: "debater", tier: "architect", task: "argue for postgres", backend: "opencode" },
				{ role: "debater", tier: "architect", task: "argue for sqlite", backend: "codex" },
			],
		});

		expect(result.isError).toBeFalsy();
		expect(manager.get("ro1").backend).toBe("opencode");
		expect(manager.get("ro2").backend).toBe("codex");
	});

	it("shows the latest progress milestone as a truncated last: line in listings", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "look" });
		expect(bodyOf(await call("neta_workers"))).not.toContain("last:");

		manager.progress("ro1", `progress: ${"x".repeat(100)}`);

		const body = bodyOf(await call("neta_workers"));
		expect(body).toContain("last: progress: x");
		expect(body).not.toContain("x".repeat(100));
		// The consolidated status snapshot carries the same line.
		expect(bodyOf(await call("neta_status"))).toContain("last: progress: x");
	});

	it("shows what a worker has cost once the backend says", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "look" });
		transports[0].options.events.usage({ totalTokens: 12345, costAmount: 0.31, costCurrency: "USD" });

		expect(bodyOf(await call("neta_workers"))).toContain("12,345 tokens, 0.31 USD");
	});

	it("shows the worker's negotiated model and mode when the backend reports them", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "look" });
		transports[0].options.events.session({ model: "test-model", mode: "test-mode", agentInfo: "bridge@2.0.0" });

		const workers = bodyOf(await call("neta_workers"));
		expect(workers).toContain("model=test-model");
		expect(workers).toContain("mode=test-mode");
		// List lines stay compact; the bridge shows in the single-worker view.
		expect(workers).not.toContain("bridge@2.0.0");
		expect(bodyOf(await call("neta_workers", { workerId: "ro1" }))).toContain("Bridge: bridge@2.0.0");
	});

	it("names the workers that exist when asked about one that does not", async () => {
		const result = await call("neta_kill", { workerId: "ro9" });

		expect(result.isError).toBe(true);
		expect(bodyOf(result)).toContain('Unknown worker "ro9"');
	});

	it("computes backend assignments without spawning via neta_plan", async () => {
		const result = await call("neta_plan", {
			workers: [
				{ role: "scout", tier: "expert" },
				{ role: "worker", tier: "expert", writer: true },
			],
		});

		const body = bodyOf(result);
		expect(body).toContain("1. scout/expert ->");
		expect(body).toContain("2. worker/expert ->");
		expect(body).toContain("read-only");
		expect(body).toContain("writer");

		// Should not have spawned any workers
		expect(transports.length).toBe(0);
	});

	it("omits tool/diff/thought entries from neta_log by default", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "look" });
		transports[0].options.events.log("tool", "Read File auth.ts");
		transports[0].options.events.log("text", "Found the issue");
		transports[0].options.events.log("thought", "considering options");
		transports[0].options.events.log("diff", "patch content");
		transports[0].options.events.log("progress", "done reading");

		const log = await call("neta_log", { workerId: "ro1" });

		const body = bodyOf(log);
		expect(body).toContain("[text] Found the issue");
		expect(body).toContain("[progress] done reading");
		expect(body).not.toContain("[tool]");
		expect(body).not.toContain("[thought]");
		expect(body).not.toContain("[diff]");
	});

	it("includes all entry kinds in neta_log when full=true", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "look" });
		transports[0].options.events.log("tool", "Read File auth.ts");
		transports[0].options.events.log("text", "Found the issue");
		transports[0].options.events.log("thought", "considering options");

		const log = await call("neta_log", { workerId: "ro1", full: true });

		const body = bodyOf(log);
		expect(body).toContain("[tool] Read File auth.ts");
		expect(body).toContain("[text] Found the issue");
		expect(body).toContain("[thought] considering options");
	});

	it("returns the full result for a single-worker neta_workers query", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "look" });
		const longResult = "x".repeat(15000);
		transports[0].finish({ ok: true, summary: longResult });
		await new Promise((resolve) => setTimeout(resolve, 0));

		const single = await call("neta_workers", { workerId: "ro1" });

		const body = bodyOf(single);
		expect(body).toContain("x".repeat(15000));
		expect(body).not.toContain("more characters");
	});

	it("clips results in the list view of neta_workers", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "look" });
		const longResult = "x".repeat(15000);
		transports[0].finish({ ok: true, summary: longResult });
		await new Promise((resolve) => setTimeout(resolve, 0));

		const list = await call("neta_workers");

		const body = bodyOf(list);
		expect(body).toContain("more characters");
		expect(body.includes("x".repeat(15000))).toBe(false);
	});
});

describe("worker MCP tools", () => {
	let address: string;
	let dir: string;
	let server: ChannelServer;
	let manager: WorkerManager;
	let client: Client;
	let workerToken: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "neta-worker-mcp-"));
		address = process.platform === "win32" ? createChannelAddress() : join(dir, "channel.sock");
		manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config: fixtureBackendConfig(),
			channelAddress: address,
			onEvent: () => {},
			createTransport: (options) => {
				workerToken = options.env.NETA_WORKER_TOKEN;
				return new FakeTransport(options);
			},
		});
		server = new ChannelServer(address, manager);
		await server.start();
		await manager.spawn({ role: "scout", tier: "expert", task: "look" });

		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await createMcpServer("neta-worker", workerTools(address, "ro1", workerToken)).connect(serverSide);
		client = new Client({ name: "test-worker", version: "0.0.0" });
		await client.connect(clientSide);
	});

	afterEach(async () => {
		await client.close();
		await manager.dispose();
		await server.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("carries a progress milestone into the worker's log", async () => {
		await client.callTool({ name: "neta_progress", arguments: { message: "reading auth.ts" } });

		expect(manager.drainLog("ro1").map((entry) => entry.text)).toContain("reading auth.ts");
	});

	it("blocks neta_ask until the leader answers", async () => {
		const asking = client.callTool({ name: "neta_ask", arguments: { question: "which database?" } });
		await new Promise((resolve) => setTimeout(resolve, 20));

		manager.answer("ro1", "postgres");

		expect(bodyOf((await asking) as CallToolResult)).toBe("postgres");
	});

	it("tells a worker with no room that it has none", async () => {
		const result = (await client.callTool({ name: "neta_say", arguments: { message: "hello" } })) as CallToolResult;

		expect(result.isError).toBe(true);
		expect(bodyOf(result)).toBe("You are not in a room.");
	});

	it("shows writers-only status through the worker MCP socket bridge", async () => {
		await manager.spawn({ role: "worker", tier: "expert", task: "Update billing", writer: true });
		await manager.spawn({ role: "worker", tier: "expert", task: "Document billing", writer: true });

		const result = (await client.callTool({ name: "neta_status", arguments: {} })) as CallToolResult;
		const body = bodyOf(result);

		expect(body).toContain("Active:\n  rw2 worker | worker: Update billing");
		expect(body).toContain("Queued:\n  rw3 worker | worker: Document billing");
		expect(body).not.toContain("ro1");
	});
});
