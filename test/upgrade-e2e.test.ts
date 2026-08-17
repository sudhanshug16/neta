/**
 * The upgrade path, with two different executables.
 *
 * The old half is `fixtures/neta-1.1.2-old-bundle.mjs`: a pinned artifact that
 * writes the durable state of a Neta release, by hand, importing nothing from
 * `src/`. The new half is the real published artifact — `bun build --target=node`
 * of the current source, run as the single file users install. Neither half can
 * borrow the other's idea of the format, which is the whole point: a test where
 * both sides are today's code proves only that today's code agrees with itself.
 *
 * What has to hold: the current build lists a session an older release saved,
 * reopens its exact vendor conversation on all three backends, gives it a fresh
 * manager, socket, token, prompt and MCP registration, keeps the recorded
 * results, notes and rooms, and restarts no worker.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SessionCheckpoint } from "../src/checkpoint.ts";
import { CHECKPOINT_SCHEMA_VERSION } from "../src/checkpoint.ts";
import { VERSION } from "../src/config.ts";
import type { SessionRecord } from "../src/session.ts";
import { waitFor } from "./helpers.ts";

const OLD_BUNDLE = fileURLToPath(new URL("./fixtures/neta-1.1.2-old-bundle.mjs", import.meta.url));
const FAKE_LEADER = fileURLToPath(new URL("./fixtures/fake-leader.mjs", import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const SOURCE_ENTRY = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const run = promisify(execFile);

/** The runtime users have: Node, not Bun. Falls back where a test host has none. */
const nodePath = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf-8" }).stdout.trim() || process.execPath;

const dirs: string[] = [];

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Build the artifact that ships: one Node-runnable file, no dependency tree. */
function buildCurrentBundle(): string {
	const outDir = scratch("neta-bundle-b-");
	const built = spawnSync("bun", ["build", SOURCE_ENTRY, "--target=node", "--outdir", outDir], {
		encoding: "utf-8",
		cwd: fileURLToPath(new URL("..", import.meta.url)),
	});
	if (built.status !== 0) throw new Error(built.stderr || "could not build the current bundle");
	const bundle = join(outDir, "cli.js");
	if (!existsSync(bundle)) throw new Error(`build produced no ${bundle}`);
	return bundle;
}

function vendorShims(): string {
	const dir = scratch("neta-old-bin-");
	for (const name of ["claude", "codex", "opencode"]) {
		writeFileSync(join(dir, name), `#!/bin/sh\nexec ${process.execPath} ${FAKE_LEADER} "$@"\n`, "utf-8");
		chmodSync(join(dir, name), 0o755);
	}
	return dir;
}

interface LaunchRecord {
	argv: string[];
	files: Record<string, string>;
	env: Record<string, string | null>;
}

function readCheckpointFile(agentDir: string, id: string): SessionCheckpoint {
	return JSON.parse(readFileSync(join(agentDir, "checkpoints", `${id}.json`), "utf8")) as SessionCheckpoint;
}

function liveSession(agentDir: string): SessionRecord {
	const dir = join(agentDir, "sessions");
	const records = readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as SessionRecord)
		.filter((record) => {
			try {
				process.kill(record.pid, 0);
				return true;
			} catch {
				return false;
			}
		});
	if (records.length !== 1) throw new Error(`expected one live session, found ${records.length}`);
	return records[0];
}

describe("a session saved by an older Neta, reopened by the current build", () => {
	it("lists and resumes Claude, Codex and OpenCode sessions without running the old bundle again", async () => {
		// The old half must be evidence, not a mirror of the new half.
		const oldSource = readFileSync(OLD_BUNDLE, "utf-8");
		expect(oldSource).not.toContain("../src/");
		expect(oldSource.match(/^import .*/gm)?.every((line) => line.includes('"node:'))).toBe(true);

		const bundle = buildCurrentBundle();
		expect(bundle).not.toBe(SOURCE_ENTRY);
		const agentDir = scratch("neta-upgrade-home-");
		const repo = scratch("neta-upgrade-repo-");
		const runLog = join(scratch("neta-upgrade-log-"), "old-runs.log");
		const promptMarker = join(scratch("neta-upgrade-marker-"), "prompted");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mux: { panes: false },
				tiers: { expert: { backend: "fake" }, architect: { backend: "fake" } },
				backends: { fake: { command: process.execPath, args: [FAKE_AGENT, "--prompt-marker", promptMarker] } },
			}),
		);

		// A: the old release writes its durable state and exits.
		const wrote = await run(nodePath, [OLD_BUNDLE, "write-state", "--dir", agentDir, "--cwd", repo], {
			env: { ...process.env, OLD_NETA_RUNLOG: runLog },
		});
		const ids = wrote.stdout.trim().split("\n");
		expect(ids).toEqual(["old-claude-session", "old-codex-session", "old-opencode-session"]);
		expect(readCheckpointFile(agentDir, ids[0]).schemaVersion as number).toBe(1);
		expect(readCheckpointFile(agentDir, ids[0]).appVersion).toBe("1.1.2");
		const afterWrite = readFileSync(runLog, "utf-8");

		const binDir = vendorShims();
		const env = {
			...process.env,
			PATH: `${binDir}${delimiter}${process.env.PATH}`,
			NETA_DIR: agentDir,
			NETA_SOCKET: "",
			NETA_LEADER_TOKEN: "",
			NETA_WORKER_ID: "",
			NETA_WORKER_TOKEN: "",
			OLD_NETA_RUNLOG: runLog,
			FAKE_LEADER_HOST_MCP: "1",
		} as Record<string, string>;

		// B: the current bundle lists what the old release left behind.
		const listed = await run(nodePath, [bundle, "sessions", "--all"], { env });
		for (const id of ids) {
			expect(listed.stdout).toContain(`${id}\tclosed`);
		}
		expect(listed.stdout.match(/conversation-id:yes/g)).toHaveLength(3);

		const expected = {
			"old-claude-session": {
				conversation: "11111111-1111-4111-8111-111111111111",
				leading: ["--resume", "11111111-1111-4111-8111-111111111111"],
			},
			"old-codex-session": {
				conversation: "22222222-2222-4222-8222-222222222222",
				leading: ["resume", "22222222-2222-4222-8222-222222222222"],
			},
			"old-opencode-session": {
				conversation: "ses_oldopencodesession000001",
				leading: ["--session", "ses_oldopencodesession000001"],
			},
		} as const;

		for (const id of ids) {
			const record = join(scratch("neta-upgrade-record-"), `${id}.json`);
			const quitFile = join(scratch("neta-upgrade-quit-"), "quit");
			const child = spawn(nodePath, [bundle, "resume", id, "--mux", "none"], {
				cwd: repo,
				env: {
					...env,
					FAKE_LEADER_RECORD: record,
					FAKE_LEADER_QUIT_FILE: quitFile,
					CODEX_HOME: join(agentDir, "real-codex"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stdout.on("data", () => {});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const closed = new Promise<number>((resolve) =>
				child.on("close", (code, signal) => resolve(signal ? 1 : (code ?? 0))),
			);

			try {
				await waitFor(() => void liveSession(agentDir), 30000);
				const session = liveSession(agentDir);
				const launch = JSON.parse(readFileSync(record, "utf8")) as LaunchRecord;

				// The exact conversation, chosen by the backend's own selector.
				expect(launch.argv.slice(0, 2)).toEqual([...expected[id as keyof typeof expected].leading]);
				expect(launch.env.NETA_RESUME).toBe("1");
				expect(launch.env.NETA_CHECKPOINT_ID).toBe(id);
				// Everything runtime is this run's, not the saved one's.
				expect(session.id).not.toBe("old-codex-manager");
				expect(session.token).not.toBe("old-manager-token");
				expect(session.socket).not.toContain("old-codex-manager");
				// Today's instructions and today's MCP registration, rebuilt.
				const configured = Object.values(launch.files).join("\n") + (launch.env.OPENCODE_CONFIG_CONTENT ?? "");
				expect(`${launch.argv.join(" ")}\n${configured}`).toContain("neta");
				expect(`${launch.argv.join(" ")}\n${configured}`).toContain(session.socket);

				const prompt = launch.argv.includes("--append-system-prompt")
					? launch.argv[launch.argv.indexOf("--append-system-prompt") + 1]
					: Object.values(launch.files).join("\n");
				expect(prompt).toContain("## Recovered session");
				expect(prompt).toContain("1.1.2");
				expect(prompt).toContain(VERSION);
				expect(prompt).toContain("No worker was restarted");
				expect(prompt).toContain("Old report");

				// The recovered state is readable through the live control plane.
				const status = await run(nodePath, [bundle, "status", "--session", session.id], { env });
				expect(status.stdout).toContain("ro1");
				expect(status.stdout).toContain("decide on the rollout window");
				const workers = await run(nodePath, [bundle, "workers", "--session", session.id], { env });
				expect(workers.stdout).toContain("Old report: mapped the auth flow");
				// Terminal states carry over exactly; nothing is re-labelled on the way in.
				expect(workers.stdout).toContain("done — map the auth flow");
			} finally {
				writeFileSync(quitFile, "quit");
				const code = await closed;
				expect({ id, code, stderr }).toMatchObject({ code: 0 });
			}

			const after = readCheckpointFile(agentDir, id);
			expect(after.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
			expect(after.appVersion).toBe(VERSION);
			expect(after.leader.vendorConversationId).toBe(expected[id as keyof typeof expected].conversation);
			expect(after.workers.map((worker) => worker.finalResult).join("\n")).toContain("Old report");
			expect(after.notes[0]).toMatchObject({ id: "n1", open: true });
			expect(after.rooms[0].posts[0].text).toBe("the race is in the refresh");
		}

		// No worker was ever restarted: the fake backend writes this file the
		// moment anything prompts it.
		expect(existsSync(promptMarker)).toBe(false);
		// And the current build never re-executed the old one.
		expect(readFileSync(runLog, "utf-8")).toBe(afterWrite);
		expect(afterWrite.trim().split("\n")).toHaveLength(1);
	}, 180000);
});
