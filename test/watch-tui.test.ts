/**
 * The interactive pane's transcript: log entries in, rendered blocks out.
 * pi-tui components render to plain string arrays, so none of this needs a
 * terminal; the interactive runner itself (raw mode, polling) is exercised by
 * hand, not here.
 */

import { describe, expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { WorkerLogEntry } from "../src/types.ts";
import { colorDiff, TranscriptView } from "../src/watch-tui.ts";

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

describe("colorDiff", () => {
	it("colors added and removed lines and leaves the text intact", () => {
		const colored = colorDiff("/repo/a.ts\n@@ -1,3 +1,3 @@\n-two\n+2\n three");

		expect(colored).toContain("\x1b[32m+2\x1b[39m");
		expect(colored).toContain("\x1b[31m-two\x1b[39m");
		expect(stripTerminalSequences(colored)).toBe("/repo/a.ts\n@@ -1,3 +1,3 @@\n-two\n+2\n three");
	});
});
