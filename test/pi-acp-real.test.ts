import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(import.meta.dir, "fixtures", "pi-acp-real.py");

async function runPi(failPrompt: boolean, provider = "fake", resetMode = false): Promise<{ output: string; prompts: number; promptSessions: string[] }> {
	const dir = await mkdtemp(join(tmpdir(), "neta-pi-acp-real-"));
	const socketPath = join(dir, "node.sock");
	let prompts = 0;
	let activeSession = "session-real";
	const promptSessions: string[] = [];
	const server = createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params?: { sessionId?: string } };
				buffer = buffer.slice(newline + 1);
				if (request.method === "hello") {
					socket.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { machine: { id: "m", name: "local", createdAt: new Date().toISOString() }, protocolVersion: 3, nodeVersion: "test", pid: process.pid } })}\n`,
					);
					continue;
				}
				if (request.method === "conversation.tail") {
						socket.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: request.params?.sessionId ?? activeSession, turns: [], blocks: [], prevCursor: null, provider, model: "test-model" } })}\n`,
					);
					continue;
				}
				if (request.method === "models.list") {
					socket.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { models: [{ id: "test-model", name: "Test model", provider }] } })}\n`,
					);
					continue;
				}
				if (request.method === "conversation.reset") {
					activeSession = "session-reset";
					socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: activeSession, provider, model: "test-model" } })}\n`);
					continue;
				}
				if (request.method !== "conversation.prompt") {
					socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
					continue;
				}
				prompts++;
				promptSessions.push(activeSession);
				if (failPrompt) {
					socket.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "transport unavailable", data: { code: "PROVIDER_ERROR" } } })}\n`,
					);
					continue;
				}
				socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { turnId: "turn-real" } })}\n`);
				const notify = (params: unknown) =>
					socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn", params })}\n`);
				notify({
					sessionId: "session-real",
					turn: { id: "turn-real", sessionId: "session-real", role: "user", startedAt: new Date().toISOString() },
				});
				notify({
					sessionId: "session-real",
					block: {
						turnId: "turn-real",
						seq: 1,
						at: new Date().toISOString(),
						role: "agent",
						kind: "text",
						text: "REMOTE_TEXT",
					},
				});
				setTimeout(() => {
					notify({
						sessionId: "session-real",
						block: {
							turnId: "turn-real",
							seq: 2,
							at: new Date().toISOString(),
							role: "agent",
							kind: "tool",
							text: "REMOTE_TOOL",
							data: { toolCallId: "tool-1", status: "in_progress" },
						},
					});
				}, 100);
				setTimeout(() => {
					notify({
						sessionId: "session-real",
						block: {
							turnId: "turn-real",
							seq: 3,
							at: new Date().toISOString(),
							role: "agent",
							kind: "tool",
							text: "REMOTE_TOOL_COMPLETE",
							data: { toolCallId: "tool-1", status: "completed" },
						},
					});
					notify({
						sessionId: "session-real",
						turn: {
							id: "turn-real",
							sessionId: "session-real",
							role: "user",
							startedAt: new Date().toISOString(),
							endedAt: new Date().toISOString(),
						},
					});
				}, 220);
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	try {
		const configBin = join(dir, "pi-config", "bin");
		await Promise.all([mkdir(join(dir, "pi")), mkdir(configBin, { recursive: true })]);
		await Promise.all([
			writeFile(join(configBin, "fd"), "#!/bin/sh\nexit 0\n"),
			writeFile(join(configBin, "rg"), "#!/bin/sh\nexit 0\n"),
		]);
		await Promise.all([chmod(join(configBin, "fd"), 0o700), chmod(join(configBin, "rg"), 0o700)]);
		await writeFile(
			join(dir, "node.json"),
			JSON.stringify({
				socket: socketPath,
				token: "test",
				pid: process.pid,
				protocolVersion: 3,
				startedAt: new Date().toISOString(),
			}),
		);
		const child = Bun.spawn(["python3", fixture], {
			cwd: root,
			env: {
				...process.env,
				NETA_DESCRIPTOR: join(dir, "node.json"),
					NETA_TARGET_SESSION_ID: "session-real",
					...(resetMode ? { NETA_PI_RESET_MODE: "1", NETA_PI_RESET_PROMPT: "FRESH_RESET_CONTEXT", NETA_PI_RESET_FIRST_MARKER: "REMOTE_TOOL_COMPLETE" } : {}),
			NETA_TARGET_PROVIDER: provider,
			NETA_TARGET_MODEL: "test-model",
			NETA_PI_READY_MARKER: `${provider} · test-model`,
				NETA_PI_VERIFY_ROOT: root,
				NETA_PI_VERIFY_SESSION_DIR: join(dir, "pi"),
				PI_CODING_AGENT_DIR: join(dir, "pi-config"),
				PI_OFFLINE: "1",
				PATH: `${configBin}:${process.env.PATH ?? ""}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [output, stderr, status] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(status, stderr).toBe(0);
		return { output, prompts, promptSessions };
	} finally {
		server.close();
		await rm(dir, { recursive: true, force: true });
	}
}

test("real Pi loads the ACP proxy and renders streamed remote text and a coalesced tool", async () => {
	const result = await runPi(false);
	expect(result.prompts, result.output).toBe(1);
	expect(result.output).toContain("REMOTE_TEXT");
	expect(result.output).toContain("REMOTE_TOOL_COMPLETE");
	expect(result.output).not.toContain('Unknown provider "neta-acp"');
}, 20_000);

test("real Pi consumes a failed ACP prompt without starting its native model loop", async () => {
	const result = await runPi(true);
	expect(result.prompts, result.output).toBe(1);
	expect(result.output).toContain("ACP prompt failed: transport unavailable");
	expect(result.output).not.toContain("native Pi model loop is disabled");
}, 20_000);

test("real Pi reset command rebinds to the replacement Node session", async () => {
	const result = await runPi(false, "fake", true);
	expect(result.prompts, result.output).toBe(2);
	expect(result.promptSessions).toEqual(["session-real", "session-reset"]);
	expect(result.output).toContain("Conversation reset; attached the replacement session.");
}, 20_000);

for (const provider of ["claude", "codex", "opencode"]) {
	test(`real Pi proxies fake ${provider} ACP without a native provider loop`, async () => {
		const result = await runPi(false, provider);
		expect(result.prompts, result.output).toBe(1);
		expect(result.output).toContain("REMOTE_TEXT");
	}, 20_000);
}
