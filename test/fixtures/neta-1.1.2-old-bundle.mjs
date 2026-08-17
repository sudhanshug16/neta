#!/usr/bin/env node
/**
 * A pinned stand-in for a Neta release the current source cannot influence.
 *
 * Neta's upgrade promise is that a session saved by an older release reopens on
 * the installed one. A test that writes the old state with today's code cannot
 * check that promise: today's writer and today's reader agree with each other by
 * construction. So this file is the other half of the pair — a frozen artifact
 * that writes the durable state exactly as Neta 1.1.2 wrote it (checkpoint
 * schema 1, which predates the shutdown proof, `substantiveResponse`, and the
 * later-failure record), by hand, with no import of anything in `src/`.
 *
 * Pinned deliberately at 1.1.2, the last release before restart-safe resume, and
 * never to be edited. If the checkpoint schema changes again, add the next
 * pinned artifact beside this one rather than updating this one: an old bundle
 * that keeps up with the source stops being evidence.
 *
 * Usage: node neta-1.1.2-old-bundle.mjs write-state --dir <neta-dir> --cwd <repo>
 *
 * Every invocation appends to $OLD_NETA_RUNLOG, so a test can prove the current
 * build never re-executed this one.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.OLD_NETA_RUNLOG) {
	appendFileSync(process.env.OLD_NETA_RUNLOG, `${argv.join(" ")}\n`, "utf-8");
}

function flag(name) {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

const agentDir = flag("--dir");
const cwd = flag("--cwd");
if (argv[0] !== "write-state" || !agentDir || !cwd) {
	process.stderr.write("usage: neta-1.1.2-old-bundle.mjs write-state --dir <neta-dir> --cwd <repo>\n");
	process.exit(2);
}

const SAVED_AT = 1_700_000_000_000;

/** A worker as 1.1.2 recorded one: no substantiveResponse, no laterFailure. */
function worker(overrides) {
	return {
		id: "ro1",
		name: "auth scout",
		role: "scout",
		tier: "expert",
		backend: "fake",
		writer: false,
		task: "map the auth flow",
		state: "done",
		startedAt: SAVED_AT,
		updatedAt: SAVED_AT + 1000,
		endedAt: SAVED_AT + 1000,
		finalResult: "Old report: mapped the auth flow and found the race.",
		log: [
			{ at: SAVED_AT, kind: "progress", text: "reading auth.ts" },
			{ at: SAVED_AT + 500, kind: "status", text: "done" },
		],
		logFirstIndex: 0,
		logCursor: 0,
		pendingBrief: [],
		...overrides,
	};
}

function checkpoint(id, backend, vendorConversationId, workers, extra = {}) {
	return {
		schemaVersion: 1,
		appVersion: "1.1.2",
		id,
		canonicalCwd: cwd,
		leader: { backend, vendorConversationId },
		createdAt: SAVED_AT,
		updatedAt: SAVED_AT + 2000,
		counter: workers.length,
		noteCounter: 1,
		workers,
		writerQueue: [],
		writerQueueHistory: [],
		notes: [
			{
				id: "n1",
				text: "decide on the rollout window",
				open: true,
				createdAt: SAVED_AT,
				workers: workers.map((entry) => ({ workerId: entry.id, state: entry.state })),
			},
		],
		rooms: [
			{
				name: "review",
				posts: [
					{ at: SAVED_AT, from: "ro1", label: "auth scout scout/expert", text: "the race is in the refresh" },
				],
			},
		],
		spreadCursors: [{ tier: "expert", cursor: 1 }],
		roomDebaterBackends: [],
		...extra,
	};
}

const sessions = {
	claude: {
		id: "old-claude-session",
		conversation: "11111111-1111-4111-8111-111111111111",
		workers: [
			worker({}),
			worker({
				id: "rw2",
				name: "config",
				role: "worker",
				writer: true,
				state: "killed",
				finalResult: "Old report: stopped by the leader.",
			}),
		],
	},
	codex: {
		id: "old-codex-session",
		conversation: "22222222-2222-4222-8222-222222222222",
		workers: [worker({ vendorSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })],
	},
	opencode: {
		id: "old-opencode-session",
		conversation: "ses_oldopencodesession000001",
		workers: [worker({ vendorSessionId: "ses_oldopencodeworker000001" })],
	},
};

mkdirSync(join(agentDir, "checkpoints"), { recursive: true, mode: 0o700 });
for (const [backend, session] of Object.entries(sessions)) {
	writeFileSync(
		join(agentDir, "checkpoints", `${session.id}.json`),
		`${JSON.stringify(checkpoint(session.id, backend, session.conversation, session.workers), null, 2)}\n`,
		{ encoding: "utf-8", mode: 0o600 },
	);
	// 1.1.2 kept the vendor's own capture beside the checkpoint, in the session
	// directory the vendor recorded absolute paths into.
	const leaderSession = join(agentDir, "leader-sessions", session.id);
	mkdirSync(leaderSession, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(leaderSession, "vendor-session.json"),
		`${JSON.stringify({ vendorConversationId: session.conversation, at: SAVED_AT })}\n`,
		{ encoding: "utf-8", mode: 0o600 },
	);
}

// The Codex session did not close cleanly: its manager left a registry record
// behind, naming a pid that is long gone and a worker group that is with it.
mkdirSync(join(agentDir, "sessions"), { recursive: true, mode: 0o700 });
writeFileSync(
	join(agentDir, "sessions", "old-codex-manager.json"),
	`${JSON.stringify(
		{
			id: "old-codex-manager",
			socket: join(agentDir, "old-codex-manager.sock"),
			token: "old-manager-token",
			cwd,
			leader: "codex",
			checkpointId: "old-codex-session",
			pid: 2147483646,
			processStartedAt: "Thu Jan  1 00:00:00 1970",
			startedAt: SAVED_AT,
			workerGroups: [{ pgid: 2147483645, leaderStartedAt: "Thu Jan  1 00:00:00 1970" }],
		},
		null,
		2,
	)}\n`,
	{ encoding: "utf-8", mode: 0o600 },
);

process.stdout.write(
	`${Object.values(sessions)
		.map((session) => session.id)
		.join("\n")}\n`,
);
