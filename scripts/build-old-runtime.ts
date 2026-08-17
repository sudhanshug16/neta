/**
 * Regenerate the pinned old Neta runtime the upgrade test resumes from.
 *
 * The upgrade promise is that a session saved by an older release reopens on the
 * installed one. A test where both halves are today's code cannot check that: the
 * writer and the reader agree with each other by construction. So the old half is
 * a real Neta — the whole CLI, manager, control plane, ACP transport and vendor
 * adapters — built from one pinned commit and checked in as one Node-runnable
 * file. At test time nothing is fetched and no Git history is read: the fixture
 * and its provenance are both in the repository.
 *
 * Run this only to pin a *different* commit, or to reproduce the checked-in one
 * byte for byte. Editing the built fixture by hand would make it evidence of
 * nothing.
 *
 *   bun run scripts/build-old-runtime.ts            # rebuild and verify the hash
 *   bun run scripts/build-old-runtime.ts <commit>   # pin a different commit
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The first commit that made a Neta session resumable — durable checkpoints, the
 * vendor conversation id, the process-death barrier. A checkpoint written before
 * it has nothing for the current build to reopen, so this is the earliest commit
 * an upgrade test can start from.
 */
const PINNED_COMMIT = "60e6a2c9d8f8fd54049d8a9cc31bcfab91349c3d";

const repo = fileURLToPath(new URL("..", import.meta.url));
const fixtures = join(repo, "test", "fixtures");
const bundleName = "neta-old-runtime.mjs";

const commit = process.argv[2] ?? PINNED_COMMIT;
const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();

const resolved = git("rev-parse", commit);
const subject = git("log", "-1", "--format=%s", resolved);
const workspace = mkdtempSync(join(tmpdir(), "neta-old-runtime-"));
try {
	// An archive rather than a worktree: nothing in this repository's Git state is
	// touched, and the checkout is exactly the commit's tree.
	execFileSync("sh", ["-c", `git archive ${resolved} | tar -x -C ${JSON.stringify(workspace)}`], { cwd: repo });

	const pinnedLock = readFileSync(join(workspace, "bun.lock"), "utf-8");
	if (pinnedLock === readFileSync(join(repo, "bun.lock"), "utf-8")) {
		// Same dependency set as this checkout, so reuse what is already installed
		// rather than reaching for the network.
		symlinkSync(join(repo, "node_modules"), join(workspace, "node_modules"));
	} else {
		execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: workspace, stdio: "inherit" });
	}

	execFileSync("bun", ["build", "src/cli.ts", "--target=node", "--outdir", "out"], {
		cwd: workspace,
		stdio: "inherit",
	});
	const bundle = readFileSync(join(workspace, "out", "cli.js"));
	const sha256 = createHash("sha256").update(bundle).digest("hex");
	const appVersion = (JSON.parse(readFileSync(join(workspace, "package.json"), "utf-8")) as { version: string }).version;

	writeFileSync(join(fixtures, bundleName), bundle);
	writeFileSync(
		join(fixtures, "neta-old-runtime.json"),
		`${JSON.stringify(
			{
				bundle: bundleName,
				sha256,
				commit: resolved,
				subject,
				appVersion,
				note:
					`Built from this repository at ${resolved.slice(0, 7)} with \`bun build src/cli.ts --target=node\`. ` +
					`That commit carries version ${appVersion} in package.json, which is the version string it stamps into ` +
					`checkpoints — it is a pre-release build of the resume work, not the released ${appVersion} artifact.`,
				regenerate: "bun run scripts/build-old-runtime.ts",
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
	process.stdout.write(`${bundleName}: ${bundle.length} bytes, sha256 ${sha256}\n(${resolved.slice(0, 7)} ${subject})\n`);
} finally {
	rmSync(workspace, { recursive: true, force: true });
}
