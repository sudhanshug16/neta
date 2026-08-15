import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoMux, selectMux } from "../src/mux/index.ts";
import { splitWindowArgs, TmuxAdapter, newSessionArgs as tmuxSessionArgs } from "../src/mux/tmux.ts";
import type { MuxAdapter, ProcessSpec } from "../src/mux/types.ts";
import { leaderLayout, newPaneArgs, newSessionArgs, ZellijAdapter } from "../src/mux/zellij.ts";

const leader: ProcessSpec = { command: "/usr/local/bin/claude", args: ["--append-system-prompt", "be a lead"] };

describe("tmux", () => {
	// Command and arguments stay separate argv entries, so a task containing
	// quotes or spaces cannot turn into extra shell words.
	it("starts a session running the leader without a shell", () => {
		expect(tmuxSessionArgs("neta-1", leader)).toEqual([
			"new-session",
			"-s",
			"neta-1",
			"--",
			"/usr/local/bin/claude",
			"--append-system-prompt",
			"be a lead",
		]);
	});

	it("opens a worker pane without stealing focus from the leader", () => {
		const args = splitWindowArgs("w1 scout", { command: "neta", args: ["watch", "w1"] }, "/repo");

		expect(args).toEqual([
			"split-window",
			"-d",
			"-c",
			"/repo",
			"-e",
			"NETA_PANE=w1 scout",
			"--",
			"neta",
			"watch",
			"w1",
		]);
	});
});

describe("zellij", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("writes a layout whose single pane is the leader", () => {
		const layout = leaderLayout(leader);

		expect(layout).toContain('command="/usr/local/bin/claude"');
		expect(layout).toContain('args "--append-system-prompt" "be a lead"');
	});

	it("escapes quotes rather than breaking the layout", () => {
		const layout = leaderLayout({ command: "/bin/agent", args: ['say "hi"'] });

		expect(layout).toContain('args "say \\"hi\\""');
	});

	it("omits the args line when there are none", () => {
		expect(leaderLayout({ command: "/bin/agent", args: [] })).not.toContain("args");
	});

	it("opens a named pane in the running session", () => {
		expect(newPaneArgs("w1 scout", { command: "neta", args: ["watch", "w1"] }, "/repo")).toEqual([
			"action",
			"new-pane",
			"--name",
			"w1 scout",
			"--cwd",
			"/repo",
			"--",
			"neta",
			"watch",
			"w1",
		]);
	});

	it("writes the layout file into the session directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "neta-mux-"));
		dirs.push(dir);

		const wrapped = new ZellijAdapter().wrapLeader(leader, "neta-1", dir);

		expect(wrapped?.args).toEqual(["--session", "neta-1", "--new-session-with-layout", join(dir, "layout.kdl")]);
		expect(readFileSync(join(dir, "layout.kdl"), "utf-8")).toContain("neta leader");
	});

	// Verified against zellij 0.44.3: with --session, plain --layout means "add
	// this layout as a tab to that session", so zellij looks for a session that
	// does not exist yet and dies with "There is no active session!". This is
	// what broke the first real launch, so it is pinned rather than described.
	it("asks for a new session, not a tab in one that does not exist", () => {
		const args = newSessionArgs("neta-1", "/tmp/layout.kdl");

		expect(args).toEqual(["--session", "neta-1", "--new-session-with-layout", "/tmp/layout.kdl"]);
		expect(args).not.toContain("--layout");
	});
});

describe("selecting a multiplexer", () => {
	function fake(id: "zellij" | "tmux", available: boolean, inSession = false): MuxAdapter {
		return {
			id,
			available: () => available,
			inSession: () => inSession,
			wrapLeader: () => undefined,
			openPane: () => true,
		};
	}

	it("prefers zellij, then tmux", () => {
		expect(selectMux("auto", [fake("zellij", true), fake("tmux", true)]).id).toBe("zellij");
		expect(selectMux("auto", [fake("zellij", false), fake("tmux", true)]).id).toBe("tmux");
	});

	// Someone already sitting in tmux should get tmux panes, whatever else is
	// installed: putting a zellij session inside their tmux would be rude.
	it("stays in the session the user is already in", () => {
		expect(selectMux("auto", [fake("zellij", true), fake("tmux", true, true)]).id).toBe("tmux");
	});

	it("falls back to headless when nothing is installed", () => {
		expect(selectMux("auto", [fake("zellij", false), fake("tmux", false)]).id).toBe("none");
	});

	// Panes are a convenience; missing one must never stop a session starting.
	it("falls back to headless when the chosen multiplexer is missing", () => {
		expect(selectMux("zellij", [fake("zellij", false), fake("tmux", true)]).id).toBe("none");
	});

	it("honours an explicit choice", () => {
		expect(selectMux("tmux", [fake("zellij", true), fake("tmux", true)]).id).toBe("tmux");
		expect(selectMux("none", [fake("zellij", true), fake("tmux", true)]).id).toBe("none");
	});

	it("opens no panes when headless", () => {
		const none = new NoMux();

		expect(none.openPane()).toBe(false);
		expect(none.wrapLeader()).toBeUndefined();
	});

	it("knows whether it is inside a session from the environment", () => {
		expect(new TmuxAdapter().inSession()).toBe(Boolean(process.env.TMUX));
		expect(new ZellijAdapter().inSession()).toBe(Boolean(process.env.ZELLIJ));
	});
});
