import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

	beforeEach(async () => {
		transports = [];
		failStartAt = undefined;
		manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config: fixtureBackendConfig(),
			channelAddress: "/tmp/neta-mcp-test.sock",
			onEvent: () => {},
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
