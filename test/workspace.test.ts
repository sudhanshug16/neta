import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectWorkspaceBinding,
	readWorkspaceBinding,
	restoreWorkspace,
	type WorkspaceBinding,
	workspaceAvailability,
	writeWorkspaceBinding,
} from "../src/workspace.ts";

describe("Worktrunk workspace bindings", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("captures and persists the exact git worktree and project subdirectory", async () => {
		root = mkdtempSync(join(tmpdir(), "neta-workspace-"));
		const repository = join(root, "repository");
		const project = join(repository, "packages", "app");
		const agentDir = join(root, "agent-dir");
		mkdirSync(project, { recursive: true });
		execFileSync("git", ["init", "-b", "main", repository]);
		execFileSync("git", ["-C", repository, "config", "user.email", "neta@example.test"]);
		execFileSync("git", ["-C", repository, "config", "user.name", "Neta Test"]);
		writeFileSync(join(repository, "README.md"), "test\n", "utf-8");
		execFileSync("git", ["-C", repository, "add", "README.md"]);
		execFileSync("git", ["-C", repository, "commit", "-m", "test"]);

		const binding = await detectWorkspaceBinding(project, "checkpoint-1");
		if (!binding) throw new Error("Expected a git workspace binding.");
		expect(binding).toMatchObject({
			checkpointId: "checkpoint-1",
			repositoryRoot: realpathSync(repository),
			worktreeRoot: realpathSync(repository),
			relativeCwd: "packages/app",
			branch: "main",
		});
		writeWorkspaceBinding(binding, agentDir);
		expect(readWorkspaceBinding("checkpoint-1", agentDir)).toEqual(binding);
		expect(workspaceAvailability(project, binding)).toBe("available");
		expect(await restoreWorkspace(binding)).toBe(realpathSync(project));
	});

	it("asks Worktrunk to recreate a missing worktree at its exact saved path", async () => {
		root = mkdtempSync(join(tmpdir(), "neta-workspace-restore-"));
		const repository = join(root, "repository");
		const worktree = join(root, "feature-worktree");
		const project = join(worktree, "packages", "app");
		const fakeWt = join(root, "fake-wt.mjs");
		mkdirSync(repository);
		writeFileSync(
			fakeWt,
			`#!/usr/bin/env node\nimport { mkdirSync } from "node:fs";\nmkdirSync(${JSON.stringify(project)}, { recursive: true });\nprocess.stdout.write(JSON.stringify({ branch: "feature/archive", worktree_path: ${JSON.stringify(worktree)} }));\n`,
			"utf-8",
		);
		chmodSync(fakeWt, 0o755);
		const binding: WorkspaceBinding = {
			version: 1,
			provider: "worktrunk",
			checkpointId: "checkpoint-2",
			repositoryRoot: realpathSync(repository),
			worktreeRoot: `${realpathSync(root)}/feature-worktree`,
			relativeCwd: "packages/app",
			branch: "feature/archive",
			head: "0123456789abcdef",
			capturedAt: Date.now(),
		};

		expect(workspaceAvailability(project, binding)).toBe("restorable");
		expect(await restoreWorkspace(binding, { wtCommand: fakeWt })).toBe(realpathSync(project));
	});
});
