/**
 * The prompt is the product here: it is what makes a general coding agent
 * behave like a lead. These check the parts that were bought with experience.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	// The leader can only call what its host calls the tool. Naming the bare tool
	// to a host that namespaces it cost a whole session's delegation.
	it("uses the host's own tool names, everywhere it names one", () => {
		const prompt = buildLeaderPrompt({
			tiers: DEFAULT_TIERS,
			control: "mcp",
			toolName: (base) => `mcp__neta__${base}`,
		});

		for (const tool of [
			"neta_spawn",
			"neta_wait",
			"neta_workers",
			"neta_status",
			"neta_log",
			"neta_answer",
			"neta_plan",
			"neta_remember",
			"neta_note",
		]) {
			expect(prompt).toContain(`mcp__neta__${tool}`);
		}
		// No bare name survives to be copied by mistake.
		expect(prompt).not.toMatch(/`neta_(spawn|wait|workers|log|answer|plan|remember|note)`/);
	});

	// If a host renames tools again, the leader should look before giving up.
	it("tells a leader whose tools are missing to look for renamed ones first", () => {
		expect(buildLeaderPrompt({ tiers: DEFAULT_TIERS })).toContain('names containing "neta"');
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

		expect(prompt).toContain("internal subagent");
		expect(prompt).toContain("Never describe results as coming");
		// A leader whose tools are gone has to say so at once: the observed failure
		// was twenty minutes of work the user believed had been delegated.
		expect(prompt).toContain("say so in your first reply and stop");
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
		const prompt = buildLeaderPrompt({
			tiers: { journeyman: { backend: "claude" }, expert: { backend: "claude" }, architect: { backend: "claude" } },
		});

		expect(prompt).toContain("journeyman -> claude");
		expect(prompt).not.toContain("haiku");
	});

	it("tells the leader to use the lowest tier that fits the work", () => {
		const prompt = buildLeaderPrompt({ tiers: DEFAULT_TIERS });

		expect(prompt).toContain("Pick the lowest tier that can do the job");
		expect(prompt).toContain("mechanical, inventory, and reading tasks go to\napprentice or journeyman scouts");
		expect(prompt).toContain("use an architect only\nwhen the shape of the answer is unknown");
	});

	it("describes unconfigured tiers as using spread policy", () => {
		const prompt = buildLeaderPrompt({ tiers: DEFAULT_TIERS });

		expect(prompt).toContain("(none — all tiers use spread policy)");
	});

	// Defaults the user never chose have to be announced, or the first session
	// silently runs on a policy they do not know exists.
	it("tells the leader to disclose the policy when nothing is configured", () => {
		const prompt = buildLeaderPrompt({ tiers: DEFAULT_TIERS });

		expect(prompt).toContain("first staffing plan of the session must state");
		expect(prompt).toContain("round-robin across\ninstalled backends; reviewer/debater diversity rule on");
		expect(prompt).toContain("a CHARTER.md in this repo or in ~/.neta/");
		expect(prompt).toContain(".neta/settings.json via neta_remember");
	});

	it("skips the policy disclosure when a charter exists", () => {
		const prompt = buildLeaderPrompt({
			tiers: DEFAULT_TIERS,
			charter: { path: "/repo/CHARTER.md", text: "Merge PRs on my behalf." },
		});

		expect(prompt).not.toContain("first staffing plan of the session");
	});

	it("skips the policy disclosure when a tier mapping is configured", () => {
		const prompt = buildLeaderPrompt({ tiers: { expert: { backend: "codex" } } });

		expect(prompt).not.toContain("first staffing plan of the session");
	});
});

describe("charter loading", () => {
	it("appends the user's default after the project charter with both paths attributed", () => {
		const cwd = scratch();
		const agentDir = scratch();
		const projectPath = join(cwd, "CHARTER.md");
		const userPath = join(agentDir, "CHARTER.md");
		writeFileSync(projectPath, "project rules");
		writeFileSync(userPath, "personal rules");

		const charter = loadCharter(cwd, agentDir);
		const prompt = buildLeaderPrompt({ tiers: DEFAULT_TIERS, charter });

		expect(charter?.text.indexOf("project rules")).toBeLessThan(charter?.text.indexOf("personal rules") ?? -1);
		expect(prompt).toContain(`## Charter from ${projectPath}`);
		expect(prompt).toContain(`## Charter from ${userPath}`);
		expect(prompt).toContain(`Your charters are ${projectPath} and ${userPath}`);
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
