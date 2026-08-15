/**
 * The whole loop, with nothing stubbed but the model: a real `neta mcp`
 * process, a real MCP client standing in for the leader's CLI, a real ACP
 * worker process, a real socket. The worker is the fake ACP agent fixture, so
 * no provider is called and nothing is paid for.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const run = promisify(execFile);

function bodyOf(result: CallToolResult): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("a leader session, end to end", () => {
	let agentDir: string;
	let repo: string;
	let client: Client;

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "neta-e2e-home-"));
		repo = mkdtempSync(join(tmpdir(), "neta-e2e-repo-"));
		// Every tier runs the fixture agent, so spawning costs nothing.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mux: { panes: false },
				tiers: {
					junior: { backend: "fake" },
					senior: { backend: "fake" },
					staff: { backend: "fake" },
				},
				backends: { fake: { command: process.execPath, args: [FAKE_AGENT] } },
			}),
		);

		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [CLI, "mcp"],
			cwd: repo,
			env: { ...process.env, NETA_DIR: agentDir, NETA_SESSION_ID: "e2e" } as Record<string, string>,
			stderr: "ignore",
		});
		client = new Client({ name: "vendor-cli", version: "0.0.0" });
		await client.connect(transport);
	});

	afterEach(async () => {
		await client.close();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	const call = async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args })) as CallToolResult;

	it("spawns a real worker process and returns what it said", async () => {
		const spawned = await call("neta_spawn", { role: "scout", tier: "senior", task: "map the auth flow" });
		expect(spawned.isError).toBeFalsy();

		const waited = await call("neta_wait", { workerIds: ["w1"], timeoutSeconds: 30 });

		// The fixture echoes the last line of its prompt, which is the task.
		expect(bodyOf(waited)).toContain("echo:map the auth flow");
		expect(bodyOf(waited)).toContain("done");
	});

	// The promise the manifesto makes: a read-only worker cannot edit, and it is
	// the protocol that stops it, not the prompt.
	it("rejects a read-only worker's edit and tells it why", async () => {
		await call("neta_spawn", { role: "scout", tier: "senior", task: "EDIT the config" });

		const waited = await call("neta_wait", { workerIds: ["w1"], timeoutSeconds: 30 });

		expect(bodyOf(waited)).toContain("permission=reject");
		expect(bodyOf(waited)).toContain("this worker is read-only");
	});

	it("lets the writer through", async () => {
		await call("neta_spawn", { role: "worker", tier: "senior", task: "EDIT the config", writer: true });
		const waited = await call("neta_wait", { workerIds: ["w1"], timeoutSeconds: 30 });

		expect(bodyOf(waited)).toContain("permission=allow");
	});

	it("hands the worker an MCP server pointing back at this session", async () => {
		await call("neta_spawn", { role: "scout", tier: "senior", task: "MCP" });
		const waited = await call("neta_wait", { workerIds: ["w1"], timeoutSeconds: 30 });

		expect(bodyOf(waited)).toContain('"name":"neta"');
		expect(bodyOf(waited)).toContain('"mcp","--worker"]');
		expect(bodyOf(waited)).toContain('{"name":"NETA_WORKER_ID","value":"w1"}');
		// The socket it is told about is this session's, not a guess.
		expect(bodyOf(waited)).toMatch(/"name":"NETA_SOCKET","value":"[^"]*neta-[^"]*\.sock"/);
	});

	it("shows the worker to someone watching from another terminal", async () => {
		await call("neta_spawn", { role: "scout", tier: "senior", task: "look around" });

		const { stdout } = await run(process.execPath, [CLI, "workers", "--session", "e2e"], {
			env: { ...process.env, NETA_DIR: agentDir, NETA_SOCKET: "", NETA_LEADER_TOKEN: "" },
		});

		expect(stdout).toContain("w1 [scout/senior, read-only]");
		expect(stdout).toContain("look around");
	});

	it("follows a finished worker's log with `neta watch`", async () => {
		await call("neta_spawn", { role: "scout", tier: "senior", task: "look around" });
		await call("neta_wait", { workerIds: ["w1"], timeoutSeconds: 30 });

		const { stdout } = await run(process.execPath, [CLI, "watch", "w1", "--session", "e2e"], {
			env: { ...process.env, NETA_DIR: agentDir, NETA_SOCKET: "", NETA_LEADER_TOKEN: "" },
		});

		expect(stdout).toContain("-- worker w1 done --");
	});

	it("refuses a second writer while one is still working", async () => {
		await call("neta_spawn", { role: "worker", tier: "senior", task: "hold the slot", writer: true });

		const second = await call("neta_spawn", { role: "worker", tier: "senior", task: "also write", writer: true });

		expect(second.isError).toBe(true);
		expect(bodyOf(second)).toContain("already holds the writer slot");
	});
});
