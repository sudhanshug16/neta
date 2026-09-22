import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderSettings } from "../acp/settings.ts";

function managedOpenCodeDir(root: string): string {
	return resolve(root, "vendor/opencode/runtime");
}

interface OpenCodePin {
	format: 1;
	repository: string;
	commit: string;
	integrationVersion: number;
	lockSha256: string;
	files: Record<string, string | null>;
}

interface OpenCodeRuntimeOptions {
	environment?: NodeJS.ProcessEnv;
	root?: string;
}

function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sourcePathAllowed(path: string): boolean {
	return (
		/^(bun\.lock|package\.json|neta-fork\.json|NETA\.md)$/.test(path) ||
		path === "packages/codemode/interpreter-support.md" ||
		(/^packages\/[\w-]+\/(?:package\.json|tsconfig\.json|(?:src|test)\/[\w./-]+\.(?:ts|tsx|js|mjs|json|md))$/.test(
			path,
		) &&
			!path.split("/").some((part) => part === ".." || part === "node_modules" || part === "dist"))
	);
}

function readPin(path: string): OpenCodePin {
	const pin = JSON.parse(readFileSync(path, "utf8")) as OpenCodePin;
	if (
		pin.format !== 1 ||
		pin.repository !== "https://github.com/anomalyco/opencode.git" ||
		!/^[a-f0-9]{40}$/.test(pin.commit) ||
		!Object.keys(pin.files).every(sourcePathAllowed)
	)
		throw new Error("Invalid OpenCode integration pin");
	return pin;
}

function git(fork: string, args: string[]): string {
	return execFileSync("git", args, { cwd: fork, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function validateOpenCodeSource(fork: string, pinPath: string): void {
	const pin = readPin(pinPath);
	if (git(fork, ["rev-parse", "HEAD"]).trim() !== pin.commit)
		throw new Error("base commit differs from the reviewed integration pin");
	for (const [path, expected] of Object.entries(pin.files)) {
		const source = join(fork, path);
		if (!existsSync(source)) {
			if (expected === null) continue;
			throw new Error(`reviewed source is missing: ${path}`);
		}
		if (!lstatSync(source).isFile()) throw new Error(`reviewed source is not a regular file: ${path}`);
		if (sha256(readFileSync(source)) !== expected) throw new Error(`reviewed source differs: ${path}`);
	}
	if (sha256(readFileSync(join(fork, "bun.lock"))) !== pin.lockSha256) throw new Error("reviewed lockfile differs");
	const changed = git(fork, ["diff", "HEAD", "--name-only"]).trim().split("\n").filter(Boolean);
	const added = git(fork, ["ls-files", "--others", "--exclude-standard"]).trim().split("\n").filter(Boolean);
	for (const path of [...changed, ...added]) {
		if (!(path in pin.files)) throw new Error(`unreviewed source file: ${path}`);
	}
}

class OpenCodeSourceDriftError extends Error {}

function sourceDriftError(fork: string, error: unknown): OpenCodeSourceDriftError {
	const detail = error instanceof Error ? error.message : "unknown validation failure";
	return new OpenCodeSourceDriftError(
		`Neta OpenCode source at ${fork} does not match the reviewed integration (${detail}). ` +
			"It was not launched. Preserve that checkout and use a fresh path instead: " +
			"NETA_OPENCODE_DIR=/path/to/clean-neta-opencode-v2 bun run setup:opencode.",
	);
}

export function openCodeInvocation(options: OpenCodeRuntimeOptions = {}): {
	command: string;
	args: string[];
	apiVersion?: 2;
} {
	const environment = options.environment ?? process.env;
	if (environment.NETA_OPENCODE_BIN) {
		const command = environment.NETA_OPENCODE_BIN;
		const marker = join(dirname(command), "neta-fork.json");
		const v2 = existsSync(marker) && JSON.parse(readFileSync(marker, "utf8")).integrationVersion === 2;
		return { command, args: [], ...(v2 ? { apiVersion: 2 as const } : {}) };
	}
	const here = dirname(fileURLToPath(import.meta.url));
	const root = options.root ?? (here.endsWith("/dist") ? dirname(here) : resolve(here, "../.."));
	const fork = environment.NETA_OPENCODE_DIR ?? managedOpenCodeDir(root);
	const v2 = existsSync(join(fork, "packages/cli/src/acp/service.ts")) && !existsSync(join(fork, "packages/opencode"));
	const binary = join(
		root,
		"dist",
		"opencode",
		`${process.platform}-${process.arch}`,
		process.platform === "win32" ? "opencode.exe" : "opencode",
	);
	if (!existsSync(join(fork, "neta-fork.json")) && existsSync(binary)) {
		const marker = join(dirname(binary), "neta-fork.json");
		if (!existsSync(marker) || JSON.parse(readFileSync(marker, "utf8")).integrationVersion !== 2)
			throw new Error("The staged OpenCode runtime is outdated. Run bun run build:opencode.");
		return { command: binary, args: [], apiVersion: 2 };
	}
	if (!existsSync(join(fork, "neta-fork.json")))
		throw new Error(
			"Neta OpenCode is not installed. Run bun run setup:opencode. NETA_OPENCODE_DIR is an explicit advanced checkout override.",
		);
	try {
		validateOpenCodeSource(fork, join(root, "vendor", "opencode", "integration.json"));
	} catch (error) {
		throw sourceDriftError(fork, error);
	}
	return {
		command: environment.NETA_BUN ?? "bun",
		...(v2 ? { apiVersion: 2 as const } : {}),
		args: ["run", "--cwd", join(fork, v2 ? "packages/cli" : "packages/opencode"), "./src/index.ts"],
	};
}

export function managedOpenCodeProvider(provider: ProviderSettings, cwd = process.cwd()): ProviderSettings | undefined {
	if (provider.command !== "opencode" || provider.args.join(" ") !== "acp") return undefined;
	let invocation: ReturnType<typeof openCodeInvocation>;
	try {
		invocation = openCodeInvocation();
	} catch (error) {
		if (error instanceof OpenCodeSourceDriftError) throw error;
		return undefined;
	}
	return {
		...provider,
		command: invocation.command,
		args: [...invocation.args, "acp", ...(invocation.apiVersion === 2 ? [] : ["--cwd", cwd])],
		processGroup: true,
		env: {
			...provider.env,
			NETA_MANAGED_OPENCODE: "1",
			OPENCODE_DISABLE_AUTOUPDATE: "true",
			NETA_RUNTIME_CWD: cwd,
			OPENCODE_SERVER_PASSWORD: randomBytes(32).toString("hex"),
		},
	};
}
