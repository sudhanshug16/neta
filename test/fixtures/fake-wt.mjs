#!/usr/bin/env node
// Fake `wt` for tests: implements `--version`, `switch --create`, `list
// --format=json` and `remove` over plain `git`, emitting exactly the payloads
// `docs/plan/06-worktrees.md` tables. Worktrees are placed as siblings named
// `<repo>.<branch with / and - flattened>` so tests prove Neta reads the path
// instead of computing it. NETA_WT_BIN points here; no test needs real `wt`.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";

function git(repoRoot, args) {
	return execFileSync("git", ["-C", repoRoot, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

const raw = process.argv.slice(2);
// `wt.ts` always prefixes `-C <cwd>` and appends `-y`.
let repoRoot = process.cwd();
let argv = [...raw];
if (argv[0] === "-C") {
	repoRoot = argv[1];
	argv = argv.slice(2);
}
argv = argv.filter((arg) => arg !== "-y" && arg !== "--no-cd" && arg !== "--foreground");
if (argv[0] === "--version") {
	process.stdout.write("wt v0.72.0 (fake-wt)\n");
	process.exit(0);
}

function flagValue(name) {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

function flattenBranch(branch) {
	return branch.replace(/[/-]/g, "-");
}

function worktreeStatus(path) {
	const porcelain = (() => {
		try {
			return git(path, ["status", "--porcelain=v1", "--untracked-files=all"]);
		} catch {
			return "";
		}
	})();
	let staged = 0;
	let modified = 0;
	let untracked = 0;
	let renamed = 0;
	let deleted = 0;
	for (const line of porcelain.split("\n")) {
		if (line.length < 2) {
			continue;
		}
		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") {
			untracked += 1;
			continue;
		}
		if (x !== " ") {
			staged += 1;
		}
		if (y !== " ") {
			modified += 1;
		}
		if (x === "R") {
			renamed += 1;
		}
		if (x === "D" || y === "D") {
			deleted += 1;
		}
	}
	let added = 0;
	let removed = 0;
	try {
		const numstat = git(path, ["diff", "--numstat", "HEAD", "--", "."]);
		for (const line of numstat.split("\n")) {
			const parts = line.split("\t");
			if (parts.length >= 2) {
				added += Number.parseInt(parts[0], 10) || 0;
				removed += Number.parseInt(parts[1], 10) || 0;
			}
		}
	} catch {
		// An unborn HEAD or similar: leave the diff at zero.
	}
	return { porcelain, staged, modified, untracked, renamed, deleted, added, removed };
}

function listWorktrees() {
	const porcelain = git(repoRoot, ["worktree", "list", "--porcelain"]);
	const blocks = porcelain
		.trim()
		.split("\n\n")
		.filter((block) => block.trim() !== "");
	const repoName = basename(repoRoot);
	let remote = "";
	try {
		remote = git(repoRoot, ["remote", "get-url", "origin"]).trim();
	} catch {
		remote = "";
	}
	return blocks.map((block) => {
		let path = "";
		let branch;
		let head = "";
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) {
				path = line.slice("worktree ".length);
			} else if (line.startsWith("HEAD ")) {
				head = line.slice("HEAD ".length);
			} else if (line.startsWith("branch ")) {
				branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
			}
		}
		const detached = branch === undefined;
		let sha = head;
		let shortSha = head.slice(0, 7);
		let message = "";
		let timestamp = 0;
		try {
			const info = git(path, ["log", "-1", "--format=%H%x1f%h%x1f%s%x1f%ct"]).trim().split("\x1f");
			sha = info[0] ?? sha;
			shortSha = info[1] ?? shortSha;
			message = info[2] ?? "";
			timestamp = Number.parseInt(info[3] ?? "0", 10) || 0;
		} catch {
			// No commits yet: keep HEAD values.
		}
		const status = worktreeStatus(path);
		const isMain = realpathSync(path) === realpathSync(repoRoot);
		return {
			branch,
			path,
			kind: isMain ? "main" : "worktree",
			is_main: isMain,
			is_current: false,
			commit: { sha, short_sha: shortSha, message, timestamp },
			working_tree: {
				staged: status.staged,
				modified: status.modified,
				untracked: status.untracked,
				renamed: status.renamed,
				deleted: status.deleted,
				diff: { added: status.added, deleted: status.removed },
			},
			main_state: status.porcelain.trim() === "" ? "clean" : "dirty",
			worktree: { detached },
			repo: { host: "", owner: "", name: repoName, remote },
		};
	});
}

const [command, ...rest] = argv;
if (command === "switch" && rest[0] === "--create") {
	const branch = rest[1];
	const base = flagValue("--base") ?? "main";
	if (branch === undefined) {
		fail("fake-wt: switch --create needs a branch");
	}
	const sibling = `${repoRoot}.${flattenBranch(branch)}`;
	try {
		git(repoRoot, ["worktree", "add", sibling, "-b", branch, base]);
	} catch (error) {
		fail(`fake-wt: ${error.message}`);
	}
	process.stdout.write(
		`${JSON.stringify({ action: "created", branch, path: sibling, created_branch: true, base_branch: base })}\n`,
	);
	// A disposable pre-start hook simulation for setup recovery tests. The
	// worktree and branch intentionally already exist when this fails.
	if (process.env.FAKE_WT_POST_START_FAIL === "1") {
		process.stdout.write("fake setup hook output: preparing local state\n");
		process.stderr.write("fake setup hook failed: intentional fixture failure\n");
		process.exit(1);
	}
	process.exit(0);
}

if (command === "list") {
	const entries = listWorktrees();
	process.stderr.write(`fake-wt: ${entries.length} worktree(s) in ${repoRoot}\n`);
	process.stdout.write(`${JSON.stringify(entries)}\n`);
	process.exit(0);
}

if (command === "remove") {
	const branch = rest.find((arg) => !arg.startsWith("-"));
	const force = rest.includes("--force");
	if (branch === undefined) {
		fail("fake-wt: remove needs a branch");
	}
	const entry = listWorktrees().find((candidate) => candidate.branch === branch);
	if (entry === undefined) {
		fail(`fake-wt: unknown branch: ${branch}`);
	}
	const status = worktreeStatus(entry.path);
	if (status.porcelain.trim() !== "" && !force) {
		fail(`Cannot remove worktree: ${branch} has uncommitted changes`);
	}
	// Removal may be invoked from the worktree being removed. Keep subsequent
	// git commands anchored in the primary worktree, as real Worktrunk does.
	const primary = listWorktrees()[0].path;
	// Model Worktrunk's exact-tree squash detection for the closeout fixture.
	const treesMatch =
		git(primary, ["rev-parse", `${branch}^{tree}`]).trim() === git(primary, ["rev-parse", "main^{tree}"]).trim();
	try {
		const args = ["worktree", "remove"];
		if (force) {
			args.push("--force");
		}
		args.push(entry.path);
		git(primary, args);
		if (rest.includes("-D") || treesMatch) {
			try {
				git(primary, ["branch", "-D", branch]);
			} catch {
				// The branch may already be gone.
			}
		} else {
			try {
				git(primary, ["branch", "-d", branch]);
			} catch {
				// An unmerged branch stays without -D.
			}
		}
	} catch (error) {
		fail(`fake-wt: ${error.message}`);
	}
	let branchOutcome = "deleted";
	try {
		git(primary, ["rev-parse", "--verify", branch]);
		branchOutcome = "retained_unmerged";
	} catch {
		branchOutcome = "deleted";
	}
	process.stdout.write(
		`${JSON.stringify([{ kind: "worktree", branch, path: entry.path, branch_outcome: branchOutcome, branch_checked_out_at: null }])}\n`,
	);
	process.exit(0);
}

fail(`fake-wt: unknown command: ${argv.join(" ")}`);
