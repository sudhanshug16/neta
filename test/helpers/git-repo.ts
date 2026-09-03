// Test rig for workstream 06 (built in T6.1, reused through T6.7): a real
// temp git repo and the fake-wt environment.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(root: string, args: string[]): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		execFile("git", ["-C", root, ...args], (error, stdout, stderr) => {
			if (error === null) {
				resolve();
				return;
			}
			reject(new Error(`git ${args.join(" ")} failed: ${stderr || error.message} ${stdout}`.trim()));
		});
	});
}

// A temp dir with `git init -b main`, local `user.name`/`user.email` and one
// commit. Caller owns `cleanup`.
export async function makeRepo(): Promise<{ root: string; cleanup(): Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "neta-git-"));
	await git(root, ["init", "-b", "main"]);
	await git(root, ["config", "user.name", "neta-test"]);
	await git(root, ["config", "user.email", "neta-test@example.com"]);
	await writeFile(join(root, "README.md"), "# test repo\n");
	await git(root, ["add", "README.md"]);
	await git(root, ["commit", "-m", "initial"]);
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// Points NETA_WT_BIN at the fake-wt shim so no test needs real `wt`.
export function fakeWtEnv(): { NETA_WT_BIN: string } {
	return { NETA_WT_BIN: new URL("../fixtures/fake-wt.mjs", import.meta.url).pathname };
}
