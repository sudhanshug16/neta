import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoMux, selectMux } from "../src/mux/index.ts";
import { createPaneHost, markWorkerPaneTerminal, tabTitle, tuiTabTitle } from "../src/mux/panes.ts";
import {
	newWindowArgs,
	renameWindowArgs,
	TmuxAdapter,
	attachSessionArgs as tmuxAttachSessionArgs,
	killSessionArgs as tmuxKillSessionArgs,
	tmuxLiteralTitle,
	newSessionArgs as tmuxSessionArgs,
} from "../src/mux/tmux.ts";
import type { MuxAdapter, ProcessSpec } from "../src/mux/types.ts";
import {
	goToTabByIdArgs,
	leaderLayout,
	listTabPanesArgs,
	listTabsArgs,
	newSessionArgs,
	newTabArgs,
	renameTabByIdArgs,
	renameZellijTab,
	ZellijAdapter,
	attachSessionArgs as zellijAttachSessionArgs,
	killSessionArgs as zellijKillSessionArgs,
	zellijTabForPane,
	zellijTabId,
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
		const args = newWindowArgs(
			"ro1 scout",
			{ command: "neta", args: ["watch", "ro1"], env: { NETA_MUX: "tmux", NETA_PANE: "ro1 scout" } },
			"/repo",
			"neta-1",
		);

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
			"NETA_MUX=tmux",
			"-e",
			"NETA_PANE=ro1 scout",
			"--",
			"neta",
			"watch",
			"ro1",
		]);
		expect(args).not.toContain("split-window");
	});

	it("targets the calling watcher's exact tmux window", () => {
		expect(renameWindowArgs("%17", "ro1 auth ✓")).toEqual(["rename-window", "-t", "%17", "ro1 auth ✓"]);
	});

	it("keeps tmux format sequences literal in new and renamed worker titles", () => {
		const title = tabTitle("ro1", "#S #{session_name} overflow", "done");
		const escaped = tmuxLiteralTitle(title);
		const opened = newWindowArgs(title, { command: "neta", args: ["watch", "ro1"] }, "/repo", "neta-1");

		expect(title.length).toBeLessThanOrEqual(22);
		expect(title).toEndWith(" ✓");
		expect(escaped).toContain("##S");
		expect(escaped).toContain("##{");
		expect(opened[opened.indexOf("-n") + 1]).toBe(escaped);
		expect(renameWindowArgs("%17", title)).toEqual(["rename-window", "-t", "%17", escaped]);
	});

	it("renames the exact tmux pane through an injected runner and fails closed", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const adapter = new TmuxAdapter((command, args) => {
			calls.push({ command, args });
			return { status: 0, stdout: "" };
		});
		const complete = { NETA_MUX: "tmux", NETA_PANE: "ro1 #S", TMUX_PANE: "%17" };

		expect(adapter.renameCurrentPane("ro1 #S ✓", complete)).toBe(true);
		expect(calls).toEqual([{ command: "tmux", args: ["rename-window", "-t", "%17", "ro1 ##S ✓"] }]);
		for (const key of Object.keys(complete)) {
			expect(adapter.renameCurrentPane("ignored", { ...complete, [key]: undefined })).toBe(false);
		}
		expect(calls).toHaveLength(1);
		expect(new TmuxAdapter(() => ({ status: 1, stdout: "" })).renameCurrentPane("x", complete)).toBe(false);
	});

	it("does not invent marker environment for an unmarked process", () => {
		const args = newWindowArgs("ro1 auth tui", { command: "claude", args: ["--resume", "abc"] }, "/repo");

		expect(args).not.toContain("-e");
		expect(args).not.toContain("NETA_PANE=ro1 auth tui");
	});
});

describe("zellij", () => {
	const dirs: string[] = [];
	const savedZellij = process.env.ZELLIJ;
	const savedZellijSessionName = process.env.ZELLIJ_SESSION_NAME;
	beforeEach(() => {
		delete process.env.ZELLIJ;
		delete process.env.ZELLIJ_SESSION_NAME;
	});
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		if (savedZellij !== undefined) {
			process.env.ZELLIJ = savedZellij;
		} else {
			delete process.env.ZELLIJ;
		}
		if (savedZellijSessionName !== undefined) {
			process.env.ZELLIJ_SESSION_NAME = savedZellijSessionName;
		} else {
			delete process.env.ZELLIJ_SESSION_NAME;
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

	it("marks Neta-owned tabs through env without a shell", () => {
		expect(
			newTabArgs(
				"ro1 scout",
				{ command: "neta", args: ["watch", "ro1"], env: { NETA_MUX: "zellij", NETA_PANE: "ro1 scout" } },
				"/repo",
			),
		).toEqual([
			"action",
			"new-tab",
			"--name",
			"ro1 scout",
			"--cwd",
			"/repo",
			"--close-on-exit",
			"--",
			"/usr/bin/env",
			"NETA_MUX=zellij",
			"NETA_PANE=ro1 scout",
			"neta",
			"watch",
			"ro1",
		]);
	});

	it.each(["leader", "user-work"])("opens behind and restores the exact %s tab by stable id", (originalName) => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const before = JSON.stringify([
			{ id: 41, is_plugin: false, tab_id: 7, tab_name: originalName },
			{ id: 42, is_plugin: false, tab_id: 9, tab_name: "ro1 duplicate" },
		]);
		const after = JSON.stringify([
			{ id: 41, is_plugin: false, tab_id: 7, tab_name: originalName },
			{ id: 42, is_plugin: false, tab_id: 9, tab_name: "ro1 duplicate" },
			{ id: 43, is_plugin: false, tab_id: 12, tab_name: "ro1 duplicate" },
		]);
		const responses = [
			{ status: 0, stdout: before },
			{ status: 0, stdout: "12\n" },
			{ status: 0, stdout: after },
			{ status: 0, stdout: "" },
			{
				status: 0,
				stdout: JSON.stringify([
					{ tab_id: 7, active: true },
					{ tab_id: 12, active: false },
				]),
			},
		];
		const adapter = new ZellijAdapter(
			(command, args) => {
				calls.push({ command, args });
				return responses[calls.length - 1];
			},
			{ ZELLIJ: "0", ZELLIJ_SESSION_NAME: "user-session", ZELLIJ_PANE_ID: "41" },
		);

		expect(adapter.openPane("ro1 duplicate", { command: "neta", args: ["watch", "ro1"] }, "/repo")).toBe(true);
		expect(calls.map((call) => call.args)).toEqual([
			listTabPanesArgs("user-session"),
			newTabArgs("ro1 duplicate", { command: "neta", args: ["watch", "ro1"] }, "/repo", "user-session"),
			listTabPanesArgs("user-session"),
			goToTabByIdArgs("user-session", 7),
			listTabsArgs("user-session"),
		]);
		expect(calls.flatMap((call) => call.args)).not.toContain("go-to-tab-name");
		expect(calls.flatMap((call) => call.args)).not.toContain("go-to-previous-tab");
	});

	it("returns false when Zellij reports success but no stable tab was added", () => {
		const before = JSON.stringify([{ id: 41, is_plugin: false, tab_id: 7, tab_name: "user-work" }]);
		const responses = [
			{ status: 0, stdout: before },
			{ status: 0, stdout: "Session 'gone' not found" },
			{ status: 0, stdout: before },
			{ status: 0, stdout: "Session 'gone' not found" },
			{ status: 0, stdout: JSON.stringify([{ tab_id: 7, active: true }]) },
		];
		let call = 0;
		const adapter = new ZellijAdapter(() => responses[call++], {
			ZELLIJ: "0",
			ZELLIJ_SESSION_NAME: "gone",
			ZELLIJ_PANE_ID: "41",
		});

		expect(adapter.openPane("ro1 auth", { command: "neta", args: [] }, "/repo")).toBe(false);
		expect(call).toBe(5);
	});

	it("reports an opened Zellij tab when targeted focus restoration cannot be verified", () => {
		const before = JSON.stringify([{ id: 41, is_plugin: false, tab_id: 7, tab_name: "user-work" }]);
		const after = JSON.stringify([
			{ id: 41, is_plugin: false, tab_id: 7, tab_name: "user-work" },
			{ id: 42, is_plugin: false, tab_id: 8, tab_name: "ro1 auth" },
		]);
		const responses = [
			{ status: 0, stdout: before },
			{ status: 0, stdout: "8\n" },
			{ status: 0, stdout: after },
			{ status: 0, stdout: "session not found" },
			{ status: 0, stdout: JSON.stringify([{ tab_id: 8, active: true }]) },
		];
		let call = 0;
		const adapter = new ZellijAdapter(() => responses[call++], {
			ZELLIJ: "0",
			ZELLIJ_SESSION_NAME: "s1",
			ZELLIJ_PANE_ID: "41",
		});

		expect(() => adapter.openPane("ro1 auth", { command: "neta", args: [] }, "/repo")).toThrow(
			"opened tab but could not restore focus to user-work",
		);
		expect(call).toBe(5);
	});

	it("does not open when original Zellij pane output is malformed or ambiguous", () => {
		for (const stdout of [
			"session not found",
			"[]",
			JSON.stringify([
				{ id: 41, is_plugin: false, tab_id: 7, tab_name: "one" },
				{ id: 41, is_plugin: false, tab_id: 8, tab_name: "two" },
			]),
		]) {
			let calls = 0;
			const adapter = new ZellijAdapter(
				() => {
					calls += 1;
					return { status: 0, stdout };
				},
				{ ZELLIJ: "0", ZELLIJ_SESSION_NAME: "s1", ZELLIJ_PANE_ID: "41" },
			);
			expect(adapter.openPane("ro1 auth", { command: "neta", args: [] }, "/repo")).toBe(false);
			expect(calls).toBe(1);
		}
	});

	it("maps a divergent pane id to its tab id and renames that exact tab", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const rows = JSON.stringify([
			{ id: 41, is_plugin: false, tab_id: 7, tab_name: "ro1 auth" },
			{ id: 42, is_plugin: false, tab_id: 9, tab_name: "another tab" },
		]);
		const renamed = renameZellijTab(
			"ro1 auth ✗",
			{
				NETA_MUX: "zellij",
				NETA_PANE: "ro1 auth",
				ZELLIJ_SESSION_NAME: "neta-s1",
				ZELLIJ_PANE_ID: "41",
			},
			(command, args) => {
				calls.push({ command, args });
				return { status: 0, stdout: calls.length === 1 ? rows : "" };
			},
		);

		expect(renamed).toBe(true);
		expect(calls).toEqual([
			{ command: "zellij", args: listTabPanesArgs("neta-s1") },
			{ command: "zellij", args: renameTabByIdArgs("neta-s1", 7, "ro1 auth ✗") },
		]);
		expect(calls.flatMap((call) => call.args)).not.toContain("rename-tab");
		expect(calls.flatMap((call) => call.args)).not.toContain("new-tab");
		expect(calls.flatMap((call) => call.args)).not.toContain("go-to-tab-name");
	});

	it("fails closed on missing Zellij ownership or target metadata", () => {
		const complete = {
			NETA_MUX: "zellij",
			NETA_PANE: "ro1 auth",
			ZELLIJ_SESSION_NAME: "neta-s1",
			ZELLIJ_PANE_ID: "41",
		};
		for (const key of Object.keys(complete)) {
			const env = { ...complete, [key]: undefined };
			expect(renameZellijTab("ro1 auth ✓", env, () => ({ status: 0, stdout: "[]" }))).toBe(false);
		}
		expect(
			renameZellijTab("ro1 auth ✓", { ...complete, NETA_MUX: "tmux" }, () => ({ status: 0, stdout: "[]" })),
		).toBe(false);
	});

	it("fails closed on command errors, malformed or ambiguous rows, mismatches, and noninteger tab ids", () => {
		const env = {
			NETA_MUX: "zellij",
			NETA_PANE: "ro1 auth",
			ZELLIJ_SESSION_NAME: "neta-s1",
			ZELLIJ_PANE_ID: "41",
		};
		const row = { id: 41, is_plugin: false, tab_id: 7, tab_name: "ro1 auth" };
		const runWith = (stdout: string, renameStatus = 0) => {
			let calls = 0;
			return renameZellijTab("ro1 auth ✓", env, () => {
				calls += 1;
				return { status: calls === 1 ? 0 : renameStatus, stdout: calls === 1 ? stdout : "" };
			});
		};

		expect(renameZellijTab("ro1 auth ✓", env, () => ({ status: 1, stdout: "" }))).toBe(false);
		expect(runWith("not json")).toBe(false);
		expect(runWith("{}")).toBe(false);
		expect(runWith("[]")).toBe(false);
		expect(runWith(JSON.stringify([row, row]))).toBe(false);
		expect(runWith(JSON.stringify([{ ...row, id: 99 }]))).toBe(false);
		expect(runWith(JSON.stringify([{ ...row, tab_name: "wrong" }]))).toBe(false);
		expect(runWith(JSON.stringify([{ ...row, is_plugin: true }]))).toBe(false);
		expect(runWith(JSON.stringify([{ ...row, tab_id: 7.5 }]))).toBe(false);
		expect(runWith(JSON.stringify([row]), 1)).toBe(false);
		expect(
			renameZellijTab("ro1 auth ✓", env, () => {
				throw new Error("missing binary");
			}),
		).toBe(false);
	});

	it("rejects malformed pane rows without treating pane ids as tab ids", () => {
		expect(
			zellijTabId(JSON.stringify([{ id: 41, is_plugin: false, tab_name: "ro1 auth" }]), "41", "ro1 auth"),
		).toBeUndefined();
		expect(renameTabByIdArgs("neta-s1", 7, "ro1 auth ⊘")).toEqual([
			"--session",
			"neta-s1",
			"action",
			"rename-tab-by-id",
			"7",
			"ro1 auth ⊘",
		]);
		expect(zellijTabForPane("not json", "41")).toBeUndefined();
		expect(
			zellijTabForPane(JSON.stringify([{ id: 41, is_plugin: false, tab_id: 7.5, tab_name: "x" }]), "41"),
		).toBeUndefined();
	});

	it("uses ZELLIJ_SESSION_NAME because ZELLIJ is only an installed marker", () => {
		process.env.ZELLIJ = "0";
		process.env.ZELLIJ_SESSION_NAME = "neta-real";

		expect(new ZellijAdapter().sessionName()).toBe("neta-real");
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

	function recordingMux(): {
		mux: MuxAdapter;
		calls: Array<{ title: string; command: string; args: string[]; env: Record<string, string> | undefined }>;
	} {
		const calls: Array<{ title: string; command: string; args: string[]; env: Record<string, string> | undefined }> =
			[];
		return {
			calls,
			mux: {
				id: "tmux",
				available: () => true,
				inSession: () => true,
				sessionName: () => "fallback",
				wrapLeader: () => undefined,
				openPane: (title, spec, _cwd, sessionName) => {
					calls.push({ title, command: spec.command, args: spec.args, env: spec.env });
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

	it("keeps the existing custom title-limit argument", () => {
		expect(tabTitle("ro1", "authentication", 10)).toBe("ro1 authe…");
	});

	it("keeps terminal outcomes distinct and inside the title limit", () => {
		expect(tabTitle("ro1", "auth flow", "done")).toBe("ro1 auth flow ✓");
		expect(tabTitle("ro1", "auth flow", "failed")).toBe("ro1 auth flow ✗");
		expect(tabTitle("ro1", "auth flow", "killed")).toBe("ro1 auth flow ⊘");
		for (const state of ["done", "failed", "killed"] as const) {
			const title = tabTitle("rw12", "the entire websocket reconnect subsystem", state);
			expect(title).toStartWith("rw12");
			expect(title.length).toBeLessThanOrEqual(22);
		}
		expect(tabTitle("rw12", "the entire websocket reconnect subsystem", "done")).toBe("rw12 the entire web… ✓");
		expect(tabTitle("rw12", "the entire websocket reconnect subsystem", "failed")).toBe("rw12 the entire web… ✗");
		expect(tabTitle("rw12", "the entire websocket reconnect subsystem", "killed")).toBe("rw12 the entire web… ⊘");
	});

	it("never guesses a mux or renames an unmarked user-owned resource", () => {
		expect(markWorkerPaneTerminal({ ...worker, state: "done" }, { TMUX: "/tmp/tmux", TMUX_PANE: "%1" })).toBe(false);
		expect(markWorkerPaneTerminal({ ...worker, state: "failed" }, { ZELLIJ: "0", ZELLIJ_PANE_ID: "1" })).toBe(false);
		expect(
			markWorkerPaneTerminal(
				{ ...worker, state: "done" },
				{ NETA_MUX: "tmux", NETA_PANE: "ro1 auth flow", TMUX: "/tmp/tmux" },
			),
		).toBe(false);
		expect(markWorkerPaneTerminal(worker, { NETA_MUX: "tmux", NETA_PANE: "ro1 auth flow", TMUX_PANE: "%1" })).toBe(
			false,
		);
	});

	it("dispatches terminal marks to tmux and Zellij success paths", () => {
		const terminal = { ...worker, state: "done" as const };
		const tmuxCalls: string[][] = [];
		const tmuxEnv = { NETA_MUX: "tmux", NETA_PANE: "ro1 auth flow", TMUX_PANE: "%17" };
		expect(
			markWorkerPaneTerminal(terminal, tmuxEnv, (mux) => {
				expect(mux).toBe("tmux");
				return new TmuxAdapter((_command, args) => {
					tmuxCalls.push(args);
					return { status: 0, stdout: "" };
				});
			}),
		).toBe(true);
		expect(tmuxCalls).toEqual([["rename-window", "-t", "%17", "ro1 auth flow ✓"]]);

		const zellijCalls: string[][] = [];
		const zellijEnv = {
			NETA_MUX: "zellij",
			NETA_PANE: "ro1 auth flow",
			ZELLIJ_SESSION_NAME: "s1",
			ZELLIJ_PANE_ID: "41",
		};
		expect(
			markWorkerPaneTerminal(terminal, zellijEnv, (mux) => {
				expect(mux).toBe("zellij");
				let call = 0;
				return new ZellijAdapter((_command, args) => {
					call += 1;
					zellijCalls.push(args);
					return {
						status: 0,
						stdout:
							call === 1
								? JSON.stringify([{ id: 41, is_plugin: false, tab_id: 7, tab_name: "ro1 auth flow" }])
								: "",
					};
				});
			}),
		).toBe(true);
		expect(zellijCalls).toEqual([listTabPanesArgs("s1"), renameTabByIdArgs("s1", 7, "ro1 auth flow ✓")]);
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
		expect(calls[0].env).toEqual({ NETA_MUX: "tmux", NETA_PANE: "ro1 auth flow" });
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
		expect(calls[0].env).toEqual({ NETA_MUX: "tmux", NETA_PANE: "auth-debate" });
		expect(calls[1].title.length).toBeLessThanOrEqual(22);
		expect(calls[1].title).toEndWith("…");
	});

	it("opens an exact resume command in a fresh native TUI tab", () => {
		const { mux, calls } = recordingMux();
		const host = createPaneHost(
			mux,
			{ command: "node", prefixArgs: ["/opt/cli.js"] },
			"s7",
			"/repo",
			"/home/u/.neta",
			"neta-s7",
		);

		const outcome = host?.attach?.(
			{ ...worker, state: "done", vendorSessionId: "vendor-exact" },
			{ command: "claude", args: ["--resume", "vendor-exact"] },
		);

		expect(outcome).toEqual({ opened: true });
		expect(calls[0]).toEqual({
			title: "ro1 auth flow tui",
			command: "claude",
			args: ["--resume", "vendor-exact"],
			env: undefined,
		});
	});

	it("keeps a clamped attach tab distinct and leaves native TUI tabs unmarked", () => {
		const watch = tabTitle("rw12", "the entire websocket reconnect subsystem");
		const tui = tuiTabTitle("rw12", "the entire websocket reconnect subsystem");

		expect(watch).toBe("rw12 the entire webso…");
		expect(tui).toBe("rw12 the entire w… tui");
		expect(tui).not.toBe(watch);
		expect(tui).toEndWith(" tui");
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
