import { afterEach, expect, mock, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RenderedTurnState } from "../src/rmux/pi-acp-controller.ts";
const clipboardWrites: string[] = [];
mock.module("../src/rmux/pi-clipboard.ts", () => ({
	copyToClipboard: (text: string) => clipboardWrites.push(text),
}));
const { default: acpExtension, latestRemoteResponse } = await import("../src/rmux/pi-acp-extension.ts");

const prior = { ...process.env };
afterEach(() => {
	process.env = { ...prior };
	clipboardWrites.length = 0;
});

async function until(check: () => boolean): Promise<void> {
	for (let index = 0; index < 100; index++) {
		if (check()) return;
		await Bun.sleep(10);
	}
	throw new Error("condition not reached");
}

test("native Pi writes its editor-ready marker without connecting ACP", async () => {
	const dir = join(process.env.TMPDIR ?? "/tmp", `neta-native-pi-ready-${process.pid}-${Date.now()}`);
	const marker = join(dir, "editor-ready");
	await mkdir(dir, { recursive: true });
	process.env.NETA_DESCRIPTOR = join(dir, "unused-node.json");
	process.env.NETA_TARGET_SESSION_ID = "native-session";
	process.env.NETA_TARGET_PROVIDER = "pi";
	process.env.NETA_PI_EDITOR_READY_PATH = marker;
	const handlers = new Map<string, (...args: never[]) => unknown>();
	acpExtension({ on: (name: string, handler: (...args: never[]) => unknown) => handlers.set(name, handler) } as unknown as ExtensionAPI);
	await handlers.get("session_start")?.({} as never, {} as never);
	expect(await readFile(marker, "utf8")).toBe("native-session");
	await rm(dir, { recursive: true, force: true });
});

test("Pi input reaches the exact ACP session and remote blocks use one turn renderer", async () => {
	const dir = join(process.env.TMPDIR ?? "/tmp", `neta-pi-acp-${process.pid}-${Date.now()}`);
	await mkdir(dir, { recursive: true });
	const socketPath = join(dir, "node.sock");
	let prompt: Record<string, unknown> | undefined;
	let tailSeen = false;
	const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
	const server = createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const request = JSON.parse(buffer.slice(0, newline)) as {
					id: string;
					method: string;
					params: Record<string, unknown>;
				};
				buffer = buffer.slice(newline + 1);
				requests.push({ method: request.method, params: request.params });
				let result: unknown = {};
				if (request.method === "hello") {
					result = {
						machine: { id: "m", name: "local", createdAt: new Date().toISOString() },
						protocolVersion: 3,
						nodeVersion: "test",
						pid: process.pid,
					};
				} else if (request.method === "conversation.tail") {
					tailSeen = true;
					result = {
						sessionId: "session-acp",
						turns: [],
						blocks: [],
						prevCursor: request.params.sessionId === "session-acp" ? "11" : null,
						provider: "fake",
						model: "fake-model",
					};
				} else if (request.method === "models.list") {
					result = { models: [{ id: "fake-model", name: "Fake", provider: "fake" }] };
				} else if (request.method === "conversation.prompt") {
					prompt = request.params;
					if (request.params.text === "!fails") {
						socket.write(
							`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "transport unavailable", data: { code: "PROVIDER_ERROR" } } })}\n`,
						);
						continue;
					}
					result = { messageId: "message-1", status: "delivered", turnId: "turn-1" };
				} else if (request.method === "conversation.reset") {
					result = { sessionId: "session-reset", provider: "fake", model: "fake-model" };
				}
				socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
				if (request.method === "conversation.prompt") {
					const notify = (params: unknown) =>
						socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn", params })}\n`);
					notify({
						sessionId: "session-acp",
						turn: { id: "turn-1", sessionId: "session-acp", role: "user", startedAt: new Date().toISOString() },
					});
					notify({
						sessionId: "session-acp",
						block: {
							turnId: "turn-1",
							seq: 1,
							at: new Date().toISOString(),
							role: "user",
							kind: "text",
							text: "hello",
						},
					});
					notify({
						sessionId: "session-acp",
						block: {
							turnId: "turn-1",
							seq: 2,
							at: new Date().toISOString(),
							role: "agent",
							kind: "tool",
							text: "Read",
							data: { toolCallId: "tool-1", status: "in_progress" },
						},
					});
					notify({
						sessionId: "session-acp",
						block: {
							turnId: "turn-1",
							seq: 3,
							at: new Date().toISOString(),
							role: "agent",
							kind: "tool",
							text: "Read complete",
							data: { toolCallId: "tool-1", status: "completed" },
						},
					});
					notify({
						sessionId: "session-acp",
						block: {
							turnId: "turn-1",
							seq: 4,
							at: new Date().toISOString(),
							role: "agent",
							kind: "text",
							text: "done",
						},
					});
					notify({
						sessionId: "session-acp",
						turn: {
							id: "turn-1",
							sessionId: "session-acp",
							role: "user",
							startedAt: new Date().toISOString(),
							endedAt: new Date().toISOString(),
						},
					});
				}
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	await writeFile(
		join(dir, "node.json"),
		JSON.stringify({
			socket: socketPath,
			token: "secret",
			pid: process.pid,
			protocolVersion: 3,
			startedAt: new Date().toISOString(),
		}),
	);
	process.env.NETA_DESCRIPTOR = join(dir, "node.json");
	process.env.NETA_TARGET_SESSION_ID = "session-acp";
	process.env.NETA_TARGET_PROVIDER = "fake";
	process.env.NETA_TARGET_MODEL = "fake-model";

	const handlers = new Map<string, (...args: never[]) => unknown>();
	const commands = new Map<string, { handler: (...args: never[]) => Promise<void> }>();
	const messages: Array<{ customType: string; details?: unknown }> = [];
	const notices: string[] = [];
	let activeTools: string[] | undefined;
	const pi = {
		on: (name: string, handler: (...args: never[]) => unknown) => handlers.set(name, handler),
		registerCommand: (name: string, command: { handler: (...args: never[]) => Promise<void> }) =>
			commands.set(name, command),
		registerProvider: () => undefined,
		registerMessageRenderer: () => undefined,
		setActiveTools: (tools: string[]) => {
			activeTools = tools;
		},
		sendMessage: (message: { customType: string; details?: unknown }) => messages.push(message),
	} as unknown as ExtensionAPI;
	acpExtension(pi);
	await handlers.get("session_start")?.(
		{} as never,
		{
			ui: {
				notify: (message: string) => notices.push(message),
				onTerminalInput: () => undefined,
				setStatus: () => undefined,
			},
			sessionManager: { getEntries: () => [] },
		} as never,
	);
	expect(activeTools).toEqual([]);
	await until(() => tailSeen);
	const input = handlers.get("input");
	expect(input).toBeDefined();
	await input?.({ text: "hello", images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] } as never);
	await until(() => messages.length === 1);
	expect(prompt?.sessionId).toBe("session-acp");
	expect(prompt?.text).toBe("hello");
	expect(prompt?.attachments).toEqual([
		expect.objectContaining({ kind: "image", mimeType: "image/png", dataBase64: "aGVsbG8=" }),
	]);
	expect(messages).toHaveLength(1);
	expect(messages[0]?.customType).toBe("neta.acp.turn");
	const copy = commands.get("neta-copy");
	expect(copy).toBeDefined();
	await copy?.handler("" as never, { ui: { notify: (message: string) => notices.push(message) } } as never);
	expect(clipboardWrites).toEqual(["done"]);
	const reset = commands.get("neta-reset");
	expect(reset).toBeDefined();
	await reset?.handler("" as never, { ui: { notify: () => undefined }, newSession: async () => ({ cancelled: false }) } as never);
	await until(() =>
		requests.some(
			(request) => request.method === "conversation.tail" && request.params.sessionId === "session-reset",
		),
	);
	await input?.({ text: "after reset" } as never);
	expect(prompt?.sessionId).toBe("session-reset");
	await copy?.handler("" as never, { ui: { notify: (message: string) => notices.push(message) } } as never);
	expect(notices).toContain("No remote agent response to copy.");
	expect(requests).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ method: "conversation.reset", params: { sessionId: "session-acp" } }),
			expect.objectContaining({ method: "conversation.untail", params: { sessionId: "session-acp" } }),
		]),
	);
	const bash = handlers.get("user_bash");
	const bashResult = await bash?.({ command: "fails", excludeFromContext: false } as never);
	expect(bashResult).toEqual(
		expect.objectContaining({
			result: expect.objectContaining({ exitCode: 1, output: "ACP command failed: transport unavailable" }),
		}),
	);
	expect(notices).toContain("ACP command failed: transport unavailable");

	server.close();
});

test("latest remote response preserves source text and excludes user, tool, plan, and stale blocks", () => {
	const state: RenderedTurnState = {
		open: false,
		turns: new Map([
			["old", { id: "old", sessionId: "old-session", role: "user", startedAt: "2026-01-03T00:00:00.000Z" }],
			["new", { id: "new", sessionId: "s", role: "user", startedAt: "2026-01-02T00:00:00.000Z" }],
		]),
		blocks: new Map([
			["old:1", { turnId: "old", seq: 1, at: "2026-01-03T00:00:00.000Z", role: "agent", kind: "text", text: "stale" }],
			["new:1", { turnId: "new", seq: 1, at: "2026-01-02T00:00:00.000Z", role: "user", kind: "text", text: "exclude me" }],
			["new:2", { turnId: "new", seq: 2, at: "2026-01-02T00:00:01.000Z", role: "agent", kind: "tool", text: "exclude tool" }],
			["new:3", { turnId: "new", seq: 3, at: "2026-01-02T00:00:02.000Z", role: "agent", kind: "text", text: "alpha\nβeta" }],
			["new:4", { turnId: "new", seq: 4, at: "2026-01-02T00:00:03.000Z", role: "agent", kind: "plan", text: "next" }],
		]),
	};
	expect(latestRemoteResponse(state, "s")).toBe("alpha\nβeta");
	expect(latestRemoteResponse(state, "old-session")).toBe("stale");
	state.blocks.delete("new:3");
	state.blocks.delete("new:4");
	expect(latestRemoteResponse(state, "s")).toBeUndefined();
});
