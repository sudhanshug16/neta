/**
 * The interactive pane's transcript: log entries in, rendered blocks out.
 * pi-tui components render to plain string arrays, so none of this needs a
 * terminal; the interactive runner itself (raw mode, polling) is exercised by
 * hand, not here.
 */

import { describe, expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { WorkerLogEntry, WorkerSummary } from "../src/types.ts";
import { colorDiff, StatusLine, TranscriptView } from "../src/watch-tui.ts";

const WIDTH = 80;

function entry(kind: WorkerLogEntry["kind"], text: string): WorkerLogEntry {
	return { at: 0, kind, text };
}

function rendered(view: TranscriptView): string {
	return view
		.render(WIDTH)
		.map((line) => stripTerminalSequences(line))
		.join("\n");
}

describe("TranscriptView", () => {
	// Paragraphs of one assistant message arrive as separate log entries; the
	// pane has to read as one message, not as scattered fragments.
	it("merges consecutive prose entries into one markdown block", () => {
		const view = new TranscriptView();
		view.append(entry("text", "First paragraph."));
		view.append(entry("text", "Second paragraph."));

		expect(view.children).toHaveLength(1);
		const text = rendered(view);
		expect(text).toContain("First paragraph.");
		expect(text).toContain("Second paragraph.");
	});

	it("ends a prose run when a tool call interrupts it", () => {
		const view = new TranscriptView();
		view.append(entry("text", "Reading the config."));
		view.append(entry("tool", "Read config.json"));
		view.append(entry("text", "It sets the port."));

		expect(view.children).toHaveLength(3);
		expect(rendered(view)).toContain("● Read config.json");
	});

	it("renders markdown instead of echoing its syntax", () => {
		const view = new TranscriptView();
		view.append(entry("text", "# Findings\n\nThe `port` is **wrong**."));

		const text = rendered(view);
		expect(text).toContain("Findings");
		expect(text).not.toContain("# Findings");
		expect(text).not.toContain("**wrong**");
	});

	// A status line or error that arrives as a wall of text must not bury the
	// pane; the worker's own prose is the one thing never clamped.
	it("collapses an oversized non-prose entry and leaves prose alone", () => {
		const wall = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		const view = new TranscriptView();
		view.append(entry("status", wall));
		view.append(entry("text", wall));

		const [status, prose] = view.children.map((child) => child.render(WIDTH).length);
		expect(status).toBeLessThan(15);
		expect(rendered(view)).toContain("… 188 more lines");
		expect(prose).toBeGreaterThan(150);
	});

	it("keeps every entry kind visible", () => {
		const view = new TranscriptView();
		view.append(entry("progress", "halfway"));
		view.append(entry("say", "posting to the room"));
		view.append(entry("status", "Leader: keep going"));
		view.append(entry("thought", "weighing options"));
		view.append(entry("error", "backend hiccup"));

		const text = rendered(view);
		expect(text).toContain("» halfway");
		expect(text).toContain("→ posting to the room");
		expect(text).toContain("· Leader: keep going");
		expect(text).toContain("weighing options");
		expect(text).toContain("! backend hiccup");
	});
});

function summary(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
	return {
		id: "w1",
		name: "auth flow",
		role: "worker",
		tier: "expert",
		backend: "claude",
		writer: true,
		state: "running",
		task: "fix the auth flow",
		startedAt: 0,
		scratchDir: "/tmp/w1",
		...overrides,
	};
}

describe("StatusLine", () => {
	// The header carries the metadata too, but the header scrolls away with the
	// transcript; this line is pinned under the input box and must say it all.
	it("pins the full metadata when the pane is wide enough", () => {
		const status = new StatusLine();
		status.update(
			summary({
				model: "Claude Opus 4.5",
				modelId: "claude-opus-4-5",
				mode: "default",
				usage: { inputTokens: 60_000, outputTokens: 8_000, contextUsed: 34_000, contextSize: 200_000 },
			}),
			"running",
		);

		const [line] = status.render(120);
		expect(stripTerminalSequences(line)).toBe(
			"w1 auth flow · Claude Opus 4.5 · default · running · context 17% · 68,000 tokens · est. $0.50",
		);
		// Metadata is dim, per the pane's design language.
		expect(line).toContain("\x1b[2m");
	});

	it("shows a reported cost plainly, not as an estimate", () => {
		const status = new StatusLine();
		status.update(summary({ model: "gpt-5.2", usage: { totalTokens: 12_345, costAmount: 1.25 } }), "running");

		expect(status.render(120).map(stripTerminalSequences)).toEqual([
			"w1 auth flow · gpt-5.2 · running · 12,345 tokens · 1.25 USD",
		]);
	});

	it("says loudly when the backend default model is running", () => {
		const status = new StatusLine();
		status.update(summary(), "running");

		expect(status.render(80).map(stripTerminalSequences)).toEqual([
			"w1 auth flow · model unknown — backend default · running",
		]);
	});

	it("drops cost first, then tokens, and never the id, model and state", () => {
		const status = new StatusLine();
		status.update(
			summary({
				model: "opus",
				modelId: "claude-opus-4-5",
				mode: "default",
				usage: { inputTokens: 60_000, outputTokens: 8_000, contextUsed: 34_000, contextSize: 200_000 },
			}),
			"running",
		);
		const at = (width: number) => stripTerminalSequences(status.render(width)[0]);

		const noCost = "w1 auth flow · opus · default · running · context 17% · 68,000 tokens";
		expect(at(noCost.length)).toBe(noCost);
		const noTokens = "w1 auth flow · opus · default · running · context 17%";
		expect(at(noTokens.length)).toBe(noTokens);
		expect(at(20)).toBe("w1 · opus · running");
		// Narrower than the narrowest candidate: clipped, never wrapped.
		expect(at(12)).toBe("w1 · opus ·…");
	});

	// Model and usage reports land mid-run over the same tail stream the footer
	// state follows; the pinned line must pick them up without a restart.
	it("updates when model and usage reports arrive mid-stream", () => {
		const status = new StatusLine();
		status.update(summary(), "running");
		expect(stripTerminalSequences(status.render(120)[0])).toContain("model unknown — backend default");

		status.update(
			summary({
				model: "Claude Opus 4.5",
				modelId: "claude-opus-4-5",
				usage: { inputTokens: 60_000, outputTokens: 8_000 },
			}),
			"running",
		);

		expect(status.render(120).map(stripTerminalSequences)).toEqual([
			"w1 auth flow · Claude Opus 4.5 · running · 68,000 tokens · est. $0.50",
		]);
	});
});

describe("colorDiff", () => {
	it("colors added and removed lines and leaves the text intact", () => {
		const colored = colorDiff("/repo/a.ts\n@@ -1,3 +1,3 @@\n-two\n+2\n three");

		expect(colored).toContain("\x1b[32m+2\x1b[39m");
		expect(colored).toContain("\x1b[31m-two\x1b[39m");
		expect(stripTerminalSequences(colored)).toBe("/repo/a.ts\n@@ -1,3 +1,3 @@\n-two\n+2\n three");
	});
});
