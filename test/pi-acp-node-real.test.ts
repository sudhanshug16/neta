import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectNode, type NodeClient, type NodeEvent } from "../src/node/client.ts";
import { type Node as NetaNode, startNode } from "../src/node/lifecycle.ts";
import type { ConversationTailResult, TurnNotification } from "../src/node/protocol.ts";

const FIXTURE = new URL("./fixtures/fake-acp-agent.mjs", import.meta.url).pathname;
const PI_FIXTURE = new URL("./fixtures/pi-acp-real.py", import.meta.url).pathname;
let dir = "";
let workspace = "";
let node: NetaNode | undefined;
let client: NodeClient | undefined;
let savedNetadir: string | undefined;
let savedPiEnv: Record<string, string | undefined> | undefined;

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(25);
	}
}

async function runPi(sessionId: string, provider: string, switchProvider?: string): Promise<string> {
	const child = Bun.spawn(["python3", PI_FIXTURE], {
		cwd: join(import.meta.dir, ".."),
		env: {
			...process.env,
			NETA_DESCRIPTOR: join(dir, "node.json"),
			NETA_TARGET_SESSION_ID: sessionId,
			NETA_TARGET_PROVIDER: provider,
			NETA_TARGET_MODEL: "fixture-default",
			NETA_PI_PROVIDER: "neta-acp",
			NETA_PI_MODEL: "fixture-default",
			NETA_PI_READY_MARKER: `${provider} · fixture-default`,
			...(switchProvider === undefined ? {} : { NETA_PI_SWITCH_PROVIDER: switchProvider }),
			NETA_PI_PROMPT: `STREAM ${provider}`,
			NETA_PI_VERIFY_ROOT: join(import.meta.dir, ".."),
			NETA_PI_VERIFY_SESSION_DIR: join(dir, `pi-${provider}`),
			PI_CODING_AGENT_DIR: join(dir, `pi-config-${provider}`),
			PI_OFFLINE: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, status] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect([0, 143], stderr).toContain(status);
	return `${stdout}\n${stderr}`;
}

afterEach(async () => {
	await client?.close().catch(() => undefined);
	client = undefined;
	await node?.stop().catch(() => undefined);
	node = undefined;
	if (dir !== "") await rm(dir, { recursive: true, force: true });
	if (workspace !== "") await rm(workspace, { recursive: true, force: true });
	if (savedNetadir === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = savedNetadir;
	savedNetadir = undefined;
	if (savedPiEnv !== undefined) {
		for (const [key, value] of Object.entries(savedPiEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		savedPiEnv = undefined;
	}
}, 90_000);

test("installed Pi proxies each configured fake ACP provider through the exact Node session", async () => {
	dir = await mkdtemp(join(tmpdir(), "neta-pi-node-real-"));
	workspace = await mkdtemp(join(tmpdir(), "neta-pi-node-work-"));
	savedNetadir = process.env.NETA_DIR;
	process.env.NETA_DIR = dir;
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			providers: Object.fromEntries(
				["claude", "codex", "opencode"].map((provider) => [provider, { command: process.execPath, args: [FIXTURE, "--config-options", "--unrestricted-mode", "bypassPermissions"], resume: true, unsandboxedMode: "bypassPermissions", defaultModel: "fixture-default" }]),
			),
			leader: { provider: "missing", model: "test-model" },
			forbiddenModels: [],
		}),
	);
	node = await startNode();
	client = await connectNode({ client: "desktop" });
	const opened = await client.request<{ leader: { sessionId: string; provider: string; state: string } }>("workspace.open", { path: workspace });
	expect(opened.leader.state, JSON.stringify(opened)).toBe("failed");
	const selected = await client.request<{ sessionId: string; provider: string }>("conversation.setProvider", {
		sessionId: opened.leader.sessionId,
		provider: "claude",
	});
	expect(selected.provider).toBe("claude");
	const notifications: TurnNotification[] = [];
	client.on("turn", (params) => notifications.push(params as TurnNotification));
	await client.request("conversation.tail", { sessionId: selected.sessionId, limit: 20 });
	for (const provider of ["claude", "codex", "opencode"]) {
		if (provider !== "claude") await client.request("conversation.setProvider", { sessionId: selected.sessionId, provider });
		notifications.length = 0;
		const before = await client.request<ConversationTailResult>("conversation.tail", { sessionId: selected.sessionId, limit: 50 });
		const priorTurnIds = new Set(before.turns.map((turn) => turn.id));
		const output = await runPi(selected.sessionId, provider);
		expect(output).toContain("First paragraph");
		await waitFor(`${provider} turn`, () => notifications.some((item) => item.turn?.endedAt !== undefined));
		const tail = await client.request<ConversationTailResult>("conversation.tail", { sessionId: selected.sessionId, limit: 50 });
		expect(tail.provider).toBe(provider);
		const user = tail.blocks.find((block) => block.role === "user" && block.text === `STREAM ${provider}` && !priorTurnIds.has(block.turnId));
		expect(user).toBeDefined();
		expect(tail.blocks.some((block) => block.role === "agent" && block.turnId === user?.turnId && block.text.includes("Second paragraph"))).toBe(true);
	}
}, 90_000);

test("installed Pi switches provider in place through /neta-providers", async () => {
	dir = await mkdtemp(join(tmpdir(), "neta-pi-node-switch-"));
	workspace = await mkdtemp(join(tmpdir(), "neta-pi-node-switch-work-"));
	savedNetadir = process.env.NETA_DIR;
	process.env.NETA_DIR = dir;
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			providers: Object.fromEntries(
				[
					["claude", { command: process.execPath, args: [FIXTURE, "--config-options", "--unrestricted-mode", "bypassPermissions"], resume: true, unsandboxedMode: "bypassPermissions", defaultModel: "fixture-default" }],
					["codex", { command: process.execPath, args: [FIXTURE, "--config-options", "--unrestricted-mode", "bypassPermissions"], resume: true, unsandboxedMode: "bypassPermissions", defaultModel: "fixture-fast" }],
				],
			),
			leader: { provider: "missing", model: "test-model" },
			forbiddenModels: [],
		}),
	);
	node = await startNode();
	client = await connectNode({ client: "desktop" });
	const opened = await client.request<{ leader: { sessionId: string } }>("workspace.open", { path: workspace });
	const selected = await client.request<{ sessionId: string }>("conversation.setProvider", {
		sessionId: opened.leader.sessionId,
		provider: "claude",
	});
	await client.request("conversation.tail", { sessionId: selected.sessionId, limit: 20 });
	const output = await runPi(selected.sessionId, "claude", "codex");
	expect(output).toContain("Provider changed to codex.");
	expect(output).toContain("codex · fixture-fast");
	const tail = await client.request<ConversationTailResult>("conversation.tail", { sessionId: selected.sessionId, limit: 50 });
	expect(tail.provider).toBe("codex");
	expect(tail.model).toBe("fixture-fast");
	expect(tail.blocks.some((block) => block.role === "user" && block.text === "STREAM claude")).toBe(true);
	expect(tail.blocks.some((block) => block.role === "agent" && block.text.includes("Second paragraph"))).toBe(true);
}, 90_000);

test("a healthy native Pi process switches to fake ACP and persists its vendor session", async () => {
	dir = await mkdtemp(join(tmpdir(), "neta-pi-native-switch-"));
	workspace = await mkdtemp(join(tmpdir(), "neta-pi-native-switch-work-"));
	savedNetadir = process.env.NETA_DIR;
	savedPiEnv = Object.fromEntries(["NETA_PI_RUNTIME", "NETA_PI_NODE", "NETA_PI_HOST", "NETA_PI_CLI", "NETA_PI_EXTENSION", "NETA_PI_PROVIDER", "NETA_PI_MODEL"].map((key) => [key, process.env[key]]));
	process.env.NETA_DIR = dir;
	process.env.NETA_PI_RUNTIME = "1";
	process.env.NETA_PI_NODE = "node";
	process.env.NETA_PI_HOST = join(import.meta.dir, "../src/pi/pty-host.mjs");
	process.env.NETA_PI_CLI = join(import.meta.dir, "./fixtures/fake-rmux-pi.mjs");
	process.env.NETA_PI_EXTENSION = join(import.meta.dir, "../src/pi/neta-extension.ts");
	process.env.NETA_PI_PROVIDER = "pi";
	process.env.NETA_PI_MODEL = "test-model";
	const promptCapture = join(dir, "fake-acp-prompts.ndjson");
	await writeFile(join(dir, "settings.json"), JSON.stringify({ providers: { fake: { command: process.execPath, args: [FIXTURE, "--prompt-capture", promptCapture], resume: true, defaultModel: "test-model" } }, leader: { provider: "fake", model: "test-model" }, forbiddenModels: [] }));
	node = await startNode();
	client = await connectNode({ client: "desktop" });
	const opened = await client.request<{ leader: { sessionId: string; provider: string } }>("workspace.open", { path: workspace });
	expect(opened.leader.provider).toBe("pi");
	let nativeOutput = "";
	const removeOutputListener = client.on("terminal.output" as NodeEvent, (params) => {
		const chunk = params as { sessionId?: string; dataBase64?: string };
		if (chunk.sessionId === opened.leader.sessionId && chunk.dataBase64 !== undefined)
			nativeOutput += Buffer.from(chunk.dataBase64, "base64").toString("utf8");
	});
	const attachment = await client.request<{ pid: number; replay: Array<{ dataBase64: string }> }>("terminal.attach", { sessionId: opened.leader.sessionId, cols: 80, rows: 24 });
	expect(attachment.pid).toBeGreaterThan(0);
	nativeOutput += attachment.replay.map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8")).join("");
	await waitFor("native Pi startup", () => nativeOutput.includes("FAKE_PI_READY:unknown"));
	removeOutputListener();
	const switched = await client.request<{ sessionId: string; provider: string; model: string; contextReset: boolean }>("conversation.setProvider", { sessionId: opened.leader.sessionId, provider: "fake", handoff: "NATIVE_HANDOFF_MARKER" });
	expect(switched).toEqual({ sessionId: opened.leader.sessionId, provider: "fake", model: "test-model", contextReset: true });
	const handoffMeta = JSON.parse(await readFile(join(dir, "conversations", `${switched.sessionId}.meta.json`), "utf8")) as { pendingHandoff?: string };
	expect(handoffMeta.pendingHandoff).toBe("NATIVE_HANDOFF_MARKER");
	await client.request("conversation.prompt", { sessionId: switched.sessionId, text: "NATIVE_PI_SWITCH_ECHO" });
	await waitFor("fake ACP response", async () => (await client?.request<ConversationTailResult>("conversation.tail", { sessionId: switched.sessionId, limit: 50 }))?.blocks.some((block) => block.role === "agent" && block.text === "echo:NATIVE_PI_SWITCH_ECHO") ?? false);
	const tail = await client.request<ConversationTailResult>("conversation.tail", { sessionId: switched.sessionId, limit: 50 });
	expect(tail.provider).toBe("fake");
	const consumedMeta = JSON.parse(await readFile(join(dir, "conversations", `${switched.sessionId}.meta.json`), "utf8")) as { pendingHandoff?: string };
	expect(consumedMeta.pendingHandoff).toBeUndefined();
	await client.request("conversation.prompt", { sessionId: switched.sessionId, text: "SECOND_PROMPT" });
	await waitFor("second fake ACP response", async () => (await client?.request<ConversationTailResult>("conversation.tail", { sessionId: switched.sessionId, limit: 50 }))?.blocks.some((block) => block.role === "agent" && block.text === "echo:SECOND_PROMPT") ?? false);
	const afterSecondPrompt = await client.request<ConversationTailResult>("conversation.tail", { sessionId: switched.sessionId, limit: 50 });
	expect(afterSecondPrompt.provider).toBe("fake");
	const afterSecondMeta = JSON.parse(await readFile(join(dir, "conversations", `${switched.sessionId}.meta.json`), "utf8")) as { pendingHandoff?: string };
	expect(afterSecondMeta.pendingHandoff).toBeUndefined();
	const capturedPrompts = (await readFile(promptCapture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string);
	expect(capturedPrompts).toHaveLength(2);
	expect(capturedPrompts[0].match(/NATIVE_HANDOFF_MARKER/g)).toHaveLength(1);
	expect(capturedPrompts[1].includes("NATIVE_HANDOFF_MARKER")).toBe(false);
	const persisted = JSON.parse(await readFile(join(dir, "conversations", `${switched.sessionId}.meta.json`), "utf8")) as { provider: string; vendorSessionId?: string };
	expect(persisted.provider).toBe("fake");
	expect(typeof persisted.vendorSessionId).toBe("string");
}, 90_000);
