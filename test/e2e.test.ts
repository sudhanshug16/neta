/**
 * The whole loop, with nothing stubbed but the model: a real `neta mcp`
 * process, a real MCP client standing in for the leader's CLI, a real ACP
 * worker process, a real socket. The worker is the fake ACP agent fixture, so
 * no provider is called and nothing is paid for.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { sendChannelRequest } from "../src/channel/client.ts";
import type { SessionRecord } from "../src/session.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const run = promisify(execFile);

function bodyOf(result: CallToolResult): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function pidFrom(text: string): number {
	const match = /pid:(\d+)/.exec(text);
	if (!match) throw new Error(`Fixture process id missing from: ${text}`);
	return Number(match[1]);
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("a leader session, end to end", () => {
	let agentDir: string;
	let repo: string;
	let client: Client;
	let transport: StdioClientTransport;
	let barrierFile: string;
	let barrierReadyFile: string;

	beforeEach(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "neta-e2e-home-"));
		repo = mkdtempSync(join(tmpdir(), "neta-e2e-repo-"));
		barrierFile = join(agentDir, "release-barrier");
		barrierReadyFile = join(agentDir, "barrier-ready");
		// Every tier runs the fixture agent, so spawning costs nothing.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mux: { panes: false },
				tiers: {
					apprentice: { backend: "fake" },
					journeyman: { backend: "fake" },
					expert: { backend: "fake" },
					architect: { backend: "fake" },
				},
				backends: {
					fake: {
						command: process.execPath,
						args: [FAKE_AGENT, "--barrier-file", barrierFile, "--barrier-ready-file", barrierReadyFile],
					},
				},
			}),
		);

		transport = new StdioClientTransport({
			command: process.execPath,
			args: [CLI, "mcp"],
			cwd: repo,
			// A test can itself run under Neta, whose socket belongs to the parent
			// control plane. The fixture must own its own socket.
			env: {
				...process.env,
				NETA_DIR: agentDir,
				NETA_SESSION_ID: "e2e",
				NETA_CHECKPOINT_ID: "e2e",
				NETA_SOCKET: "",
				NETA_WORKER_ID: "",
				NETA_WORKER_TOKEN: "",
			} as Record<string, string>,
			stderr: "ignore",
		});
		client = new Client({ name: "vendor-cli", version: "0.0.0" });
		await client.connect(transport);
	});

	afterEach(async () => {
		await client.close().catch(() => {});
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	const call = async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args })) as CallToolResult;

	it("spawns a real worker process and returns what it said", async () => {
		const spawned = await call("neta_spawn", { role: "scout", tier: "apprentice", task: "map the auth flow" });
		expect(spawned.isError).toBeFalsy();

		const waited = await call("neta_wait", { workerIds: ["ro1"], timeoutSeconds: 30 });

		// The fixture echoes the last line of its prompt, which is the task.
		expect(bodyOf(waited)).toContain("echo:map the auth flow");
		expect(bodyOf(waited)).toContain("done");
	});

	// The promise the manifesto makes: a read-only worker cannot edit, and it is
	// the protocol that stops it, not the prompt.
	it("rejects a read-only worker's edit and tells it why", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "EDIT the config" });

		const waited = await call("neta_wait", { workerIds: ["ro1"], timeoutSeconds: 30 });
		expect(bodyOf(waited)).toContain("permission=reject");

		// Why it was rejected is in the worker's log, which the leader reads
		// deliberately — a wait carries results, not running commentary.
		expect(bodyOf(await call("neta_log", { workerId: "ro1" }))).toContain("this worker is read-only");
	});

	// Five chatty workers once returned 120,000 characters from one status call
	// and buried the leader's context. Status is a status view now.
	it("keeps a status listing small, whatever the workers have been saying", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "look around" });
		await call("neta_wait", { workerIds: ["ro1"], timeoutSeconds: 30 });

		const listed = bodyOf(await call("neta_workers"));

		expect(listed).toContain("ro1 scout/expert");
		expect(listed.length).toBeLessThan(4000);
		expect(listed).not.toContain("[output]");
	});

	it("lets the writer through", async () => {
		await call("neta_spawn", { role: "worker", tier: "expert", task: "EDIT the config", writer: true });
		const waited = await call("neta_wait", { workerIds: ["rw1"], timeoutSeconds: 30 });

		expect(bodyOf(waited)).toContain("permission=allow");
	});

	it("queues writer activity notices for a running read-only fixture worker", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "WAIT_FOR_BARRIER SUBSTANTIVE_HANDOFF" });
		while (!existsSync(barrierReadyFile)) await new Promise((resolve) => setTimeout(resolve, 10));
		await call("neta_spawn", {
			role: "worker",
			tier: "expert",
			name: "config migration",
			task: "Migrate config records\nVerify the new index.",
			writer: true,
		});

		await call("neta_wait", { workerIds: ["rw2"], timeoutSeconds: 30 });
		writeFileSync(barrierFile, "release\n");
		const waited = bodyOf(await call("neta_wait", { workerIds: ["ro1"], timeoutSeconds: 30 }));
		const readerLog = bodyOf(await call("neta_log", { workerId: "ro1" }));
		const writerLog = bodyOf(await call("neta_log", { workerId: "rw2" }));
		const listed = bodyOf(await call("neta_workers"));
		const checkpoint = JSON.parse(readFileSync(join(agentDir, "checkpoints", "e2e.json"), "utf8"));

		expect(readerLog).toContain(
			"[Neta system notice — automatic heads-up, not a new instruction. Your task is unchanged.]",
		);
		expect(readerLog).toContain('Writer rw2 "config migration" started.');
		expect(readerLog).toContain('Writer rw2 "config migration" finished.');
		expect(readerLog).toContain("Objective: config migration: Migrate config records");
		expect(readerLog).toContain("Changes:");
		expect(readerLog).toContain("`git show HEAD:<path>`");
		expect(writerLog).not.toContain("Neta system notice");
		expect(waited).toContain("Substantive report: audited the control path");
		expect(listed).toContain("Substantive report: audited the control path");
		expect(checkpoint.workers.find((worker: { id: string }) => worker.id === "ro1")?.finalResult).toContain(
			"Substantive report: audited the control path",
		);
		expect(checkpoint.workers.find((worker: { id: string }) => worker.id === "ro1")?.lastResponse).not.toContain(
			"Substantive report: audited the control path",
		);
	});

	it("cancels an active turn and delivers typed pane input immediately through the real channel", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "WAIT_FOR_BARRIER" });
		while (!existsSync(barrierReadyFile)) await new Promise((resolve) => setTimeout(resolve, 10));
		const session = JSON.parse(readFileSync(join(agentDir, "sessions", "e2e.json"), "utf8")) as SessionRecord;

		const accepted = await sendChannelRequest(session.socket, {
			type: "pane-input",
			token: session.token,
			workerId: "ro1",
			text: "pane follow-up",
		});
		expect(accepted.ok).toBe(true);
		expect(accepted.ok && accepted.text).toContain("Interrupted ro1's running turn");
		const steeredLog = bodyOf(await call("neta_log", { workerId: "ro1" }));
		expect(steeredLog).toContain("Turn interrupted to deliver the leader's message");
		expect(steeredLog).toContain("Leader delivering now as next turn: pane follow-up");
		const waited = bodyOf(await call("neta_wait", { workerIds: ["ro1"], timeoutSeconds: 30 }));
		expect(waited).toContain("echo:pane follow-up");
	});

	it("does not notify a terminal read-only worker about a writer", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "already done" });
		await call("neta_wait", { workerIds: ["ro1"], timeoutSeconds: 30 });
		await call("neta_spawn", { role: "worker", tier: "expert", task: "change config", writer: true });
		await call("neta_wait", { workerIds: ["rw2"], timeoutSeconds: 30 });

		const readerLog = bodyOf(await call("neta_log", { workerId: "ro1" }));
		expect(readerLog).not.toContain("Neta system notice");
	});

	// A turn ending is not enough: a backend can have a backgrounded command
	// that reawakens its session later. Neta only reports done after the ACP
	// process itself is gone.
	it("kills the fixture process before reporting a worker done", async () => {
		await call("neta_spawn", { role: "worker", tier: "expert", task: "REPORT_PID", writer: true });
		const waited = await call("neta_wait", { workerIds: ["rw1"], timeoutSeconds: 30 });
		const pid = pidFrom(bodyOf(waited));

		expect(isRunning(pid)).toBe(false);
	});

	it("records a running worker group for crash cleanup, then removes it at death", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "WAIT_FOR_NOTICE" });
		const registry = join(agentDir, "sessions", "e2e.json");
		expect(JSON.parse(readFileSync(registry, "utf-8")).workerGroups).toHaveLength(1);

		await call("neta_wait", { workerIds: ["ro1"], timeoutSeconds: 30 });
		expect(JSON.parse(readFileSync(registry, "utf-8")).workerGroups).toEqual([]);
	});

	it("awaits a repeated shutdown signal until a SIGTERM-resistant worker is dead", async () => {
		await call("neta_spawn", { role: "worker", tier: "expert", task: "REPORT_PID TRAP_SIGTERM", writer: true });
		const registry = join(agentDir, "sessions", "e2e.json");
		const deadline = Date.now() + 3000;
		let log = bodyOf(await call("neta_log", { workerId: "rw1" }));
		while (!log.includes("pid:") && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			log = bodyOf(await call("neta_log", { workerId: "rw1" }));
		}
		const workerPid = pidFrom(log);
		const controlPlanePid = transport.pid;
		if (controlPlanePid === null) throw new Error("Control plane pid missing.");

		process.kill(controlPlanePid, "SIGTERM");
		process.kill(controlPlanePid, "SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(isRunning(workerPid)).toBe(true);
		expect(() => readFileSync(registry, "utf-8")).not.toThrow();

		const stoppedBy = Date.now() + 5000;
		while (isRunning(controlPlanePid) && Date.now() < stoppedBy) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(isRunning(controlPlanePid)).toBe(false);
		expect(isRunning(workerPid)).toBe(false);
		expect(() => readFileSync(registry, "utf-8")).toThrow();
	});

	it("starts a queued writer only after the previous fixture process dies", async () => {
		await call("neta_spawn", { role: "worker", tier: "expert", task: "REPORT_PID TRAP_SIGTERM", writer: true });

		const firstDeadline = Date.now() + 3000;
		let firstLog = bodyOf(await call("neta_log", { workerId: "rw1" }));
		while (!firstLog.includes("pid:") && Date.now() < firstDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			firstLog = bodyOf(await call("neta_log", { workerId: "rw1" }));
		}
		const firstPid = pidFrom(firstLog);

		const queued = await call("neta_spawn", { role: "worker", tier: "expert", task: "REPORT_PID", writer: true });
		expect(bodyOf(queued)).toContain("Queued");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(bodyOf(await call("neta_workers"))).toContain("rw2 worker/expert | backend=fake | queued | writer");

		await call("neta_wait", { workerIds: ["rw1"], timeoutSeconds: 30 });
		expect(isRunning(firstPid)).toBe(false);

		const secondDeadline = Date.now() + 3000;
		let secondLog = bodyOf(await call("neta_log", { workerId: "rw2" }));
		while (!secondLog.includes("pid:") && Date.now() < secondDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			secondLog = bodyOf(await call("neta_log", { workerId: "rw2" }));
		}
		expect(pidFrom(secondLog)).toBeGreaterThan(0);
		expect(isRunning(firstPid)).toBe(false);
	});

	it("hands the worker an MCP server pointing back at this session", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "MCP" });
		const waited = await call("neta_wait", { workerIds: ["ro1"], timeoutSeconds: 30 });

		expect(bodyOf(waited)).toContain('"name":"neta"');
		expect(bodyOf(waited)).toContain('"mcp","--worker"]');
		expect(bodyOf(waited)).toContain('{"name":"NETA_WORKER_ID","value":"ro1"}');
		// The socket it is told about is this session's, not a guess.
		expect(bodyOf(waited)).toMatch(/"name":"NETA_SOCKET","value":"[^"]*neta-[^"]*\.sock"/);
	});

	it("shows the worker to someone watching from another terminal", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "look around" });

		const { stdout } = await run(process.execPath, [CLI, "workers", "--session", "e2e"], {
			env: {
				...process.env,
				NETA_DIR: agentDir,
				NETA_SOCKET: "",
				NETA_LEADER_TOKEN: "",
				NETA_WORKER_ID: "",
				NETA_WORKER_TOKEN: "",
			},
		});

		expect(stdout).toContain("ro1 [scout/expert, read-only, test-model/test-mode]");
		expect(stdout).toContain("look around");
	});

	it("follows a finished worker's log with `neta watch`", async () => {
		await call("neta_spawn", { role: "scout", tier: "expert", task: "look around" });
		await call("neta_wait", { workerIds: ["ro1"], timeoutSeconds: 30 });

		const { stdout } = await run(process.execPath, [CLI, "watch", "ro1", "--session", "e2e"], {
			env: {
				...process.env,
				NETA_DIR: agentDir,
				NETA_SOCKET: "",
				NETA_LEADER_TOKEN: "",
				NETA_WORKER_ID: "",
				NETA_WORKER_TOKEN: "",
			},
		});

		expect(stdout).toContain("── ro1 done");
	});

	it("queues a second writer while one is working", async () => {
		await call("neta_spawn", { role: "worker", tier: "expert", task: "hold the slot", writer: true });

		const second = await call("neta_spawn", { role: "worker", tier: "expert", task: "also write", writer: true });

		expect(second.isError).toBe(false);
		expect(bodyOf(second)).toContain("Queued");
	});
});
