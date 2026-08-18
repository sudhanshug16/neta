import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("passes argv literally without shell interpolation", async () => {
		const repo = repository();
		const marker = join(repo, "interpolated");
		const result = await tool(manager(repo)).run({ argv: ["git", "status", "--short", `$(touch ${marker})`] });

		expect(body(result)).toContain("Exit code:");
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
		]) {
			await expect(tool(value).run({ argv })).rejects.toThrow();
		}
		await expect(
			tool(value).run({ argv: ["git", "push", "--exec=sh", "origin", "main"], userApproved: true }),
		).rejects.toThrow("does not allow Git option");
	});

	it("refuses write-capable commands while a writer owns or waits for the slot", async () => {
		const repo = repository();
		const value = manager(repo);
		await value.spawn({ role: "worker", tier: "expert", task: "hold", writer: true });
		await value.spawn({ role: "worker", tier: "expert", task: "queue", writer: true });

		await expect(tool(value).run({ argv: ["bun", "test", "missing.test.ts"] })).rejects.toThrow(
			"owns or is queued for the writer slot",
		);
		await expect(tool(value).run({ argv: ["git", "push", "origin", "main"], userApproved: true })).rejects.toThrow(
			"owns or is queued for the writer slot",
		);
	});

	it("classifies a push-shaped argv without contacting a remote", () => {
		expect(() => classifyRepoCommand(["git", "push", "origin", "main"])).toThrow("explicitly authorized");
		expect(classifyRepoCommand(["git", "push", "origin", "main"], true)).toEqual({
			writeCapable: true,
			outward: true,
		});
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
	});

	it("captures stdout and stderr in their shared descriptor order", async () => {
		const repo = repository();
		const env = new EnvStub();
		env.set("NETA_EXEC_TEST_SECRET", "must-not-leak");
		const result = await manager(repo)
			.exec({ argv: ["bun", "test", outputFixture] })
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
		const running = value.exec({ argv: ["bun", "test", timeoutFixture], timeoutMs: 250 });
		await waitFor(() => expect(existsSync(join(repo, "exec-descendant.pid"))).toBe(true));
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
		expect(prompt).toContain("not a way to edit source");
		expect(prompt).toContain("explicit user authority");
		expect(prompt).toContain("refused while a worker owns or is queued for the writer slot");
	});
});
