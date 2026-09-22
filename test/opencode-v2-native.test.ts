import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnProvider } from "../src/acp/process.ts";
import { type SessionEvent, startSession } from "../src/acp/session.ts";
import { writeSystemContext } from "../src/acp/system-context.ts";
import { ulid } from "../src/core/ids.ts";
import type { Leader, Workspace } from "../src/core/types.ts";
import { connectNode, type NodeClient } from "../src/node/client.ts";
import { type Node as NetaNode, startNode } from "../src/node/lifecycle.ts";
import type { SnapshotResult } from "../src/node/protocol.ts";
import type { OpenCodeAttachment } from "../src/opencode/attachment.ts";
import { openCodeEndpoint } from "../src/opencode/attachment.ts";
import { managedOpenCodeProvider } from "../src/opencode/runtime.ts";
import { managedOpenCodeDir } from "../scripts/opencode-pin.ts";
import { visualProxy } from "./fixtures/neta-visual-proxy.ts";

const fork = process.env.NETA_OPENCODE_DIR ?? managedOpenCodeDir();

// Opt in after installing the managed pinned fork. All inference is a local fake;
// no provider credentials, user configuration or real workspaces are used.
const nativeReady = process.env.NETA_OPENCODE_BIN
	? existsSync(process.env.NETA_OPENCODE_BIN)
	: existsSync(join(fork, "node_modules"));
if (process.env.NETA_REQUIRED_CONFORMANCE === "1" && !nativeReady)
	throw new Error("Required native conformance needs the pinned OpenCode checkout or staged executable");
test.skipIf(!nativeReady)(
	"native V2 OpenCode uses the same Neta conversation",
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
		const modelInputs: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
		let responseMode: "success" | "auth" | "hang" = "success";
		let externalRead = false;
		const evidence = join(dir, "downloaded-evidence.txt");
		const llm = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			async fetch(request) {
				const body = (await request.json()) as {
					messages?: Array<{ role: string; content: unknown }>;
					tools?: Array<{ function?: { name: string } }>;
				};
				modelInputs.push(body);
				requests++;
				if (externalRead && body.tools?.some((tool) => tool.function?.name === "read")) {
					externalRead = false;
					return new Response(
						[
							{
								choices: [
									{
										index: 0,
										delta: {
											role: "assistant",
											tool_calls: [
												{
													index: 0,
													id: "read_evidence",
													type: "function",
													function: { name: "read", arguments: JSON.stringify({ path: evidence }) },
												},
											],
										},
									},
								],
							},
							{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
						]
							.map(
								(chunk) =>
									`data: ${JSON.stringify({ id: "external-read", object: "chat.completion.chunk", model: "test-model", created: 1, ...chunk })}\n\n`,
							)
							.join("") + "data: [DONE]\n\n",
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
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
					{
						choices: [
							{
								delta: {
									role: "assistant",
									content:
										"Native fixture reply\n\nThe reply belongs in the Dialpad inbound webhook.\nI added coverage for active orders and duplicate delivery.\n\nThe request specs pass. I am checking the duplicate-delivery path.",
								},
								index: 0,
							},
						],
					},
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
				OPENCODE_DISABLE_PROJECT_CONFIG: "true",

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
			let legacySession: string | undefined;
			let legacyBytes: Buffer | undefined;
			const legacyFork = resolve(import.meta.dir, "../../neta-opencode");
			const nativeBinary = process.env.NETA_OPENCODE_BIN;
			if (!process.env.NETA_REQUIRED_CONFORMANCE && existsSync(join(legacyFork, "node_modules"))) {
				process.env.NETA_OPENCODE_DIR = legacyFork;
				delete process.env.NETA_OPENCODE_BIN;
				node = await startNode();
				client = await connectNode();
				const old = await client.request<{ leader: Leader }>("workspace.open", {
					path: work,
					provider: "opencode",
				});
				const oldNative = await client.request<OpenCodeAttachment>("conversation.native", {
					sessionId: old.leader.sessionId,
				});
				legacySession = oldNative.sessionId;
				await client.request("conversation.prompt", {
					sessionId: old.leader.sessionId,
					text: "V1 history to preserve",
				});
				const until = Date.now() + 20000;
				while (Date.now() < until) {
					if (
						JSON.stringify(
							await client.request("conversation.tail", { sessionId: old.leader.sessionId }),
						).includes("Native fixture reply")
					)
						break;
					await Bun.sleep(100);
				}
				await client.close();
				await node.stop();
				legacyBytes = await readFile(join(env.XDG_DATA_HOME, "opencode", "opencode-local.db"));
				process.env.NETA_OPENCODE_DIR = fork;
				if (nativeBinary) process.env.NETA_OPENCODE_BIN = nativeBinary;
			}
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

			expect(native.apiVersion).toBe(2);
			if (legacySession) {
				expect(native.sessionId).toBe(legacySession);
				expect(
					await (await fetch(`${native.url}/api/session/${native.sessionId}/message`, { headers })).text(),
				).toContain("V1 history to preserve");
				expect((await readFile(join(env.XDG_DATA_HOME, "opencode", "opencode-local.db"))).toString("base64")).toBe(
					legacyBytes?.toString("base64") ?? "missing V1 snapshot",
				);
			}
			const initial = await fetch(`${native.url}/api/session/${native.sessionId}`, { headers });
			expect(initial.status).toBe(200);
			const setting = await fetch(`${native.url}/api/session/${native.sessionId}/model`, {
				method: "POST",
				headers,
				body: JSON.stringify({ model: { providerID: "test", id: "test-model" } }),
			});
			if (!setting.ok) throw new Error(await setting.text());
			const send = await fetch(`${native.url}/api/session/${native.sessionId}/neta-prompt`, {
				method: "POST",
				headers,
				body: JSON.stringify({ text: "Fix issue 4041. Add tests for duplicate webhook delivery." }),
			});
			expect(send.status).toBe(200);
			let transcript = "";
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				transcript = JSON.stringify(
					await client.request("conversation.tail", { sessionId: opened.leader.sessionId }),
				);
				if (
					transcript.includes("Fix issue 4041.") &&
					transcript.split("Native fixture reply").length >= (legacySession ? 3 : 2)
				)
					break;
				await Bun.sleep(100);
			}
			expect(transcript).toContain("Native fixture reply");
			expect(
				await (await fetch(`${native.url}/api/session/${native.sessionId}/message`, { headers })).text(),
			).toContain("Native fixture reply");
			if (process.env.NETA_TUI_SMOKE) {
				const second = join(dir, "second-project");
				await mkdir(second);
				await client.request("workspace.open", { path: second, provider: "opencode" });
				const socket = `neta-smoke-${process.pid}`;
				const tmux = async (...args: string[]) => {
					const child = Bun.spawn(["tmux", "-L", socket, ...args], {
						env: { ...process.env, ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
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
							: [process.execPath, "run", "--cwd", join(fork, "packages/cli"), "./src/index.ts", "neta"]),
						work,
					);
					let screen = "";
					const ready = Date.now() + 25000;
					while (Date.now() < ready) {
						screen = await tmux("capture-pane", "-p", "-t", "migration");
						if (screen.includes("Workspace leader") && screen.includes("Native fixture reply")) break;
						await Bun.sleep(200);
					}
					await writeFile("/tmp/neta-opencode-v2-smoke.txt", screen);
					expect(screen).toContain("Workspace leader");
					expect(screen).toContain("Native fixture reply");
					expect(screen).not.toContain("workspace/neta");
					expect(screen).toContain("SPINE");
					expect(screen).not.toContain("Plugin failed");
					expect(screen).toContain("needs you");
					if (process.env.NETA_TUI_CAPTURE_DIR) {
						await mkdir(process.env.NETA_TUI_CAPTURE_DIR, { recursive: true });
						await writeFile(
							join(process.env.NETA_TUI_CAPTURE_DIR, "live-wide.ansi"),
							await tmux("capture-pane", "-e", "-p", "-t", "migration"),
						);
					}
					await tmux("send-keys", "-t", "migration", "-l", "/tabs");
					await Bun.sleep(250);
					await tmux("send-keys", "-t", "migration", "Tab");
					await Bun.sleep(350);
					expect(await tmux("capture-pane", "-p", "-t", "migration")).toContain("Agents and open tabs");
					await tmux("send-keys", "-t", "migration", "Escape");
					await tmux("resize-window", "-t", "migration", "-x", "80", "-y", "32");
					await Bun.sleep(500);
					const compact = await tmux("capture-pane", "-p", "-t", "migration");
					expect(compact).not.toContain("SPINE");
					expect(compact).not.toContain("[ Jump to leader ]");
					expect(compact).toContain("/tabs");
					expect(compact).toContain("Native fixture reply");
					if (process.env.NETA_TUI_CAPTURE_DIR)
						await writeFile(
							join(process.env.NETA_TUI_CAPTURE_DIR, "live-narrow.ansi"),
							await tmux("capture-pane", "-e", "-p", "-t", "migration"),
						);
					await tmux("send-keys", "-t", "migration", "-l", "/archive");
					await Bun.sleep(250);
					await tmux("send-keys", "-t", "migration", "Tab");
					await Bun.sleep(350);
					expect(await tmux("capture-pane", "-p", "-t", "migration")).toContain("Archived missions");
					await tmux("send-keys", "-t", "migration", "Escape");
					await tmux("resize-window", "-t", "migration", "-x", "140", "-y", "44");
					await Bun.sleep(400);

					if (process.env.NETA_TUI_CAPTURE_DIR) {
						const fixture = await visualProxy({
							directory: dir,
							descriptor: node.descriptor,
							snapshot: await client.request<SnapshotResult>("snapshot"),
							workspaceId: opened.workspace.id,
							path: work,
							sessionId: opened.leader.sessionId,
						});
						try {
							await tmux(
								"new-window",
								"-d",
								"-t",
								"migration",
								"-n",
								"visual",
								"env",
								`NETA_DIR=${fixture.directory}`,
								"COLORTERM=truecolor",
								...(process.env.NETA_OPENCODE_BIN
									? [process.env.NETA_OPENCODE_BIN, "neta"]
									: [process.execPath, "run", "--cwd", join(fork, "packages/cli"), "./src/index.ts", "neta"]),
							);
							await tmux("resize-window", "-t", "migration:visual", "-x", "170", "-y", "45");
							let frame = "";
							const until = Date.now() + 15000;
							while (Date.now() < until) {
								frame = await tmux("capture-pane", "-p", "-t", "migration:visual");
								if (frame.includes("CM auto-response") && frame.includes("Native fixture reply")) break;
								await Bun.sleep(200);
							}
							await writeFile(
								join(process.env.NETA_TUI_CAPTURE_DIR, "mission.ansi"),
								await tmux("capture-pane", "-e", "-p", "-t", "migration:visual"),
							);
							expect(frame).toContain("[ mac-mini ▾ ]");
							expect(frame).toContain("[ all states ▾ ]");
							expect(frame).toMatch(/├ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Sol · lead · RUNNING/);
							expect(frame).toContain("└ ◷ Terra · QUEUED");
							expect(frame).toContain("! BLOCKED");
							expect(frame).toContain("□ ARCHIVED");
							expect(frame).toContain("[ Jump to leader ]");
							expect(frame).toContain("[ tabs ▾ ]");
							const color = await tmux("capture-pane", "-e", "-p", "-t", "migration:visual");
							for (const rgb of ["17;19;21", "232;184;109", "54;59;64", "48;48;48", "35;35;35", "50;42;30"])
								expect(color).toContain(`;2;${rgb}m`);
							const rows = frame.split("\n");
							expect(rows.find((row) => row.includes("14:58"))?.indexOf("14:58")).toBe(
								rows.find((row) => row.includes("14:54"))?.indexOf("14:54"),
							);
							expect(rows.find((row) => row.includes("BLOCKED · 1 agent"))?.indexOf("BLOCKED")).toBe(
								rows.find((row) => row.includes("RUNNING · 2 agents"))?.indexOf("RUNNING"),
							);
							await writeFile(join(process.env.NETA_TUI_CAPTURE_DIR, "mission.ansi"), color);
							const waitVisual = async (label: string, visible = true) => {
								let screen = "";
								const deadline = Date.now() + 5000;
								while (Date.now() < deadline) {
									screen = await tmux("capture-pane", "-p", "-t", "migration:visual");
									if (screen.includes(label) === visible) return screen;
									await Bun.sleep(100);
								}
								throw new Error(`Visual state did not ${visible ? "show" : "dismiss"} ${label}:\n${screen}`);
							};
							await tmux("send-keys", "-t", "migration:visual", "C-p");
							await waitVisual("Commands");
							await writeFile(
								join(process.env.NETA_TUI_CAPTURE_DIR, "commands.ansi"),
								await tmux("capture-pane", "-e", "-p", "-t", "migration:visual"),
							);
							await tmux("send-keys", "-t", "migration:visual", "-l", "neta");
							expect(await waitVisual("Switch workspace")).toContain("Inspect archived missions");
							await writeFile(
								join(process.env.NETA_TUI_CAPTURE_DIR, "commands-neta.ansi"),
								await tmux("capture-pane", "-e", "-p", "-t", "migration:visual"),
							);
							await tmux("send-keys", "-t", "migration:visual", "Escape");
							await waitVisual("Commands", false);
							await tmux("send-keys", "-t", "migration:visual", "-l", "/archive");
							await tmux("send-keys", "-t", "migration:visual", "Tab");
							await waitVisual("Archived missions");
							await writeFile(
								join(process.env.NETA_TUI_CAPTURE_DIR, "archive-list.ansi"),
								await tmux("capture-pane", "-e", "-p", "-t", "migration:visual"),
							);
							await tmux("send-keys", "-t", "migration:visual", "Enter");
							await waitVisual("Saved conversations");
							await tmux("send-keys", "-t", "migration:visual", "Enter");
							const archive = await waitVisual("The pasted image is attached once.");
							expect(archive).toContain("Saved transcript");
							expect(archive).toContain("[ Back to workspace leader ]");
							expect(archive).toContain("The pasted image is attached once.");
							expect(archive).toContain("ARCHIVED · 18 Sep, 12:28");
							expect(archive).toContain("Session ended · 18 Sep, 12:28");
							expect(archive).toContain("ARCHIVED · merged · 1 agent");
							await writeFile(
								join(process.env.NETA_TUI_CAPTURE_DIR, "archive.ansi"),
								await tmux("capture-pane", "-e", "-p", "-t", "migration:visual"),
							);
						} finally {
							await tmux("kill-window", "-t", "migration:visual").catch(() => undefined);
							fixture.close();
						}
					}

					for (let cycle = 0; cycle < 3; cycle++) {
						await tmux("send-keys", "-t", "migration", "-l", "/mcp");
						await Bun.sleep(150);
						await tmux("send-keys", "-t", "migration", "Enter");
						await Bun.sleep(250);
						const dialog = await tmux("capture-pane", "-p", "-t", "migration");
						expect(dialog).toContain("MCP servers");
						expect(dialog).not.toContain("MaxListenersExceededWarning");
						await tmux("send-keys", "-t", "migration", "Escape");
						await Bun.sleep(300);
						expect(await tmux("capture-pane", "-p", "-t", "migration")).not.toContain("MCP servers");
					}
					await tmux("send-keys", "-t", "migration", "-l", "UI fixture prompt");
					await tmux("send-keys", "-t", "migration", "Enter");
					await Bun.sleep(1000);
					const sendScreen = await tmux("capture-pane", "-p", "-t", "migration");
					const sendDeadline = Date.now() + 15000;
					let sent = "";
					while (Date.now() < sendDeadline) {
						sent = JSON.stringify(
							await client.request("conversation.tail", { sessionId: opened.leader.sessionId }),
						);
						if (
							sent.includes("UI fixture prompt") &&
							sent.split("Native fixture reply").length >= (legacySession ? 4 : 3)
						)
							break;
						await Bun.sleep(100);
					}
					if (!sent.includes("UI fixture prompt")) throw new Error(sendScreen);
					expect(sent).toContain("UI fixture prompt");
					expect(sent.split("Native fixture reply").length).toBeGreaterThanOrEqual(legacySession ? 4 : 3);

					// Drive a real native turn long enough to inspect sidebar activity.
					responseMode = "hang";
					await tmux("send-keys", "-t", "migration", "-l", "UI leader activity fixture");
					await tmux("send-keys", "-t", "migration", "Enter");
					const activityDeadline = Date.now() + 15000;
					let runningScreen = "";
					while (Date.now() < activityDeadline) {
						runningScreen = await tmux("capture-pane", "-p", "-t", "migration");
						if (
							runningScreen.includes(`${opened.leader.name} · RUNNING`) &&
							runningScreen.includes("Waiting for cancellation")
						)
							break;
						await Bun.sleep(100);
					}
					expect(runningScreen).toContain(`${opened.leader.name} · RUNNING`);
					expect(runningScreen).toContain("1 running");
					expect(
						(await client.request<SnapshotResult>("snapshot")).leaders.find(
							(one) => one.workspaceId === opened.workspace.id,
						)?.state,
					).toBe("running");
					const frames = new Set<string>();
					for (let frame = 0; frame < 5; frame++) {
						const captured = await tmux("capture-pane", "-p", "-t", "migration");
						frames.add(
							captured.split("\n").find((line) => line.includes(`${opened.leader.name} · RUNNING`)) ?? "",
						);
						if (process.env.NETA_TUI_CAPTURE_DIR)
							await writeFile(
								join(process.env.NETA_TUI_CAPTURE_DIR, `leader-running-${frame}.ansi`),
								await tmux("capture-pane", "-e", "-p", "-t", "migration"),
							);
						await Bun.sleep(100);
					}
					expect(frames.size).toBeGreaterThan(1);
					// OpenCode intentionally requires two Esc presses to interrupt.
					await tmux("send-keys", "-t", "migration", "Escape");
					await Bun.sleep(100);
					await tmux("send-keys", "-t", "migration", "Escape");
					const idleDeadline = Date.now() + 10000;
					let idleScreen = "";
					while (Date.now() < idleDeadline) {
						idleScreen = await tmux("capture-pane", "-p", "-t", "migration");
						if (idleScreen.includes(`${opened.leader.name} · IDLE`)) break;
						await Bun.sleep(100);
					}
					expect(idleScreen).toContain(`${opened.leader.name} · IDLE`);
					expect(idleScreen).toContain("0 running");
					if (process.env.NETA_TUI_CAPTURE_DIR)
						await writeFile(
							join(process.env.NETA_TUI_CAPTURE_DIR, "leader-idle.ansi"),
							await tmux("capture-pane", "-e", "-p", "-t", "migration"),
						);
					responseMode = "success";

					await tmux("send-keys", "-t", "migration", "-l", "/mach");
					await Bun.sleep(400);
					expect(await tmux("capture-pane", "-p", "-t", "migration")).toContain("/machines");
					await tmux("send-keys", "-t", "migration", "Tab");
					await Bun.sleep(400);
					const machineScreen = await tmux("capture-pane", "-p", "-t", "migration");
					expect(machineScreen).toContain("Machines");
					await tmux("send-keys", "-t", "migration", "Escape");
					await Bun.sleep(200);
					await tmux("send-keys", "-t", "migration", "-l", "/reset");
					await tmux("send-keys", "-t", "migration", "Tab");
					await Bun.sleep(400);
					const resetPicker = await tmux("capture-pane", "-p", "-t", "migration");
					expect(resetPicker).toContain("Reset chat");
					expect(resetPicker).toContain("Reset workspace");
					if (process.env.NETA_TUI_CAPTURE_DIR)
						await writeFile(
							join(process.env.NETA_TUI_CAPTURE_DIR, "reset.ansi"),
							await tmux("capture-pane", "-e", "-p", "-t", "migration"),
						);
					await tmux("send-keys", "-t", "migration", "Escape");
					await Bun.sleep(300);
					await tmux("send-keys", "-t", "migration", "-l", "draft stays here");
					await tmux("send-keys", "-t", "migration", "C-k");
					await Bun.sleep(500);
					const picker = await tmux("capture-pane", "-p", "-t", "migration");
					expect(picker).toContain("Switch workspace");
					if (process.env.NETA_TUI_CAPTURE_DIR)
						await writeFile(
							join(process.env.NETA_TUI_CAPTURE_DIR, "workspaces.ansi"),
							await tmux("capture-pane", "-e", "-p", "-t", "migration"),
						);
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
					expect(await waitScreen("[ second-project ▾")).not.toContain("draft stays here");
					await tmux("send-keys", "-t", "migration", "C-k");
					await Bun.sleep(200);
					await tmux("send-keys", "-t", "migration", "-l", "first-project");
					await tmux("send-keys", "-t", "migration", "Enter");
					await waitScreen("[ first-project ▾");
					const restored = await waitScreen("draft stays here");
					expect(restored).toContain("first-project /");
					expect(restored.match(/· LEADER/g)).toHaveLength(1);
					await writeFile("/tmp/neta-opencode-v2-smoke.txt", restored);
					await tmux(
						"new-window",
						"-d",
						"-t",
						"migration",
						"-n",
						"reopened",
						...(process.env.NETA_OPENCODE_BIN
							? [process.env.NETA_OPENCODE_BIN, "neta"]
							: [process.execPath, "run", "--cwd", join(fork, "packages/cli"), "./src/index.ts", "neta"]),
					);
					let reopened = "";
					const reopenDeadline = Date.now() + 15000;
					while (Date.now() < reopenDeadline) {
						reopened = await tmux("capture-pane", "-p", "-t", "migration:reopened");
						if (reopened.includes("[ first-project ▾")) break;
						await Bun.sleep(200);
					}
					expect(reopened).toContain("[ first-project ▾");
				} finally {
					await tmux("kill-server").catch(() => undefined);
				}
			}
			for (const variant of ["high", "xhigh", undefined]) {
				const selection = await fetch(`${native.url}/api/session/${native.sessionId}/model`, {
					method: "POST",
					headers,
					body: JSON.stringify({ model: { providerID: "test", id: "test-model", variant } }),
				});
				expect(selection.status).toBe(204);
			}
			responseMode = "hang";
			await fetch(`${native.url}/api/session/${native.sessionId}/neta-prompt`, {
				method: "POST",
				headers,
				body: JSON.stringify({ text: "Cancel this turn" }),
			});
			const hangDeadline = Date.now() + 10000;
			while (Date.now() < hangDeadline) {
				if (
					JSON.stringify(
						await client.request("conversation.tail", { sessionId: opened.leader.sessionId }),
					).includes("Waiting for cancellation")
				)
					break;
				await Bun.sleep(100);
			}
			expect(
				(await fetch(`${native.url}/api/session/${native.sessionId}/interrupt`, { method: "POST", headers }))
					.status,
			).toBe(200);
			responseMode = "auth";
			await fetch(`${native.url}/api/session/${native.sessionId}/neta-prompt`, {
				method: "POST",
				headers,
				body: JSON.stringify({ text: "Show provider error" }),
			});
			const errorDeadline = Date.now() + 10000;
			let failure = "";
			while (Date.now() < errorDeadline) {
				failure = JSON.stringify(await client.request("conversation.tail", { sessionId: opened.leader.sessionId }));
				if (failure.includes("Fixture sign-in expired")) break;
				await Bun.sleep(100);
			}
			expect(failure).toContain("Fixture sign-in expired");
			responseMode = "success";
			let count = requests;
			await client.request("conversation.reset", { sessionId: opened.leader.sessionId });
			await client.request("workspace.reset", { workspaceId: opened.workspace.id, confirm: true });
			const snapshot = await client.request<{ leaders: Leader[] }>("snapshot");
			const leaders = snapshot.leaders.filter((leader) => leader.workspaceId === opened.workspace.id);
			expect(leaders).toHaveLength(1);
			const fresh = await client.request<OpenCodeAttachment>("conversation.native", {
				sessionId: leaders[0]?.sessionId,
			});
			expect(fresh.sessionId).not.toBe(native.sessionId);
			const clean = await client.request<{ blocks: unknown[]; turns: unknown[] }>("conversation.tail", {
				sessionId: leaders[0]?.sessionId,
			});
			expect(clean.blocks).toEqual([]);
			expect(clean.turns).toEqual([]);
			const cleanNative = await fetch(`${fresh.url}/api/session/${fresh.sessionId}/message`, {
				headers: { Authorization: fresh.authorization },
			});
			expect(await cleanNative.json()).toMatchObject({ data: [] });
			await client.request("conversation.prompt", {
				sessionId: leaders[0]?.sessionId,
				text: "First prompt after workspace reset",
			});
			const resetDeadline = Date.now() + 20000;
			let resetTranscript = "";
			while (Date.now() < resetDeadline) {
				resetTranscript = JSON.stringify(
					await client.request("conversation.tail", { sessionId: leaders[0]?.sessionId }),
				);
				if (resetTranscript.includes("Native fixture reply")) break;
				await Bun.sleep(100);
			}
			expect(resetTranscript).toContain("Native fixture reply");
			expect(resetTranscript).not.toContain("Neta instruction context is missing");
			expect(requests).toBeGreaterThan(count);
			count = requests;

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
			expect(requests).toBe(count);
			// Reproduce a still-running older Node launching the new native
			// executable after reset: plaintext file and no generation identity.
			const legacyFile = join(dir, "legacy-reset-context.txt");
			const legacyProvider = managedOpenCodeProvider(
				{ command: "opencode", args: ["acp"], resume: true, defaultModel: "test/test-model", env },
				work,
			);
			if (!legacyProvider) throw new Error("Native legacy fixture provider unavailable");
			for (const agreement of ["Legacy workspace agreement", "Fresh legacy reset agreement"]) {
				const requestStart = modelInputs.length;
				await writeFile(legacyFile, agreement);
				const legacy = await spawnProvider({
					provider: legacyProvider,
					access: "readOnly",
					cwd: work,
					env: {
						NETA_SYSTEM_CONTEXT_FILE: legacyFile,
						NETA_NATIVE_LEADER: "1",
						NETA_SYSTEM_CONTEXT_ACTOR_ID: undefined,
						NETA_SYSTEM_CONTEXT_SESSION_ID: undefined,
						NETA_SYSTEM_CONTEXT_GENERATION: undefined,
					},
					handlers: {
						onSessionUpdate() {},
						requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
					},
				});
				try {
					expect(openCodeEndpoint(legacy.initialize._meta)?.contract).toBeUndefined();
					const session = await legacy.connection.agent.request("session/new", { cwd: work, mcpServers: [] });
					const result = await legacy.connection.agent.request("session/prompt", {
						sessionId: session.sessionId,
						prompt: [{ type: "text", text: "First prompt after legacy workspace reset" }],
					});
					expect(result.stopReason).toBe("end_turn");
					expect(
						JSON.stringify(
							modelInputs
								.slice(requestStart)
								.flatMap((body) => body.messages?.filter((message) => message.role === "system") ?? []),
						),
					).toContain(agreement);
					expect(existsSync(`${legacyFile}.applied.json`)).toBe(false);
				} finally {
					await legacy.kill();
				}
			}

			// Exercise the actual OpenCode external-directory permission through
			// Neta's read-only ACP handler, without a real provider or user data.
			await writeFile(evidence, "Downloaded evidence read successfully");
			const evidenceSession = ulid();
			const generation = "read-only-evidence";
			await writeSystemContext({
				sessionId: evidenceSession,
				actorId: evidenceSession,
				bindingGeneration: generation,
				role: "agent",
				text: "Inspect the downloaded evidence read-only.",
			});
			const reader = await startSession({
				settings: {
					providers: { opencode: legacyProvider },
					leader: { provider: "opencode" },
					forbiddenModels: [],
				},
				provider: "opencode",
				access: "readOnly",
				cwd: work,
				sessionId: evidenceSession,
				bindingGeneration: generation,
			});
			try {
				const requestStart = modelInputs.length;
				externalRead = true;
				reader.prompt("Read the downloaded evidence");
				const events: SessionEvent[] = [];
				for await (const event of reader.events()) {
					events.push(event);
					if (event.type === "turnEnd") break;
				}
				expect(externalRead).toBe(false);
				expect(events.at(-1)).toMatchObject({ type: "turnEnd", stopReason: "end_turn", cancelled: false });
				expect(events.some((event) => event.type === "turn" && event.turn.failed)).toBe(false);
				expect(
					modelInputs
						.slice(requestStart)
						.some((body) =>
							body.messages?.some(
								(message) =>
									message.role === "tool" &&
									JSON.stringify(message.content).includes("Downloaded evidence read successfully"),
							),
						),
				).toBe(true);
			} finally {
				externalRead = false;
				await reader.close();
			}

			expect(
				modelInputs.some((body) =>
					body.messages?.some(
						(message) =>
							message.role === "system" &&
							JSON.stringify(message.content).includes("# Leader working agreement"),
					),
				),
			).toBe(true);
			expect(
				modelInputs.every(
					(body) =>
						!body.messages?.some(
							(message) =>
								message.role === "user" &&
								JSON.stringify(message.content).includes("# Leader working agreement"),
						),
				),
			).toBe(true);
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
