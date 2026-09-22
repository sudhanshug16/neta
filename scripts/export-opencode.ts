import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { git, overlayPath, pinPath, repositoryRoot, sha256, sourcePathAllowed, type OpenCodePin } from "./opencode-pin.ts";

// Explicit review/export step. Never reads ignored files or user configuration.
const fork = process.env.NETA_OPENCODE_DIR ?? resolve(repositoryRoot, "../neta-opencode-v2");
const commit = (await git(fork, ["rev-parse", "HEAD"])).trim();
const tracked = (await git(fork, ["diff", "HEAD", "--name-only"])).trim().split("\n").filter(Boolean);
const added = (await git(fork, ["ls-files", "--others", "--exclude-standard"])).trim().split("\n").filter(Boolean);
const paths = [...new Set([...tracked, ...added])].sort();
for (const path of paths) {
	if (!sourcePathAllowed(path)) throw new Error(`Refusing non-source overlay path: ${path}`);
	const stat = await lstat(resolve(fork, path)).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (stat && !stat.isFile()) throw new Error(`Refusing non-regular source overlay path: ${path}`);
}
let overlay = await git(fork, ["diff", "HEAD", "--binary", "--no-ext-diff"]);
for (const path of added.sort()) overlay += await git(fork, ["diff", "--no-index", "--binary", "--no-ext-diff", "--", "/dev/null", path], true);
const files: Record<string, string | null> = {};
for (const path of paths) files[path] = await readFile(resolve(fork, path)).then(sha256).catch((error: NodeJS.ErrnoException) => {
	if (error.code === "ENOENT") return null;
	throw error;
});
const metadata = JSON.parse(await readFile(resolve(fork, "neta-fork.json"), "utf8")) as { integrationVersion: number };
const pkg = JSON.parse(await readFile(resolve(fork, "package.json"), "utf8")) as { packageManager: string };
const pin: OpenCodePin = { format: 1, repository: "https://github.com/anomalyco/opencode.git", commit,
	bun: pkg.packageManager.replace(/^bun@/, ""), integrationVersion: metadata.integrationVersion,
	overlaySha256: sha256(overlay), lockSha256: sha256(await readFile(resolve(fork, "bun.lock"))), files };
await mkdir(dirname(pinPath), { recursive: true });
await writeFile(overlayPath, overlay);
await writeFile(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
console.log(`Exported ${paths.length} reviewed source paths at ${commit}; overlay ${pin.overlaySha256}`);
