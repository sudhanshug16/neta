/**
 * The interactive pane's transcript: log entries in, rendered blocks out.
 * pi-tui components render to plain string arrays, so none of this needs a
 * terminal; the interactive runner itself (raw mode, polling) is exercised by
 * hand, not here.
 */

import { describe, expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { WorkerLogEntry, WorkerSummary } from "../src/types.ts";
import {
	colorDiff,
	footerMessage,
	SentBlock,
	StatusLine,
	TranscriptView,
	WORKER_INPUT_HINT,
	workerHeaderText,
} from "../src/watch-tui.ts";

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
	it("states that Enter steers through the shared immediate path", () => {
		expect(WORKER_INPUT_HINT).toBe("enter steers this worker now · ctrl+c closes this view");
	});
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
		view.append(entry("status", "writer slot freed"));
		view.append(entry("thought", "weighing options"));
		view.append(entry("error", "backend hiccup"));

		const text = rendered(view);
		expect(text).not.toContain("halfway");
		expect(text).toContain(" worker ");
		expect(text).toContain("posting to the room");
		expect(text).toContain("· writer slot freed");
		expect(text).toContain("weighing options");
		expect(text).toContain("! backend hiccup");
	});

	// A debate argument is the content of a debate, not a status line: the post
	// renders as an attribution line over the full body as markdown — the same
	// treatment the worker's own prose gets, never squeezed onto the arrow line.
	it("renders a room post as attribution over a full markdown body", () => {
		const view = new TranscriptView();
		view.append({
			at: 0,
			kind: "say",
			text: "# Opening\n\nFirst paragraph of the argument.\n\nSecond paragraph, with `code`.",
			from: "ro2",
			label: "pro · debater/architect",
		});

		expect(view.children).toHaveLength(1);
		const text = rendered(view);
		expect(text).toContain(" ro2 pro · debater/architect ");
		expect(text).toContain("Opening");
		expect(text).not.toContain("# Opening");
		expect(text).toContain("First paragraph of the argument.");
		expect(text).toContain("Second paragraph, with code.");
	});

	// The clamp exists for dumps, not for arguments: a long post is exactly the
	// thing a room view is for.
	it("never clamps a room post", () => {
		const wall = Array.from({ length: 200 }, (_, i) => `point ${i}`).join("\n\n");
		const view = new TranscriptView();
		view.append({ at: 0, kind: "say", text: wall, from: "ro1", label: "debater/architect" });

		const text = rendered(view);
		expect(text).not.toContain("more lines");
		expect(text).toContain("point 199");
	});
});

// Everything sent TO the worker is the operator's voice: it stays left-aligned
// with a high-contrast role chip, distinct from the worker chip. Typed pane input
// and the leader's neta_send ride the same path into the log, so one entry
// shape covers both.
describe("sent messages", () => {
	const USER_BACKGROUND = "\x1b[48;2;232;190;95m";
	const LEADER_BACKGROUND = "\x1b[48;2;104;68;132m";
	const WORKER_BACKGROUND = "\x1b[48;2;40;91;132m";
	const content = (view: TranscriptView, width = WIDTH) =>
		view
			.render(width)
			.map((line) => stripTerminalSequences(line))
			.filter((line) => line.trim() !== "");

	it("echoes a message typed at the pane left-aligned with an operator role chip", () => {
		const view = new TranscriptView();
		view.append(entry("status", "Leader: keep going"));

		expect(view.render(WIDTH).join("\n")).toContain(LEADER_BACKGROUND);
		const [attribution, body] = content(view);
		expect(attribution).toBe(" leader ");
		expect(body).toBe("keep going");
	});

	it("distinguishes queued and delivering phases while retaining legacy leader entries", () => {
		const view = new TranscriptView();
		view.append(entry("status", "Leader queued for next turn: keep going"));
		view.append(entry("status", "Leader delivering now as next turn: keep going"));
		view.append(entry("status", "Leader: historical checkpoint message"));

		const text = rendered(view);
		expect(text).toContain("leader queued");
		expect(text).toContain("leader delivering");
		expect(text).toContain("historical checkpoint message");
		expect(text).not.toContain("· Leader");
	});

	it("renders the leader's answer in the same sent style", () => {
		const view = new TranscriptView();
		view.append(entry("status", "Leader answered: use Postgres"));

		const [attribution, body] = content(view);
		expect(attribution).toBe(" leader answered ");
		expect(body).toBe("use Postgres");
	});

	// A wall of status text collapses; a message the operator sent never does.
	it("wraps a long sent message to the pane width and keeps it whole", () => {
		const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
		const view = new TranscriptView();
		view.append(entry("status", `Leader: ${words.join(" ")}`));

		const lines = content(view);
		expect(lines.length).toBeGreaterThan(2);
		for (const line of lines.slice(1)) {
			expect(line.length).toBeLessThanOrEqual(WIDTH);
			expect(line.startsWith(" ")).toBe(false);
		}
		const text = rendered(view);
		expect(text).not.toContain("more lines");
		for (const word of words) expect(text).toContain(word);
	});

	// What the runner does on the first page: the full brief opens the
	// transcript as a sent block, ahead of everything the worker says.
	it("opens the transcript with the whole task brief", () => {
		const brief = "Fix the auth flow.\n\nStart from login.ts, keep the tests green.";
		const view = new TranscriptView();
		view.addChild(new SentBlock("task", brief));
		view.append(entry("text", "Reading login.ts now."));

		const text = rendered(view);
		expect(text).toContain(" user · task ");
		expect(text).toContain("Fix the auth flow.");
		expect(text).toContain("Start from login.ts, keep the tests green.");
		expect(text.indexOf("Fix the auth flow.")).toBeLessThan(text.indexOf("Reading login.ts now."));
	});

	// The TUI re-renders every component with the terminal's current width; a
	// sent block must re-wrap and stay left-aligned at whatever width arrives.
	it("re-wraps left-aligned at each render width", () => {
		const block = new SentBlock("leader", "a message that should remain readable at any width");
		for (const width of [100, 46]) {
			const lines = block
				.render(width)
				.map((line) => stripTerminalSequences(line))
				.filter((line) => line.trim() !== "");
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(width);
				expect(line.startsWith("  ")).toBe(false);
			}
		}
		for (const line of block.render(8)) expect(stripTerminalSequences(line).length).toBeLessThanOrEqual(8);
	});

	it("uses distinct readable role backgrounds for user, leader and worker text", () => {
		const view = new TranscriptView();
		view.addChild(new SentBlock("task", "Fix auth."));
		view.append(entry("status", "Leader: inspect auth.ts"));
		view.append(entry("text", "I found the race."));
		const output = view.render(WIDTH).join("\n");
		expect(output).toContain(USER_BACKGROUND);
		expect(output).toContain(LEADER_BACKGROUND);
		expect(output).toContain(WORKER_BACKGROUND);
		const plain = output.split("\n").map(stripTerminalSequences);
		expect(plain).toContain(" user · task ");
		expect(plain).toContain(" leader ");
		expect(plain).toContain(" worker ");
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
	it("shows the latest progress in the live Neta-owned header", () => {
		const text = stripTerminalSequences(
			workerHeaderText(summary({ lastProgress: { text: "found the cancellation race", at: 1 } })),
		);
		expect(text).toContain("last: found the cancellation race");
	});

	it("gives a pane user the CLI command for a blocked question", () => {
		expect(
			footerMessage({
				entries: [],
				cursor: 0,
				state: "waiting",
				worker: summary({ state: "waiting", pendingQuestion: "Postgres?" }),
			}),
		).toContain("neta answer w1 <answer>");
	});
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
