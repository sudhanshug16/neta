import { describe, expect, test } from "bun:test";
import { canonicalRemote, workspaceIdFor } from "../src/core/workspace-id.ts";

describe("canonicalRemote", () => {
	test("the four documented remote forms map to one id", () => {
		const forms = [
			"git@github.com:org/repo.git",
			"ssh://git@github.com/org/repo",
			"https://github.com/org/repo.git",
			"https://user@github.com/org/repo/",
		];
		for (const form of forms) {
			expect(canonicalRemote(form)).toBe("github.com/org/repo");
		}
	});

	test("trailing slashes and .git are ignored", () => {
		expect(canonicalRemote("https://github.com/org/repo///")).toBe("github.com/org/repo");
		expect(canonicalRemote("git@github.com:org/repo.GIT")).toBe("github.com/org/repo.GIT");
	});

	test("host case is lowered, path case is kept", () => {
		expect(canonicalRemote("https://GitHub.COM/Org/Repo")).toBe("github.com/Org/Repo");
	});
});

describe("workspaceIdFor", () => {
	test("git workspaces share an id across remote forms", () => {
		const a = workspaceIdFor({ kind: "git", remote: "git@github.com:org/repo.git", path: "/tmp/a" });
		const b = workspaceIdFor({ kind: "git", remote: "https://github.com/org/repo", path: "/tmp/b" });
		expect(a).toBe("git:github.com/org/repo");
		expect(a).toBe(b);
	});

	test("folder ids are stable and distinct per path", () => {
		const a = workspaceIdFor({ kind: "folder", path: "/tmp/one" });
		const b = workspaceIdFor({ kind: "folder", path: "/tmp/one" });
		const c = workspaceIdFor({ kind: "folder", path: "/tmp/two" });
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^folder:[0-9a-f]{16}$/);
	});

	test("a git workspace without a remote throws", () => {
		expect(() => workspaceIdFor({ kind: "git", path: "/tmp/a" })).toThrow();
	});
});
