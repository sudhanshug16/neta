/**
 * The real `neta mcp` process, spoken to the way a vendor CLI speaks to it:
 * a stdio MCP client on one side, a Unix socket and a session file on the
 * other. Nothing here is stubbed except the absence of real worker backends —
 * no worker is spawned, so no agent CLI is ever launched.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listSessions } from "../src/session.ts";
import { waitFor } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const run = promisify(execFile);

describe("neta mcp", () => {
	let agentDir: string;
	let client: Client;
	let transport: StdioClientTransport;

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "neta-cp-"));
		transport = new StdioClientTransport({
			command: process.execPath,
			args: [CLI, "mcp"],
			env: { ...process.env, NETA_DIR: agentDir, NETA_SESSION_ID: "smoke", NETA_LEADER_BACKEND: "claude" } as Record<
				string,
				string
			>,
			stderr: "ignore",
		});
		client = new Client({ name: "vendor-cli", version: "0.0.0" });
		await client.connect(transport);
	});

	afterEach(async () => {
		await client.close();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("starts, advertises the worker tools, and explains itself to the leader", async () => {
		const tools = await client.listTools();

		expect(tools.tools.map((tool) => tool.name)).toContain("neta_spawn");
		expect(client.getInstructions()).toContain("never do the work yourself");
	});

	it("registers a session other terminals can find", async () => {
		const sessions = listSessions(agentDir);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe("smoke");
		expect(sessions[0].leader).toBe("claude");
		expect(existsSync(sessions[0].socket)).toBe(true);
	});

	// The second door: a person in another window runs `neta workers` and reaches
	// the same orchestrator the leader is using, without any environment set up.
	it("answers `neta workers` from an unrelated process", async () => {
		const { stdout } = await run(process.execPath, [CLI, "workers", "--session", "smoke"], {
			env: { ...process.env, NETA_DIR: agentDir, NETA_SOCKET: "", NETA_LEADER_TOKEN: "" },
		});

		expect(stdout.trim()).toBe("No workers.");
	});

	it("answers `neta status` through the real socket from an unrelated process", async () => {
		const { stdout } = await run(process.execPath, [CLI, "status", "--session", "smoke"], {
			env: { ...process.env, NETA_DIR: agentDir, NETA_SOCKET: "", NETA_LEADER_TOKEN: "" },
		});

		expect(stdout).toContain("Neta status");
		expect(stdout).toContain("Writer slot:\n  (none)");
		expect(stdout).toContain("Open notes:\n  (none)");
	});

	it("refuses a worker command from someone without the session token", async () => {
		const session = listSessions(agentDir)[0];
		await expect(
			run(process.execPath, [CLI, "workers"], {
				env: { ...process.env, NETA_DIR: agentDir, NETA_SOCKET: session.socket, NETA_LEADER_TOKEN: "guessed" },
			}),
		).rejects.toThrow(/Invalid leader token/);
	});

	// The MCP SDK's stdio transport never reports the end of the stream, so a
	// leader that exits without killing its child would otherwise leave this
	// process running forever with its workers still spending tokens.
	it("exits by itself when the leader closes the stream", async () => {
		const home = mkdtempSync(join(tmpdir(), "neta-orphan-"));
		const child = spawn(process.execPath, [CLI, "mcp"], {
			env: { ...process.env, NETA_DIR: home, NETA_SESSION_ID: "orphan" },
			stdio: ["pipe", "pipe", "ignore"],
		});
		try {
			await waitFor(() => expect(listSessions(home)).toHaveLength(1), 5000);

			child.stdin?.end();

			const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
			expect(code).toBe(0);
			expect(listSessions(home)).toEqual([]);
		} finally {
			child.kill("SIGKILL");
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("cleans up its session and socket when the leader goes away", async () => {
		const session = listSessions(agentDir)[0];

		await client.close();
		// The control plane exits with its transport; give it a moment to unwind.
		await new Promise((resolve) => setTimeout(resolve, 500));

		expect(listSessions(agentDir)).toEqual([]);
		expect(existsSync(session.socket)).toBe(false);
	});
});
