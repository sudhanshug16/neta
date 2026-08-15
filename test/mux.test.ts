import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoMux, selectMux } from "../src/mux/index.ts";
import { newWindowArgs, TmuxAdapter, newSessionArgs as tmuxSessionArgs } from "../src/mux/tmux.ts";
import type { MuxAdapter, ProcessSpec } from "../src/mux/types.ts";
import { leaderLayout, newSessionArgs, newTabArgs, ZellijAdapter } from "../src/mux/zellij.ts";

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

	// A window, not a split. Splitting the leader's window shrinks the thing the
	// user is typing into, and five workers made it unreadable.
	it("puts a worker in its own window, leaving the leader focused", () => {
		const args = newWindowArgs("w1 scout", { command: "neta", args: ["watch", "w1"] }, "/repo");

		expect(args).toEqual([
			"new-window",
			"-d",
			"-n",
			"w1 scout",
			"-c",
			"/repo",
			"-e",
			"NETA_PANE=w1 scout",
			"--",
			"neta",
			"watch",
			"w1",
		]);
		expect(args).not.toContain("split-window");
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

	// A custom layout replaces zellij's own UI. Without these the user gets
	// worker tabs with no tab bar to see them and no status bar telling them how
	// to quit — which is how someone ends up trapped in a multiplexer.
	it("keeps zellij's tab bar and status bar", () => {
		const layout = leaderLayout(leader);

		expect(layout).toContain('plugin location="zellij:tab-bar"');
		expect(layout).toContain('plugin location="zellij:status-bar"');
		expect(layout).toContain("default_tab_template");
	});

	// Checked against a running session with `zellij action dump-layout`: a pane
	// declared at the top level becomes a tab that skips the template, so the
	// leader's own tab had no tab bar while every worker tab had one — you could
	// only see the tabs existed once you had already left the leader.
	it("puts the leader inside a tab, so the template reaches it", () => {
		const layout = leaderLayout(leader);

		expect(layout).toContain('tab name="leader"');
		const tabStart = layout.indexOf('tab name="leader"');
		expect(layout.indexOf('name="neta leader"')).toBeGreaterThan(tabStart);
	});

	// Quitting the leader should end the session, not leave a dead pane behind.
	it("closes the leader's pane when the leader exits", () => {
		expect(leaderLayout(leader)).toContain("close_on_exit=true");
	});

	// Otherwise `zellij list-sessions` fills up with "EXITED - attach to
	// resurrect" entries the user has to delete by hand.
	it("does not leave the finished session lying around to be resurrected", () => {
		expect(newSessionArgs("neta-1", "/tmp/layout.kdl")).toEqual([
			"--session",
			"neta-1",
			"--new-session-with-layout",
			"/tmp/layout.kdl",
			"options",
			"--session-serialization",
			"false",
		]);
	});

	it("escapes quotes rather than breaking the layout", () => {
		const layout = leaderLayout({ command: "/bin/agent", args: ['say "hi"'] });

		expect(layout).toContain('args "say \\"hi\\""');
	});

	it("omits the args line when there are none", () => {
		expect(leaderLayout({ command: "/bin/agent", args: [] })).not.toContain("args");
	});

	// A tab of its own, and one that disposes of itself: --close-on-exit is what
	// lets a finished worker's tab disappear when the watcher exits.
	it("opens a worker in its own tab, set to close when it ends", () => {
		expect(newTabArgs("w1 scout", { command: "neta", args: ["watch", "w1"] }, "/repo")).toEqual([
			"action",
			"new-tab",
			"--name",
			"w1 scout",
			"--cwd",
			"/repo",
			"--close-on-exit",
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

		expect(wrapped?.args.slice(0, 4)).toEqual([
			"--session",
			"neta-1",
			"--new-session-with-layout",
			join(dir, "layout.kdl"),
		]);
		expect(readFileSync(join(dir, "layout.kdl"), "utf-8")).toContain("neta leader");
	});

	// Verified against zellij 0.44.3: with --session, plain --layout means "add
	// this layout as a tab to that session", so zellij looks for a session that
	// does not exist yet and dies with "There is no active session!". This is
	// what broke the first real launch, so it is pinned rather than described.
	it("asks for a new session, not a tab in one that does not exist", () => {
		const args = newSessionArgs("neta-1", "/tmp/layout.kdl");

		expect(args.slice(0, 4)).toEqual(["--session", "neta-1", "--new-session-with-layout", "/tmp/layout.kdl"]);
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
