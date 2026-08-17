import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoMux, selectMux } from "../src/mux/index.ts";
import { createPaneHost, tabTitle } from "../src/mux/panes.ts";
import {
	newWindowArgs,
	TmuxAdapter,
	attachSessionArgs as tmuxAttachSessionArgs,
	killSessionArgs as tmuxKillSessionArgs,
	newSessionArgs as tmuxSessionArgs,
} from "../src/mux/tmux.ts";
import type { MuxAdapter, ProcessSpec } from "../src/mux/types.ts";
import {
	leaderLayout,
	newSessionArgs,
	newTabArgs,
	ZellijAdapter,
	attachSessionArgs as zellijAttachSessionArgs,
	killSessionArgs as zellijKillSessionArgs,
} from "../src/mux/zellij.ts";

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

	it("sets each leader's session environment explicitly", () => {
		expect(
			tmuxSessionArgs("neta-2", {
				command: "leader",
				args: [],
				env: { NETA_SOCKET: "/tmp/neta-2.sock", NETA_SESSION_ID: "2" },
			}),
		).toEqual([
			"new-session",
			"-s",
			"neta-2",
			"-e",
			"NETA_SESSION_ID=2",
			"-e",
			"NETA_SOCKET=/tmp/neta-2.sock",
			"--",
			"leader",
		]);
	});

	it("reattaches a recorded tmux session with its exact name", () => {
		expect(tmuxAttachSessionArgs("neta-2")).toEqual(["attach", "-t", "neta-2"]);
	});

	it("kills an orphaned tmux session with its exact name", () => {
		expect(tmuxKillSessionArgs("neta-2")).toEqual(["kill-session", "-t", "neta-2"]);
	});

	// A window, not a split. Splitting the leader's window shrinks the thing the
	// user is typing into, and five workers made it unreadable.
	it("puts a worker in its own window, leaving the leader focused", () => {
		const args = newWindowArgs("ro1 scout", { command: "neta", args: ["watch", "ro1"] }, "/repo", "neta-1");

		expect(args).toEqual([
			"new-window",
			"-t",
			"neta-1",
			"-d",
			"-n",
			"ro1 scout",
			"-c",
			"/repo",
			"-e",
			"NETA_PANE=ro1 scout",
			"--",
			"neta",
			"watch",
			"ro1",
		]);
		expect(args).not.toContain("split-window");
	});
});

describe("zellij", () => {
	const dirs: string[] = [];
	const savedZellij = process.env.ZELLIJ;
	beforeEach(() => {
		delete process.env.ZELLIJ;
	});
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		if (savedZellij !== undefined) {
			process.env.ZELLIJ = savedZellij;
		} else {
			delete process.env.ZELLIJ;
		}
	});

	it("writes a layout whose single pane is the leader", () => {
		const layout = leaderLayout(leader);

		expect(layout).toContain('command="/usr/local/bin/claude"');
		expect(layout).toContain('args "--append-system-prompt" "be a lead"');
	});

	it("passes a leader's environment through the layout command", () => {
		const layout = leaderLayout({ command: "leader", args: [], env: { NETA_SESSION_ID: "2" } });

		expect(layout).toContain('command="/usr/bin/env"');
		expect(layout).toContain('args "NETA_SESSION_ID=2" "leader"');
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
		expect(newTabArgs("ro1 scout", { command: "neta", args: ["watch", "ro1"] }, "/repo", "neta-1")).toEqual([
			"--session",
			"neta-1",
			"action",
			"new-tab",
			"--name",
			"ro1 scout",
			"--cwd",
			"/repo",
			"--close-on-exit",
			"--",
			"neta",
			"watch",
			"ro1",
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

	it("reattaches a recorded Zellij session with its exact name", () => {
		expect(zellijAttachSessionArgs("neta-1")).toEqual(["attach", "neta-1"]);
	});

	it("kills an orphaned Zellij session with its exact name", () => {
		expect(zellijKillSessionArgs("neta-1")).toEqual(["kill-session", "neta-1"]);
	});
});

describe("worker views", () => {
	const worker = {
		id: "ro1",
		name: "auth flow",
		role: "scout",
		tier: "expert" as const,
		backend: "claude",
		writer: false,
		state: "running" as const,
		task: "map it",
		startedAt: 0,
		scratchDir: "/tmp/x",
	};

	function recordingMux(): { mux: MuxAdapter; calls: Array<{ title: string; args: string[] }> } {
		const calls: Array<{ title: string; args: string[] }> = [];
		return {
			calls,
			mux: {
				id: "tmux",
				available: () => true,
				inSession: () => true,
				sessionName: () => "fallback",
				wrapLeader: () => undefined,
				openPane: (title, spec, _cwd, sessionName) => {
					calls.push({ title, args: spec.args });
					expect(sessionName).toBe("neta-s7");
					return true;
				},
			},
		};
	}

	// The tab title is the only place a person sees which worker is which, and
	// five tabs called "scout" say nothing.
	it("titles the tab with the worker's id and name", () => {
		expect(tabTitle("ro1", "auth flow")).toBe("ro1 auth flow");
		expect(tabTitle("ro1", "scout")).toBe("ro1 scout");
	});

	it("keeps a long name short enough for a tab bar", () => {
		const title = tabTitle("ro12", "the entire websocket reconnect subsystem");

		expect(title.length).toBeLessThanOrEqual(22);
		expect(title.startsWith("ro12 the")).toBe(true);
		expect(title).toEndWith("…");
	});

	// Multiplexers start these from their own server process, which does not have
	// Neta's environment: a pane that cannot find the session dies instantly and
	// the tab disappears before anyone sees it.
	it("tells the watcher where to find the session, without relying on env", () => {
		const { mux, calls } = recordingMux();
		const host = createPaneHost(
			mux,
			{ command: "node", prefixArgs: ["/opt/cli.js"] },
			"s7",
			"/repo",
			"/home/u/.neta",
			"neta-s7",
		);

		host?.open(worker);

		expect(calls[0].title).toBe("ro1 auth flow");
		expect(calls[0].args).toEqual(["/opt/cli.js", "watch", "ro1", "--session", "s7", "--dir", "/home/u/.neta"]);
	});

	// The room's own view runs the same watch command; the tab is titled with
	// the room's name, clamped like every tab title.
	it("opens the room view with the room's name as the tab title", () => {
		const { mux, calls } = recordingMux();
		const host = createPaneHost(
			mux,
			{ command: "node", prefixArgs: ["/opt/cli.js"] },
			"s7",
			"/repo",
			"/home/u/.neta",
			"neta-s7",
		);

		host?.openRoom("auth-debate");
		host?.openRoom("a-room-name-far-too-long-for-a-tab");

		expect(calls[0].title).toBe("auth-debate");
		expect(calls[0].args).toEqual([
			"/opt/cli.js",
			"watch",
			"auth-debate",
			"--session",
			"s7",
			"--dir",
			"/home/u/.neta",
		]);
		expect(calls[1].title.length).toBeLessThanOrEqual(22);
		expect(calls[1].title).toEndWith("…");
	});

	it("reports why a view could not open rather than losing it", () => {
		const mux: MuxAdapter = {
			id: "tmux",
			available: () => true,
			inSession: () => true,
			sessionName: () => "fallback",
			wrapLeader: () => undefined,
			openPane: () => {
				throw new Error("tmux: no server running");
			},
		};

		const outcome = createPaneHost(mux, { command: "neta", prefixArgs: [] }, "s1", "/repo", "/n", "neta-s1")?.open(
			worker,
		);

		expect(outcome).toEqual({ opened: false, reason: "tmux: no server running" });
	});

	it("opens nothing when the leader is not inside a multiplexer", () => {
		const { mux } = recordingMux();
		const outside: MuxAdapter = { ...mux, inSession: () => false };

		expect(createPaneHost(outside, { command: "neta", prefixArgs: [] }, "s1", "/repo", "/n")).toBeUndefined();
	});
});

describe("selecting a multiplexer", () => {
	function fake(id: "zellij" | "tmux", available: boolean, inSession = false): MuxAdapter {
		return {
			id,
			available: () => available,
			inSession: () => inSession,
			sessionName: () => undefined,
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
