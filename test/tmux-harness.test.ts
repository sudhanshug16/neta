import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type OwnershipRecord,
	type ProcessControl,
	type ProcessIdentity,
	reapOrphanedTmuxTestRuns,
	runBoundedCommand,
	TmuxTestRun,
	terminateOwnedProcess,
	writeOwnershipRecordAtomic,
} from "./tmux-harness.ts";

function identity(pid: number, startedAt = "started"): ProcessIdentity {
	return { pid, startedAt };
}

function commandResult(stdout = "", status = 0, stderr = "") {
	return { status, stdout, stderr, timedOut: false };
}

describe("tmux test harness process ownership", () => {
	it("escalates an owned process group from TERM to KILL after the grace period", async () => {
		const signals: NodeJS.Signals[] = [];
		let alive = true;
		const control: ProcessControl = {
			signal(_pid, signal) {
				signals.push(signal);
				if (signal === "SIGKILL") alive = false;
			},
			alive: () => alive,
		};

		expect(
			await terminateOwnedProcess(identity(123), {
				control,
				identify: () => "started",
				termGraceMs: 5,
				killGraceMs: 5,
				pollMs: 1,
			}),
		).toBe(true);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("does not signal a reused PID and never falls back from group ESRCH", async () => {
		const signals: NodeJS.Signals[] = [];
		const control: ProcessControl = {
			signal(_pid, signal) {
				signals.push(signal);
				throw Object.assign(new Error("gone"), { code: "ESRCH" });
			},
			alive: () => true,
		};

		expect(await terminateOwnedProcess(identity(321, "old"), { control, identify: () => "replacement" })).toBe(false);
		expect(signals).toEqual([]);

		await expect(
			terminateOwnedProcess(identity(321), {
				control,
				identify: () => "started",
				termGraceMs: 1,
				killGraceMs: 1,
				pollMs: 1,
			}),
		).rejects.toThrow("gone");
		expect(signals).toEqual(["SIGTERM"]);
	});

	it("bounds a hanging invocation and kills its detached process group", async () => {
		const result = await runBoundedCommand(
			process.execPath,
			["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
			{ timeoutMs: 25, termGraceMs: 10, killGraceMs: 500, pollMs: 5 },
		);

		expect(result.timedOut).toBe(true);
		expect(result.status).toBe(124);
	});

	it("cleans the exact owned socket and server once when cleanup is repeated", async () => {
		const calls: string[][] = [];
		const run = new TmuxTestRun(
			async (args) => {
				calls.push(args);
				if (args.includes("display-message"))
					return args.some((arg) => arg.includes("#{window_index}"))
						? commandResult("/private/tmp/neta-owned-only,456,0\n")
						: commandResult("/private/tmp/neta-owned-only\t456\n");
				return commandResult();
			},
			async () => true,
			{
				ownerIdentity: identity(111, "owner"),
				identify: (pid) => (pid === 456 || pid === 111 ? (pid === 456 ? "server" : "owner") : undefined),
				pidAlive: (pid) => pid === 456,
			},
		);

		run.ownSocket("neta-owned-only");
		await run.recordServer("neta-owned-only");
		const record = JSON.parse(readFileSync(run.recordPath, "utf8")) as OwnershipRecord;
		expect(record.sockets).toEqual([{ socket: "neta-owned-only", server: identity(456, "server") }]);
		await Promise.all([run.cleanup(), run.cleanup()]);

		expect(calls).toEqual([
			["-L", "neta-owned-only", "display-message", "-p", "#{socket_path},#{pid},#{window_index}"],
			["-L", "neta-owned-only", "display-message", "-p", "#{socket_path}\t#{pid}"],
			["-L", "neta-owned-only", "kill-server"],
		]);
		expect(existsSync(run.recordPath)).toBe(false);
	});

	it("does not kill a replacement server that reused the exact socket name", async () => {
		const directory = mkdtempSync(join(tmpdir(), "neta-mux-ledger-reuse-"));
		const path = join(directory, "neta-mux-run-reuse.json");
		writeOwnershipRecordAtomic(path, {
			owner: identity(2147483646, "dead-owner"),
			sockets: [{ socket: "neta-reused", server: identity(456, "old-server") }],
		});
		const calls: string[][] = [];

		await reapOrphanedTmuxTestRuns({
			ownershipDirectory: directory,
			command: async (args) => {
				calls.push(args);
				return args.includes("display-message")
					? commandResult("/private/tmp/neta-reused\t456\n")
					: commandResult();
			},
			identify: (pid) => (pid === 456 ? "replacement-server" : undefined),
			pidAlive: (pid) => pid === 456,
		});

		expect(calls).toEqual([["-L", "neta-reused", "display-message", "-p", "#{socket_path}\t#{pid}"]]);
		expect(existsSync(path)).toBe(false);
	});

	it("removes every per-run signal listener on repeated idempotent cleanup", async () => {
		const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
		const before = signals.map((signal) => process.listenerCount(signal));
		for (let index = 0; index < 3; index += 1) {
			const run = new TmuxTestRun(
				async () => commandResult(),
				async () => true,
				{ ownerIdentity: identity(100 + index, `owner-${index}`), identify: () => `owner-${index}` },
			);
			await Promise.all([run.cleanup(), run.cleanup()]);
		}
		expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before);
	});

	it("preserves the last complete ledger and ignores interrupted or malformed records", async () => {
		const directory = mkdtempSync(join(tmpdir(), "neta-mux-ledger-atomic-"));
		const validPath = join(directory, "neta-mux-run-valid.json");
		const valid: OwnershipRecord = { owner: identity(777, "live"), sockets: [] };
		writeOwnershipRecordAtomic(validPath, valid);
		writeFileSync(`${validPath}.interrupted.tmp`, '{"owner":');
		const malformedPath = join(directory, "neta-mux-run-malformed.json");
		writeFileSync(malformedPath, '{"owner":');
		const calls: string[][] = [];

		await reapOrphanedTmuxTestRuns({
			ownershipDirectory: directory,
			command: async (args) => {
				calls.push(args);
				return commandResult();
			},
			identify: () => "live",
			pidAlive: () => true,
		});

		expect(JSON.parse(readFileSync(validPath, "utf8"))).toEqual(valid);
		expect(readFileSync(`${validPath}.interrupted.tmp`, "utf8")).toBe('{"owner":');
		expect(existsSync(malformedPath)).toBe(true);
		expect(calls).toEqual([]);
	});
});
