/**
 * Real tmux uses one server process and captures that server's environment at
 * its first session. Run against a private server so this never touches a
 * developer's existing tmux session. Every command is bounded, and cleanup
 * records the exact random socket and server pid. A SIGKILL of this parent can
 * still preempt macOS exit handlers; the bounded residual is that one owned
 * server. The next harness load retries only its dead-owner ledger entries,
 * never a broad sweep or a user's tmux/Zellij/Neta session.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newSessionArgs, newWindowArgs } from "../src/mux/tmux.ts";
import type { ProcessSpec } from "../src/mux/types.ts";
import { waitFor } from "./helpers.ts";
import { reapOrphanedTmuxTestRuns, runBoundedCommand, TmuxTestRun, uniqueTmuxSocket } from "./tmux-harness.ts";

const FAKE_LEADER = fileURLToPath(new URL("./fixtures/fake-leader.mjs", import.meta.url));
const dirs: string[] = [];
const runs: TmuxTestRun[] = [];
await reapOrphanedTmuxTestRuns();
const tmuxAvailable = (await runBoundedCommand("tmux", ["-V"])).status === 0;
const tmuxIt = tmuxAvailable ? it : it.skip;

function ownedRun(): TmuxTestRun {
	const run = new TmuxTestRun();
	runs.push(run);
	return run;
}

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function leader(record: string, env: Record<string, string>): ProcessSpec {
	return {
		command: process.execPath,
		args: [FAKE_LEADER],
		env: { ...process.env, ...env, FAKE_LEADER_RECORD: record, FAKE_LEADER_HOLD_MS: "1000" },
	};
}

async function start(run: TmuxTestRun, tmuxSocket: string, name: string, spec: ProcessSpec): Promise<void> {
	const args = newSessionArgs(name, spec);
	args.splice(1, 0, "-d");
	const result = await run.invoke(["-L", tmuxSocket, ...args]);
	if (result.status !== 0 || result.timedOut) throw new Error(result.stderr || `tmux exited ${result.status}`);
	await run.recordServer(tmuxSocket);
}

function readEnv(record: string): Record<string, string | null> {
	return (JSON.parse(readFileSync(record, "utf-8")) as { env: Record<string, string | null> }).env;
}

afterEach(async () => {
	await Promise.all(runs.splice(0).map((run) => run.cleanup()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tmux leader environment isolation", () => {
	tmuxIt("opens a worker window in the explicit session on a custom tmux server", async () => {
		const run = ownedRun();
		const socket = run.ownSocket(uniqueTmuxSocket("neta-pane"));
		const name = `neta-pane-${process.pid}`;
		try {
			const started = await run.invoke(["-L", socket, "new-session", "-d", "-s", name, "sleep", "30"]);
			if (started.status !== 0 || started.timedOut)
				throw new Error(started.stderr || "Could not start tmux test session.");
			const locator = (await run.recordServer(socket)).locator;
			const opened = await run.invoke(
				newWindowArgs("worker", { command: "sleep", args: ["30"] }, process.cwd(), name),
				{
					env: { ...process.env, TMUX: locator },
				},
			);

			expect(opened.status).toBe(0);
			expect((await run.invoke(["-L", socket, "list-windows", "-t", name, "-F", "#W"])).stdout).toContain("worker");
		} finally {
			await run.cleanup();
		}
	});

	tmuxIt(
		"gives two different NETA_DIR launches and two shared-dir launches their own socket and id",
		async () => {
			const run = ownedRun();
			const socket = run.ownSocket(uniqueTmuxSocket("neta-test"));
			const records = scratch("neta-tmux-records-");
			const firstDir = scratch("neta-tmux-home-a-");
			const secondDir = scratch("neta-tmux-home-b-");
			const sharedDir = scratch("neta-tmux-home-shared-");
			const specs = [
				["a", firstDir, "/tmp/neta-a.sock", "a-id"],
				["b", secondDir, "/tmp/neta-b.sock", "b-id"],
				["c", sharedDir, "/tmp/neta-c.sock", "c-id"],
				["d", sharedDir, "/tmp/neta-d.sock", "d-id"],
			] as const;

			try {
				for (const [name, agentDir, channel, sessionId] of specs) {
					await start(
						run,
						socket,
						`neta-${name}`,
						leader(join(records, `${name}.json`), {
							NETA_DIR: agentDir,
							NETA_SOCKET: channel,
							NETA_SESSION_ID: sessionId,
							NETA_LEADER_TOKEN: `token-${name}`,
						}),
					);
				}
				await waitFor(() => specs.every(([name]) => existsSync(join(records, `${name}.json`))), 5000);

				for (const [name, agentDir, channel, sessionId] of specs) {
					const env = readEnv(join(records, `${name}.json`));
					expect(env.NETA_DIR).toBe(agentDir);
					expect(env.NETA_SOCKET).toBe(channel);
					expect(env.NETA_SESSION_ID).toBe(sessionId);
				}
			} finally {
				await run.cleanup();
			}
		},
		15000,
	);

	it.skip("skips live Zellij matrix: its layout environment is covered by unit tests; no shared-server repro is available.", () => {});
});
