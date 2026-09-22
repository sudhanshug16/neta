import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const repositoryRoot = resolve(import.meta.dir, "..");
export const pinPath = resolve(repositoryRoot, "vendor/opencode/integration.json");
export const overlayPath = resolve(repositoryRoot, "vendor/opencode/overlay.patch");

/** The repository owns this generated checkout; a sibling fork is never implicit. */
export function managedOpenCodeDir(root = repositoryRoot): string {
	return resolve(root, "vendor/opencode/runtime");
}

export interface OpenCodePin {
	format: 1;
	repository: string;
	commit: string;
	bun: string;
	integrationVersion: number;
	overlaySha256: string;
	lockSha256: string;
	files: Record<string, string | null>;
}

export function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function sourcePathAllowed(path: string): boolean {
	return /^(bun\.lock|package\.json|neta-fork\.json|NETA\.md)$/.test(path)
		|| path === "packages/codemode/interpreter-support.md"
		|| /^packages\/[\w-]+\/(?:package\.json|tsconfig\.json|(?:src|test)\/[\w./-]+\.(?:ts|tsx|js|mjs|json|md))$/.test(path)
		&& !path.split("/").some((part) => part === ".." || part === "node_modules" || part === "dist");
}

export async function git(cwd: string, args: string[], allowDiff = false): Promise<string> {
	const result = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, status] = await Promise.all([
		new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited,
	]);
	if (status !== 0 && !(allowDiff && status === 1)) throw new Error(`git ${args[0]} failed: ${stderr}`);
	return stdout;
}

export async function readPin(): Promise<OpenCodePin> {
	const pin: OpenCodePin = JSON.parse(await readFile(pinPath, "utf8"));
	if (pin.format !== 1 || !/^[a-f0-9]{40}$/.test(pin.commit)
		|| pin.repository !== "https://github.com/anomalyco/opencode.git"
		|| !Object.keys(pin.files).every(sourcePathAllowed)) throw new Error("Invalid OpenCode integration pin");
	if (sha256(await readFile(overlayPath)) !== pin.overlaySha256) throw new Error("OpenCode overlay hash mismatch");
	return pin;
}

export async function verifyCheckout(fork: string, pin: OpenCodePin): Promise<void> {
	if ((await git(fork, ["rev-parse", "HEAD"])).trim() !== pin.commit) throw new Error("OpenCode base commit differs from integration pin");
	for (const [path, expected] of Object.entries(pin.files)) {
		if (!sourcePathAllowed(path)) throw new Error(`Unsafe OpenCode source path: ${path}`);
		const stat = await lstat(resolve(fork, path)).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (stat && !stat.isFile()) throw new Error(`OpenCode source must be a regular file: ${path}`);
		const actual = await readFile(resolve(fork, path)).then(sha256).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (actual !== expected) throw new Error(`OpenCode pinned source differs: ${path}. Export the reviewed integration before release.`);
	}
	if (sha256(await readFile(resolve(fork, "bun.lock"))) !== pin.lockSha256) throw new Error("OpenCode lockfile hash mismatch");
	const changed = (await git(fork, ["diff", "HEAD", "--name-only"])).trim().split("\n").filter(Boolean);
	const added = (await git(fork, ["ls-files", "--others", "--exclude-standard"])).trim().split("\n").filter(Boolean);
	for (const path of [...changed, ...added]) {
		if (!(path in pin.files)) throw new Error(`Unpinned OpenCode file: ${path}`);
	}
}
