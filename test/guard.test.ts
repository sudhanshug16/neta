/**
 * The guard is the difference between "the leader has no edit tool" and "the
 * leader cannot edit". Every case here is a way a model actually reaches for a
 * file when its edit tool is gone.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { Readable } from "node:stream";
import { inspectBashCommand, runGuard } from "../src/guard.ts";

const allowed = (command: string) => inspectBashCommand(command).decision === "allow";
const denied = (command: string) => inspectBashCommand(command).decision === "deny";

describe("bash guard", () => {
	it("allows the reading and running a leader is supposed to do", () => {
		for (const command of [
			"ls -la src",
			"cat package.json",
			"rg 'spawn' src",
			"npm test",
			"git status --porcelain",
			"git log --oneline -20",
			"git diff HEAD~1",
			"node --version 2>/dev/null",
			"npm run build > /dev/null 2>&1",
			"grep -rn foo . | head -20",
		]) {
			expect(allowed(command), command).toBe(true);
		}
	});

	it("denies the shortcuts that write files", () => {
		for (const command of [
			"echo hello > src/index.ts",
			"cat template >> config.json",
			"sed -i '' 's/a/b/' src/app.ts",
			"perl -i -pe 's/a/b/' file",
			"tee src/out.txt",
			"patch -p1 < fix.diff",
			"rm -rf dist",
			"mv a.ts b.ts",
			"cp a.ts b.ts",
			"mkdir -p src/new",
			"touch src/new.ts",
			"chmod +x script.sh",
		]) {
			expect(denied(command), command).toBe(true);
		}
	});

	it("denies git commands that change the repository", () => {
		for (const command of [
			"git commit -m 'fix'",
			"git apply patch.diff",
			"git checkout -- src",
			"git reset --hard",
		]) {
			expect(denied(command), command).toBe(true);
		}
	});

	it("sees through env prefixes, sudo and absolute paths", () => {
		expect(denied("FOO=1 rm -rf dist")).toBe(true);
		expect(denied("sudo rm -rf /etc/hosts")).toBe(true);
		expect(denied("/bin/rm file")).toBe(true);
		expect(denied("env BAR=2 sed -i s/x/y/ f")).toBe(true);
	});

	it("checks every command in a chain, not just the first", () => {
		expect(denied("npm test && echo done > result.txt")).toBe(true);
		expect(denied("ls; rm -rf build")).toBe(true);
		expect(denied("cat a | tee b")).toBe(true);
	});

	it("explains what to do instead, since the leader has to act on the refusal", () => {
		const verdict = inspectBashCommand("sed -i s/a/b/ file");

		expect(verdict.reason).toContain("edits files in place");
		expect(verdict.reason).toContain("Spawn a worker");
	});
});

describe("guard hook protocol", () => {
	async function hook(payload: unknown): Promise<Record<string, unknown>> {
		const written: string[] = [];
		const write = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		});
		await runGuard(Readable.from([JSON.stringify(payload)]));
		write.mockRestore();
		return JSON.parse(written.join("")).hookSpecificOutput;
	}

	it("denies a write with a reason Claude Code can show", async () => {
		const output = await hook({ tool_name: "Bash", tool_input: { command: "echo x > file.ts" } });

		expect(output.permissionDecision).toBe("deny");
		expect(String(output.permissionDecisionReason)).toContain("file.ts");
	});

	it("stays out of the way for a read", async () => {
		const output = await hook({ tool_name: "Bash", tool_input: { command: "cat file.ts" } });

		expect(output.permissionDecision).toBeUndefined();
	});

	// Failing open would silently remove the restriction the user was promised.
	it("asks rather than allows when the payload is unreadable", async () => {
		const written: string[] = [];
		const write = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		});
		await runGuard(Readable.from(["not json"]));
		write.mockRestore();

		expect(JSON.parse(written.join("")).hookSpecificOutput.permissionDecision).toBe("ask");
	});
});
