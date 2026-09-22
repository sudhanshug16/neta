import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderSettings } from "../acp/settings.ts";

export function openCodeInvocation(): { command: string; args: string[]; apiVersion?: 2 } {
	if (process.env.NETA_OPENCODE_BIN) {
		const command = process.env.NETA_OPENCODE_BIN;
		const marker = join(dirname(command), "neta-fork.json");
		const v2 = existsSync(marker) && JSON.parse(readFileSync(marker, "utf8")).integrationVersion === 2;
		return { command, args: [], ...(v2 ? { apiVersion: 2 as const } : {}) };
	}
	const here = dirname(fileURLToPath(import.meta.url));
	const root = here.endsWith("/dist") ? dirname(here) : resolve(here, "../..");
	const fork = process.env.NETA_OPENCODE_DIR ?? resolve(root, "../neta-opencode-v2");
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
			"Neta OpenCode is not installed. Run bun run setup:opencode, or set NETA_OPENCODE_DIR to the fork checkout.",
		);
	return {
		command: process.env.NETA_BUN ?? "bun",
		...(v2 ? { apiVersion: 2 as const } : {}),
		args: ["run", "--cwd", join(fork, v2 ? "packages/cli" : "packages/opencode"), "./src/index.ts"],
	};
}

export function managedOpenCodeProvider(provider: ProviderSettings, cwd = process.cwd()): ProviderSettings | undefined {
	if (provider.command !== "opencode" || provider.args.join(" ") !== "acp") return undefined;
	let invocation: ReturnType<typeof openCodeInvocation>;
	try {
		invocation = openCodeInvocation();
	} catch {
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
