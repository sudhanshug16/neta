// Test rig for workstream 08 (built in T8.2, reused through T8.8): a temp
// `NETA_DIR` whose `settings.json` has one provider running the fake ACP
// agent, plus a `run`/`spawn` front for the built CLI bundle.
//
// `startNode` prepares the directory and the bundle but starts no Node
// itself: tests start one through the bundle (`node start --detach`, T8.3).
// `stop` kills anything still running and removes the directory.
import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

function fixturePath(): string {
	return new URL("../fixtures/fake-acp-agent.mjs", import.meta.url).pathname;
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
		// `readVersion()` walks up from the bundle to the first
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

function settingsJson(): string {
	return JSON.stringify(
		{
			providers: {
				fake: {
					command: "node",
					args: [fixturePath()],
					resume: true,
					defaultModel: "test-model",
				},
			},
			leader: { provider: "fake", model: "test-model" },
			forbiddenModels: [],
		},
		null,
		"\t",
	);
}

export async function startNode(): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "neta-cli-"));
	await writeFile(join(dir, "settings.json"), settingsJson());
	const bundle = await buildBundleOnce();
	const children = new Set<ChildProcess>();

	function run(args: string[]): Promise<CliRunResult> {
		return new Promise<CliRunResult>((resolve, reject) => {
			const child = spawn("node", [bundle, ...args], {
				env: { ...process.env, NETA_DIR: dir },
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
			env: { ...process.env, NETA_DIR: dir },
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
		await rm(dir, { recursive: true, force: true });
	}

	return { dir, run, spawn: spawnCli, stop };
}
