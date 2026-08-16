/**
 * The bash guard.
 *
 * Taking away a leader's edit tool does not stop it editing files; it stops it
 * editing files *that way*. `echo x > file`, `sed -i`, `git commit` and friends
 * are all still there, and a model under pressure to finish will reach for
 * them. This is the check that says no.
 *
 * It runs as a PreToolUse hook on Claude Code and as a permission pattern list
 * on OpenCode. Codex needs neither: its read-only sandbox is enforced by the
 * kernel, which is strictly better than pattern matching.
 *
 * The rule is deliberately blunt — deny anything that looks like a write, and
 * let the leader delegate it. A false deny costs the leader one turn and a
 * junior worker; a false allow costs the user the guarantee they were promised.
 */

/** Commands that exist to change files. */
const WRITE_COMMANDS = new Set([
	"cp",
	"dd",
	"install",
	"ln",
	"mkdir",
	"mv",
	"patch",
	"rm",
	"rmdir",
	"tee",
	"touch",
	"truncate",
	"chmod",
	"chown",
	"rsync",
	"unzip",
]);

/** Package-manager subcommands that install or rewrite dependencies and lockfiles. */
const PACKAGE_MANAGER_WRITES = new Set(["install", "add", "ci"]);

/** Interpreters can write through inline code or a supplied script. */
const SCRIPT_INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl", "sh", "bash", "zsh"]);
const INTERPRETER_INSPECTION_FLAGS = new Set(["--help", "-h", "--version", "-v"]);

/** Git subcommands that write to the tree, the index, or history. */
const WRITE_GIT_SUBCOMMANDS = new Set([
	"add",
	"am",
	"apply",
	"checkout",
	"cherry-pick",
	"clean",
	"commit",
	"merge",
	"mv",
	"rebase",
	"reset",
	"restore",
	"revert",
	"rm",
	"stash",
	"switch",
]);

/** In-place editors: harmless without the flag, a file rewrite with it. */
const IN_PLACE = [
	{ command: "sed", flags: ["-i"] },
	{ command: "perl", flags: ["-i"] },
	{ command: "ruby", flags: ["-i"] },
	{ command: "gawk", flags: ["-i", "-i inplace"] },
];

export interface GuardVerdict {
	decision: "allow" | "deny";
	reason?: string;
}

const ALLOW: GuardVerdict = { decision: "allow" };

function deny(reason: string): GuardVerdict {
	return {
		decision: "deny",
		reason: `${reason} You are the leader: you do not edit files, even one-line fixes. Spawn a worker with an exact instruction instead.`,
	};
}

/** Redirections into /dev/null or another stream are output plumbing, not writes. */
function isHarmlessRedirect(target: string): boolean {
	return target.startsWith("&") || target === "/dev/null" || target === "/dev/stdout" || target === "/dev/stderr";
}

/** Split on the operators that start a new command, keeping it simple and conservative. */
function segments(command: string): string[] {
	return command
		.split(/(?:\|\||&&|[;|\n])/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function words(segment: string): string[] {
	return segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replaceAll(/^["']|["']$/g, "")) ?? [];
}

export function inspectBashCommand(command: string): GuardVerdict {
	for (const segment of segments(command)) {
		const parts = words(segment);
		if (parts.length === 0) continue;

		// Redirections: `> file`, `1> file` and `&> file` write; `2>/dev/null` does not.
		const redirect = segment.matchAll(/(?<![<=>])(?:\d+|&)?>{1,2}\s*(\S+)/g);
		for (const match of redirect) {
			const target = match[1];
			if (!isHarmlessRedirect(target)) return deny(`Writing to ${target} through a shell redirect is not allowed.`);
		}

		// `env FOO=bar cmd`, `sudo cmd` and plain assignments should not hide the verb.
		let index = 0;
		while (index < parts.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[index]) || parts[index] === "env")) index++;
		if (parts[index] === "sudo" || parts[index] === "command" || parts[index] === "nohup") index++;
		const head = (parts[index] ?? "").split("/").pop() ?? "";
		const rest = parts.slice(index + 1);

		if (WRITE_COMMANDS.has(head)) return deny(`\`${head}\` changes files.`);
		const packageWrite = rest.find((word) => PACKAGE_MANAGER_WRITES.has(word));
		if (["npm", "pnpm", "yarn", "bun"].includes(head) && packageWrite) {
			return deny(`\`${head} ${packageWrite}\` writes dependencies or a lockfile.`);
		}

		if (SCRIPT_INTERPRETERS.has(head)) {
			const meaningfulArguments = rest.filter((word) => !/^\d*>{1,2}/.test(word));
			if (meaningfulArguments.some((word) => !INTERPRETER_INSPECTION_FLAGS.has(word))) {
				return deny(`\`${head}\` can run code that writes files.`);
			}
		}

		if (head === "tar" && rest.some((word) => word === "--extract" || /^-?[A-Za-z]*x[A-Za-z]*$/.test(word))) {
			return deny("`tar` extraction writes files.");
		}
		if (
			head === "curl" &&
			rest.some(
				(word) =>
					/^-(?:o|O)/.test(word) ||
					word === "--output" ||
					word.startsWith("--output=") ||
					word === "--remote-name",
			)
		) {
			return deny("`curl` output writes files.");
		}
		if (head === "wget") return deny("`wget` writes downloaded files.");

		if (head === "git") {
			const subcommand = rest.find((word) => !word.startsWith("-"));
			if (subcommand && WRITE_GIT_SUBCOMMANDS.has(subcommand)) {
				return deny(`\`git ${subcommand}\` changes the repository. Workers commit their own work.`);
			}
		}

		for (const editor of IN_PLACE) {
			if (head !== editor.command) continue;
			if (rest.some((word) => word.startsWith("-") && word.includes("i"))) {
				return deny(`\`${head} -i\` edits files in place.`);
			}
		}
	}
	return ALLOW;
}

interface PreToolUseInput {
	tool_name?: string;
	tool_input?: { command?: string };
}

/**
 * Claude Code hook entry point: the event arrives as JSON on stdin, and the
 * decision goes back as JSON on stdout.
 */
export async function runGuard(stdin: NodeJS.ReadableStream = process.stdin): Promise<void> {
	let raw = "";
	for await (const chunk of stdin) raw += chunk;

	let event: PreToolUseInput;
	try {
		event = JSON.parse(raw) as PreToolUseInput;
	} catch {
		// A hook that cannot read its input must not silently allow everything.
		process.stdout.write(
			`${JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "ask",
					permissionDecisionReason: "Neta's guard could not read the hook payload.",
				},
			})}\n`,
		);
		return;
	}

	const command = event.tool_input?.command;
	const verdict = command ? inspectBashCommand(command) : ALLOW;
	if (verdict.decision === "allow") {
		process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse" } })}\n`);
		return;
	}
	process.stdout.write(
		`${JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: verdict.reason,
			},
		})}\n`,
	);
}
