import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { connectNode } from "../src/node/client.ts";

const fork = process.env.NETA_OPENCODE_DIR ?? resolve(import.meta.dir, "../../neta-opencode-v2");
const available =
	Boolean(Bun.which("tmux")) &&
	Boolean(
		process.env.NETA_TEST_EXECUTABLE ||
			(process.env.NETA_OPENCODE_BIN && existsSync(process.env.NETA_OPENCODE_BIN)) ||
			existsSync(join(fork, "node_modules")),
	);
if (process.env.NETA_REQUIRED_CONFORMANCE === "1" && !available)
	throw new Error("Required cold-start conformance needs tmux and the pinned native runtime");

test.skipIf(!available)(
	"tui cold-starts a real detached Node without manual service commands",
	async () => {
		const dir = await mkdtemp("/tmp/neta-cold-");
		const nodeDir = join(dir, "node");
		const work = join(dir, "project");
		const socket = `neta-cold-${process.pid}`;
		const llm = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(
					`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Packaged fixture reply" } }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
		const old = process.env.NETA_DIR;
		process.env.NETA_DIR = nodeDir;
		const env = {
			...process.env,
			NETA_DIR: nodeDir,
			PATH: process.env.NETA_TEST_PATH ?? `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
			NETA_OPENCODE_DIR: process.env.NETA_OPENCODE_DIR ?? resolve(import.meta.dir, "../../neta-opencode-v2"),
			XDG_DATA_HOME: join(dir, "data"),
			XDG_CONFIG_HOME: join(dir, "config"),
			XDG_CACHE_HOME: join(dir, "cache"),
			XDG_STATE_HOME: join(dir, "state"),
			OPENCODE_TEST_HOME: join(dir, "home"),
			OPENCODE_TEST_MANAGED_CONFIG_DIR: join(dir, "managed"),
			OPENCODE_DISABLE_MODELS_FETCH: "true",
			OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
			OPENCODE_DISABLE_AUTOUPDATE: "true",
			TERM: "xterm-256color",
			SHELL: "/bin/bash",
			OPENCODE_CONFIG_CONTENT: JSON.stringify({
				model: "test/model",
				enabled_providers: ["test"],
				formatter: false,
				lsp: false,
				provider: {
					test: {
						name: "Fixture",
						npm: "@ai-sdk/openai-compatible",
						env: [],
						options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${llm.port}/v1` },
						models: { model: { name: "Fixture", limit: { context: 100000, output: 10000 } } },
					},
				},
			}),
		};
		const tmux = async (...args: string[]) => {
			const proc = Bun.spawn(["tmux", "-L", socket, ...args], { env, stdout: "pipe", stderr: "pipe" });
			const output = await new Response(proc.stdout).text();
			if (await proc.exited) throw new Error(await new Response(proc.stderr).text());
			return output;
		};
		try {
			await mkdir(nodeDir);
			await mkdir(work);
			await writeFile(
				join(nodeDir, "settings.json"),
				JSON.stringify({
					providers: {
						opencode: { command: "opencode", args: ["acp"], resume: true, defaultModel: "test/model", env },
					},
					leader: { provider: "opencode", model: "test/model" },
					forbiddenModels: [],
				}),
			);
			await writeFile(join(dir, "tmux.conf"), "set -g default-shell /bin/bash\nset -g remain-on-exit on\n");
			await tmux(
				"-f",
				join(dir, "tmux.conf"),
				"new-session",
				"-d",
				"-s",
				"cold",
				"-x",
				"140",
				"-y",
				"44",
				"-c",
				work,
				...(process.env.NETA_TEST_EXECUTABLE
					? [process.env.NETA_TEST_EXECUTABLE]
					: [process.execPath, resolve(import.meta.dir, "../src/cli/main.ts"), "tui", work]),
			);
			let screen = "";
			const deadline = Date.now() + 45000;
			while (Date.now() < deadline) {
				screen = await tmux("capture-pane", "-p", "-t", "cold");
				if (screen.includes("Workspace leader")) break;
				if ((await tmux("display-message", "-p", "-t", "cold", "#{pane_dead}")).trim() === "1")
					throw new Error(`Cold-start command exited before opening the workspace:\n${screen}`);
				await Bun.sleep(200);
			}
			expect(screen).toContain("Workspace leader");
			expect(screen).not.toContain("UnknownError");
			const client = await connectNode();
			try {
				const { leader } = await client.request<{ leader: { sessionId: string } }>("workspace.open", {
					path: work,
				});
				await client.request("conversation.prompt", {
					sessionId: leader.sessionId,
					text: "Reply to the packaged fixture",
				});
				let transcript = "";
				const replyDeadline = Date.now() + 20000;
				while (Date.now() < replyDeadline) {
					transcript = JSON.stringify(await client.request("conversation.tail", { sessionId: leader.sessionId }));
					if (transcript.includes("Packaged fixture reply")) break;
					await Bun.sleep(100);
				}
				expect(transcript).toContain("Packaged fixture reply");
				const elsewhere = join(dir, "elsewhere");
				await mkdir(elsewhere);
				await tmux(
					"new-window",
					"-d",
					"-t",
					"cold",
					"-n",
					"reopened",
					"-c",
					elsewhere,
					...(process.env.NETA_TEST_EXECUTABLE
						? [process.env.NETA_TEST_EXECUTABLE]
						: [process.execPath, resolve(import.meta.dir, "../src/cli/main.ts"), "tui"]),
				);
				let reopened = "";
				const reopenDeadline = Date.now() + 15000;
				while (Date.now() < reopenDeadline) {
					reopened = await tmux("capture-pane", "-p", "-t", "cold:reopened");
					if (reopened.includes("Workspace leader") && reopened.includes("Packaged fixture reply")) break;
					if ((await tmux("display-message", "-p", "-t", "cold:reopened", "#{pane_dead}")).trim() === "1")
						throw new Error(`Reopen command exited before restoring the workspace:\n${reopened}`);
					await Bun.sleep(100);
				}
				expect(reopened).toContain("[ project ▾  ^K ]");
				expect(reopened).toContain("Packaged fixture reply");
				expect(
					(await client.request<{ nativeOpenCodeRevision: number }>("runtime.capabilities"))
						.nativeOpenCodeRevision,
				).toBeGreaterThanOrEqual(9);
			} finally {
				client.close();
			}
		} finally {
			await tmux("kill-server").catch(() => {});
			const client = await connectNode().catch(() => undefined);
			if (client) {
				await client.request("node.stop").catch(() => {});
				client.close();
				await Bun.sleep(1000);
			}
			if (old === undefined) delete process.env.NETA_DIR;
			else process.env.NETA_DIR = old;
			llm.stop(true);
			await rm(dir, { recursive: true, force: true });
		}
	},
	90000,
);
