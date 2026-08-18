import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { leaderTools } from "../src/mcp/leader.ts";
import { OUTPUT_LIMIT_BYTES, SPAWN_FAILURE_EXIT_CODE } from "../src/orchestrator/exec.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { buildLeaderPrompt } from "../src/prompts/leader.ts";
import { fixtureBackendConfig, waitFor } from "./helpers.ts";

const timeoutFixture = fileURLToPath(new URL("./fixtures/exec-timeout-fixture.ts", import.meta.url));
const outputFixture = fileURLToPath(new URL("./fixtures/exec-output-fixture.ts", import.meta.url));
const childFixture = fileURLToPath(new URL("./fixtures/sigterm-ignoring-child.mjs", import.meta.url));
const echoFixture = fileURLToPath(new URL("./fixtures/exec-echo-fixture.mjs", import.meta.url));

class HoldingTransport implements WorkerTransportDriver {
	readonly options: TransportOptions;
	constructor(options: TransportOptions) {
		this.options = options;
	}
	start(): Promise<void> {
		return Promise.resolve();
	}
	prompt(): Promise<PromptOutcome> {
		return new Promise(() => {});
	}
	cancel(): boolean {
		return true;
	}
	kill(): Promise<void> {
		return Promise.resolve();
	}
	markTerminal(): void {}
}

function body(result: CallToolResult): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

describe("neta_exec", () => {
	const dirs: string[] = [];
	const managers: WorkerManager[] = [];

	afterEach(async () => {
		for (const manager of managers.splice(0)) await manager.dispose();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function repository(): string {
		const dir = mkdtempSync(join(tmpdir(), "neta-exec-repo-"));
		dirs.push(dir);
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "test@neta.invalid"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "Neta Test"], { cwd: dir });
		writeFileSync(join(dir, "tracked.txt"), "initial\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir });
		mkdirSync(join(dir, "test", "fixtures"), { recursive: true });
		copyInto(dir, timeoutFixture, "exec-timeout-fixture.test.ts");
		copyInto(dir, outputFixture, "exec-output-fixture.test.ts");
		copyInto(dir, childFixture, "sigterm-ignoring-child.mjs");
		return dir;
	}

	function copyInto(repo: string, source: string, name: string): void {
		writeFileSync(join(repo, "test", "fixtures", name), readFileSync(source));
	}

	function manager(repo: string): WorkerManager {
		const sessionDir = mkdtempSync(join(tmpdir(), "neta-exec-session-"));
		dirs.push(sessionDir);
		const value = new WorkerManager({
			cwd: repo,
			agentDir: sessionDir,
			config: fixtureBackendConfig(),
			channelAddress: join(sessionDir, "neta.sock"),
			execOutputDir: join(sessionDir, "exec"),
			onEvent: () => {},
			createTransport: (options) => new HoldingTransport(options),
		});
		managers.push(value);
		return value;
	}

	function tool(value: WorkerManager) {
		const found = leaderTools(value).find((candidate) => candidate.name === "neta_exec");
		if (!found) throw new Error("neta_exec missing");
		return found;
	}

	it("runs an arbitrary shell command, including shell-control characters in the source string", async () => {
		const repo = repository();
		const value = manager(repo);
		const result = await value.exec({
			argv: ["sh", "-c", "echo a; echo b | cat; echo `echo backticked`; echo $(echo substituted) > /dev/stdout"],
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("a");
		expect(result.output).toContain("b");
		expect(result.output).toContain("backticked");
		expect(result.output).toContain("substituted");
	});

	it("runs an absolute executable path with an absolute argument, not only bare allowlisted names", async () => {
		const repo = repository();
		const value = manager(repo);
		const result = await value.exec({ argv: [realpathSync(process.execPath), echoFixture] });
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("ABSOLUTE_EXEC_OK");
	});

	it("accepts git subcommands, flags and config/alias injection the old grammar disallowed entirely", async () => {
		const repo = repository();
		const value = manager(repo);
		writeFileSync(join(repo, "needle.txt"), "unique-grep-target\n");
		execFileSync("git", ["add", "needle.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "add needle"], { cwd: repo });

		const grep = await value.exec({ argv: ["git", "grep", "-n", "unique-grep-target"] });
		expect(grep.exitCode).toBe(0);
		expect(grep.output).toContain("unique-grep-target");

		execFileSync("git", ["branch", "throwaway"], { cwd: repo });
		const branchDelete = await value.exec({ argv: ["git", "branch", "-D", "throwaway"] });
		expect(branchDelete.exitCode).toBe(0);
		expect(() => execFileSync("git", ["rev-parse", "--verify", "throwaway"], { cwd: repo })).toThrow();

		const aliasInjection = await value.exec({
			argv: ["git", "-c", "alias.pwn=!echo injected-alias-ran", "pwn"],
		});
		expect(aliasInjection.exitCode).toBe(0);
		expect(aliasInjection.output).toContain("injected-alias-ran");
	});

	it("runs git push with options the old grammar forbade entirely and no userApproved gate, without actually pushing", async () => {
		const repo = repository();
		const value = manager(repo);
		const remote = mkdtempSync(join(tmpdir(), "neta-exec-remote-"));
		dirs.push(remote);
		execFileSync("git", ["init", "--bare", "-q"], { cwd: remote });
		execFileSync("git", ["remote", "add", "reviewer-remote", remote], { cwd: repo });

		const result = await value.exec({
			argv: ["git", "push", "--dry-run", "--force", "reviewer-remote", "HEAD:refs/heads/main"],
		});

		expect(result.exitCode).toBe(0);
		expect(() => execFileSync("git", ["rev-parse", "--verify", "refs/heads/main"], { cwd: remote })).toThrow();
	});

	it("runs in any existing directory, not only the session repository", async () => {
		const repo = repository();
		const value = manager(repo);
		const outside = mkdtempSync(join(tmpdir(), "neta-exec-outside-cwd-"));
		dirs.push(outside);

		const result = await value.exec({ argv: ["sh", "-c", "touch outside-marker"], cwd: outside });

		expect(result.cwd).toBe(realpathSync(outside));
		expect(existsSync(join(outside, "outside-marker"))).toBe(true);
	});

	it("resolves a relative cwd against the session's own working directory", async () => {
		const repo = repository();
		const value = manager(repo);
		const result = await value.exec({ argv: ["sh", "-c", "pwd"], cwd: "test/fixtures" });
		expect(result.cwd).toBe(realpathSync(join(repo, "test", "fixtures")));
	});

	it("no longer refuses any neta_exec command because a worker owns or is queued for the writer slot", async () => {
		const repo = repository();
		const value = manager(repo);
		await value.spawn({ role: "worker", tier: "expert", task: "hold", writer: true });
		await value.spawn({ role: "worker", tier: "expert", task: "queue", writer: true });

		const result = await tool(value).run({ argv: ["true"] });
		expect(body(result)).toMatch(/Exit code: 0/);
	});

	it("rejects structurally invalid input before any process runs, and never counts it as an accepted call", async () => {
		const repo = repository();
		const value = manager(repo);

		await expect(tool(value).run({ argv: [] })).rejects.toThrow();
		await expect(tool(value).run({ argv: ["ok", 7] })).rejects.toThrow();
		await expect(value.exec({ argv: [] })).rejects.toThrow("non-empty argv");
		await expect(value.exec({ argv: ["true", "bad\0arg"] })).rejects.toThrow("NUL");
		await expect(value.exec({ argv: ["true"], cwd: join(repo, "does-not-exist") })).rejects.toThrow("does not exist");
		await expect(value.exec({ argv: ["true"], cwd: join(repo, "tracked.txt") })).rejects.toThrow("not a directory");
		await expect(value.exec({ argv: ["true"], timeoutMs: 0 })).rejects.toThrow("timeout");
		await expect(value.exec({ argv: ["true"], timeoutMs: 700_000 })).rejects.toThrow("timeout");
		await expect(value.exec({ argv: ["true"], timeoutMs: 1.5 })).rejects.toThrow("timeout");

		const stillFirst = await tool(value).run({ argv: ["true"] });
		expect(body(stillFirst)).not.toContain("call #");
	});

	it("rejects an out-of-range timeoutSeconds structurally at the MCP boundary before it can round into a valid millisecond value, and never counts it", async () => {
		const repo = repository();
		const value = manager(repo);

		await expect(tool(value).run({ argv: ["true"], timeoutSeconds: 600.0004 })).rejects.toThrow();
		await expect(tool(value).run({ argv: ["true"], timeoutSeconds: 0 })).rejects.toThrow();
		await expect(tool(value).run({ argv: ["true"], timeoutSeconds: -1 })).rejects.toThrow();
		await expect(tool(value).run({ argv: ["true"], timeoutSeconds: Number.POSITIVE_INFINITY })).rejects.toThrow();
		await expect(tool(value).run({ argv: ["true"], timeoutSeconds: Number.NaN })).rejects.toThrow();

		const stillFirst = body(await tool(value).run({ argv: ["true"] }));
		expect(stillFirst).not.toContain("call #");
	});

	it("returns a completed result instead of throwing when the command cannot be spawned, and still carries its call number", async () => {
		const repo = repository();
		const missing = "neta-exec-test-missing-binary-xyz";

		const raw = await manager(repo).exec({ argv: [missing] });
		expect(raw.exitCode).toBe(SPAWN_FAILURE_EXIT_CODE);
		expect(raw.output.toLowerCase()).toMatch(/enoent|not found/);
		expect(raw.callNumber).toBe(1);

		const value = manager(repo);
		const first = body(await tool(value).run({ argv: [missing] }));
		expect(first).not.toContain("call #");
		expect(first.toLowerCase()).toMatch(/enoent|not found/);

		const second = body(await tool(value).run({ argv: [missing] }));
		expect(second).toContain("call #2");
		expect(second.toLowerCase()).toContain("delegate");
	});

	it("returns nonzero exits with cwd, duration, and a full audit path", async () => {
		const repo = repository();
		const result = await tool(manager(repo)).run({ argv: ["git", "rev-parse", "--verify", "missing-ref"] });
		const text = body(result);

		expect(text).toMatch(/Exit code: [1-9]/);
		expect(text).toContain(`Cwd: ${realpathSync(repo)}`);
		expect(text).toMatch(/Duration: \d+ ms/);
		const path = /Output file: (.+)/.exec(text)?.[1];
		expect(path).toBeTruthy();
		expect(readFileSync(path as string, "utf-8")).toContain("Needed a single revision");
		expect(statSync(dirname(path as string)).mode & 0o777).toBe(0o700);
		expect(statSync(path as string).mode & 0o777).toBe(0o600);
	});

	it("captures stdout and stderr in their shared descriptor order", async () => {
		const repo = repository();
		const result = await manager(repo).exec({ argv: ["bun", "test", "./test/fixtures/exec-output-fixture.test.ts"] });
		const full = readFileSync(result.outputPath, "utf-8");

		expect(full.indexOf("ORDER_ONE")).toBeLessThan(full.indexOf("ORDER_TWO"));
		expect(full.indexOf("ORDER_TWO")).toBeLessThan(full.indexOf("ORDER_THREE"));
	});

	it("bounds displayed output to head and tail, states the output was too large to inspect, and names the exact full-output path", async () => {
		const repo = repository();
		const value = manager(repo);
		const script = [
			"printf 'HEAD_MARKER\\n'",
			"i=0",
			"while [ $i -lt 2000 ]; do printf 'line-%04d-filler-filler-filler\\n' $i; i=$((i+1)); done",
			"printf 'TAIL_MARKER\\n'",
		].join("; ");
		const argv = ["sh", "-c", script];

		const raw = await value.exec({ argv });
		expect(raw.truncated).toBe(true);
		expect(Buffer.byteLength(raw.output, "utf-8")).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
		expect(raw.output).toContain("HEAD_MARKER");
		expect(raw.output).toContain("TAIL_MARKER");
		expect(raw.output).not.toContain("line-1000-filler");

		const result = await tool(value).run({ argv });
		const text = body(result);

		expect(text).toContain("too large");
		expect(text.toLowerCase()).toMatch(/delegate.*(apprentice|scout)/s);
		expect(text).toContain("HEAD_MARKER");
		expect(text).toContain("TAIL_MARKER");
		expect(text).not.toContain("line-1000-filler");
		expect(text).toContain("output truncated");

		const path = /Full output: (.+)/.exec(text)?.[1];
		expect(path).toBeTruthy();
		const full = readFileSync(path as string, "utf-8");
		expect(full).toContain("HEAD_MARKER");
		expect(full).toContain("line-1000-filler");
		expect(full).toContain("TAIL_MARKER");
		expect(statSync(dirname(path as string)).mode & 0o777).toBe(0o700);
		expect(statSync(path as string).mode & 0o777).toBe(0o600);
	});

	it("warns starting at the second accepted call, naming the exact call number, and never on the first", async () => {
		const repo = repository();
		const value = manager(repo);

		const first = body(await tool(value).run({ argv: ["true"] }));
		expect(first).not.toContain("call #");
		expect(first.toLowerCase()).not.toContain("delegate");

		const second = body(await tool(value).run({ argv: ["true"] }));
		expect(second).toContain("call #2");
		expect(second.toLowerCase()).toContain("delegate");

		const third = body(await tool(value).run({ argv: ["true"] }));
		expect(third).toContain("call #3");
	});

	it("counts a failed command exit as accepted once it has passed structural validation", async () => {
		const repo = repository();
		const value = manager(repo);

		const first = body(await tool(value).run({ argv: ["sh", "-c", "exit 3"] }));
		expect(first).toMatch(/Exit code: 3/);
		expect(first).not.toContain("call #");

		const second = body(await tool(value).run({ argv: ["true"] }));
		expect(second).toContain("call #2");
	});

	it("never rejects or delays the command because of the frequency warning", async () => {
		const repo = repository();
		const value = manager(repo);
		await tool(value).run({ argv: ["true"] });
		const result = await tool(value).run({ argv: ["git", "rev-parse", "--verify", "missing-ref"] });
		expect(body(result)).toMatch(/Exit code: [1-9]/);
		expect(body(result)).toContain("call #2");
	});

	it("times out and kills the detached process group and its descendant, without taking the writer slot from a concurrent spawn", async () => {
		const repo = repository();
		const value = manager(repo);
		const running = value.exec({
			argv: ["bun", "test", "./test/fixtures/exec-timeout-fixture.test.ts"],
			timeoutMs: 250,
		});
		await waitFor(() => existsSync(join(repo, "exec-descendant.pid")));

		const summary = await value.spawn({
			role: "worker",
			tier: "expert",
			task: "writer while exec runs",
			writer: true,
		});
		expect(summary.state).not.toBe("queued");

		const result = await running;
		expect(result).toMatchObject({ exitCode: 124, timedOut: true });
		const descendant = Number.parseInt(readFileSync(join(repo, "exec-descendant.pid"), "utf-8"), 10);
		expect(() => process.kill(descendant, 0)).toThrow();
	});

	it("tells the leader the command surface is unrestricted, userApproved is ignored, and truncation/discovery delegation are expected", () => {
		const prompt = buildLeaderPrompt({ tiers: {} });
		expect(prompt).toContain("or a bounded diff — not\nto edit files yourself.");
		expect(prompt).toContain("no command allowlist: any\nexecutable name or path");
		expect(prompt).toContain(
			"does not sandbox `git push`, and\ndoes not gate push or any other command on user approval",
		);
		expect(prompt).toContain("`userApproved` is\naccepted for compatibility but ignored.");
		expect(prompt).toContain(
			"the result also names its call number and tells you to delegate repeated\ndiscovery to a worker",
		);
	});
});
