import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { leaderTools } from "../src/mcp/leader.ts";
import { classifyRepoCommand } from "../src/orchestrator/exec.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { buildLeaderPrompt } from "../src/prompts/leader.ts";
import { EnvStub, fixtureBackendConfig, waitFor } from "./helpers.ts";

const timeoutFixture = fileURLToPath(new URL("./fixtures/exec-timeout-fixture.ts", import.meta.url));
const outputFixture = fileURLToPath(new URL("./fixtures/exec-output-fixture.ts", import.meta.url));
const childFixture = fileURLToPath(new URL("./fixtures/sigterm-ignoring-child.mjs", import.meta.url));

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
		copyFileSync(timeoutFixture, join(dir, "test", "fixtures", "exec-timeout-fixture.test.ts"));
		copyFileSync(outputFixture, join(dir, "test", "fixtures", "exec-output-fixture.test.ts"));
		copyFileSync(childFixture, join(dir, "test", "fixtures", "sigterm-ignoring-child.mjs"));
		return dir;
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

	it("rejects Git shell, pager, helper, alias, config and option injection", async () => {
		const repo = repository();
		const value = manager(repo);
		const marker = join(repo, "shell-injection-marker");
		rmSync(marker, { force: true });
		for (const argv of [
			["git", "grep", `-O${marker}`, "initial"],
			["git", "-c", `pager.grep=sh -c 'touch ${marker}'`, "grep", "-O", "initial"],
			["git", "--config-env=alias.pwn=BAD", "pwn"],
			["git", "status", `$(touch ${marker})`],
			["git", "diff", "--ext-diff"],
			["git", "diff", "--textconv"],
			["git", "diff", "-O/tmp/order"],
			["git", "log", "--exec=sh"],
			["git", "show", "--output=/tmp/out"],
			["git", "push", "--receive-pack=sh", "origin", "main"],
			["git", "fetch", "--upload-pack=sh", "origin"],
		]) {
			await expect(tool(value).run({ argv })).rejects.toThrow();
		}
		expect(existsSync(marker)).toBe(false);
	});

	it("rejects cwd traversal and interpreter or shell bypasses", async () => {
		const repo = repository();
		const value = manager(repo);
		await expect(tool(value).run({ argv: ["git", "status"], cwd: ".." })).rejects.toThrow(
			"must remain within the session repository",
		);
		for (const argv of [
			["sh", "-c", "git status"],
			["node", "-e", "process.exit()"],
			["bun", "-e", "process.exit()"],
			["git", "-c", "alias.x=!sh", "x"],
			["git", "branch", "-D", "main"],
			["git", "diff", "--output=changed.patch"],
			["bun", "test", "--preload=payload.ts"],
			["bun", "test", "--config=payload.toml"],
			["bun", "test", "--env-file=.env"],
			["bun", "test", "--test-worker"],
			["bun", "test", "--reporter-outfile=/tmp/report"],
		]) {
			await expect(tool(value).run({ argv })).rejects.toThrow();
		}
	});

	it("confines every Bun test path to the real repository", async () => {
		const repo = repository();
		const value = manager(repo);
		const outside = mkdtempSync(join(tmpdir(), "neta-exec-outside-"));
		dirs.push(outside);
		const marker = join(outside, "outside-marker");
		const payload = join(outside, "payload.test.ts");
		writeFileSync(
			payload,
			`import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("pwn", () => writeFileSync(${JSON.stringify(marker)}, "yes"));\n`,
		);
		symlinkSync(outside, join(repo, "outside-link"));

		await expect(tool(value).run({ argv: ["bun", "test", payload] })).rejects.toThrow("must be relative");
		await expect(tool(value).run({ argv: ["bun", "test", "--bail", payload] })).rejects.toThrow("must be relative");
		await expect(tool(value).run({ argv: ["bun", "test", "../payload.test.ts"] })).rejects.toThrow("escapes");
		await expect(tool(value).run({ argv: ["bun", "test", "outside-link/payload.test.ts"] })).rejects.toThrow(
			"escapes",
		);
		await expect(tool(value).run({ argv: ["bun", "test", "outside-link/not-created.test.ts"] })).rejects.toThrow(
			"escapes",
		);
		expect(existsSync(marker)).toBe(false);
	});

	it("canonicalizes every supported Bun target form before running exactly one local test", async () => {
		const repo = repository();
		const value = manager(repo);
		const outside = mkdtempSync(join(tmpdir(), "neta-exec-outside-discovery-"));
		dirs.push(outside);
		const localMarker = join(repo, "local-test-marker");
		const outsideMarker = join(outside, "outside-test-marker");
		writeFileSync(
			join(repo, "test", "exec.test.ts"),
			`import { test } from "bun:test"; import { appendFileSync } from "node:fs"; test("local target", () => appendFileSync(${JSON.stringify(localMarker)}, "ran\\n"));\n`,
		);
		mkdirSync(join(outside, "test"));
		writeFileSync(
			join(outside, "test", "exec.test.ts"),
			`import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("outside", () => writeFileSync(${JSON.stringify(outsideMarker)}, "ran"));\n`,
		);
		symlinkSync(outside, join(repo, "outside-link"));

		await expect(tool(value).run({ argv: ["bun", "test"] })).rejects.toThrow("explicit repository test file");
		for (const argv of [
			["bun", "test", "test/exec.test.ts"],
			["bun", "test", "--", "test/exec.test.ts"],
			["bun", "test", "test/exec.test.ts", "-t", "local target"],
			["bun", "test", "./test/exec.test.ts"],
		]) {
			rmSync(localMarker, { force: true });
			rmSync(outsideMarker, { force: true });
			const targeted = await value.exec({ argv });
			expect(targeted.exitCode).toBe(0);
			expect(readFileSync(localMarker, "utf-8")).toBe("ran\n");
			expect(existsSync(outsideMarker)).toBe(false);
		}
		rmSync(localMarker, { force: true });
		const nested = await value.exec({ argv: ["bun", "test", "exec.test.ts"], cwd: "test" });
		expect(nested.exitCode).toBe(0);
		expect(readFileSync(localMarker, "utf-8")).toBe("ran\n");
		expect(existsSync(outsideMarker)).toBe(false);
	});

	it("disables repository hooks for every allowed Git inspection command", async () => {
		const repo = repository();
		const value = manager(repo);
		const marker = join(repo, "hook-marker");
		const hook = join(repo, ".git", "hooks", "post-index-change");
		writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
		chmodSync(hook, 0o755);
		rmSync(marker, { force: true });
		writeFileSync(join(repo, "tracked.txt"), "changed\n");

		for (const argv of [
			["git", "status", "--porcelain"],
			["git", "diff", "--", "tracked.txt"],
			["git", "log", "-n1"],
			["git", "ls-files"],
			["git", "rev-parse", "--show-toplevel"],
			["git", "show", "--stat", "HEAD"],
		]) {
			const result = await value.exec({ argv });
			expect(result.exitCode).toBe(0);
			expect(existsSync(marker)).toBe(false);
		}
	});

	it("refuses configured clean/process filters before status or diff can run them", async () => {
		const repo = repository();
		const value = manager(repo);
		const marker = join(repo, "filter-marker");
		writeFileSync(join(repo, ".gitattributes"), "tracked.txt filter=reviewer-probe\n");
		execFileSync("git", ["config", "filter.reviewer-probe.clean", `sh -c 'touch ${marker}'`], { cwd: repo });
		execFileSync("git", ["config", "filter.reviewer-probe.process", `sh -c 'touch ${marker}'`], { cwd: repo });
		writeFileSync(join(repo, "tracked.txt"), "changed\n");

		for (const argv of [
			["git", "status", "--porcelain"],
			["git", "diff", "--", "tracked.txt"],
		]) {
			await expect(value.exec({ argv })).rejects.toThrow("filter.*.clean/process");
			expect(existsSync(marker)).toBe(false);
		}
		for (const argv of [
			["git", "log", "-n1"],
			["git", "ls-files"],
			["git", "rev-parse", "--show-toplevel"],
			["git", "show", "--stat", "HEAD"],
		]) {
			expect((await value.exec({ argv })).exitCode).toBe(0);
			expect(existsSync(marker)).toBe(false);
		}
	});

	it("accepts the documented Git status porcelain and untracked-file grammar only", () => {
		for (const argv of [
			["git", "status", "--porcelain"],
			["git", "status", "--porcelain=v1"],
			["git", "status", "--porcelain=v2", "-uall", "--branch"],
			["git", "status", "-u"],
			["git", "status", "-uno", "--short"],
			["git", "status", "-unormal", "-b"],
			["git", "status", "--untracked-files", "all", "--show-stash"],
			["git", "status", "--untracked-files=no", "--ahead-behind"],
		]) {
			expect(classifyRepoCommand(argv)).toEqual({ writeCapable: false, kind: "git-inspection" });
		}
		for (const argv of [
			["git", "status", "--porcelain=v3"],
			["git", "status", "--porcelain=../../payload"],
			["git", "status", "-usometimes"],
			["git", "status", "--untracked-files=../../payload"],
			["git", "status", "--untracked-files", "sometimes"],
		]) {
			expect(() => classifyRepoCommand(argv)).toThrow();
		}
	});

	it("refuses write-capable commands while a writer owns or waits for the slot", async () => {
		const repo = repository();
		const value = manager(repo);
		await value.spawn({ role: "worker", tier: "expert", task: "hold", writer: true });
		await value.spawn({ role: "worker", tier: "expert", task: "queue", writer: true });

		await expect(tool(value).run({ argv: ["bun", "test", "missing.test.ts"] })).rejects.toThrow(
			"owns or is queued for the writer slot",
		);
		await expect(
			tool(value).run({ argv: ["git", "push", "origin", "HEAD:main"], userApproved: true }),
		).rejects.toThrow("owns or is queued for the writer slot");
	});

	it("pushes only with direct authority and runs the normal pre-push hook", async () => {
		const repo = repository();
		const value = manager(repo);
		const remote = mkdtempSync(join(tmpdir(), "neta-exec-remote-"));
		dirs.push(remote);
		execFileSync("git", ["init", "--bare", "-q"], { cwd: remote });
		execFileSync("git", ["remote", "add", "reviewer-remote", remote], { cwd: repo });
		writeFileSync(join(repo, "tracked.txt"), "authorized push\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "push fixture"], { cwd: repo });
		const marker = join(repo, "pre-push-marker");
		const hook = join(repo, ".git", "hooks", "pre-push");
		writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
		chmodSync(hook, 0o755);
		const argv = ["git", "push", "reviewer-remote", "HEAD:refs/heads/main"];

		await expect(tool(value).run({ argv })).rejects.toThrow("direct user authority");
		expect(existsSync(marker)).toBe(false);
		expect(() => execFileSync("git", ["rev-parse", "--verify", "refs/heads/main"], { cwd: remote })).toThrow();

		const result = await value.exec({ argv, userApproved: true });
		expect(result.exitCode).toBe(0);
		expect(existsSync(marker)).toBe(true);
		expect(execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: remote, encoding: "utf-8" }).trim()).toBe(
			execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim(),
		);
	});

	it("rejects push option, URL, deletion, force, and multi-refspec forms", () => {
		for (const argv of [
			["git", "push"],
			["git", "push", "https://example.invalid/repo.git", "main"],
			["git", "push", "origin", "--all"],
			["git", "push", "origin", "+main"],
			["git", "push", "origin", ":main"],
			["git", "push", "origin", "main", "other"],
		]) {
			expect(() => classifyRepoCommand(argv, true)).toThrow();
		}
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
		const env = new EnvStub();
		env.set("NETA_EXEC_TEST_SECRET", "must-not-leak");
		const result = await manager(repo)
			.exec({ argv: ["bun", "test", "./test/fixtures/exec-output-fixture.test.ts"] })
			.finally(() => env.restore());
		const full = readFileSync(result.outputPath, "utf-8");

		expect(full.indexOf("ORDER_ONE")).toBeLessThan(full.indexOf("ORDER_TWO"));
		expect(full.indexOf("ORDER_TWO")).toBeLessThan(full.indexOf("ORDER_THREE"));
		expect(full).toContain("SECRET_ABSENT");
		expect(full).not.toContain("must-not-leak");
	});

	it("bounds displayed output and leaves the exact full response in its audit file", async () => {
		const repo = repository();
		const tail = "FULL_OUTPUT_TAIL";
		writeFileSync(join(repo, "tracked.txt"), `${"changed line\n".repeat(2_000)}${tail}\n`);
		const result = await tool(manager(repo)).run({ argv: ["git", "diff", "--", "tracked.txt"] });
		const text = body(result);
		const suffix = /Read the entire response here: (.+)$/.exec(text);

		expect(suffix).toBeTruthy();
		expect(text.endsWith(`Read the entire response here: ${suffix?.[1]}`)).toBe(true);
		expect(readFileSync(suffix?.[1] as string, "utf-8")).toContain(tail);
	});

	it("times out and kills the detached Bun test process group and its descendant", async () => {
		const repo = repository();
		const value = manager(repo);
		const running = value.exec({
			argv: ["bun", "test", "./test/fixtures/exec-timeout-fixture.test.ts"],
			timeoutMs: 250,
		});
		await waitFor(() => existsSync(join(repo, "exec-descendant.pid")));
		await expect(value.spawn({ role: "worker", tier: "expert", task: "must wait", writer: true })).rejects.toThrow(
			"neta_exec command owns the writer safety guard",
		);
		const result = await running;

		expect(result).toMatchObject({ exitCode: 124, timedOut: true });
		const descendant = Number.parseInt(readFileSync(join(repo, "exec-descendant.pid"), "utf-8"), 10);
		expect(() => process.kill(descendant, 0)).toThrow();
	});

	it("tells the leader the narrow scope, authority rule, and writer conflict", () => {
		const prompt = buildLeaderPrompt({ tiers: {} });
		expect(prompt).toContain("guarded escape hatch for small, fully");
		expect(prompt).toContain("source\nedits");
		expect(prompt).toContain("userApproved:true");
		expect(prompt).toContain("pre-push hook runs with host permissions");
		expect(prompt).toContain("repository clean/process filters are configured");
		expect(prompt).toContain("refused while a\nworker owns or is queued for the writer slot");
	});
});
