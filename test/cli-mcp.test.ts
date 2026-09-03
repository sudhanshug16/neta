// T8.8: `neta mcp --actor <id> --token <t>` through the built bundle
// against a temp `NETA_DIR` (the T8.2 harness). Without `--actor` the command
// is usage (exit 1); with both flags and a running Node it answers an MCP
// `initialize` on stdin and every stdout line is MCP framing; a node
// descriptor whose token the Node rejects is exit 3.
import { afterAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { type Harness, startNode as startHarness } from "./helpers/cli-harness.ts";

let harness: Harness | undefined;

async function ensureSetup(): Promise<Harness> {
	if (harness !== undefined) {
		return harness;
	}
	const fresh = await startHarness();
	harness = fresh;
	try {
		const started = await fresh.run(["node", "start", "--detach"]);
		expect(started.code).toBe(0);
		const opened = await fresh.run(["open", process.cwd()]);
		expect(opened.code).toBe(0);
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

function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
	const deadline = Date.now() + ms;
	return (async () => {
		for (;;) {
			if (cond()) {
				return;
			}
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for ${what}`);
			}
			await new Promise((done) => setTimeout(done, 25));
		}
	})();
}

interface McpFrame {
	jsonrpc?: unknown;
	id?: unknown;
	result?: unknown;
	error?: unknown;
}

function framesOf(stdout: string): McpFrame[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as McpFrame);
}

describe("mcp", () => {
	test("neta mcp without --actor exits 1 and prints usage", async () => {
		const h = await ensureSetup();
		const result = await h.run(["mcp", "--token", "t"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("neta mcp needs --actor");
		expect(result.stderr).toContain("usage:");
		expect(result.stdout).toBe("");
	}, 120000);

	test("neta mcp without --token exits 1 and prints usage", async () => {
		const h = await ensureSetup();
		const result = await h.run(["mcp", "--actor", "a"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("neta mcp needs --token");
		expect(result.stderr).toContain("usage:");
		expect(result.stdout).toBe("");
	}, 120000);

	test("with both flags it answers initialize and writes only MCP framing", async () => {
		const h = await ensureSetup();
		const child: ChildProcess = h.spawn(["mcp", "--actor", "actor-1", "--token", "token-1"]);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		const closed = new Promise<number>((resolve) => {
			child.on("close", (code) => resolve(code ?? 1));
		});
		try {
			child.stdin?.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`,
			);
			await waitFor(() => stdout.includes('"id":1'), 15000, "the initialize response");
			const frames = framesOf(stdout);
			const hello = frames.find((frame) => frame.id === 1);
			expect(hello?.result).toMatchObject({ serverInfo: { name: "neta" } });
			// A notification gets no reply but must not disturb the stream.
			child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
			child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
			await waitFor(() => framesOf(stdout).some((frame) => frame.id === 2), 15000, "the tools/list response");
		} finally {
			child.stdin?.end();
		}
		const code = await closed;
		expect(code).toBe(0);
		expect(stderr).toBe("");
		// Nothing on stdout that is not MCP framing: every line parses as a
		// JSON-RPC message.
		const frames = framesOf(stdout);
		expect(frames.length).toBeGreaterThan(0);
		for (const frame of frames) {
			expect(frame.jsonrpc).toBe("2.0");
			expect(frame.id === undefined || typeof frame.id === "string" || typeof frame.id === "number").toBe(true);
			expect(frame.result !== undefined || frame.error !== undefined).toBe(true);
		}
	}, 120000);

	test("a bad token exits 3", async () => {
		const h = await ensureSetup();
		const descriptorPath = `${h.dir}/node.json`;
		const original = await readFile(descriptorPath, "utf8");
		const tampered = { ...(JSON.parse(original) as Record<string, unknown>), token: "bad" };
		await writeFile(descriptorPath, JSON.stringify(tampered));
		try {
			const result = await h.run(["mcp", "--actor", "actor-1", "--token", "token-1"]);
			expect(result.code).toBe(3);
			expect(result.stderr).toContain("neta:");
			expect(result.stdout).toBe("");
		} finally {
			await writeFile(descriptorPath, original);
		}
	}, 120000);
});
