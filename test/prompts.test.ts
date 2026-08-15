/**
 * The prompt is the product here: it is what makes a general coding agent
 * behave like a lead. These check the parts that were bought with experience.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCharter } from "../src/prompts/charter.ts";
import { materializeFlavors } from "../src/prompts/flavors.ts";
import { buildLeaderPrompt } from "../src/prompts/leader.ts";
import { DEFAULT_TIERS } from "../src/settings.ts";

const dirs: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "neta-prompt-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("leader prompt", () => {
	it("tells the leader it does not write code, in either surface", () => {
		expect(buildLeaderPrompt({ tiers: DEFAULT_TIERS })).toContain("You do not write code");
		expect(buildLeaderPrompt({ tiers: DEFAULT_TIERS, control: "cli" })).toContain("You do not write code");
	});

	it("names the MCP tools when the leader manages workers with tools", () => {
		const prompt = buildLeaderPrompt({ tiers: DEFAULT_TIERS, control: "mcp" });

		expect(prompt).toContain("neta_spawn");
		expect(prompt).toContain("neta_wait");
		expect(prompt).not.toContain("neta spawn --role");
	});

	it("names the CLI commands when the leader has no tools", () => {
		const prompt = buildLeaderPrompt({ tiers: DEFAULT_TIERS, control: "cli" });

		expect(prompt).toContain("neta spawn --role");
		expect(prompt).not.toContain("`neta_spawn`");
	});

	// A leader that cannot delegate has been seen reporting work its backend's
	// own subagents did. That failure has to be named in the prompt itself.
	it("forbids faking delegation when the tools fail", () => {
		const prompt = buildLeaderPrompt({ tiers: DEFAULT_TIERS });

		expect(prompt).toContain("stop\nand report the blocker");
		expect(prompt).toContain("internal subagent");
	});

	it("closes the bash hole in words as well as in enforcement", () => {
		expect(buildLeaderPrompt({ tiers: DEFAULT_TIERS })).toContain("sed -i");
	});

	it("embeds the charter rather than pointing at it", () => {
		const prompt = buildLeaderPrompt({
			tiers: DEFAULT_TIERS,
			charter: { path: "/repo/CHARTER.md", text: "Merge PRs on my behalf. Ask before billing." },
		});

		expect(prompt).toContain("Merge PRs on my behalf");
		expect(prompt).toContain("/repo/CHARTER.md");
	});

	it("tells a leader with no charter to ask before anything expensive", () => {
		expect(buildLeaderPrompt({ tiers: DEFAULT_TIERS })).toContain("There is no CHARTER.md");
	});

	it("lists flavors with paths the leader can actually read", () => {
		const prompt = buildLeaderPrompt({
			tiers: DEFAULT_TIERS,
			flavors: [{ name: "implement", path: "/home/u/.neta/skills/implement/SKILL.md", description: "build it" }],
		});

		expect(prompt).toContain("**implement** — build it (/home/u/.neta/skills/implement/SKILL.md)");
	});

	it("describes the tier mapping without naming models", () => {
		const prompt = buildLeaderPrompt({ tiers: DEFAULT_TIERS });

		expect(prompt).toContain("junior -> claude");
		expect(prompt).not.toContain("haiku");
	});
});

describe("charter loading", () => {
	it("prefers the project charter over the user's default", () => {
		const cwd = scratch();
		const agentDir = scratch();
		writeFileSync(join(cwd, "CHARTER.md"), "project rules");
		writeFileSync(join(agentDir, "CHARTER.md"), "personal rules");

		expect(loadCharter(cwd, agentDir)?.text).toBe("project rules");
	});

	it("falls back to the user's default", () => {
		const agentDir = scratch();
		writeFileSync(join(agentDir, "CHARTER.md"), "personal rules");

		expect(loadCharter(scratch(), agentDir)?.text).toBe("personal rules");
	});

	it("treats an empty charter as no charter", () => {
		const cwd = scratch();
		writeFileSync(join(cwd, "CHARTER.md"), "   \n");

		expect(loadCharter(cwd, scratch())).toBeUndefined();
	});
});

describe("flavors", () => {
	it("writes the shipped playbooks where the leader can read them", async () => {
		const agentDir = scratch();

		const refs = await materializeFlavors(agentDir);

		expect(refs.map((ref) => ref.name)).toEqual(["implement", "decide", "investigate"]);
		expect(refs[0].path).toBe(join(agentDir, "skills", "implement", "SKILL.md"));
	});

	// Overwriting an edited playbook would silently undo the user's work.
	it("uses a project copy and leaves it untouched", async () => {
		const agentDir = scratch();
		const cwd = scratch();
		const projectFlavor = join(cwd, ".neta", "skills", "implement");
		mkdirSync(projectFlavor, { recursive: true });
		writeFileSync(join(projectFlavor, "SKILL.md"), "my own implement");

		const refs = await materializeFlavors(agentDir, cwd);

		expect(refs[0].path).toBe(join(projectFlavor, "SKILL.md"));
	});
});
