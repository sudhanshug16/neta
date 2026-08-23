/**
 * The real `neta mcp` process, spoken to the way a vendor CLI speaks to it:
 * a stdio MCP client on one side, a Unix socket and a session file on the
 * other. Nothing here is stubbed except the absence of real worker backends —
 * no worker is spawned, so no agent CLI is ever launched.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listSessions, tryAcquireSessionLock } from "../src/session.ts";
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

		expect(tools.tools.map((tool) => tool.name)).toEqual([
			"neta_goal",
			"neta_delegate",
			"neta_exec",
			"neta_status",
			"neta_attach",
			"neta_inspect",
			"neta_wait",
			"neta_send",
			"neta_kill",
			"neta_note",
		]);
		expect(client.getInstructions()).toContain("never do the work yourself");
	});

	// The startup checklist runs in the launcher, which is a different process
	// from this one. This is the hop that carries its answer, and the only thing
	// that makes the choice enforcement rather than a note in a prompt.
	it("staffs only the tiers the launcher chose", async () => {
		const home = mkdtempSync(join(tmpdir(), "neta-tiers-"));
		const tierTransport = new StdioClientTransport({
			command: process.execPath,
			args: [CLI, "mcp"],
			env: {
				...process.env,
				NETA_DIR: home,
				NETA_SESSION_ID: "tiers",
				NETA_TIERS: "journeyman,expert",
			} as Record<string, string>,
			stderr: "ignore",
		});
		const tierClient = new Client({ name: "vendor-cli", version: "0.0.0" });
		await tierClient.connect(tierTransport);
		try {
			const delegate = (await tierClient.listTools()).tools.find((tool) => tool.name === "neta_delegate");
			const tiers = (
				delegate?.inputSchema.properties as { workers: { items: { properties: { tier: { enum: string[] } } } } }
			).workers.items.properties.tier.enum;
			expect(tiers).toEqual(["journeyman", "expert"]);

			// And the refusal is real, not just a narrowed schema: this call names a
			// tier the schema does not offer, the way a leader ignoring it would.
			const refused = await tierClient.callTool({
				name: "neta_delegate",
				arguments: { workers: [{ role: "scout", tier: "architect", task: "think hard" }] },
			});
			expect(refused.isError).toBe(true);
			expect(JSON.stringify(refused.content)).toContain("is unavailable");
		} finally {
			await tierClient.close().catch(() => {});
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("staffs every tier when the launcher chose none", async () => {
		const delegate = (await client.listTools()).tools.find((tool) => tool.name === "neta_delegate");
		const tiers = (
			delegate?.inputSchema.properties as { workers: { items: { properties: { tier: { enum: string[] } } } } }
		).workers.items.properties.tier.enum;
		expect(tiers).toEqual(["apprentice", "journeyman", "expert", "architect"]);
	});

	it("registers a session other terminals can find", async () => {
		const sessions = listSessions(agentDir);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe("smoke");
		expect(sessions[0].leader).toBe("claude");
		expect(existsSync(sessions[0].socket)).toBe(true);
	});

	it("persists the launcher's mux session name before releasing its launch lock", async () => {
		const home = mkdtempSync(join(tmpdir(), "neta-mux-record-"));
		const lock = tryAcquireSessionLock(process.cwd(), home);
		if (!lock) throw new Error("Could not acquire test launch lock.");
		const muxTransport = new StdioClientTransport({
			command: process.execPath,
			args: [CLI, "mcp"],
			env: {
				...process.env,
				NETA_DIR: home,
				NETA_MUX: "tmux",
				NETA_MUX_SESSION_NAME: "neta-mux-record",
				NETA_PANES: "0",
				NETA_SESSION_ID: "mux-record",
				NETA_SESSION_LOCK_PATH: lock.path,
				NETA_SESSION_LOCK_TOKEN: lock.token,
			} as Record<string, string>,
			stderr: "ignore",
		});
		const muxClient = new Client({ name: "vendor-cli", version: "0.0.0" });
		try {
			await muxClient.connect(muxTransport);
			expect(listSessions(home)[0]?.mux).toEqual({ id: "tmux", name: "neta-mux-record" });
			expect(existsSync(lock.path)).toBe(false);
		} finally {
			await muxClient.close();
			rmSync(home, { recursive: true, force: true });
		}
	});

	// The live lease is what records which manager owns this session's worker
	// processes. Without it on disk, a later `neta resume` would believe the
	// checkpoint is free while those processes may still be running.
	it("refuses to register when the first durable checkpoint write fails", async () => {
		const home = mkdtempSync(join(tmpdir(), "neta-unwritable-"));
		// A file where the checkpoint directory has to be: every write fails, and
		// nothing about the failure is Neta's to repair.
		writeFileSync(join(home, "checkpoints"), "not a directory");
		writeFileSync(join(home, "checkpoints-v6"), "not a directory");
		const lock = tryAcquireSessionLock(process.cwd(), home);
		if (!lock) throw new Error("Could not acquire test launch lock.");
		const child = spawn(process.execPath, [CLI, "mcp"], {
			env: {
				...process.env,
				NETA_DIR: home,
				NETA_SESSION_ID: "unsafe",
				NETA_LEADER_BACKEND: "claude",
				NETA_SESSION_LOCK_PATH: lock.path,
				NETA_SESSION_LOCK_TOKEN: lock.token,
			} as Record<string, string>,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		try {
			const code = await new Promise<number | null>((resolve) => child.on("close", resolve));

			expect(code).not.toBe(0);
			expect(stderr).toContain("could not record session unsafe");
			expect(stderr).toContain("No control plane was registered");
			// Nothing a person or a resume could find: no manager, no socket, and the
			// launch lock still held by its owner.
			expect(listSessions(home)).toEqual([]);
			expect(existsSync(join(home, "sessions", "unsafe.json"))).toBe(false);
			expect(existsSync(lock.path)).toBe(true);
		} finally {
			child.kill("SIGKILL");
			rmSync(home, { recursive: true, force: true });
		}
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
			await waitFor(() => listSessions(home).length === 1, 5000);

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
		// The control plane exits with its transport. Poll for the result rather
		// than assuming an unwind window: on a loaded machine a fixed sleep only
		// tests how busy the machine was.
		await waitFor(() => listSessions(agentDir).length === 0 && !existsSync(session.socket), 15000);
	});
});
