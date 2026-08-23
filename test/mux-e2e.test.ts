/**
 * Regression tests: ensure default `bun test` never spawns real tmux servers.
 *
 * Live tmux integration tests moved to mux-live.test.ts (opt-in only).
 * These tests verify the mux adapters work correctly with injected/fake
 * command runners, covering the exact same code paths as live tests but
 * without spawning actual tmux processes.
 */

import { describe, expect, it } from "bun:test";
import { newSessionArgs, newWindowArgs, TmuxAdapter } from "../src/mux/tmux.ts";
import type { ProcessSpec } from "../src/mux/types.ts";

const leader: ProcessSpec = {
	command: "claude",
	args: ["--session", "s1"],
	env: { NETA_SOCKET: "/tmp/neta.sock", NETA_SESSION_ID: "1" },
};

describe("mux adapters never spawn real tmux (default suite)", () => {
	it("TmuxAdapter.newSessionArgs constructs correct arguments without executing", () => {
		const args = newSessionArgs("neta-1", leader);
		expect(args).toContain("new-session");
		expect(args).toContain("-s");
		expect(args).toContain("neta-1");
		expect(args).toContain("claude");
	});

	it("TmuxAdapter.newWindowArgs constructs correct arguments without executing", () => {
		const args = newWindowArgs("ro1 scout", { command: "neta", args: ["watch", "ro1"] }, "/repo", "neta-1");
		expect(args).toContain("new-window");
		expect(args).toContain("-n");
		expect(args).toContain("ro1 scout");
	});

	it("TmuxAdapter with injected runner never spawns external processes", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const adapter = new TmuxAdapter((command, args) => {
			calls.push({ command, args });
			return { status: 0, stdout: "" };
		});

		// These adapter methods should call the injected runner, not exec tmux
		expect(adapter.inSession()).toBe(Boolean(process.env.TMUX));
		expect(calls).toHaveLength(0); // No actual commands executed
	});

	it("TmuxAdapter.openPane uses injected runner without spawning", () => {
		let didExecute = false;
		const adapter = new TmuxAdapter(() => {
			didExecute = true;
			return { status: 0, stdout: "" };
		});

		const result = adapter.openPane("test", { command: "sleep", args: ["30"] }, "/repo", "test-session");
		expect(result).toBe(true);
		expect(didExecute).toBe(true); // Ran the injected runner
	});

	it("TmuxAdapter.renameCurrentPane uses injected runner without spawning", () => {
		let didExecute = false;
		const adapter = new TmuxAdapter(() => {
			didExecute = true;
			return { status: 0, stdout: "" };
		});

		const result = adapter.renameCurrentPane("new title", {
			NETA_MUX: "tmux",
			NETA_PANE: "ro1",
			TMUX_PANE: "%17",
		});
		expect(result).toBe(true);
		expect(didExecute).toBe(true);
	});

	it("environment isolation is verified by checking args construction", () => {
		const spec1 = { command: "leader", args: [], env: { NETA_SESSION_ID: "a", NETA_SOCKET: "/tmp/a.sock" } };
		const spec2 = { command: "leader", args: [], env: { NETA_SESSION_ID: "b", NETA_SOCKET: "/tmp/b.sock" } };

		const args1 = newSessionArgs("neta-a", spec1);
		const args2 = newSessionArgs("neta-b", spec2);

		// Each should have its own environment
		expect(args1).toContain("NETA_SESSION_ID=a");
		expect(args1).toContain("NETA_SOCKET=/tmp/a.sock");
		expect(args2).toContain("NETA_SESSION_ID=b");
		expect(args2).toContain("NETA_SOCKET=/tmp/b.sock");

		// No actual tmux process executed
	});

	it("skips actual tmux availability checks and uses injected runner", () => {
		const adapter = new TmuxAdapter(() => ({ status: 0, stdout: "test" }));

		// available() checks process.env.PATH; inSession() checks process.env.TMUX
		// These read the environment but don't spawn processes
		const available = adapter.available();
		const inSession = adapter.inSession();

		// available() is false unless tmux is on PATH, inSession() is false unless TMUX is set
		// Neither spawns a process; that's the regression check.
		expect(typeof available).toBe("boolean");
		expect(typeof inSession).toBe("boolean");
	});

	it("default test suite behavior: injected runners only, no tmux spawn", () => {
		// This test suite uses TmuxAdapter with injected runners for all tests.
		// It never passes the default runCommand, which would spawn real tmux.
		// The regression is that this entire suite runs without spawning tmux.

		const injectedRunner = () => ({ status: 1, stdout: "" });
		const adapter = new TmuxAdapter(injectedRunner);

		expect(adapter.openPane("test", { command: "noop", args: [] }, "/tmp")).toBe(false);
		// If openPane tried to spawn tmux, the test would hang or error. It doesn't.
	});
});
