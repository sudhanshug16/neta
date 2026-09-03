import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mission } from "../src/core/types.ts";
import { agreement, BANNED_WORDS, composeContext, loadCharter, loadSkills } from "../src/tools/context.ts";
import type { ActorKind } from "../src/tools/schemas.ts";

const KINDS: ActorKind[] = ["leader", "lead", "agent"];
const BUDGET: Record<ActorKind, number> = { leader: 40, lead: 30, agent: 20 };

function lineCount(text: string): number {
	return text.trimEnd().split("\n").length;
}

function bannedHits(text: string): string[] {
	return BANNED_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
}

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

async function roots(): Promise<{ root: string; home: string }> {
	const root = await mkdtemp(join(tmpdir(), "neta-charter-root-"));
	const home = await mkdtemp(join(tmpdir(), "neta-charter-home-"));
	dirs.push(root, home);
	return { root, home };
}

function testMission(): Mission {
	return {
		id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		number: 7,
		workspaceId: "w",
		machineId: "m",
		name: "lens port",
		objective: "port the lens",
		changes: [
			{ at: new Date(0).toISOString(), text: "first change" },
			{ at: new Date(1).toISOString(), text: "second change" },
		],
		lead: { kind: "leader" },
		agentIds: [],
		access: "readWrite",
		worktree: { provider: "worktrunk", path: "/tmp/wt-7", branch: "neta/7", base: "main" },
		state: "running",
		createdAt: new Date(0).toISOString(),
	};
}

describe("working agreements", () => {
	test("each agreement is inside its line budget and free of banned words", () => {
		for (const kind of KINDS) {
			const text = agreement(kind);
			expect(lineCount(text)).toBeLessThanOrEqual(BUDGET[kind]);
			expect(bannedHits(text)).toEqual([]);
		}
	});

	test("the agent agreement names neither neta_agent nor neta_ask", () => {
		const text = agreement("agent");
		expect(text).not.toContain("neta_agent");
		expect(text).not.toContain("neta_ask");
	});
});

describe("charter loading", () => {
	test("the workspace charter precedes the user one", async () => {
		const { root, home } = await roots();
		await writeFile(join(root, "CHARTER.md"), "workspace rules");
		await mkdir(join(home, ".neta"), { recursive: true });
		await writeFile(join(home, ".neta", "CHARTER.md"), "user rules");
		const charter = loadCharter(root, home);
		expect(charter?.text).toBe("workspace rules\nuser rules");
		expect(charter?.sources).toEqual([join(root, "CHARTER.md"), join(home, ".neta", "CHARTER.md")]);
		expect(typeof charter?.hash).toBe("string");
		expect(charter?.hash).toHaveLength(64);
	});

	test("the hash changes when either file changes", async () => {
		const { root, home } = await roots();
		await writeFile(join(root, "CHARTER.md"), "v1");
		const first = loadCharter(root, home)?.hash;
		await writeFile(join(root, "CHARTER.md"), "v2");
		expect(loadCharter(root, home)?.hash).not.toBe(first);
	});

	test("no charter gives undefined", async () => {
		const { root, home } = await roots();
		expect(loadCharter(root, home)).toBeUndefined();
	});
});

describe("skill loading", () => {
	async function skilled(): Promise<{ root: string; home: string }> {
		const { root, home } = await roots();
		await mkdir(join(root, ".neta", "skills"), { recursive: true });
		await mkdir(join(home, ".neta", "skills"), { recursive: true });
		await writeFile(join(root, ".neta", "skills", "notes.md"), "workspace notes");
		await writeFile(join(home, ".neta", "skills", "git.md"), "user git");
		return { root, home };
	}

	test("workspace skills resolve before user ones", async () => {
		const { root, home } = await skilled();
		const loaded = loadSkills(["notes", "git"], root, home);
		expect(loaded).toEqual({
			ok: true,
			skills: [
				{ name: "notes", text: "workspace notes" },
				{ name: "git", text: "user git" },
			],
		});
	});

	test("a missing skill reports the name and the available list", async () => {
		const { root, home } = await skilled();
		expect(loadSkills(["nope"], root, home)).toEqual({ ok: false, missing: "nope", available: ["git", "notes"] });
	});

	test("a traversing name is rejected", async () => {
		const { root, home } = await skilled();
		for (const name of ["../evil", "a/b", ".."]) {
			const result = loadSkills([name], root, home);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.missing).toBe(name);
			}
		}
	});
});

describe("context composition", () => {
	test("an ordinary agent's context has no charter text", () => {
		const text = composeContext({
			kind: "agent",
			charter: { text: "secret rules", hash: "h", sources: [] },
			task: "port the lens",
		});
		expect(text).not.toContain("secret rules");
		expect(text).toContain("port the lens");
	});

	test("the brief keeps accepted changes in order with access and worktree", () => {
		const text = composeContext({ kind: "lead", mission: testMission(), task: "run it" });
		expect(text.indexOf("port the lens")).toBeLessThan(text.indexOf("first change"));
		expect(text.indexOf("first change")).toBeLessThan(text.indexOf("second change"));
		expect(text).toContain("readWrite");
		expect(text).toContain("/tmp/wt-7");
	});
});
