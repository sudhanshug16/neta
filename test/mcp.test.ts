import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { leaderTools } from "../src/mcp/leader.ts";
import { createMcpServer } from "../src/mcp/serve.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { fixtureBackendConfig } from "./helpers.ts";

class FakeTransport implements WorkerTransportDriver {
	readonly options: TransportOptions;
	private readonly startFailure: string | undefined;
	private pending: Array<(outcome: PromptOutcome) => void> = [];
	constructor(options: TransportOptions, startFailure?: string) {
		this.options = options;
		this.startFailure = startFailure;
	}
	start(): Promise<void> {
		return this.startFailure ? Promise.reject(new Error(this.startFailure)) : Promise.resolve();
	}
	prompt(): Promise<PromptOutcome> {
		return new Promise((resolve) => this.pending.push(resolve));
	}
	cancel(): boolean {
		this.pending.shift()?.({ ok: false, cancelled: true, summary: "cancelled" });
		return true;
	}
	kill(): Promise<void> {
		return Promise.resolve();
	}
	markTerminal(): void {}
	finish(outcome: PromptOutcome): void {
		this.pending.shift()?.(outcome);
	}
}

function body(result: CallToolResult): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

describe("leader MCP redesign", () => {
	let manager: WorkerManager;
	let client: Client;
	let transports: FakeTransport[];
	let failStartAt: number | undefined;
	let failPrepareAt: number | undefined;
	let prepareCalls: number;

	beforeEach(async () => {
		transports = [];
		failStartAt = undefined;
		failPrepareAt = undefined;
		prepareCalls = 0;
		manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config: fixtureBackendConfig(),
			channelAddress: "/tmp/neta-mcp-test.sock",
			onEvent: () => {},
			prepareEnv: () => {
				prepareCalls += 1;
				return prepareCalls === failPrepareAt
					? Promise.reject(new Error("fixture prepareEnv refused"))
					: Promise.resolve({});
			},
			createTransport(options) {
				const transport = new FakeTransport(
					options,
					transports.length + 1 === failStartAt ? "fixture startup refused" : undefined,
				);
				transports.push(transport);
				return transport;
			},
		});
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await createMcpServer("neta", leaderTools(manager)).connect(serverSide);
		client = new Client({ name: "test", version: "0" });
		await client.connect(clientSide);
	});

	afterEach(async () => {
		await client.close();
		await manager.dispose();
	});
	const call = async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args })) as CallToolResult;

	it("offers exactly the ten settled leader tools", async () => {
		expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
			"neta_attach",
			"neta_delegate",
			"neta_exec",
			"neta_inspect",
			"neta_kill",
			"neta_note",
			"neta_send",
			"neta_status",
			"neta_wait",
			"neta_workers",
		]);
	});

	it("delegates one or many workers and returns real assignments", async () => {
		const result = await call("neta_delegate", {
			workers: [
				{ role: "scout", tier: "expert", task: "map auth" },
				{ role: "worker", tier: "expert", task: "fix auth", writer: true },
			],
		});
		expect(result.isError).toBeFalsy();
		expect(body(result)).toContain("ro1: scout/expert -> claude (read-only, running)");
		expect(body(result)).toContain("rw2: worker/expert -> codex (writer, running)");
		expect(transports).toHaveLength(2);
	});

	it("validates a complete team before posting its seed", async () => {
		const result = await call("neta_delegate", {
			team: "review",
			seed: "compare",
			workers: [
				{ role: "scout", tier: "expert", task: "one" },
				{ role: "missing", tier: "expert", task: "two" },
			],
		});
		expect(result.isError).toBe(true);
		expect(manager.list()).toEqual([]);
		expect(manager.roomTranscript("review")).toEqual([]);
	});

	it("collects a middle runtime startup failure and still attempts the full team", async () => {
		failStartAt = 2;
		const result = await call("neta_delegate", {
			team: "startup-review",
			seed: "compare all three",
			workers: [
				{ role: "scout", tier: "expert", task: "one" },
				{ role: "reviewer", tier: "expert", task: "two" },
				{ role: "scout", tier: "expert", task: "three" },
			],
		});
		expect(result.isError).toBeFalsy();
		expect(body(result)).toContain("ro1:");
		expect(body(result)).toContain("ro2:");
		expect(body(result)).toContain("Startup failure: fixture startup refused");
		expect(body(result)).toContain("ro3:");
		expect(manager.list().map((worker) => [worker.id, worker.state])).toEqual([
			["ro1", "running"],
			["ro2", "failed"],
			["ro3", "running"],
		]);
		expect(manager.roomTranscript("startup-review")[0]?.text).toBe("compare all three");
		for (const id of ["ro1", "ro2", "ro3"]) expect(manager.get(id).id).toBe(id);

		const waiting = call("neta_wait", { workerIds: ["ro1", "ro2", "ro3"], timeoutSeconds: 5 });
		transports[0].finish({ ok: true, summary: "one done" });
		transports[2].finish({ ok: true, summary: "three done" });
		expect(body(await waiting)).toContain("fixture startup refused");
	});

	it("returns a read-only pre-record failure and still attempts the later member", async () => {
		failPrepareAt = 2;
		const result = await call("neta_delegate", {
			workers: [
				{ role: "scout", tier: "expert", task: "one", name: "first read" },
				{ role: "reviewer", tier: "expert", task: "two", name: "broken read" },
				{ role: "scout", tier: "expert", task: "three", name: "later read" },
			],
		});

		expect(result.isError).toBeFalsy();
		expect(body(result)).toContain("ro1:");
		expect(body(result)).toContain("unallocated: broken read (reviewer/expert) -> codex (read-only, startup failed)");
		expect(body(result)).toContain("Startup failure: fixture prepareEnv refused");
		expect(body(result)).not.toContain("ro2:");
		expect(body(result)).toContain("ro3:");
		expect(manager.list().map((worker) => worker.id)).toEqual(["ro1", "ro3"]);
		expect(transports).toHaveLength(2);
	});

	it("keeps the writer holder visible when a queued writer fails before its record", async () => {
		failPrepareAt = 2;
		const result = await call("neta_delegate", {
			workers: [
				{ role: "worker", tier: "expert", task: "hold", name: "holder", writer: true },
				{ role: "worker", tier: "expert", task: "fail", name: "broken writer", writer: true },
				{ role: "scout", tier: "expert", task: "later", name: "later read" },
			],
		});

		expect(result.isError).toBeFalsy();
		expect(body(result)).toContain("rw1:");
		expect(body(result)).toContain(
			"unallocated: broken writer (worker/expert) -> codex (writer, startup failed; writer holder: rw1)",
		);
		expect(body(result)).not.toContain("rw2:");
		expect(body(result)).toContain("ro3:");
		expect(manager.statusSnapshot().writerSlot?.id).toBe("rw1");
		expect(manager.list().map((worker) => worker.id)).toEqual(["rw1", "ro3"]);
		expect(transports).toHaveLength(2);
	});

	it("waits for delegated work and returns the handoff", async () => {
		await call("neta_delegate", { workers: [{ role: "scout", tier: "expert", task: "map" }] });
		const waiting = call("neta_wait", { workerIds: ["ro1"], timeoutSeconds: 5 });
		transports[0].finish({ ok: true, summary: "auth is in src/auth.ts" });
		expect(body(await waiting)).toContain("auth is in src/auth.ts");
	});

	it("surfaces a blocked worker and its question when neta_wait has no ids", async () => {
		await call("neta_delegate", { workers: [{ role: "scout", tier: "expert", task: "map" }] });
		expect(manager.blocked("ro1", "Which account?")).toMatchObject({ ok: true });
		expect(body(await call("neta_wait"))).toContain("ro1 blocked and stopped: Which account?");
	});

	it("keeps note, inspect, status and worker summaries available", async () => {
		await call("neta_note", { text: "auth follow-up" });
		await call("neta_delegate", { workers: [{ role: "scout", tier: "expert", task: "map", note: "n1" }] });
		expect(body(await call("neta_status"))).toContain("ro1");
		expect(body(await call("neta_workers", { workerId: "ro1" }))).toContain("scout/expert");
		expect(body(await call("neta_inspect", { workerId: "ro1" }))).toContain("map");
	});
});

describe("neta_exec through the real MCP client/server boundary", () => {
	let manager: WorkerManager;
	let client: Client;
	let execDir: string;

	beforeEach(async () => {
		execDir = mkdtempSync(join(tmpdir(), "neta-mcp-exec-"));
		manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config: fixtureBackendConfig(),
			channelAddress: "/tmp/neta-mcp-exec-test.sock",
			execOutputDir: execDir,
			onEvent: () => {},
		});
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await createMcpServer("neta", leaderTools(manager)).connect(serverSide);
		client = new Client({ name: "test", version: "0" });
		await client.connect(clientSide);
	});

	afterEach(async () => {
		await client.close();
		await manager.dispose();
		rmSync(execDir, { recursive: true, force: true });
	});

	const call = async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args })) as CallToolResult;

	it("runs a real command through the MCP client and returns its completed, non-error result", async () => {
		const result = await call("neta_exec", { argv: ["true"] });
		expect(result.isError).toBeFalsy();
		expect(body(result)).toMatch(/Exit code: 0/);
		expect(body(result)).not.toContain("call #");
	});

	it("warns with the exact call number from the second MCP call on, in the same completed response", async () => {
		await call("neta_exec", { argv: ["true"] });
		const second = await call("neta_exec", { argv: ["true"] });
		expect(second.isError).toBeFalsy();
		expect(body(second)).toContain("call #2");
		expect(body(second).toLowerCase()).toContain("delegate");
	});

	it("returns a completed result carrying the call number when the command cannot be spawned, not an MCP tool error", async () => {
		const missing = "neta-exec-mcp-test-missing-binary-xyz";
		const first = await call("neta_exec", { argv: [missing] });
		expect(first.isError).toBeFalsy();
		expect(body(first)).not.toContain("call #");
		expect(body(first).toLowerCase()).toMatch(/enoent|not found/);

		const second = await call("neta_exec", { argv: [missing] });
		expect(second.isError).toBeFalsy();
		expect(body(second)).toContain("call #2");
		expect(body(second).toLowerCase()).toContain("delegate");
	});

	it("rejects a non-positive or non-finite timeoutSeconds as an MCP tool error, and does not count it", async () => {
		const rejected = await call("neta_exec", { argv: ["true"], timeoutSeconds: 0 });
		expect(rejected.isError).toBe(true);
		const rejectedNegative = await call("neta_exec", { argv: ["true"], timeoutSeconds: -1 });
		expect(rejectedNegative.isError).toBe(true);
		const rejectedInfinite = await call("neta_exec", { argv: ["true"], timeoutSeconds: Number.POSITIVE_INFINITY });
		expect(rejectedInfinite.isError).toBe(true);

		const first = await call("neta_exec", { argv: ["true"] });
		expect(first.isError).toBeFalsy();
		expect(body(first)).not.toContain("call #");
	});

	it("accepts a timeoutSeconds far beyond the old 600-second ceiling, and no timeout at all when it is omitted", async () => {
		const beyondOldCeiling = await call("neta_exec", { argv: ["true"], timeoutSeconds: 20 * 24 * 60 * 60 });
		expect(beyondOldCeiling.isError).toBeFalsy();
		expect(body(beyondOldCeiling)).toMatch(/Exit code: 0/);

		const omitted = await call("neta_exec", { argv: ["true"] });
		expect(omitted.isError).toBeFalsy();
		expect(body(omitted)).toMatch(/Exit code: 0/);
	});
});
