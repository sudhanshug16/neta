import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChannelAddress, NETA_LEADER_ENV, NETA_SOCKET_ENV, NETA_WORKER_ENV } from "../src/channel/protocol.ts";
import type { ChannelHandler } from "../src/channel/server.ts";
import { ChannelServer } from "../src/channel/server.ts";
import { createLeaderCliShim, prependToPath } from "../src/cli-shim.ts";

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

describe("leader CLI over the production shim", () => {
	const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
	let shimDir: string;
	let address: string;
	let server: ChannelServer;
	let leaderRequests: Array<{ type: string; timeoutMs?: number }>;
	let agentDir: string;

	beforeEach(async () => {
		leaderRequests = [];
		agentDir = mkdtempSync(join(tmpdir(), "neta-cli-agent-"));
		shimDir = await createLeaderCliShim({ command: process.execPath, prefixArgs: [cli] });
		address = createChannelAddress();
		const handler: ChannelHandler = {
			authenticateWorker: () => ({ ok: false, error: "worker auth refused" }),
			progress: () => ({ ok: true }),
			blocked: () => ({ ok: true }),
			say: () => ({ ok: true }),
			room: () => ({ ok: true }),
			writerStatus: () => ({ ok: true }),
			leader: async (request) => {
				leaderRequests.push({
					type: request.type,
					timeoutMs: request.type === "wait" ? request.timeoutMs : undefined,
				});
				return { ok: true, text: request.type === "workers" ? "No workers." : "ok" };
			},
		};
		server = new ChannelServer(address, handler);
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
		rmSync(shimDir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	function run(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
		return new Promise((resolve) => {
			const child = spawn(join(shimDir, "neta"), args, {
				env: {
					...process.env,
					PATH: prependToPath(shimDir, process.env.PATH),
					NETA_DIR: agentDir,
					[NETA_SOCKET_ENV]: address,
					[NETA_LEADER_ENV]: "leader-token",
					[NETA_WORKER_ENV]: "",
					...extraEnv,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
		});
	}

	it("runs the real createLeaderCliShim control-plane path", async () => {
		const result = await run(["workers"]);
		expect(result).toEqual({ code: 0, stdout: "No workers.", stderr: "" });
		expect(leaderRequests).toEqual([{ type: "workers", timeoutMs: undefined }]);
	});

	it("converts leader wait timeout seconds to milliseconds", async () => {
		const result = await run(["wait", "ro1", "--timeout", "7"]);
		expect(result.code).toBe(0);
		expect(leaderRequests).toEqual([{ type: "wait", timeoutMs: 7_000 }]);
	});

	it("refuses leader commands in a worker environment without consulting the registry", async () => {
		const result = await run(["workers"], { [NETA_WORKER_ENV]: "ro1" });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Workers cannot run leader command `workers`");
		expect(leaderRequests).toEqual([]);
	});
});
