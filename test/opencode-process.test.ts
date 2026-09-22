import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { type ProviderProcess, spawnProvider } from "../src/acp/process.ts";
import { startSession } from "../src/acp/session.ts";
import type { ProviderSettings } from "../src/acp/settings.ts";

const launcher = join(import.meta.dir, "..", "node_modules", "opencode-ai", "bin", "opencode");
const realNode = Bun.which("node") ?? "node";
const HANDLERS = {
	onSessionUpdate: (): void => undefined,
	requestPermission: async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "cancelled" } }),
};

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(description: string, check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
		await Bun.sleep(20);
	}
}

function pidAt(path: string): number {
	const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
	if (!Number.isSafeInteger(pid)) throw new Error(`invalid pid in ${path}`);
	return pid;
}

function killGroup(leaderPid: number | undefined): void {
	if (leaderPid === undefined) return;
	try {
		process.kill(-leaderPid, "SIGKILL");
	} catch {
		// The launcher process group has already ended.
	}
}

function writeFakeOpenCode(dir: string): {
	executable: string;
	childPidFile: string;
	childReadyFile: string;
	launcherPidFile: string;
} {
	const executable = join(dir, "fake-opencode.cjs");
	const childPidFile = join(dir, "persistent-child.pid");
	const childReadyFile = join(dir, "persistent-child.ready");
	const launcherPidFile = join(dir, "launcher.pid");
	writeFileSync(
		executable,
		`#!${realNode}
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { existsSync, writeFileSync } = require("node:fs");

if (process.argv.includes("--persistent")) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
  writeFileSync(process.env.NETA_CHILD_READY_FILE, "ready");
} else {
  const child = spawn(process.execPath, [process.argv[1], "--persistent"], { stdio: "ignore" });
  writeFileSync(process.env.NETA_CHILD_PID_FILE, String(child.pid));
  writeFileSync(process.env.NETA_LAUNCHER_PID_FILE, String(process.ppid));
  const exitAfter = process.env.NETA_EXIT_AFTER;
  const failInitialize = process.env.NETA_FAIL_INITIALIZE === "1";
  const waitForChildReady = async () => {
    while (!existsSync(process.env.NETA_CHILD_READY_FILE)) await new Promise((done) => setTimeout(done, 5));
  };
  const reply = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
  createInterface({ input: process.stdin }).on("line", async (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
	  await waitForChildReady();
      reply(failInitialize
        ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "intentional initialize failure" } }
        : { jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, agentCapabilities: {}, agentInfo: { name: "controlled-opencode", version: "1" } } });
      if (exitAfter === "initialize" || failInitialize) setImmediate(() => process.exit(0));
      return;
    }
    if (request.method === "session/new") {
      reply({ jsonrpc: "2.0", id: request.id, result: { sessionId: "controlled-session" } });
      if (exitAfter === "session/new") setImmediate(() => process.exit(0));
      return;
    }
    if (request.method === "session/prompt") {
      reply({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
      return;
    }
    reply({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unsupported method" } });
  });
}
`,
	);
	chmodSync(executable, 0o755);
	return { executable, childPidFile, childReadyFile, launcherPidFile };
}

function provider(fake: ReturnType<typeof writeFakeOpenCode>, env: Record<string, string>): ProviderSettings {
	return {
		// Run the installed CommonJS launcher with real Node, never Bun's
		// process.execPath. The launcher calls spawnSync with inherited stdio.
		command: realNode,
		args: [launcher, "acp"],
		env: {
			OPENCODE_BIN_PATH: fake.executable,
			NETA_CHILD_PID_FILE: fake.childPidFile,
			NETA_CHILD_READY_FILE: fake.childReadyFile,
			NETA_LAUNCHER_PID_FILE: fake.launcherPidFile,
			...env,
		},
		resume: true,
		defaultModel: "",
		processGroup: true,
	};
}

async function cleanup(proc: ProviderProcess | undefined, launcherPid: number | undefined, dir: string): Promise<void> {
	try {
		await proc?.kill();
	} catch {
		// The group may already have been reaped by the assertion path.
	}
	try {
		proc?.connection.close();
	} catch {
		// The transport closes when the launcher exits.
	}
	killGroup(launcherPid);
	rmSync(dir, { recursive: true, force: true });
}

test("session close reaps a persistent OpenCode descendant after its launcher exits", async () => {
	if (process.platform === "win32") return;
	const dir = mkdtempSync(join(tmpdir(), "neta-opencode-session-"));
	const fake = writeFakeOpenCode(dir);
	let launcherPid: number | undefined;
	let childPid: number | undefined;
	let session: Awaited<ReturnType<typeof startSession>> | undefined;
	try {
		session = await startSession({
			settings: {
				providers: { opencode: provider(fake, { NETA_EXIT_AFTER: "session/new" }) },
				leader: { provider: "opencode" },
				forbiddenModels: [],
			},
			provider: "opencode",
			access: "readOnly",
			cwd: dir,
		});
		await waitFor("persistent child pid", () => existsSync(fake.childPidFile));
		await waitFor("persistent child SIGTERM handler", () => existsSync(fake.childReadyFile));
		await waitFor("launcher pid", () => existsSync(fake.launcherPidFile));
		childPid = pidAt(fake.childPidFile);
		launcherPid = pidAt(fake.launcherPidFile);
		await waitFor("OpenCode launcher exit", () => !alive(launcherPid as number));
		expect(alive(childPid)).toBe(true);
		await session.close();
		await waitFor("persistent child group cleanup", () => !alive(childPid as number));
	} finally {
		await session?.close();
		killGroup(launcherPid);
		rmSync(dir, { recursive: true, force: true });
	}
}, 12_000);

test("concurrent provider kills share cleanup after the OpenCode launcher exits", async () => {
	if (process.platform === "win32") return;
	const dir = mkdtempSync(join(tmpdir(), "neta-opencode-concurrent-"));
	const fake = writeFakeOpenCode(dir);
	let proc: ProviderProcess | undefined;
	let launcherPid: number | undefined;
	let childPid: number | undefined;
	try {
		proc = await spawnProvider({
			provider: provider(fake, { NETA_EXIT_AFTER: "initialize" }),
			access: "readOnly",
			cwd: dir,
			handlers: HANDLERS,
		});
		await waitFor("persistent child pid", () => existsSync(fake.childPidFile));
		await waitFor("persistent child SIGTERM handler", () => existsSync(fake.childReadyFile));
		await waitFor("launcher pid", () => existsSync(fake.launcherPidFile));
		childPid = pidAt(fake.childPidFile);
		launcherPid = pidAt(fake.launcherPidFile);
		await proc.exited;
		expect(alive(childPid)).toBe(true);
		const first = proc.kill();
		const second = proc.kill();
		expect(second).toBe(first);
		await Promise.all([first, second]);
		await waitFor("persistent child group cleanup", () => !alive(childPid as number));
	} finally {
		await cleanup(proc, launcherPid, dir);
	}
}, 12_000);

test("provider kill reaps a group after the OpenCode launcher already exited", async () => {
	if (process.platform === "win32") return;
	const dir = mkdtempSync(join(tmpdir(), "neta-opencode-exited-"));
	const fake = writeFakeOpenCode(dir);
	let proc: ProviderProcess | undefined;
	let launcherPid: number | undefined;
	let childPid: number | undefined;
	try {
		proc = await spawnProvider({
			provider: provider(fake, { NETA_EXIT_AFTER: "initialize" }),
			access: "readOnly",
			cwd: dir,
			handlers: HANDLERS,
		});
		await waitFor("persistent child pid", () => existsSync(fake.childPidFile));
		await waitFor("persistent child SIGTERM handler", () => existsSync(fake.childReadyFile));
		await waitFor("launcher pid", () => existsSync(fake.launcherPidFile));
		childPid = pidAt(fake.childPidFile);
		launcherPid = pidAt(fake.launcherPidFile);
		await proc.exited;
		expect(alive(childPid)).toBe(true);
		await proc.kill();
		await waitFor("persistent child group cleanup", () => !alive(childPid as number));
	} finally {
		await cleanup(proc, launcherPid, dir);
	}
}, 12_000);

test("an initialize JSON-RPC error kills the OpenCode process group", async () => {
	if (process.platform === "win32") return;
	const dir = mkdtempSync(join(tmpdir(), "neta-opencode-init-error-"));
	const fake = writeFakeOpenCode(dir);
	let launcherPid: number | undefined;
	let childPid: number | undefined;
	try {
		await expect(
			spawnProvider({
				provider: provider(fake, { NETA_FAIL_INITIALIZE: "1" }),
				access: "readOnly",
				cwd: dir,
				handlers: HANDLERS,
			}),
		).rejects.toThrow("initialize failed");
		await waitFor("persistent child pid", () => existsSync(fake.childPidFile));
		await waitFor("persistent child SIGTERM handler", () => existsSync(fake.childReadyFile));
		await waitFor("launcher pid", () => existsSync(fake.launcherPidFile));
		childPid = pidAt(fake.childPidFile);
		launcherPid = pidAt(fake.launcherPidFile);
		await waitFor("persistent child group cleanup", () => !alive(childPid as number));
	} finally {
		killGroup(launcherPid);
		rmSync(dir, { recursive: true, force: true });
	}
}, 12_000);
