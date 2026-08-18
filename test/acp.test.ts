import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpConnection, chooseModel, sanitizeInheritedEnv } from "../src/acp/connection.ts";
import { AcpWorkerTransport, describeToolCall, paragraphFlushIndex, renderDiffText } from "../src/acp/transport.ts";
import type { NegotiatedSession, TransportOptions, WorkerMcpServer } from "../src/orchestrator/transport.ts";
import type { WorkerLogEntry, WorkerUsage } from "../src/types.ts";
import { EnvStub, processGone, waitFor } from "./helpers.ts";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

describe("AcpWorkerTransport", () => {
	const started: AcpWorkerTransport[] = [];
	const tempDirs: string[] = [];
	const grandchildPids: number[] = [];

	afterEach(async () => {
		for (const transport of started.splice(0)) await transport.kill();
		for (const pid of grandchildPids.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		usageReports.length = 0;
		sessionReports.length = 0;
		vendorSessions.length = 0;
	});

	const usageReports: WorkerUsage[] = [];
	const sessionReports: NegotiatedSession[] = [];
	const vendorSessions: string[] = [];

	function createTransport(
		writer: boolean,
		log: WorkerLogEntry[],
		mcpServers: WorkerMcpServer[] = [],
		agentArgs: string[] = [],
		env: Record<string, string> = {},
		model: string | undefined = undefined,
		requireExactModel = false,
		resumeSessionId?: string,
	): AcpWorkerTransport {
		const scratchDir = mkdtempSync(join(tmpdir(), "neta-acp-"));
		tempDirs.push(scratchDir);
		const options: TransportOptions = {
			workerId: "ro1",
			cwd: process.cwd(),
			env,
			command: process.execPath,
			args: [fakeAgent, ...agentArgs],
			model,
			requireExactModel,
			writer,
			systemPrompt: "You are a test worker.",
			scratchDir,
			mcpServers,
			resumeSessionId,
			events: {
				log: (kind, text) => log.push({ at: 0, kind, text }),
				usage: (usage) => usageReports.push(usage),
				vendorSession: (sessionId) => vendorSessions.push(sessionId),
				session: (session) => sessionReports.push(session),
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

	it("resumes the exact session across processes without replaying or duplicating the role prompt", async () => {
		const storeDir = mkdtempSync(join(tmpdir(), "neta-acp-store-"));
		tempDirs.push(storeDir);
		const store = join(storeDir, "sessions.json");
		const server = { name: "neta", command: "/usr/bin/neta", args: ["mcp", "--worker"], env: { TOKEN: "exact" } };
		const first = createTransport(
			false,
			[],
			[server],
			["--config-options", "--session-store", store],
			{},
			"fixture-fast",
		);
		await first.start();
		await first.prompt("first turn");
		const sessionId = vendorSessions.at(-1);
		expect(sessionId).toBeTruthy();
		await first.kill();

		const second = createTransport(
			false,
			[],
			[server],
			["--config-options", "--session-store", store],
			{},
			"fixture-fast",
			false,
			sessionId,
		);
		await second.start();
		const history = await second.prompt("HISTORY");
		expect(vendorSessions.at(-1)).toBe(sessionId);
		expect(history.summary).toContain("You are a test worker.");
		expect(history.summary.match(/You are a test worker\./g)).toHaveLength(1);
		const resumedMcp = await second.prompt("MCP");
		expect(resumedMcp.summary).toContain('"name":"TOKEN","value":"exact"');
		expect(resumedMcp.summary).toContain('"args":["mcp","--worker"]');
		expect(sessionReports.at(-1)).toMatchObject({ modelId: "fixture-fast[medium]", mode: "Always Ask" });
	});

	it("refuses unsupported resume without falling back to session/new", async () => {
		const transport = createTransport(false, [], [], ["--unsupported-resume"], {}, undefined, false, "missing");
		await expect(transport.start()).rejects.toThrow("does not advertise ACP session/resume");
		expect(vendorSessions).not.toContain("missing");
	});

	it("refuses a rejected resume without opening a replacement session", async () => {
		const storeDir = mkdtempSync(join(tmpdir(), "neta-acp-reject-store-"));
		tempDirs.push(storeDir);
		const store = join(storeDir, "sessions.json");
		const first = createTransport(false, [], [], ["--session-store", store]);
		await first.start();
		const sessionId = vendorSessions.at(-1) as string;
		await first.kill();

		const rejected = createTransport(
			false,
			[],
			[],
			["--session-store", store, "--reject-resume"],
			{},
			undefined,
			false,
			sessionId,
		);
		await expect(rejected.start()).rejects.toThrow("failed to start an ACP session");
		const saved = JSON.parse(readFileSync(store, "utf-8")) as { counter: number; sessions: Record<string, unknown> };
		expect(saved.counter).toBe(1);
		expect(Object.keys(saved.sessions)).toEqual([sessionId]);
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

	it("accumulates token usage over follow-up turns", async () => {
		const transport = createTransport(false, []);
		await transport.start();

		await transport.prompt("USAGE first turn");
		await transport.prompt("USAGE second turn");

		expect(usageReports.at(-1)).toMatchObject({ totalTokens: 3000, inputTokens: 2000, outputTokens: 1000 });
	});

	// A sandboxed worker cannot open our socket from its shell, so the backend
	// starts Neta's MCP server for it instead.
	it("hands the backend the worker's MCP server at session start", async () => {
		const transport = createTransport(
			false,
			[],
			[{ name: "neta", command: "/usr/bin/neta", args: ["mcp", "--worker"], env: { NETA_WORKER_ID: "ro1" } }],
		);
		await transport.start();

		const outcome = await transport.prompt("MCP list");

		expect(outcome.summary).toContain('"name":"neta"');
		expect(outcome.summary).toContain('"args":["mcp","--worker"]');
		expect(outcome.summary).toContain('{"name":"NETA_WORKER_ID","value":"ro1"}');
	});

	it("does not pass leader authority into a spawned worker", async () => {
		const env = new EnvStub();
		env.set("NETA_LEADER_TOKEN", "leader-secret");
		env.set("NETA_LEADER_BACKEND", "claude");
		env.set("NETA_SESSION_ID", "leader-session");
		env.set("NETA_MUX", "tmux");
		env.set("NETA_PANES", "1");
		try {
			const transport = createTransport(false, [], [], [], { NETA_LEADER_TOKEN: "backend-secret" });
			await transport.start();

			const outcome = await transport.prompt("REPORT_NETA_ENV");
			expect(outcome.summary).toBe(
				'{"leaderToken":null,"leaderBackend":null,"sessionId":null,"mux":null,"panes":null}',
			);
		} finally {
			env.restore();
		}
	});

	it("reports the negotiated model, mode and bridge from the backend", async () => {
		const transport = createTransport(false, []);
		await transport.start();

		expect(sessionReports).toHaveLength(1);
		expect(sessionReports[0]).toEqual({
			model: "test-model",
			modelId: "test-model",
			mode: "test-mode",
			agentInfo: "fake-acp-agent@1.0.0",
		});
	});

	it("uses legacy set_model only when the backend offers legacy models", async () => {
		const transport = createTransport(false, [], [], [], {}, "legacy-other");
		await transport.start();

		expect(sessionReports.at(-1)).toMatchObject({ model: "legacy-other", modelId: "legacy-other" });
	});

	it("prefers configOptions over the legacy model fields and applies mid-session updates", async () => {
		const transport = createTransport(false, [], [], ["--config-options"]);
		await transport.start();

		expect(sessionReports.at(-1)).toEqual({
			model: "Fixture Default [Medium]",
			modelId: "fixture-default[medium]",
			mode: "Always Ask",
			agentInfo: "fake-acp-agent@1.0.0",
		});

		await transport.prompt("CONFIG_UPDATE");

		expect(sessionReports.at(-1)).toEqual({
			model: "Fixture Fast [Medium]",
			modelId: "fixture-fast[medium]",
			mode: "Always Ask",
			agentInfo: "fake-acp-agent@1.0.0",
		});
	});

	it("selects a composite Codex model through config options and confirms the active values", async () => {
		const log: WorkerLogEntry[] = [];
		const transport = createTransport(false, log, [], ["--config-options"], {}, "gpt-5.6-sol[xhigh]");
		await transport.start();

		expect(sessionReports.at(-1)).toMatchObject({
			model: "GPT 5.6 Sol [Extra High]",
			modelId: "gpt-5.6-sol[xhigh]",
		});
		expect(log.some((entry) => entry.text.includes("legacy set_model"))).toBe(false);
	});

	it("negotiates every shipped Codex tier id by splitting model and thought level", async () => {
		const tiers = [
			["gpt-5.6-luna[high]", "GPT 5.6 Luna [High]"],
			["gpt-5.6-terra[medium]", "GPT 5.6 Terra [Medium]"],
			["gpt-5.6-sol[medium]", "GPT 5.6 Sol [Medium]"],
			["gpt-5.6-sol[max]", "GPT 5.6 Sol [Max]"],
		] as const;

		for (const [model, display] of tiers) {
			const transport = createTransport(false, [], [], ["--config-options"], {}, model);
			await transport.start();
			expect(sessionReports.at(-1)).toMatchObject({ model: display, modelId: model });
		}
	});

	it("selects the exact Claude Opus 1M model and separate Max effort", async () => {
		const transport = createTransport(false, [], [], ["--config-options"], {}, "opus[1m][max]", true);
		await transport.start();

		expect(sessionReports.at(-1)).toMatchObject({
			model: "Claude Opus 1M [Max]",
			modelId: "opus[1m][max]",
		});
	});

	// Every Claude tier, not only the architect's. A user-global Fable default is
	// what a lower tier would silently run on if selection were best-effort.
	for (const [model, display] of [
		["haiku", "Claude Haiku"],
		["sonnet", "Claude Sonnet"],
		["opus[1m]", "Claude Opus 1M"],
	] as const) {
		it(`selects the exact "${model}" tier model over a Claude backend's Fable default`, async () => {
			const transport = createTransport(false, [], [], ["--claude-fable-default"], {}, model, true);
			await transport.start();

			expect(sessionReports.at(-1)).toMatchObject({ model: display, modelId: model });
			expect(sessionReports.at(-1)?.modelId).not.toContain("fable");
		});
	}

	for (const [name, fixtureFlag, error] of [
		["the requested lower-tier model is absent", "--missing-sonnet", /exact model "sonnet" is unavailable/, "sonnet"],
		["setConfig fails for a lower tier", "--fail-set-config", /configuration request failed/, "haiku"],
	] as const) {
		it(`fails closed before the task prompt when ${name}`, async () => {
			const markerDir = mkdtempSync(join(tmpdir(), "neta-prompt-marker-"));
			tempDirs.push(markerDir);
			const marker = join(markerDir, "prompted");
			const transport = createTransport(
				false,
				[],
				[],
				["--claude-fable-default", fixtureFlag, "--prompt-marker", marker],
				{},
				name.includes("absent") ? "sonnet" : "haiku",
				true,
			);

			await expect(transport.start()).rejects.toThrow(error);
			expect(existsSync(marker)).toBe(false);
		});
	}

	it("fails closed when a Claude tier resolved no model at all", async () => {
		const markerDir = mkdtempSync(join(tmpdir(), "neta-prompt-marker-"));
		tempDirs.push(markerDir);
		const marker = join(markerDir, "prompted");
		const transport = createTransport(
			false,
			[],
			[],
			["--claude-fable-default", "--prompt-marker", marker],
			{},
			undefined,
			true,
		);

		await expect(transport.start()).rejects.toThrow(/no model was resolved for this tier/);
		expect(existsSync(marker)).toBe(false);
	});

	it("fails closed when a Claude backend advertises no selectable model", async () => {
		const markerDir = mkdtempSync(join(tmpdir(), "neta-prompt-marker-"));
		tempDirs.push(markerDir);
		const marker = join(markerDir, "prompted");
		const transport = createTransport(false, [], [], ["--bare", "--prompt-marker", marker], {}, "haiku", true);

		await expect(transport.start()).rejects.toThrow(/did not advertise a selectable model/);
		expect(existsSync(marker)).toBe(false);
	});

	for (const [name, fixtureFlag, error] of [
		["exact Opus 1M is absent", "--missing-exact-opus", /exact model "opus\[1m\]" is unavailable/],
		["Max effort is absent", "--missing-max", /exact thought level "max" is unavailable/],
		["setConfig fails", "--fail-set-config", /configuration request failed: Internal error/],
	] as const) {
		it(`fails closed before the task prompt when ${name}`, async () => {
			const markerDir = mkdtempSync(join(tmpdir(), "neta-prompt-marker-"));
			tempDirs.push(markerDir);
			const marker = join(markerDir, "prompted");
			const transport = createTransport(
				false,
				[],
				[],
				["--config-options", fixtureFlag, "--prompt-marker", marker],
				{},
				"opus[1m][max]",
				true,
			);

			await expect(transport.start()).rejects.toThrow(error);
			expect(existsSync(marker)).toBe(false);
		});
	}

	it("tracks a mode the backend switches mid-session", async () => {
		const transport = createTransport(false, [], [], ["--config-options"]);
		await transport.start();

		await transport.prompt("MODE_UPDATE");

		expect(sessionReports.at(-1)).toMatchObject({ mode: "plan" });
	});

	it("says loudly when no model was requested and the backend reports none", async () => {
		const log: WorkerLogEntry[] = [];
		const transport = createTransport(false, log, [], ["--bare"]);
		await transport.start();

		expect(
			log.some((entry) => entry.kind === "error" && entry.text === "no model requested; backend default in use"),
		).toBe(true);
		expect(sessionReports.at(-1)).toEqual({
			model: undefined,
			modelId: undefined,
			mode: undefined,
			agentInfo: "fake-acp-agent@1.0.0",
		});
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
			workerId: "ro2",
			cwd: process.cwd(),
			env: {},
			command: join(scratchDir, "definitely-not-installed"),
			args: [],
			model: undefined,
			writer: false,
			systemPrompt: "",
			scratchDir,
			mcpServers: [],
			events: {
				log: (kind, text) => log.push({ at: 0, kind, text }),
				usage: () => {},
				vendorSession: () => {},
				session: () => {},
			},
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

	it("waits for SIGTERM-ignoring grandchildren before resolving", async () => {
		const transport = createTransport(false, []);
		await transport.start();
		const outcome = await transport.prompt("SPAWN_TRAP_SIGTERM_CHILD");
		const pid = Number(outcome.summary.match(/grandchild:(\d+)/)?.[1]);
		expect(pid).toBeGreaterThan(0);
		grandchildPids.push(pid);

		const killStart = Date.now();
		await transport.kill();

		expect(Date.now() - killStart).toBeGreaterThanOrEqual(2900);
		await waitFor(() => processGone(pid), 1000);
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

	it("closes and kills even when the cancel notification never resolves", async () => {
		let pgid: number | undefined;
		let closed = false;
		const connection = new AcpConnection({
			command: process.execPath,
			args: [fakeAgent],
			cwd: process.cwd(),
			env: {},
			allowMutations: false,
			onUpdate: () => {},
			onStderr: () => {},
			onDenied: () => {},
			onProcessGroup: (pid) => {
				pgid = pid;
			},
		});
		await connection.start();
		Object.defineProperty(connection, "connection", {
			configurable: true,
			value: {
				agent: { notify: () => new Promise<void>(() => {}) },
				close: () => {
					closed = true;
				},
			},
			writable: true,
		});

		const startedAt = Date.now();
		await connection.kill();
		expect(Date.now() - startedAt).toBeLessThan(1000);
		expect(closed).toBe(true);
		if (pgid === undefined) throw new Error("ACP fixture did not report its process group");
		expect(() => process.kill(pgid as number, 0)).toThrow();
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

describe("terminal permission gate", () => {
	it("denies terminal commands loudly without blocking reads", () => {
		const denials: string[] = [];
		const connection = new AcpConnection({
			command: process.execPath,
			args: [],
			cwd: process.cwd(),
			env: {},
			allowMutations: true,
			onUpdate: () => {},
			onStderr: () => {},
			onDenied: (kind, _title, reason) => denials.push(`${kind}:${reason}`),
		});
		const requestPermission = Reflect.get(connection, "requestPermission") as (params: {
			toolCall: { toolCallId: string; title: string; kind: string; status: "pending" };
			options: Array<{ kind: "allow_once" | "reject_once"; name: string; optionId: string }>;
		}) => unknown;

		connection.markTerminal();
		const write = requestPermission.call(connection, {
			toolCall: { toolCallId: "write", title: "Write config.json", kind: "write", status: "pending" },
			options: [
				{ kind: "allow_once", name: "Allow", optionId: "allow" },
				{ kind: "reject_once", name: "Reject", optionId: "reject" },
			],
		});
		const read = requestPermission.call(connection, {
			toolCall: { toolCallId: "read", title: "Read config.json", kind: "read", status: "pending" },
			options: [
				{ kind: "allow_once", name: "Allow", optionId: "allow" },
				{ kind: "reject_once", name: "Reject", optionId: "reject" },
			],
		});
		const execute = requestPermission.call(connection, {
			toolCall: { toolCallId: "execute", title: "Run tests", kind: "execute", status: "pending" },
			options: [
				{ kind: "allow_once", name: "Allow", optionId: "allow" },
				{ kind: "reject_once", name: "Reject", optionId: "reject" },
			],
		});

		expect(write).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
		expect(read).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		expect(execute).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
		expect(denials).toEqual(["write:terminal", "execute:terminal"]);
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

	it("drops Neta leader authority while preserving worker credentials", () => {
		const clean = sanitizeInheritedEnv({
			NETA_LEADER_TOKEN: "leader-secret",
			NETA_LEADER_BACKEND: "claude",
			NETA_SESSION_ID: "leader-session",
			NETA_MUX: "tmux",
			NETA_PANES: "1",
			NETA_WORKER_ID: "ro1",
			NETA_WORKER_TOKEN: "worker-token",
		});

		expect(clean).toEqual({ NETA_WORKER_ID: "ro1", NETA_WORKER_TOKEN: "worker-token" });
	});
});
