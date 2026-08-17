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
import {
	existsSync,
	lstatSync,
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
import { preserveRefreshedAuth } from "../src/adapters/codex.ts";
import {
	type CodexHookEntry,
	codexEnforcesHookTrust,
	ensureCaptureHookTrusted,
	probeCodexHooks,
	pruneStaleNetaHookTrust,
	trustedHashes,
	upsertHookTrust,
} from "../src/adapters/codex-hooks.ts";

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

	it("vouches for Neta's own hook and nothing it was not already trusted for", async () => {
		const realHome = scratch("neta-codex-real-");
		const codexHome = scratch("neta-codex-overlay-");
		const hooksPath = join(codexHome, "hooks.json");
		writeFileSync(
			join(realHome, "config.toml"),
			'[hooks.state."/home/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:user-trusted"\n',
		);
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
			realHome,
			cwd: "/repo",
			hooksPath,
			captureCommand: ours.command as string,
			ownedPrefix: "/neta/leader-sessions",
			probe: async () => {
				round += 1;
				return round === 1
					? [ours, carried, stranger, projectHook]
					: [{ ...ours, trustStatus: "trusted" }, carried, stranger, projectHook];
			},
		});

		expect(result.key).toBe(ours.key);
		expect(result.wrote).toEqual([ours.key, carried.key]);
		const config = readFileSync(join(realHome, "config.toml"), "utf-8");
		expect(config).toContain(`[hooks.state."${ours.key}"]`);
		expect(config).toContain(`[hooks.state."${carried.key}"]`);
		// Neither an unreviewed hook of the user's nor anything the repository ships.
		expect(config).not.toContain("sha256:stranger");
		expect(config).not.toContain("/repo/.codex/hooks.json");
		// The overlay can see the config the trust was written to.
		expect(readlinkSync(join(codexHome, "config.toml"))).toBe(join(realHome, "config.toml"));
	});

	it("does nothing when Codex already trusts the capture hook", async () => {
		const realHome = scratch("neta-codex-real-");
		const codexHome = scratch("neta-codex-overlay-");
		const hooksPath = join(codexHome, "hooks.json");
		const ours = entry({ key: `${hooksPath}:session_start:0:0`, sourcePath: hooksPath, trustStatus: "trusted" });

		const result = await ensureCaptureHookTrusted({
			binary: "codex",
			codexHome,
			realHome,
			cwd: "/repo",
			hooksPath,
			captureCommand: ours.command as string,
			ownedPrefix: "/neta/leader-sessions",
			probe: async () => [ours],
		});

		expect(result.wrote).toEqual([]);
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
					realHome,
					cwd: "/repo",
					hooksPath,
					captureCommand: ours.command as string,
					ownedPrefix: "/neta/leader-sessions",
					probe: async () => (entries.length === 0 ? [] : [ours]),
				}),
			).rejects.toThrow(error);
			expect(existsSync(join(realHome, "config.toml"))).toBe(false);
		});
	}

	it("refuses the launch when Codex still will not trust the hook after the write", async () => {
		const realHome = scratch("neta-codex-real-");
		const codexHome = scratch("neta-codex-overlay-");
		const hooksPath = join(codexHome, "hooks.json");
		const ours = entry({ key: `${hooksPath}:session_start:0:0`, sourcePath: hooksPath });

		await expect(
			ensureCaptureHookTrusted({
				binary: "codex",
				codexHome,
				realHome,
				cwd: "/repo",
				hooksPath,
				captureCommand: ours.command as string,
				ownedPrefix: "/neta/leader-sessions",
				// A build whose trust scheme Neta no longer matches never flips.
				probe: async () => [ours],
			}),
		).rejects.toThrow(/still does not trust Neta's session-start capture hook/);
	});
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
				realHome: codexHome,
				cwd: codexHome,
				hooksPath: ours?.sourcePath ?? hooksPath,
				captureCommand: command,
				ownedPrefix: codexHome,
			});

			expect(result.wrote).toEqual([ours?.key as string]);
			expect(readFileSync(join(codexHome, "config.toml"), "utf-8")).toContain(ours?.currentHash as string);
		},
		60_000,
	);
});
