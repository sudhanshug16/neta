import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const moduleDirectory = dirname(modulePath);
const packaged = moduleDirectory.endsWith("/dist");
const packageRoot = packaged ? dirname(moduleDirectory) : join(moduleDirectory, "..", "..");

function file(path: string, label: string): string {
	if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
	return path;
}

function executable(path: string, label: string): string {
	file(path, label);
	try {
		accessSync(path, constants.X_OK);
	} catch {
		throw new Error(`${label} is not executable: ${path}`);
	}
	return path;
}

function packagedRuntime(): { client: string; daemon: string; extension: string } {
	const target = `${process.platform}-${process.arch}`;
	const root = join(moduleDirectory, "tui", target);
	return {
		client: executable(join(root, "neta-rmux"), `unsupported or missing packaged TUI runtime for ${target}`),
		daemon: executable(join(root, "rmux"), `unsupported or missing packaged TUI runtime for ${target}`),
		extension: file(join(root, "pi-acp-extension.mjs"), `unsupported or missing packaged TUI runtime for ${target}`),
	};
}

function piCli(): string {
	const main = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	return file(join(dirname(main), "bundle", "cli.js"), "installed Pi runtime");
}

async function spawnShell(): Promise<ChildProcess> {
	const configured = process.env.NETA_RMUX_BINARY;
	const runtime = packaged ? packagedRuntime() : undefined;
	const environment = {
		...process.env,
		NETA_WORKSPACE_ROOT: process.cwd(),
		NETA_NODE_EXECUTABLE: process.execPath,
		NETA_NODE_SCRIPT: packaged ? modulePath : join(packageRoot, "src", "cli", "main.ts"),
		NETA_PI_EXECUTABLE: process.env.NETA_PI_EXECUTABLE ?? process.execPath,
		NETA_PI_CLI: process.env.NETA_PI_CLI ?? piCli(),
		NETA_PI_ACP_EXTENSION: process.env.NETA_PI_ACP_EXTENSION ?? runtime?.extension ?? join(packageRoot, "src", "rmux", "pi-acp-extension.ts"),
		RMUX_SDK_DAEMON_BINARY:
			process.env.RMUX_SDK_DAEMON_BINARY ?? runtime?.daemon ?? join(packageRoot, ".cache", "rmux", "libexec", "rmux", "rmux"),
	};
	const options: SpawnOptions = { stdio: "inherit", env: environment };
	if (configured !== undefined && configured !== "") {
		return spawn(configured, [], options);
	}
	if (runtime !== undefined) return spawn(runtime.client, [], options);
	const manifest = join(packageRoot, "apps", "rmux", "Cargo.toml");
	return spawn("cargo", ["run", "--quiet", "--manifest-path", manifest], {
		...options,
	});
}

export async function rmuxCommand(): Promise<number> {
	let child: ChildProcess;
	try {
		child = await spawnShell();
	} catch (error) {
		process.stderr.write(`neta: cannot launch rmux UI: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	return new Promise<number>((resolve) => {
		child.once("error", (error) => {
			process.stderr.write(`neta: cannot launch rmux UI: ${error.message}\n`);
			resolve(1);
		});
		child.once("exit", (code, signal) => resolve(signal === null ? (code ?? 1) : 1));
	});
}
