import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Leader, Workspace } from "../src/core/types.ts";
import { connectNode, type NodeClient } from "../src/node/client.ts";
import { type Node as NetaNode, startNode } from "../src/node/lifecycle.ts";
import type { OpenCodeAttachment } from "../src/opencode/attachment.ts";

const fork = process.env.NETA_OPENCODE_DIR ?? resolve(import.meta.dir, "../../neta-opencode");

// Opt in after installing the pinned sibling fork. All inference is a local fake;
// no provider credentials, user configuration or real workspaces are used.
test.skipIf(!existsSync(join(fork, "node_modules")))(
	"native OpenCode shares Neta's turn, survives view close, and resets one leader",
	async () => {
		const dir = await mkdtemp("/tmp/neta-native-");
		const oldDir = process.env.NETA_DIR;
		const oldFork = process.env.NETA_OPENCODE_DIR;
		const oldBin = process.env.NETA_BIN;
		process.env.NETA_DIR = join(dir, "node");
		process.env.NETA_OPENCODE_DIR = fork;
		const work = join(dir, "first-project");
		let node: NetaNode | undefined;
		let client: NodeClient | undefined;
		let requests = 0;
		let responseMode: "success" | "auth" | "hang" = "success";
		const llm = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				await request.json();
				requests++;
				if (responseMode === "auth")
					return Response.json(
						{ error: { message: "Fixture sign-in expired", type: "authentication_error" } },
						{ status: 401 },
					);
				if (responseMode === "hang")
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify({ id: "chatcmpl-hang", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant", content: "Waiting for cancellation" }, index: 0 }] })}\n\n`,
									),
								);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				const chunks = [
					{ choices: [{ delta: { role: "assistant", content: "Native fixture reply" }, index: 0 }] },
					{
						choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				];
				return new Response(
					chunks
						.map(
							(chunk) =>
								`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`,
						)
						.join("") + "data: [DONE]\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			await mkdir(process.env.NETA_DIR, { recursive: true });
			await mkdir(work);
			const runner = join(dir, "neta");
			await writeFile(
				runner,
				`#!/bin/sh\nexec '${process.execPath}' '${resolve(import.meta.dir, "../src/cli/main.ts")}' "$@"\n`,
			);
			await chmod(runner, 0o700);
			process.env.NETA_BIN = runner;
			const env = {
				XDG_DATA_HOME: join(dir, "data"),
				XDG_CONFIG_HOME: join(dir, "config"),
				XDG_CACHE_HOME: join(dir, "cache"),
				XDG_STATE_HOME: join(dir, "state"),
				OPENCODE_TEST_HOME: join(dir, "home"),
				OPENCODE_TEST_MANAGED_CONFIG_DIR: join(dir, "managed"),
				OPENCODE_DISABLE_MODELS_FETCH: "true",
				OPENCODE_DISABLE_AUTOUPDATE: "true",
				OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
				OPENCODE_MODELS_PATH: join(fork, "packages/opencode/test/tool/fixtures/models-api.json"),
				OPENCODE_CONFIG_CONTENT: JSON.stringify({
					model: "test/test-model",
					small_model: "test/test-model",
					enabled_providers: ["test"],
					formatter: false,
					lsp: false,
					provider: {
						test: {
							name: "Fixture",
							npm: "@ai-sdk/openai-compatible",
							env: [],
							options: { apiKey: "fixture", baseURL: llm.url.href },
							models: {
								"test-model": {
									name: "Fixture",
									variants: { high: {}, xhigh: {} },
									limit: { context: 100000, output: 10000 },
									cost: { input: 0, output: 0 },
								},
							},
						},
					},
				}),
			};
			await writeFile(
				join(process.env.NETA_DIR, "settings.json"),
				JSON.stringify({
					providers: {
						opencode: { command: "opencode", args: ["acp"], resume: true, defaultModel: "test/test-model", env },
					},
					leader: { provider: "opencode", model: "test/test-model" },
					forbiddenModels: [],
				}),
			);
			node = await startNode();
			client = await connectNode();
			const opened = await client.request<{ workspace: Workspace; leader: Leader }>("workspace.open", {
				path: work,
				provider: "opencode",
			});
			expect(opened.leader.state).toBe("idle");
			const native = await client.request<OpenCodeAttachment>("conversation.native", {
				sessionId: opened.leader.sessionId,
			});
			const headers = { Authorization: native.authorization, "content-type": "application/json" };
			const initial = await fetch(`${native.url}/session/${native.sessionId}`, { headers });
			expect(initial.status).toBe(200);
			expect(await initial.json()).toMatchObject({ directory: await realpath(work) });
			const response = await fetch(`${native.url}/session/${native.sessionId}/message`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					messageID: "msg_native_fixture",
					parts: [{ type: "text", text: "Say hello" }],
					model: { providerID: "test", modelID: "test-model" },
					variant: "xhigh",
				}),
			});
			expect(await response.text()).not.toContain("NetaError");
			const deadline = Date.now() + 30000;
			let transcript = "";
			while (Date.now() < deadline) {
				transcript = JSON.stringify(
					await client.request("conversation.tail", { sessionId: opened.leader.sessionId }),
				);
				if (transcript.includes("Native fixture reply")) break;
				await Bun.sleep(100);
			}
			expect(transcript).toContain("Native fixture reply");
			expect(transcript).toContain("Say hello");
			const mcp = await fetch(`${native.url}/mcp`, { headers });
			expect(await mcp.json()).toMatchObject({ neta: { status: "connected" } });
			const scoped = await fetch(`${native.url}/session/${native.sessionId}`, { headers });
			expect(await scoped.json()).toMatchObject({
				permission: [
					{ permission: "task", action: "deny", pattern: "*" },
					{ permission: "edit", action: "deny", pattern: "*" },
					{ permission: "bash", action: "deny", pattern: "*" },
				],
			});
			const messages = await fetch(`${native.url}/session/${native.sessionId}/message`, { headers });
			expect(await messages.text()).toContain("Native fixture reply");
			expect(requests).toBeGreaterThan(0);
			const high = await fetch(`${native.url}/session/${native.sessionId}/message`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					parts: [{ type: "text", text: "Check high effort" }],
					model: { providerID: "test", modelID: "test-model" },
					variant: "high",
				}),
			});
			expect(high.ok).toBe(true);
			const highDeadline = Date.now() + 15000;
			let highMessages = "";
			while (Date.now() < highDeadline) {
				highMessages = await (await fetch(`${native.url}/session/${native.sessionId}/message`, { headers })).text();
				const snapshot = await client.request<{ leaders: Leader[] }>("snapshot");
				if (
					highMessages.includes('"variant":"high"') &&
					snapshot.leaders.find((one) => one.workspaceId === opened.workspace.id)?.state === "idle"
				)
					break;
				await Bun.sleep(100);
			}
			expect(highMessages).toContain('"variant":"high"');
			expect(highMessages).toContain('"variant":"xhigh"');
			const normal = await fetch(`${native.url}/session/${native.sessionId}/message`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					parts: [{ type: "text", text: "Back to default effort" }],
					model: { providerID: "test", modelID: "test-model" },
				}),
			});
			expect(normal.ok).toBe(true);
			const normalDeadline = Date.now() + 15000;
			let normalMessage: { info: { role: string; variant?: string }; parts: { text?: string }[] } | undefined;
			while (Date.now() < normalDeadline) {
				const messages = (await (
					await fetch(`${native.url}/session/${native.sessionId}/message`, { headers })
				).json()) as { info: { role: string; variant?: string }; parts: { text?: string }[] }[];
				normalMessage = messages.find(
					(message) =>
						message.info.role === "user" && message.parts.some((part) => part.text === "Back to default effort"),
				);
				const snapshot = await client.request<{ leaders: Leader[] }>("snapshot");
				if (
					normalMessage &&
					snapshot.leaders.find((one) => one.workspaceId === opened.workspace.id)?.state === "idle"
				)
					break;
				await Bun.sleep(100);
			}
			expect(normalMessage).toBeDefined();
			expect(normalMessage?.info.variant).toBeUndefined();

			if (process.env.NETA_TUI_SMOKE) {
				const second = join(dir, "second-project");
				await mkdir(second);
				await client.request("workspace.open", { path: second, provider: "opencode" });
				const socket = `neta-smoke-${process.pid}`;
				const tmux = async (...args: string[]) => {
					const child = Bun.spawn(["tmux", "-L", socket, ...args], {
						env: { ...process.env, ...env, TERM: "xterm-256color" },
						stdout: "pipe",
						stderr: "pipe",
					});
					const output = await new Response(child.stdout).text();
					if (await child.exited) throw new Error(await new Response(child.stderr).text());
					return output;
				};
				try {
					await tmux(
						"-f",
						"/dev/null",
						"new-session",
						"-d",
						"-s",
						"migration",
						"-x",
						"140",
						"-y",
						"44",
						...(process.env.NETA_OPENCODE_BIN
							? [process.env.NETA_OPENCODE_BIN, "neta"]
							: [process.execPath, "run", join(fork, "script/neta.ts")]),
						work,
					);
					let screen = "";
					const ready = Date.now() + 25000;
					while (Date.now() < ready) {
						screen = await tmux("capture-pane", "-p", "-t", "migration");
						if (screen.includes("Workspace leader") && screen.includes("Native fixture reply")) break;
						await Bun.sleep(200);
					}
					await writeFile("/tmp/neta-opencode-smoke.txt", screen);
					expect(screen).toContain("Workspace leader");
					expect(screen).toContain("Native fixture reply");
					expect(screen).not.toContain("workspace/neta");
					await tmux("send-keys", "-t", "migration", "-l", "/mach");
					await Bun.sleep(400);
					expect(await tmux("capture-pane", "-p", "-t", "migration")).toContain("/machines");
					await tmux("send-keys", "-t", "migration", "Tab");
					await Bun.sleep(400);
					const machineScreen = await tmux("capture-pane", "-p", "-t", "migration");
					expect(machineScreen).toContain("Machines");
					await tmux("send-keys", "-t", "migration", "Escape");
					await Bun.sleep(200);
					await tmux("send-keys", "-t", "migration", "-l", "draft stays here");
					await tmux("send-keys", "-t", "migration", "C-k");
					await Bun.sleep(500);
					const picker = await tmux("capture-pane", "-p", "-t", "migration");
					expect(picker).toContain("Workspaces");
					await tmux("send-keys", "-t", "migration", "Escape");
					await Bun.sleep(300);
					expect(await tmux("capture-pane", "-p", "-t", "migration")).toContain("draft stays here");
					const waitScreen = async (contains: string) => {
						const deadline = Date.now() + 15000;
						let screen = "";
						while (Date.now() < deadline) {
							screen = await tmux("capture-pane", "-p", "-t", "migration");
							if (screen.includes(contains)) return screen;
							await Bun.sleep(200);
						}
						throw new Error(`Screen never showed ${contains}:\n${screen}`);
					};
					await tmux("send-keys", "-t", "migration", "C-k");
					await Bun.sleep(200);
					await tmux("send-keys", "-t", "migration", "-l", "second-project");
					await tmux("send-keys", "-t", "migration", "Enter");
					expect(await waitScreen("neta second-project")).not.toContain("draft stays here");
					await tmux("send-keys", "-t", "migration", "C-k");
					await Bun.sleep(200);
					await tmux("send-keys", "-t", "migration", "-l", "first-project");
					await tmux("send-keys", "-t", "migration", "Enter");
					await waitScreen("neta first-project");
					const restored = await waitScreen("draft stays here");
					expect(restored).toContain("first-project /");
					expect(restored.match(/· LEADER/g)).toHaveLength(1);
					await writeFile("/tmp/neta-opencode-smoke.txt", restored);
					await tmux(
						"new-window",
						"-d",
						"-t",
						"migration",
						"-n",
						"reopened",
						...(process.env.NETA_OPENCODE_BIN
							? [process.env.NETA_OPENCODE_BIN, "neta"]
							: [process.execPath, "run", join(fork, "script/neta.ts")]),
					);
					let reopened = "";
					const reopenDeadline = Date.now() + 15000;
					while (Date.now() < reopenDeadline) {
						reopened = await tmux("capture-pane", "-p", "-t", "migration:reopened");
						if (reopened.includes("neta first-project")) break;
						await Bun.sleep(200);
					}
					expect(reopened).toContain("neta first-project");
				} finally {
					await tmux("kill-server").catch(() => undefined);
				}
			}
			responseMode = "hang";
			const cancelCount = requests;
			await fetch(`${native.url}/session/${native.sessionId}/message`, {
				method: "POST",
				headers,
				body: JSON.stringify({ parts: [{ type: "text", text: "Wait for cancellation" }] }),
			});
			const cancelDeadline = Date.now() + 15000;
			while (requests === cancelCount && Date.now() < cancelDeadline) await Bun.sleep(100);
			expect(requests).toBeGreaterThan(cancelCount);
			expect(
				(await fetch(`${native.url}/session/${native.sessionId}/abort`, { method: "POST", headers, body: "{}" }))
					.status,
			).toBe(200);
			let idle = false;
			while (Date.now() < cancelDeadline) {
				const state = await client.request<{ leaders: Leader[] }>("snapshot");
				idle = state.leaders.find((one) => one.workspaceId === opened.workspace.id)?.state === "idle";
				if (idle) break;
				await Bun.sleep(100);
			}
			expect(idle).toBe(true);
			responseMode = "auth";
			await fetch(`${native.url}/session/${native.sessionId}/message`, {
				method: "POST",
				headers,
				body: JSON.stringify({ parts: [{ type: "text", text: "Test expired sign-in" }] }),
			});
			const errorDeadline = Date.now() + 15000;
			let failed = "";
			while (Date.now() < errorDeadline) {
				failed = JSON.stringify(await client.request("conversation.tail", { sessionId: opened.leader.sessionId }));
				if (failed.includes("Fixture sign-in expired")) break;
				await Bun.sleep(100);
			}
			expect(failed).toContain("Fixture sign-in expired");
			expect(await (await fetch(`${native.url}/session/${native.sessionId}/message`, { headers })).text()).toContain(
				"Fixture sign-in expired",
			);
			responseMode = "success";
			await client.close();
			client = await connectNode();
			const reopened = await client.request<OpenCodeAttachment>("conversation.native", {
				sessionId: opened.leader.sessionId,
			});
			expect(reopened.sessionId).toBe(native.sessionId);
			const count = requests;
			await client.request("conversation.reset", { sessionId: opened.leader.sessionId });
			const snapshot = await client.request<{ leaders: Leader[] }>("snapshot");
			const leaders = snapshot.leaders.filter((one) => one.workspaceId === opened.workspace.id);
			expect(leaders).toHaveLength(1);
			expect(leaders[0]?.name).toBe(opened.leader.name);
			expect(leaders[0]?.sessionId).not.toBe(opened.leader.sessionId);
			expect(requests).toBe(count);
			expect(
				(
					await fetch(`${reopened.url}/session/${native.sessionId}`, {
						headers: { Authorization: reopened.authorization },
					})
				).status,
			).toBe(409);
			const fresh = await client.request<OpenCodeAttachment>("conversation.native", {
				sessionId: leaders[0]?.sessionId,
			});
			expect(fresh.sessionId).not.toBe(native.sessionId);
			await client.close();
			await node.stop();
			node = await startNode();
			client = await connectNode();
			const restored = await client.request<{ leader: Leader }>("workspace.open", {
				path: work,
				provider: "opencode",
			});
			const resumed = await client.request<OpenCodeAttachment>("conversation.native", {
				sessionId: restored.leader.sessionId,
			});
			expect(resumed.sessionId).toBe(fresh.sessionId);
			const originalFetch = globalThis.fetch;
			let failedProbe = false;
			globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
				const input = args[0];
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (!failedProbe && url.pathname === `/session/${resumed.sessionId}`) {
					failedProbe = true;
					throw new TypeError("fetch failed");
				}
				return originalFetch(...args);
			}, originalFetch);
			try {
				const recovered = await client.request<OpenCodeAttachment>("conversation.native", {
					sessionId: restored.leader.sessionId,
				});
				expect(failedProbe).toBe(true);
				expect(recovered.sessionId).toBe(resumed.sessionId);
			} finally {
				globalThis.fetch = originalFetch;
			}

			expect(requests).toBe(count);
		} finally {
			await client?.close();
			await node?.stop();
			llm.stop(true);
			if (oldDir === undefined) delete process.env.NETA_DIR;
			else process.env.NETA_DIR = oldDir;
			if (oldFork === undefined) delete process.env.NETA_OPENCODE_DIR;
			else process.env.NETA_OPENCODE_DIR = oldFork;
			if (oldBin === undefined) delete process.env.NETA_BIN;
			else process.env.NETA_BIN = oldBin;
			if (process.env.NETA_KEEP_TEST_DIR) console.log("Fixture directory:", dir);
			else await rm(dir, { recursive: true, force: true });
		}
	},
	90000,
);
