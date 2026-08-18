/**
 * Expanding one worker in place.
 *
 * Neta's status output lists workers as text lines; whether a line can be
 * clicked belongs to whichever host renders it, and Neta owns no session UI to
 * make one clickable. What Neta can own is the expansion itself: a bounded,
 * deterministic window onto a worker's recent input and output that works from
 * anywhere, including for a worker whose multiplexer tab was never created.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
	INSPECT_MAX_CHARS,
	INSPECT_MAX_ENTRIES,
	WorkerManager,
	type WorkerPaneHost,
} from "../src/orchestrator/manager.ts";
import {
	formatInspection,
	formatStatusSnapshot,
	INSPECT_RENDER_MAX_CHARS,
	inspectHint,
} from "../src/orchestrator/status.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { fixtureBackendConfig, waitFor } from "./helpers.ts";

class FakeTransport implements WorkerTransportDriver {
	readonly options: TransportOptions;
	readonly prompts: string[] = [];
	private pending: Array<(outcome: PromptOutcome) => void> = [];
	constructor(options: TransportOptions) {
		this.options = options;
	}
	start(): Promise<void> {
		// A real ACP handshake hands back the backend's own session id.
		this.options.events.vendorSession("vendor-session-1");
		return Promise.resolve();
	}
	prompt(text: string): Promise<PromptOutcome> {
		this.prompts.push(text);
		return new Promise((resolve) => this.pending.push(resolve));
	}
	cancel(): boolean {
		return true;
	}
	async kill(): Promise<void> {}
	markTerminal(): void {}
	/** Narrate, the way a real transport does as the backend streams. */
	say(kind: "text" | "tool" | "error", text: string): void {
		this.options.events.log(kind, text);
	}
	finish(outcome: PromptOutcome): void {
		this.pending.shift()?.(outcome);
	}
}

/** A multiplexer that refuses every tab, which is the case this exists for. */
const refusingPanes: WorkerPaneHost = {
	open: () => ({ opened: false, reason: "zellij action new-tab failed: no session" }),
	openRoom: () => ({ opened: false, reason: "zellij action new-tab failed: no session" }),
};

function build(options: { panes?: WorkerPaneHost; headlessReason?: string } = {}) {
	const transports: FakeTransport[] = [];
	const manager = new WorkerManager({
		cwd: process.cwd(),
		agentDir: "/nonexistent-agent-dir",
		config: fixtureBackendConfig(),
		channelAddress: "/tmp/neta-inspect-test.sock",
		leaderToken: "leader-token",
		onEvent: () => {},
		panes: options.panes,
		headlessReason: options.headlessReason,
		createTransport: (transportOptions) => {
			const transport = new FakeTransport(transportOptions);
			transports.push(transport);
			return transport;
		},
	});
	return { manager, transports };
}

describe("inspecting a worker", () => {
	let manager: WorkerManager;
	let transports: FakeTransport[];

	beforeEach(() => {
		({ manager, transports } = build({ headlessReason: "panes disabled" }));
	});

	async function worker() {
		await manager.spawn({ role: "scout", tier: "expert", task: "read the auth flow" });
		const transport = transports[0];
		await waitFor(() => transport.prompts.length === 1);
		return transport;
	}

	it("shows what was sent to the worker and what it said back", async () => {
		const transport = await worker();
		transport.say("text", "the flow starts in session.ts");
		manager.send("ro1", "check the refresh path too");

		const rendered = formatInspection(manager.inspect("ro1")).join("\n");
		expect(rendered).toContain("task: read the auth flow");
		expect(rendered).toContain("the flow starts in session.ts");
		expect(rendered).toContain("check the refresh path too");
	});

	// `neta_log` moves the leader's cursor on purpose. Looking must not.
	it("does not consume lines the leader has not read", async () => {
		const transport = await worker();
		transport.say("text", "a finding");
		manager.inspect("ro1");
		expect(manager.drainLog("ro1").some((entry) => entry.text === "a finding")).toBe(true);
	});

	it("says so plainly when a worker has produced nothing yet", async () => {
		({ manager, transports } = build());
		await manager.spawn({ role: "scout", tier: "expert", task: "read" });
		const rendered = formatInspection(manager.inspect("ro1")).join("\n");
		expect(rendered).toContain("(this worker has produced no output yet)");
	});

	it("refuses an unknown worker", () => {
		expect(() => manager.inspect("ro9")).toThrow(/Unknown worker/);
	});
});

describe("the inspection cap", () => {
	let manager: WorkerManager;
	let transports: FakeTransport[];

	beforeEach(() => {
		({ manager, transports } = build());
	});

	async function chatty(lines: number, text = "a line of output") {
		await manager.spawn({ role: "scout", tier: "expert", task: "read" });
		const transport = transports[0];
		await waitFor(() => transport.prompts.length === 1);
		for (let index = 0; index < lines; index++) transport.say("text", `${index}: ${text}`);
		return transport;
	}

	// A truncated dump that looks complete is worse than no dump: a reader
	// concludes the worker did nothing between the lines that are missing.
	it("caps the entries and says how many it dropped", async () => {
		await chatty(INSPECT_MAX_ENTRIES + 25);
		const inspection = manager.inspect("ro1");
		expect(inspection.entries.length).toBeLessThanOrEqual(INSPECT_MAX_ENTRIES);
		expect(inspection.droppedEntries).toBeGreaterThan(0);
		expect(formatInspection(inspection).join("\n")).toContain("earlier entries not shown (inspection cap)");
	});

	it("caps the characters and says how many it truncated", async () => {
		await chatty(3, "x".repeat(INSPECT_MAX_CHARS));
		const inspection = manager.inspect("ro1");
		const characters = inspection.entries.reduce((total, entry) => total + entry.text.length, 0);
		expect(characters).toBeLessThanOrEqual(INSPECT_MAX_CHARS);
		expect(inspection.droppedChars).toBeGreaterThan(0);
		expect(formatInspection(inspection).join("\n")).toContain("characters truncated (inspection cap)");
	});

	// The tail is what a reader opened this for, so the budget is spent there.
	it("keeps the most recent output rather than the oldest", async () => {
		await chatty(INSPECT_MAX_ENTRIES + 5);
		const entries = manager.inspect("ro1").entries;
		expect(entries.at(-1)?.text).toContain(`${INSPECT_MAX_ENTRIES + 4}:`);
	});

	it("keeps the tail of one oversized recent entry", async () => {
		const transport = await chatty(0);
		transport.say("text", `${"old".repeat(INSPECT_MAX_CHARS)}LATEST`);
		const inspection = manager.inspect("ro1");
		expect(inspection.entries.at(-1)?.text).toEndWith("LATEST");
		expect(formatInspection(inspection).join("\n")).toContain("earlier characters truncated");
	});

	// The cap is the point; a caller cannot talk it up past the ceiling.
	it("cannot be raised past the hard ceiling", async () => {
		await chatty(INSPECT_MAX_ENTRIES + 25);
		const inspection = manager.inspect("ro1", { maxEntries: 10_000, maxChars: 10_000_000 });
		expect(inspection.entries.length).toBeLessThanOrEqual(INSPECT_MAX_ENTRIES);
		expect(inspection.droppedEntries).toBeGreaterThan(0);
	});

	it("can be asked for less", async () => {
		await chatty(10);
		expect(manager.inspect("ro1", { maxEntries: 3 }).entries.length).toBeLessThanOrEqual(3);
	});

	it("caps the entire rendering when task and header metadata are oversized", async () => {
		await manager.spawn({ role: "scout", tier: "expert", name: "n".repeat(10_000), task: "t".repeat(20_000) });
		const transport = transports[0];
		await waitFor(() => transport.prompts.length === 1);
		transport.say("text", `older output ${"x".repeat(500)} newest finding`);

		const rendered = formatInspection(manager.inspect("ro1")).join("\n");
		expect(rendered.length).toBeLessThanOrEqual(INSPECT_RENDER_MAX_CHARS);
		expect(rendered).toStartWith("… earlier inspection content truncated (6000 character hard cap)");
		expect(rendered).toContain("newest finding");
	});
});

describe("a worker whose tab was never created", () => {
	// The exact case in the ask: automatic Zellij pane creation failed, so the
	// worker is headless and there is nothing to click.
	it("still expands, and says why it has no tab", async () => {
		const { manager, transports } = build({ panes: refusingPanes });
		await manager.spawn({ role: "scout", tier: "expert", task: "read" });
		await waitFor(() => transports[0].prompts.length === 1);
		transports[0].say("text", "found it");

		const inspection = manager.inspect("ro1");
		expect(inspection.headlessReason).toContain("zellij action new-tab failed");
		const rendered = formatInspection(inspection).join("\n");
		expect(rendered).toContain("Worker view: headless");
		expect(rendered).toContain("inspection still works without a tab");
		expect(rendered).toContain("found it");
	});

	// A refusal that names no alternative is a dead end, and this is exactly the
	// worker a reader most needs a way into.
	it("points at what does work instead of dead-ending", async () => {
		const { manager, transports } = build({ panes: refusingPanes });
		await manager.spawn({ role: "scout", tier: "expert", task: "read" });
		await waitFor(() => transports[0].prompts.length === 1);
		transports[0].finish({ ok: true, summary: "done" });
		await waitFor(() => manager.get("ro1").state === "done");

		// This pane host cannot attach at all, which is the headless case.
		expect(() => manager.reopenWorkerTui("ro1")).toThrow(/neta inspect ro1/);
		expect(() => manager.reopenWorkerTui("ro1")).toThrow(/neta attach ro1/);
	});

	// The other shape of the same problem: the worker never got far enough to
	// have a backend session to reopen.
	it("points at the expand path when there is no backend session to reopen", async () => {
		const { manager } = build({ panes: refusingPanes });
		await manager.spawn({ role: "scout", tier: "expert", task: "read" });
		await manager.kill("ro1");
		expect(() => manager.reopenWorkerTui("ro1")).toThrow(/neta inspect ro1/);
	});
});

describe("worker rows", () => {
	// The row is where a reader decides they want more, so the row says how.
	it("name their own expand command, in every state", async () => {
		const { manager, transports } = build({ panes: refusingPanes });
		await manager.spawn({ role: "scout", tier: "expert", task: "read" });
		await waitFor(() => transports[0].prompts.length === 1);
		expect(formatStatusSnapshot(manager.statusSnapshot())).toContain(inspectHint("ro1"));

		transports[0].finish({ ok: true, summary: "done" });
		await waitFor(() => manager.get("ro1").state === "done");
		const terminal = formatStatusSnapshot(manager.statusSnapshot());
		expect(terminal).toContain("Terminal:");
		expect(terminal).toContain(inspectHint("ro1"));
	});
});
