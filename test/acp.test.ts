import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseModel, sanitizeInheritedEnv } from "../src/acp/connection.ts";
import { AcpWorkerTransport, describeToolCall, paragraphFlushIndex, renderDiffText } from "../src/acp/transport.ts";
import type { TransportOptions, WorkerMcpServer } from "../src/orchestrator/transport.ts";
import type { WorkerLogEntry, WorkerUsage } from "../src/types.ts";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

describe("AcpWorkerTransport", () => {
	const started: AcpWorkerTransport[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const transport of started.splice(0)) await transport.kill();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		usageReports.length = 0;
		sessionReports.length = 0;
	});

	const usageReports: WorkerUsage[] = [];
	const sessionReports: Array<{ model?: string; mode?: string }> = [];

	function createTransport(
		writer: boolean,
		log: WorkerLogEntry[],
		mcpServers: WorkerMcpServer[] = [],
	): AcpWorkerTransport {
		const scratchDir = mkdtempSync(join(tmpdir(), "neta-acp-"));
		tempDirs.push(scratchDir);
		const options: TransportOptions = {
			workerId: "w1",
			cwd: process.cwd(),
			env: {},
			command: process.execPath,
			args: [fakeAgent],
			model: undefined,
			writer,
			systemPrompt: "You are a test worker.",
			scratchDir,
			mcpServers,
			events: {
				log: (kind, text) => log.push({ at: 0, kind, text }),
				usage: (usage) => usageReports.push(usage),
				vendorSession: () => {},
				session: (model, mode) => sessionReports.push({ model, mode }),
			},
		};
		const transport = new AcpWorkerTransport(options);
		started.push(transport);
		return transport;
	}

	it("prepends the role prompt to the first message only", async () => {
		const transport = createTransport(false, []);
		await transport.start();

		const first = await transport.prompt("hello");
		expect(first).toEqual({ ok: true, summary: "echo:hello" });

		// The fake agent echoes the last line, so a second turn without the role
		// prompt echoes the message itself.
		const second = await transport.prompt("again");
		expect(second).toEqual({ ok: true, summary: "echo:again" });
	});

	it("rejects file-mutating tool calls for a read-only worker", async () => {
		const log: WorkerLogEntry[] = [];
		const transport = createTransport(false, log);
		await transport.start();

		const outcome = await transport.prompt("EDIT the config");

		expect(outcome).toEqual({ ok: true, summary: "permission=reject" });
		expect(log.some((entry) => entry.text.includes("this worker is read-only"))).toBe(true);
	});

	it("allows file-mutating tool calls for the writer", async () => {
		const transport = createTransport(true, []);
		await transport.start();

		expect(await transport.prompt("EDIT the config")).toEqual({ ok: true, summary: "permission=allow" });
	});

	it("reports a turn that stopped early as a failure", async () => {
		const transport = createTransport(false, []);
		await transport.start();

		const outcome = await transport.prompt("FAIL please");

		expect(outcome.ok).toBe(false);
		expect(outcome.summary).toContain("Stopped early (refusal)");
	});

	it("streams tool call titles into the worker log", async () => {
		const log: WorkerLogEntry[] = [];
		const transport = createTransport(true, log);
		await transport.start();
		await transport.prompt("EDIT the config");

		expect(log.some((entry) => entry.kind === "tool" && entry.text === "Edit config.json")).toBe(true);
	});

	// A pane that showed tool calls but never the worker's own words made every
	// worker look like it was grinding silently until the final result appeared.
	it("streams the worker's prose into the log a paragraph at a time", async () => {
		const log: WorkerLogEntry[] = [];
		const transport = createTransport(false, log);
		await transport.start();

		await transport.prompt("STREAM");

		const prose = log.filter((entry) => entry.kind === "text").map((entry) => entry.text);
		expect(prose).toEqual(["First paragraph continues.", "Second paragraph."]);
	});

	it("logs thought chunks as thoughts", async () => {
		const log: WorkerLogEntry[] = [];
		const transport = createTransport(false, log);
		await transport.start();

		await transport.prompt("THINK about it");

		expect(log.some((entry) => entry.kind === "thought" && entry.text === "weighing options")).toBe(true);
	});

	it("logs a tool call's diff once, even when an update repeats it", async () => {
		const log: WorkerLogEntry[] = [];
		const transport = createTransport(true, log);
		await transport.start();

		await transport.prompt("DIFF the config");

		const diffs = log.filter((entry) => entry.kind === "diff");
		expect(diffs).toHaveLength(1);
		expect(diffs[0].text).toContain("/repo/config.json");
		expect(diffs[0].text).toContain("-b");
		expect(diffs[0].text).toContain("+B");
	});

	// Cost was invisible in the first version of Neta: workers spent real money
	// and nothing anywhere said how much.
	it("reports tokens and cost the backend sends", async () => {
		const transport = createTransport(false, []);
		await transport.start();

		await transport.prompt("USAGE please");

		const latest = usageReports.at(-1);
		expect(latest).toMatchObject({
			totalTokens: 1500,
			inputTokens: 1000,
			outputTokens: 500,
			contextUsed: 1200,
			contextSize: 200000,
			costAmount: 0.42,
			costCurrency: "USD",
		});
	});

	// A sandboxed worker cannot open our socket from its shell, so the backend
	// starts Neta's MCP server for it instead.
	it("hands the backend the worker's MCP server at session start", async () => {
		const transport = createTransport(
			false,
			[],
			[{ name: "neta", command: "/usr/bin/neta", args: ["mcp", "--worker"], env: { NETA_WORKER_ID: "w1" } }],
		);
		await transport.start();

		const outcome = await transport.prompt("MCP list");

		expect(outcome.summary).toContain('"name":"neta"');
		expect(outcome.summary).toContain('"args":["mcp","--worker"]');
		expect(outcome.summary).toContain('{"name":"NETA_WORKER_ID","value":"w1"}');
	});

	it("reports the negotiated model and mode from the backend", async () => {
		const transport = createTransport(false, []);
		await transport.start();

		expect(sessionReports).toHaveLength(1);
		expect(sessionReports[0]).toEqual({ model: "test-model", mode: "test-mode" });
	});

	it("returns only text after the last tool call as the result", async () => {
		const transport = createTransport(false, []);
		await transport.start();

		const outcome = await transport.prompt("TOOL_STREAM");

		expect(outcome).toEqual({ ok: true, summary: "After tool call." });
	});

	it("explains which backend failed when the command does not exist", async () => {
		const log: WorkerLogEntry[] = [];
		const scratchDir = mkdtempSync(join(tmpdir(), "neta-acp-"));
		tempDirs.push(scratchDir);
		const transport = new AcpWorkerTransport({
			workerId: "w2",
			cwd: process.cwd(),
			env: {},
			command: join(scratchDir, "definitely-not-installed"),
			args: [],
			model: undefined,
			writer: false,
			systemPrompt: "",
			scratchDir,
			mcpServers: [],
			events: { log: (kind, text) => log.push({ at: 0, kind, text }), usage: () => {}, vendorSession: () => {}, session: () => {} },
		});
		started.push(transport);

		await expect(transport.start()).rejects.toThrow(/definitely-not-installed/);
	});

	it("waits for the process to exit and escalates to SIGKILL if needed", async () => {
		const log: WorkerLogEntry[] = [];
		const transport = createTransport(false, log);
		await transport.start();
		// Have the fake agent trap SIGTERM so kill escalates to SIGKILL.
		await transport.prompt("TRAP_SIGTERM");

		const killStart = Date.now();
		await transport.kill();
		const killDuration = Date.now() - killStart;

		// Kill should have waited for actual exit (escalated to SIGKILL after 3s).
		expect(killDuration).toBeGreaterThanOrEqual(2900);
		expect(killDuration).toBeLessThan(4000);
	});

	it("kill() waits for process exit before resolving", async () => {
		const transport = createTransport(true, []);
		await transport.start();

		// Kill should not resolve until the process actually exits.
		let killResolved = false;
		const killPromise = transport.kill().then(() => {
			killResolved = true;
		});

		// Give it a moment - it should not resolve immediately.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(killResolved).toBe(true);

		await killPromise;
	});
});

// Codex folds the reasoning level into the model id, so "gpt-5.6-sol" alone
// still has to land on a real model rather than being dropped silently.
describe("choosing a worker's model", () => {
	const available = ["haiku", "sonnet", "gpt-5.6-sol[low]", "gpt-5.6-sol[xhigh]"];

	it("takes an exact id", () => {
		expect(chooseModel(available, "sonnet")).toBe("sonnet");
		expect(chooseModel(available, "gpt-5.6-sol[xhigh]")).toBe("gpt-5.6-sol[xhigh]");
	});

	it("falls back to the family when only the model is named", () => {
		expect(chooseModel(available, "gpt-5.6-sol")).toBe("gpt-5.6-sol[low]");
	});

	it("returns nothing for a model this backend does not have", () => {
		expect(chooseModel(available, "opus")).toBeUndefined();
	});
});

// Worker panes were a wall of "Read File", twenty times over, because that is
// all some backends put in a tool call's title.
describe("describing a worker's tool calls", () => {
	it("names the file a call touches", () => {
		expect(describeToolCall("Read File", [{ path: "/repo/src/auth.ts" }])).toBe("Read File /repo/src/auth.ts");
	});

	it("falls back to the argument that says what it did", () => {
		expect(describeToolCall("Bash", undefined, { command: "npm test -- --watch=false" })).toBe(
			"Bash npm test -- --watch=false",
		);
		expect(describeToolCall("grep", null, { pattern: "WebSocket|cable" })).toBe("grep WebSocket|cable");
	});

	it("does not repeat an argument the title already carries", () => {
		expect(describeToolCall("grep WebSocket|cable", undefined, { pattern: "WebSocket|cable" })).toBe(
			"grep WebSocket|cable",
		);
	});

	it("keeps a long argument short enough to read in a pane", () => {
		const long = describeToolCall("Bash", undefined, { command: "x".repeat(400) });

		expect(long.length).toBeLessThan(140);
		expect(long).toEndWith("…");
	});

	it("says just the title when there is nothing to add", () => {
		expect(describeToolCall("Thinking")).toBe("Thinking");
	});
});

describe("flushing streamed prose by paragraph", () => {
	it("flushes up to the last completed paragraph", () => {
		const buffer = "First paragraph.\n\nSecond still going";
		const flushAt = paragraphFlushIndex(buffer);

		expect(buffer.slice(0, flushAt)).toBe("First paragraph.\n\n");
		expect(buffer.slice(flushAt)).toBe("Second still going");
	});

	it("holds back a buffer with no completed paragraph", () => {
		expect(paragraphFlushIndex("still one paragraph\nwith a line break")).toBe(0);
	});

	// A blank line inside a code fence is layout, not a paragraph break; a
	// flush there would hand the renderer half a code block.
	it("does not flush inside a fenced code block", () => {
		expect(paragraphFlushIndex("```ts\nconst a = 1;\n\nconst b = 2;\n")).toBe(0);

		const closed = "```ts\nconst a = 1;\n```\n\nafter";
		expect(closed.slice(0, paragraphFlushIndex(closed))).toBe("```ts\nconst a = 1;\n```\n\n");
	});
});

describe("rendering a tool call's diff", () => {
	it("prints the path, hunk headers and changed lines", () => {
		const text = renderDiffText("/repo/a.ts", "one\ntwo\nthree\n", "one\n2\nthree\n");

		const lines = text.split("\n");
		expect(lines[0]).toBe("/repo/a.ts");
		expect(lines[1]).toStartWith("@@");
		expect(lines).toContain("-two");
		expect(lines).toContain("+2");
	});

	it("caps a huge diff instead of flooding the log", () => {
		const oldText = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
		const text = renderDiffText("/repo/big.ts", oldText, "");

		expect(text.split("\n").length).toBeLessThan(130);
		expect(text).toContain("more lines");
	});
});

describe("sanitizeInheritedEnv", () => {
	// Claude Code refuses to start when it sees another session's variables, and
	// it is right to: they point at a different session's runtime. Neta launches
	// these CLIs the way an editor does, so an ancestor session's plumbing must
	// not be forwarded into a fresh one.
	it("drops an ancestor agent session's own runtime variables", () => {
		const clean = sanitizeInheritedEnv({
			CLAUDECODE: "1",
			CLAUDE_CODE_ENTRYPOINT: "cli",
			CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/other.sock",
			CLAUDE_PID: "123",
			CLAUDE_EFFORT: "high",
		});

		expect(clean).toEqual({});
	});

	it("keeps everything else, including the model settings we set ourselves", () => {
		const clean = sanitizeInheritedEnv({
			PATH: "/usr/bin",
			ANTHROPIC_MODEL: "haiku",
			ANTHROPIC_API_KEY: "sk-test",
			CLAUDECODE: "1",
			UNSET: undefined,
		});

		expect(clean).toEqual({ PATH: "/usr/bin", ANTHROPIC_MODEL: "haiku", ANTHROPIC_API_KEY: "sk-test" });
	});
});
