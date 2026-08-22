import { describe, expect, it } from "bun:test";
import { type ProcessControl, runBoundedCommand, TmuxTestRun, terminateOwnedProcess } from "./tmux-harness.ts";

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

		expect(await terminateOwnedProcess(123, { control, termGraceMs: 5, killGraceMs: 5, pollMs: 1 })).toBe(true);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
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
		const terminated: number[] = [];
		const run = new TmuxTestRun(
			async (args) => {
				calls.push(args);
				return args.includes("display-message")
					? { status: 0, stdout: "/private/tmp/neta-owned,456,0\n", stderr: "", timedOut: false }
					: { status: 0, stdout: "", stderr: "", timedOut: false };
			},
			async (pid) => {
				terminated.push(pid);
				return true;
			},
		);

		run.ownSocket("neta-owned-only");
		await run.recordServer("neta-owned-only");
		await Promise.all([run.cleanup(), run.cleanup()]);

		expect(calls).toEqual([
			["-L", "neta-owned-only", "display-message", "-p", "#{socket_path},#{pid},#{window_index}"],
			["-L", "neta-owned-only", "kill-server"],
		]);
		expect(terminated).toEqual([456]);
	});
});
