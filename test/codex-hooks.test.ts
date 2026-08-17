/**
 * The two things Neta arranges inside a Codex overlay home: a session-start
 * hook Codex will actually run, and credentials that stay in the user's own
 * home rather than being left behind in Neta's.
 *
 * The trust rules here are the installed Codex's, read off the binary rather
 * than assumed — the last test in this file asks the real `codex` when one is
 * on PATH, offline and with no provider call.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AuthFileOps, posixHookCommand, preserveRefreshedAuth } from "../src/adapters/codex.ts";
import {
	type CodexHookEntry,
	codexEnforcesHookTrust,
	ensureCaptureHookTrusted,
	hookKeySourcePath,
	pathIsInside,
	probeCodexHooks,
	pruneStaleNetaHookTrust,
	readCodexConfigFile,
	trustedHashes,
	upsertHookTrust,
	writeCodexConfigFile,
} from "../src/adapters/codex-hooks.ts";
import { emptySessionCheckpoint, readCheckpoint, writeCheckpointAtomic } from "../src/checkpoint.ts";
import { requireLeaderConversationId } from "../src/recovery.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const dirs: string[] = [];

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<CodexHookEntry> & { key: string }): CodexHookEntry {
	return {
		eventName: "sessionStart",
		command: "neta capture-leader-session --session logical-1",
		sourcePath: "/neta/leader-sessions/logical-1/codex-home/hooks.json",
		enabled: true,
		isManaged: false,
		currentHash: "sha256:aaa",
		trustStatus: "untrusted",
		...overrides,
	};
}

describe("Codex hook trust", () => {
	it("reads whether the installed build enforces it from its own help", () => {
		expect(codexEnforcesHookTrust("      --dangerously-bypass-hook-trust\n  Run enabled hooks")).toBe(true);
		expect(codexEnforcesHookTrust("Usage: codex [OPTIONS]\n  --search  Enable live web search")).toBe(false);
	});

	it("writes one trust table per key and updates an existing one in place", () => {
		const key = "/home/.codex/hooks.json:session_start:0:0";
		const appended = upsertHookTrust('model = "gpt-5.6-sol"\n', key, "sha256:one");
		expect(appended).toContain('model = "gpt-5.6-sol"');
		expect(appended).toContain(`[hooks.state."${key}"]\ntrusted_hash = "sha256:one"`);

		const updated = upsertHookTrust(appended, key, "sha256:two");
		expect(updated).toContain('trusted_hash = "sha256:two"');
		expect(updated).not.toContain("sha256:one");
		expect(updated.match(/\[hooks\.state\./g)).toHaveLength(1);
		// Other tables keep their contents and their order.
		const withNeighbour = upsertHookTrust(`${updated}\n[tui]\ntheme = "dark"\n`, key, "sha256:three");
		expect(withNeighbour).toContain('[tui]\ntheme = "dark"');
		expect(withNeighbour).toContain('trusted_hash = "sha256:three"');
		expect(withNeighbour).not.toContain("sha256:two");
	});

	it("refuses a key it cannot write as a TOML string rather than corrupting the config", () => {
		expect(() => upsertHookTrust("", '/home/we"ird/hooks.json:session_start:0:0', "sha256:one")).toThrow(
			/unquotable key/,
		);
	});

	it("collects the hashes a config already vouches for", () => {
		const config =
			'[hooks.state."/a/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:one"\n\n' +
			'[hooks.state."/b/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:two"\nenabled = true\n';
		expect(trustedHashes(config)).toEqual(new Set(["sha256:one", "sha256:two"]));
	});

	it("prunes only Neta's own dead entries", () => {
		const owned = "/neta/leader-sessions";
		const config =
			'[hooks.state."/neta/leader-sessions/old/codex-home/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:old"\n\n' +
			'[hooks.state."/neta/leader-sessions/live/codex-home/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:live"\n\n' +
			'[hooks.state."/home/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:user"\n';
		const pruned = pruneStaleNetaHookTrust(config, owned, (path) => path.includes("/live/"));

		expect(pruned).not.toContain("sha256:old");
		expect(pruned).toContain("sha256:live");
		expect(pruned).toContain("sha256:user");
	});

	/**
	 * Ownership is a question about paths, not about strings. Every case here
	 * shares a textual prefix with Neta's directory and only one of them is
	 * actually inside it.
	 */
	describe("deciding what Neta owns", () => {
		const owned = "/home/u/.neta/leader-sessions";
		for (const [name, path, inside] of [
			["the owned directory itself", "/home/u/.neta/leader-sessions", true],
			["a session inside it", "/home/u/.neta/leader-sessions/abc/codex-home/hooks.json", true],
			["a nested path several levels down", "/home/u/.neta/leader-sessions/abc/x/y/z/hooks.json", true],
			["a sibling directory sharing the prefix", "/home/u/.neta/leader-sessions-backup/abc/hooks.json", false],
			["a sibling file sharing the prefix", "/home/u/.neta/leader-sessions.old", false],
			["a path that escapes through ..", "/home/u/.neta/leader-sessions/../secrets/hooks.json", false],
			["a path that escapes further up", "/home/u/.neta/leader-sessions/a/../../../../etc/hooks.json", false],
			["a path that leaves and comes back", "/home/u/.neta/leader-sessions/a/../b/hooks.json", true],
			["somewhere else entirely", "/home/u/.codex/hooks.json", false],
		] as const) {
			it(`treats ${name} as ${inside ? "owned" : "not owned"}`, () => {
				expect(pathIsInside(path, owned)).toBe(inside);
			});
		}

		it("never prunes a sibling, an escape or an existing file", () => {
			const config = [
				'[hooks.state."/home/u/.neta/leader-sessions/dead/codex-home/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:dead"',
				'[hooks.state."/home/u/.neta/leader-sessions-backup/dead/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:sibling"',
				'[hooks.state."/home/u/.neta/leader-sessions/../secrets/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:escaped"',
				'[hooks.state."/home/u/.neta/leader-sessions/live/codex-home/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:live"',
				'[hooks.state."/home/u/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:user"',
			].join("\n\n");
			// Only the live session's file is still on disk; everything else is gone.
			const pruned = pruneStaleNetaHookTrust(config, "/home/u/.neta/leader-sessions", (path) =>
				path.includes("/live/"),
			);

			expect(pruned).not.toContain("sha256:dead");
			for (const kept of ["sha256:sibling", "sha256:escaped", "sha256:live", "sha256:user"]) {
				expect(pruned).toContain(kept);
			}
		});

		/**
		 * A colon separates the fields of a trust key and is also a legal character
		 * in a path — on macOS and Linux anywhere, on Windows right after the drive
		 * letter. Counting the three trailing fields from the end is what keeps a
		 * path with a colon in it from being read as some shorter path.
		 */
		it("reads a colon in the hook's own path as part of the path", () => {
			expect(hookKeySourcePath("/home/u/.neta/leader-sessions/a:b/codex-home/hooks.json:session_start:0:0")).toBe(
				"/home/u/.neta/leader-sessions/a:b/codex-home/hooks.json",
			);
			expect(hookKeySourcePath("C:\\neta\\leader-sessions\\a\\hooks.json:session_start:0:0")).toBe(
				"C:\\neta\\leader-sessions\\a\\hooks.json",
			);
			// Not a key Neta wrote, and not one to guess a path out of.
			expect(hookKeySourcePath("odd")).toBeUndefined();
			expect(hookKeySourcePath(":session_start:0:0")).toBeUndefined();
		});

		it("prunes a dead session whose own path contains a colon", () => {
			const config =
				'[hooks.state."/home/u/.neta/leader-sessions/a:b/codex-home/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:colon"\n';
			expect(pruneStaleNetaHookTrust(config, "/home/u/.neta/leader-sessions", () => false)).not.toContain(
				"sha256:colon",
			);
		});

		it("leaves a key that is not shaped like one Neta wrote", () => {
			const config = '[hooks.state."odd"]\ntrusted_hash = "sha256:odd"\n';
			expect(pruneStaleNetaHookTrust(config, "/", () => false)).toBe(config);
		});
	});

	it("vouches for Neta's own hook and nothing it was not already trusted for", async () => {
		const realHome = scratch("neta-codex-real-");
		const codexHome = scratch("neta-codex-overlay-");
		const hooksPath = join(codexHome, "hooks.json");
		const userConfig = '[hooks.state."/home/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:user-trusted"\n';
		writeFileSync(join(realHome, "config.toml"), userConfig);
		// The overlay carries the user's config forward, which is where the decisions
		// they have already made are read from.
		writeFileSync(join(codexHome, "config.toml"), userConfig);
		const ours = entry({ key: `${hooksPath}:session_start:1:0`, sourcePath: hooksPath, currentHash: "sha256:neta" });
		const carried = entry({
			key: `${hooksPath}:stop:0:0`,
			sourcePath: hooksPath,
			eventName: "stop",
			command: "user notify",
			currentHash: "sha256:user-trusted",
		});
		const stranger = entry({
			key: `${hooksPath}:pre_tool_use:0:0`,
			sourcePath: hooksPath,
			eventName: "preToolUse",
			command: "unreviewed hook",
			currentHash: "sha256:stranger",
		});
		const projectHook = entry({
			key: "/repo/.codex/hooks.json:session_start:0:0",
			sourcePath: "/repo/.codex/hooks.json",
			command: "project hook",
			currentHash: "sha256:project",
		});
		let round = 0;
		const result = await ensureCaptureHookTrusted({
			binary: "codex",
			codexHome,
			cwd: "/repo",
			hooksPath,
			captureCommand: ours.command as string,
			probe: async () => {
				round += 1;
				return round === 1
					? [ours, carried, stranger, projectHook]
					: [{ ...ours, trustStatus: "trusted" }, carried, stranger, projectHook];
			},
		});

		expect(result.key).toBe(ours.key);
		expect(result.wrote).toEqual([ours.key, carried.key]);
		expect(result.configPath).toBe(join(codexHome, "config.toml"));
		const config = readFileSync(join(codexHome, "config.toml"), "utf-8");
		expect(config).toContain(`[hooks.state."${ours.key}"]`);
		expect(config).toContain(`[hooks.state."${carried.key}"]`);
		// The user's own settings are carried, not replaced.
		expect(config).toContain("sha256:user-trusted");
		// Neither an unreviewed hook of the user's nor anything the repository ships.
		expect(config).not.toContain("sha256:stranger");
		expect(config).not.toContain("/repo/.codex/hooks.json");
		// The user's own config is read and never written.
		expect(readFileSync(join(realHome, "config.toml"), "utf-8")).toBe(userConfig);
	});

	it("does nothing when Codex already trusts the capture hook", async () => {
		const realHome = scratch("neta-codex-real-");
		const codexHome = scratch("neta-codex-overlay-");
		const hooksPath = join(codexHome, "hooks.json");
		const ours = entry({ key: `${hooksPath}:session_start:0:0`, sourcePath: hooksPath, trustStatus: "trusted" });

		const result = await ensureCaptureHookTrusted({
			binary: "codex",
			codexHome,
			cwd: "/repo",
			hooksPath,
			captureCommand: ours.command as string,
			probe: async () => [ours],
		});

		expect(result.wrote).toEqual([]);
		expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
		expect(existsSync(join(realHome, "config.toml"))).toBe(false);
	});

	for (const [name, entries, error] of [
		["the capture hook is not reported at all", [], /did not report Neta's session-start capture hook/],
		[
			"the capture hook is disabled",
			[{ enabled: false }],
			/reports Neta's session-start capture hook .* as disabled/,
		],
	] as const) {
		it(`refuses the launch when ${name}`, async () => {
			const realHome = scratch("neta-codex-real-");
			const codexHome = scratch("neta-codex-overlay-");
			const hooksPath = join(codexHome, "hooks.json");
			const ours = entry({ key: `${hooksPath}:session_start:0:0`, sourcePath: hooksPath, ...entries[0] });

			await expect(
				ensureCaptureHookTrusted({
					binary: "codex",
					codexHome,
					cwd: "/repo",
					hooksPath,
					captureCommand: ours.command as string,
					probe: async () => (entries.length === 0 ? [] : [ours]),
				}),
			).rejects.toThrow(error);
			expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
			expect(existsSync(join(realHome, "config.toml"))).toBe(false);
		});
	}

	it("refuses the launch when Codex still will not trust the hook after the write", async () => {
		const codexHome = scratch("neta-codex-overlay-");
		const hooksPath = join(codexHome, "hooks.json");
		const ours = entry({ key: `${hooksPath}:session_start:0:0`, sourcePath: hooksPath });

		await expect(
			ensureCaptureHookTrusted({
				binary: "codex",
				codexHome,
				cwd: "/repo",
				hooksPath,
				captureCommand: ours.command as string,
				// A build whose trust scheme Neta no longer matches never flips.
				probe: async () => [ours],
			}),
		).rejects.toThrow(/still does not trust Neta's session-start capture hook/);
	});

	/**
	 * A config that is there but unreadable must never be read as an empty one:
	 * the session config is generated from those bytes, and an empty copy is a
	 * Codex running with none of the user's model, provider or approval settings.
	 */
	it("refuses to treat an unreadable config as an empty one", () => {
		const home = scratch("neta-codex-unreadable-");
		// A directory where a config file should be: readable(2) fails with EISDIR.
		mkdirSync(join(home, "config.toml"));

		expect(readCodexConfigFile(join(home, "missing.toml"))).toBe("");
		expect(() => readCodexConfigFile(join(home, "config.toml"))).toThrow(/could not read the Codex config/);
	});
});

/**
 * Two Neta launches, in two directories, at the same time.
 *
 * Trust used to be recorded in the user's one config.toml, which every session
 * read and rewrote. The window between one session's read and its write is a
 * window another session can write in, and the loser's entry disappears — after
 * its own confirming probe said it was there. The session then starts with an
 * untrusted capture hook, Codex never runs it, and that conversation's id is
 * lost with no error anywhere.
 *
 * This drives exactly that interleaving, deterministically, through the seams
 * either side of the read-modify-write. Codex is modelled from what it actually
 * does: a hook runs only if the config that session reads records its hash, and
 * a hook that runs is run through a shell with the payload on stdin. The end of
 * the chain is the real one — `neta capture-leader-session`, real checkpoints —
 * so what is proven is that both sessions come out resumable, not that two files
 * hold the right bytes.
 */
describe("two Neta launches arranging Codex hook trust at once", () => {
	interface Session {
		id: string;
		codexHome: string;
		conversationId: string;
	}

	/** Codex's own rule: a hook is trusted when this session's config records its hash. */
	function trustStatusIn(configPath: string, key: string, hash: string): CodexHookEntry["trustStatus"] {
		let config = "";
		try {
			config = readFileSync(configPath, "utf-8");
		} catch {
			// No config yet is nothing trusted yet.
		}
		const recorded = new RegExp(
			`\\[hooks\\.state\\."${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"]\\s*\\n\\s*trusted_hash\\s*=\\s*"([^"]+)"`,
		).exec(config)?.[1];
		return recorded === undefined ? "untrusted" : recorded === hash ? "trusted" : "modified";
	}

	it("records trust each session can still see, and both exact ids survive", async () => {
		// Adversarial on purpose: the hook's arguments carry this path, so a joined
		// command line would split it, and a shell would run the parts of it.
		const agentDir = join(scratch("neta-codex-race-"), "neta dir 'with $(touch marker) `and`; more&");
		mkdirSync(join(agentDir, "checkpoints"), { recursive: true });
		const sessions: Session[] = [
			{ id: "race-one", codexHome: scratch("neta-codex-one-"), conversationId: randomUUID() },
			{ id: "race-two", codexHome: scratch("neta-codex-two-"), conversationId: randomUUID() },
		];
		for (const session of sessions) {
			writeCheckpointAtomic(
				emptySessionCheckpoint({ id: session.id, canonicalCwd: agentDir, leaderBackend: "codex" }),
				agentDir,
			);
		}

		const commandOf = (session: Session): string =>
			posixHookCommand([
				process.execPath,
				CLI,
				"capture-leader-session",
				"--session",
				session.id,
				"--dir",
				agentDir,
			]);
		const hashOf = (session: Session): string => `sha256:${session.id}`;
		const keyOf = (session: Session): string => `${join(session.codexHome, "hooks.json")}:session_start:0:0`;
		const probeFor = (session: Session) => async (): Promise<CodexHookEntry[]> => [
			entry({
				key: keyOf(session),
				sourcePath: join(session.codexHome, "hooks.json"),
				command: commandOf(session),
				currentHash: hashOf(session),
				trustStatus: trustStatusIn(join(session.codexHome, "config.toml"), keyOf(session), hashOf(session)),
			}),
		];

		// The interleaving: the first session reads, then stops. The second reads,
		// writes and confirms all the way through. Only then does the first write —
		// on top of what it read before the second existed.
		let releaseFirstWrite: () => void = () => {};
		const firstHasRead = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});
		let secondFinished: () => void = () => {};
		const secondIsDone = new Promise<void>((resolve) => {
			secondFinished = resolve;
		});

		const first = ensureCaptureHookTrusted({
			binary: "codex",
			codexHome: sessions[0].codexHome,
			cwd: agentDir,
			hooksPath: join(sessions[0].codexHome, "hooks.json"),
			captureCommand: commandOf(sessions[0]),
			probe: probeFor(sessions[0]),
			readConfig: (path) => {
				const contents = readCodexConfigFile(path);
				releaseFirstWrite();
				return contents;
			},
			writeConfig: async (path, contents) => {
				await secondIsDone;
				writeCodexConfigFile(path, contents);
			},
		});
		await firstHasRead;
		const second = await ensureCaptureHookTrusted({
			binary: "codex",
			codexHome: sessions[1].codexHome,
			cwd: agentDir,
			hooksPath: join(sessions[1].codexHome, "hooks.json"),
			captureCommand: commandOf(sessions[1]),
			probe: probeFor(sessions[1]),
		});
		secondFinished();
		const firstResult = await first;

		expect(firstResult.wrote).toEqual([keyOf(sessions[0])]);
		expect(second.wrote).toEqual([keyOf(sessions[1])]);
		// Each session's trust lives in its own config, so neither write could be
		// the one that removed the other's.
		for (const session of sessions) {
			expect(readFileSync(join(session.codexHome, "config.toml"), "utf-8")).toContain(hashOf(session));
			expect(readFileSync(join(session.codexHome, "config.toml"), "utf-8")).not.toContain(
				hashOf(sessions[sessions.indexOf(session) === 0 ? 1 : 0]),
			);
		}

		// Now start both, as Codex would: run the SessionStart hook, and only the
		// one this session's config trusts.
		for (const session of sessions) {
			expect(trustStatusIn(join(session.codexHome, "config.toml"), keyOf(session), hashOf(session))).toBe("trusted");
			const hook = spawnSync("/bin/sh", ["-c", commandOf(session)], {
				input: JSON.stringify({ hook_event_name: "SessionStart", session_id: session.conversationId }),
				encoding: "utf-8",
			});
			expect({ id: session.id, status: hook.status, stderr: hook.stderr }).toMatchObject({ status: 0 });
		}

		// Both exact ids were recorded, each against its own session, and resume
		// accepts them: these two sessions can be reopened.
		for (const session of sessions) {
			const checkpoint = readCheckpoint(session.id, agentDir);
			expect(checkpoint.leader.vendorConversationId).toBe(session.conversationId);
			expect(requireLeaderConversationId(checkpoint, agentDir)).toBe(session.conversationId);
		}
		// The adversarial directory name was passed as one argument, not run.
		expect(existsSync(join(agentDir, "marker"))).toBe(false);
		expect(existsSync("marker")).toBe(false);
	}, 60_000);
});

describe("Codex credentials in the overlay home", () => {
	function overlayWithRefreshedAuth(): { overlay: string; realHome: string } {
		const realHome = scratch("neta-codex-real-");
		const overlay = scratch("neta-codex-overlay-");
		writeFileSync(join(realHome, "auth.json"), '{"token":"old"}', { mode: 0o600 });
		// Codex replaces the file rather than writing through the link.
		writeFileSync(join(overlay, "auth.json"), '{"token":"refreshed"}', { mode: 0o600 });
		return { overlay, realHome };
	}

	it("moves refreshed credentials back and leaves no copy under Neta", () => {
		const { overlay, realHome } = overlayWithRefreshedAuth();

		preserveRefreshedAuth(overlay, realHome, () => {
			throw new Error("nothing should be reported");
		});

		expect(readFileSync(join(realHome, "auth.json"), "utf-8")).toBe('{"token":"refreshed"}');
		expect(statSync(join(realHome, "auth.json")).mode & 0o077).toBe(0);
		// The overlay keeps a link, not a secret.
		expect(lstatSync(join(overlay, "auth.json")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(overlay, "auth.json"))).toBe(join(realHome, "auth.json"));
		expect(readFileSync(join(overlay, "auth.json"), "utf-8")).toBe('{"token":"refreshed"}');
		// The write went through a temporary file in the destination directory, so
		// the replacement was atomic — and nothing of it is left behind.
		expect(readdirSync(realHome)).toEqual(["auth.json"]);
		expect(readdirSync(overlay)).toEqual(["auth.json"]);
	});

	it("leaves a symlinked overlay untouched", () => {
		const { realHome } = overlayWithRefreshedAuth();
		const overlay = scratch("neta-codex-overlay-");
		spawnSync("ln", ["-s", join(realHome, "auth.json"), join(overlay, "auth.json")]);

		preserveRefreshedAuth(overlay, realHome, () => {
			throw new Error("nothing should be reported");
		});

		expect(lstatSync(join(overlay, "auth.json")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(realHome, "auth.json"), "utf-8")).toBe('{"token":"old"}');
	});

	it("keeps the only good copy and says so when the real home cannot be written", () => {
		const { overlay } = overlayWithRefreshedAuth();
		const realHome = join(scratch("neta-codex-gone-"), "not", "a", "directory");
		const reported: string[] = [];

		preserveRefreshedAuth(overlay, realHome, (message) => reported.push(message));

		expect(reported.join(" ")).toContain("could not copy Codex's refreshed credentials back");
		expect(reported.join(" ")).toContain(join(overlay, "auth.json"));
		expect(readFileSync(join(overlay, "auth.json"), "utf-8")).toBe('{"token":"refreshed"}');
	});

	it("does nothing at all when Codex never refreshed anything", () => {
		const realHome = scratch("neta-codex-real-");
		const overlay = scratch("neta-codex-overlay-");
		writeFileSync(join(realHome, "auth.json"), '{"token":"old"}');

		preserveRefreshedAuth(overlay, realHome, () => {
			throw new Error("nothing should be reported");
		});

		expect(existsSync(join(overlay, "auth.json"))).toBe(false);
		expect(readFileSync(join(realHome, "auth.json"), "utf-8")).toBe('{"token":"old"}');
	});

	/**
	 * The copy goes through a temporary file beside the real credentials, so every
	 * way that copy can fail is a way to leave a second copy of someone's Codex
	 * token lying in their home directory. Each stage is made to fail on its own,
	 * and each time: no temporary file survives, and neither of the two real
	 * copies is destroyed.
	 */
	describe("when a stage of the copy fails", () => {
		function tempSecrets(realHome: string): string[] {
			return readdirSync(realHome).filter((name) => /\.neta-.*\.tmp$/.test(name));
		}

		for (const stage of ["open", "write", "fsync", "rename"] as const) {
			it(`removes its temporary copy when ${stage} fails, and keeps both good copies`, () => {
				const { overlay, realHome } = overlayWithRefreshedAuth();
				const reported: string[] = [];
				const ops: Partial<AuthFileOps> = {
					[stage]: () => {
						throw new Error(`injected ${stage} failure`);
					},
				};

				preserveRefreshedAuth(overlay, realHome, (message) => reported.push(message), ops);

				expect(reported.join(" ")).toContain(`injected ${stage} failure`);
				expect(reported.join(" ")).toContain("could not copy Codex's refreshed credentials back");
				// Nothing secret is left in a temporary file...
				expect(tempSecrets(realHome)).toEqual([]);
				// ...and neither of the copies that did exist was destroyed.
				expect(readFileSync(join(overlay, "auth.json"), "utf-8")).toBe('{"token":"refreshed"}');
				expect(readFileSync(join(realHome, "auth.json"), "utf-8")).toBe('{"token":"old"}');
			});
		}

		it("keeps the copy when only closing the descriptor fails", () => {
			const { overlay, realHome } = overlayWithRefreshedAuth();
			const reported: string[] = [];

			// The bytes are written and flushed by then; a descriptor that will not
			// close is no reason to throw away a good copy.
			preserveRefreshedAuth(overlay, realHome, (message) => reported.push(message), {
				close: () => {
					throw new Error("injected close failure");
				},
			});

			expect(reported).toEqual([]);
			expect(tempSecrets(realHome)).toEqual([]);
			expect(readFileSync(join(realHome, "auth.json"), "utf-8")).toBe('{"token":"refreshed"}');
			expect(lstatSync(join(overlay, "auth.json")).isSymbolicLink()).toBe(true);
		});

		it("reports a permissions failure without undoing a copy that landed", () => {
			const { overlay, realHome } = overlayWithRefreshedAuth();
			const reported: string[] = [];

			preserveRefreshedAuth(overlay, realHome, (message) => reported.push(message), {
				chmod: () => {
					throw new Error("injected chmod failure");
				},
			});

			expect(reported.join(" ")).toContain("could not set the permissions on");
			expect(reported.join(" ")).toContain("injected chmod failure");
			expect(tempSecrets(realHome)).toEqual([]);
			// The file was created 0600 in the first place, so it is still private.
			expect(statSync(join(realHome, "auth.json")).mode & 0o077).toBe(0);
			expect(readFileSync(join(realHome, "auth.json"), "utf-8")).toBe('{"token":"refreshed"}');
			expect(lstatSync(join(overlay, "auth.json")).isSymbolicLink()).toBe(true);
		});

		it("says so when it cannot even read what Codex left behind", () => {
			const realHome = scratch("neta-codex-real-");
			const overlay = scratch("neta-codex-overlay-");
			writeFileSync(join(realHome, "auth.json"), '{"token":"old"}', { mode: 0o600 });
			// A directory where the refreshed credentials should be: read(2) fails.
			mkdirSync(join(overlay, "auth.json"));
			const reported: string[] = [];

			preserveRefreshedAuth(overlay, realHome, (message) => reported.push(message));

			expect(reported.join(" ")).toContain("could not read Codex's refreshed credentials");
			expect(readFileSync(join(realHome, "auth.json"), "utf-8")).toBe('{"token":"old"}');
			expect(tempSecrets(realHome)).toEqual([]);
		});

		it("names the file it could not remove rather than leaving it to be found", () => {
			const { overlay, realHome } = overlayWithRefreshedAuth();
			const reported: string[] = [];

			preserveRefreshedAuth(overlay, realHome, (message) => reported.push(message), {
				rename: () => {
					throw new Error("injected rename failure");
				},
				remove: () => {
					throw new Error("injected remove failure");
				},
			});

			expect(reported.join(" ")).toContain("could not remove its temporary copy at");
			expect(reported.join(" ")).toContain("injected remove failure");
			expect(reported.join(" ")).toContain("it holds your Codex credentials");
			// The test's own cleanup, since the run under test was told it could not.
			for (const name of tempSecrets(realHome)) rmSync(join(realHome, name), { force: true });
		});
	});
});

/**
 * The one test that talks to the installed Codex. It runs `codex app-server`
 * against a throwaway CODEX_HOME and asks it about a hook in that home: no
 * prompt, no session, no provider, nothing of the user's touched. Skipped where
 * Codex is not installed or has no hook trust to arrange.
 */
const codexPath = spawnSync("sh", ["-c", "command -v codex"], { encoding: "utf-8" }).stdout.trim();
const codexHelp = codexPath ? (spawnSync(codexPath, ["--help"], { encoding: "utf-8" }).stdout ?? "") : "";
const realCodexIt = codexPath && codexEnforcesHookTrust(codexHelp) ? it : it.skip;

describe("the installed Codex", () => {
	realCodexIt(
		"reports Neta's capture hook as untrusted, and as trusted once its trust is recorded",
		async () => {
			// Codex answers with canonical paths, which on macOS is not the path a
			// temporary directory is handed out as.
			const codexHome = realpathSync(scratch("neta-codex-probe-"));
			const hooksPath = join(codexHome, "hooks.json");
			const command = "/bin/echo neta-capture-probe";
			writeFileSync(
				hooksPath,
				JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }),
			);

			const before = await probeCodexHooks(codexPath, codexHome, codexHome);
			const ours = before.find((hook) => hook.sourcePath.startsWith(codexHome) && hook.command === command);
			expect(ours).toBeDefined();
			expect(ours?.trustStatus).toBe("untrusted");

			const result = await ensureCaptureHookTrusted({
				binary: codexPath,
				codexHome,
				cwd: codexHome,
				hooksPath: ours?.sourcePath ?? hooksPath,
				captureCommand: command,
			});

			expect(result.wrote).toEqual([ours?.key as string]);
			expect(result.configPath).toBe(join(codexHome, "config.toml"));
			expect(readFileSync(join(codexHome, "config.toml"), "utf-8")).toContain(ours?.currentHash as string);
		},
		60_000,
	);

	/**
	 * The quoted command has to survive the round trip through Codex: Neta matches
	 * the hook it vouches for by the exact command string Codex reports, so a build
	 * that normalised the string would silently break the match. Still offline —
	 * `hooks/list` starts no session.
	 */
	realCodexIt(
		"reports back the exact quoted command line for an adversarial path",
		async () => {
			const codexHome = realpathSync(scratch("neta-codex-quoting-"));
			const nasty = join(codexHome, "bin dir 'with $(everything) `and`; more&");
			mkdirSync(nasty, { recursive: true });
			const executable = join(nasty, "ne ta");
			writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			const command = posixHookCommand([executable, "capture-leader-session", "--session", "a b;c"]);
			writeFileSync(
				join(codexHome, "hooks.json"),
				JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }),
			);

			const reported = (await probeCodexHooks(codexPath, codexHome, codexHome)).find(
				(hook) => hook.sourcePath === join(codexHome, "hooks.json"),
			);

			expect(reported?.command).toBe(command);
			const trusted = await ensureCaptureHookTrusted({
				binary: codexPath,
				codexHome,
				cwd: codexHome,
				hooksPath: join(codexHome, "hooks.json"),
				captureCommand: command,
			});
			expect(trusted.wrote).toEqual([reported?.key as string]);
		},
		60_000,
	);
});
