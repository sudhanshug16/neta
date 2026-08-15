/**
 * A `neta` command for processes Neta launches.
 *
 * Workers report back by running the `neta` CLI from their shell tool, but a
 * worker process has no reason to have our binary on its PATH — especially when
 * Neta runs from a source checkout, where no `neta` executable exists at all.
 * So we write a one-line shim that re-invokes whatever is running us, and
 * prepend its directory to the child's PATH.
 */

import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { APP_NAME } from "./config.ts";

export interface CliInvocation {
	command: string;
	prefixArgs: string[];
}

/**
 * How to re-invoke ourselves: prefer the script we are running, fall back to
 * the installed binary.
 */
export function resolveSelfInvocation(): CliInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, prefixArgs: [currentScript] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, prefixArgs: [] };
	return { command: APP_NAME, prefixArgs: [] };
}

/** Single-quote for /bin/sh, where the only escape is ending the quoted run. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Create a directory containing an executable `neta`, and return the directory.
 *
 * The invocation defaults to however this process was started. Callers that are
 * not running as the CLI (tests) pass it explicitly, because `process.argv[1]`
 * then points at their own entry point rather than ours.
 */
export async function createLeaderCliShim(invocation: CliInvocation = resolveSelfInvocation()): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `${APP_NAME}-cli-`));

	if (process.platform === "win32") {
		const parts = [invocation.command, ...invocation.prefixArgs].map((part) => `"${part}"`).join(" ");
		await writeFile(join(dir, `${APP_NAME}.cmd`), `@echo off\r\n${parts} %*\r\n`, { encoding: "utf-8" });
		return dir;
	}

	const parts = [invocation.command, ...invocation.prefixArgs].map(shellQuote).join(" ");
	await writeFile(join(dir, APP_NAME), `#!/bin/sh\nexec ${parts} "$@"\n`, { encoding: "utf-8", mode: 0o755 });
	return dir;
}

/** Put the shim directory first, so `neta` resolves to it. */
export function prependToPath(dir: string, path: string | undefined): string {
	return path ? `${dir}${delimiter}${path}` : dir;
}
