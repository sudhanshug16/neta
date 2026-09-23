// A temp Neta directory, a pinned OpenCode V2 process, and a local fake
// OpenAI-compatible model for the built CLI bundle.
//
// `startNode` prepares the directory and the bundle but starts no Node
// itself: tests start one through the bundle (`node start --detach`, T8.3).
// `stop` kills anything still running and removes the directory.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { managedOpenCodeDir } from "../../scripts/opencode-pin.ts";

export const nativeHarnessReady = process.env.NETA_OPENCODE_BIN
	? existsSync(process.env.NETA_OPENCODE_BIN)
	: existsSync(join(managedOpenCodeDir(), "node_modules"));

export interface CliRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface Harness {
	dir: string;
	run(args: string[]): Promise<CliRunResult>;
	spawn(args: string[], opts?: { cwd?: string }): ChildProcess;
	stop(): Promise<void>;
}

function repoRoot(): string {
	return dirname(new URL("../../package.json", import.meta.url).pathname);
}

// The CLI bundle, built once per test file and reused by every harness in
// it. `run` executes it with `node`.
let bundleFile: string | undefined;
let bundleBuilding: Promise<string> | undefined;

async function buildBundleOnce(): Promise<string> {
	if (bundleFile !== undefined) {
		return bundleFile;
	}
	bundleBuilding ??= (async (): Promise<string> => {
		if (typeof Bun === "undefined" || typeof Bun.build !== "function") {
			throw new Error("the CLI harness builds the bundle with Bun.build, so it runs under bun test");
		}
		const entry = join(repoRoot(), "src", "cli", "main.ts");
		const outdir = await mkdtemp(join(tmpdir(), "neta-cli-bundle-"));
		const result = await Bun.build({ entrypoints: [entry], target: "node", outdir });
		if (!result.success) {
			throw new Error(`bun build src/cli/main.ts failed:\n${result.logs.join("\n")}`);
		}
		const built = join(outdir, "main.js");
		await chmod(built, 0o755);
		// `netaVersion()` walks up from the bundle to the first
		// `@intervene/neta` package.json; a tmpdir build has none above
		// it, so the repo's own rides along, the way the installed
		// package carries one above `dist/main.js`.
		await writeFile(join(outdir, "package.json"), await readFile(join(repoRoot(), "package.json"), "utf8"));
		return built;
	})();
	try {
		bundleFile = await bundleBuilding;
		return bundleFile;
	} catch (error) {
		bundleBuilding = undefined;
		throw error;
	}
}

function settingsJson(dir: string, modelUrl: string): string {
	return JSON.stringify(
		{
			providers: {
				opencode: {
					command: "opencode",
					args: ["serve"],
					resume: true,
					defaultModel: "test/test-model",
					env: {
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
									options: { apiKey: "fixture", baseURL: modelUrl },
									models: {
										"test-model": {
											name: "Fixture model",
											limit: { context: 100000, output: 10000 },
											cost: { input: 0, output: 0 },
										},
										"legacy-other": {
											name: "Other fixture model",
											limit: { context: 100000, output: 10000 },
											cost: { input: 0, output: 0 },
										},
									},
								},
							},
						}),
					},
				},
			},
			leader: { provider: "opencode", model: "test/test-model" },
			forbiddenModels: [],
		},
		null,
		"\t",
	);
}

export async function startNode(): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "neta-cli-"));
	const native = process.env.NETA_OPENCODE_BIN ?? join(dir, "opencode");
	if (!process.env.NETA_OPENCODE_BIN) {
		const fork = managedOpenCodeDir();
		await writeFile(
			native,
			`#!/bin/sh\nexec '${process.execPath}' run --cwd '${join(fork, "packages/cli")}' ./src/index.ts "$@"\n`,
		);
		await chmod(native, 0o700);
		await writeFile(join(dir, "neta-fork.json"), '{"integrationVersion":2}\n');
	}
	const model = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const body = (await request.json()) as { messages?: Array<{ role?: string; content?: unknown }> };
			const content = body.messages?.filter((message) => message.role === "user").at(-1)?.content;
			const userText =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.flatMap((part) =>
									part && typeof part === "object" && "text" in part && typeof part.text === "string"
										? [part.text]
										: [],
								)
								.join("\n")
						: "";
			if (userText.includes("HOLD_FOREVER")) {
				return new Response(new ReadableStream({ start() {} }), {
					headers: { "content-type": "text/event-stream" },
				});
			}
			const reply = userText.includes("STREAM")
				? "First paragraph continues.\n\nSecond paragraph."
				: `echo:${userText}`;
			const chunks = [
				{ choices: [{ index: 0, delta: { role: "assistant", content: reply } }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
			return new Response(
				`${chunks
					.map(
						(chunk) =>
							`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`,
					)
					.join("")}data: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	await writeFile(join(dir, "settings.json"), settingsJson(dir, model.url.href));
	const bundle = await buildBundleOnce();
	const children = new Set<ChildProcess>();
	const environment = { ...process.env, NETA_DIR: dir, NETA_OPENCODE_BIN: native };

	function run(args: string[]): Promise<CliRunResult> {
		return new Promise<CliRunResult>((resolve, reject) => {
			const child = spawn("node", [bundle, ...args], {
				env: environment,
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.add(child);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.on("error", (error) => {
				children.delete(child);
				reject(error);
			});
			child.on("close", (code) => {
				children.delete(child);
				resolve({ code: code ?? 1, stdout, stderr });
			});
		});
	}

	function spawnCli(args: string[], opts?: { cwd?: string }): ChildProcess {
		const child = spawn("node", [bundle, ...args], {
			env: environment,
			cwd: opts?.cwd,
			// stdin stays a pipe so chat tests (T8.4) can drive the prompt
			// loop and signal the process.
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.add(child);
		child.on("exit", () => {
			children.delete(child);
		});
		return child;
	}

	async function stop(): Promise<void> {
		for (const child of [...children]) {
			if (child.exitCode === null && !child.killed) {
				child.kill("SIGTERM");
			}
		}
		children.clear();
		// A detached node started through the bundle (T8.3) outlives `run`,
		// so stop it by the pid in `node.json`, best effort.
		try {
			const raw = await readFile(join(dir, "node.json"), "utf8");
			const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
			if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// Already gone.
				}
			}
		} catch {
			// No descriptor: nothing to stop.
		}
		await model.stop(true);
		await rm(dir, { recursive: true, force: true });
	}

	return { dir, run, spawn: spawnCli, stop };
}
