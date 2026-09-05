// T8.4: the terminal chat attaches to the workspace leader's conversation.
// `renderBlock` is pinned per BlockKind in TTY and non-TTY mode; the rest
// drives the built bundle against a temp `NETA_DIR` (the T8.2 harness): a
// piped prompt reaches the fake agent and its reply streams to stdout, a
// second client on the same session sees the first client's user turn, and
// SIGINT mid-turn cancels without killing the process.
import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBlock } from "../src/cli/chat.ts";
import { NodeClient } from "../src/cli/client.ts";
import type { Block } from "../src/core/types.ts";
import { type Harness, startNode as startHarness } from "./helpers/cli-harness.ts";

function block(over: Partial<Block>): Block {
	return {
		turnId: "t1",
		seq: 1,
		at: "2026-01-01T00:00:00.000Z",
		role: "agent",
		kind: "text",
		text: "x",
		...over,
	};
}

describe("renderBlock", () => {
	test("text is verbatim with no prefix", () => {
		const b = block({ kind: "text", text: "hello\nworld" });
		expect(renderBlock(b, true)).toBe("hello\nworld");
		expect(renderBlock(b, false)).toBe("hello\nworld");
	});

	test("thought is one dim line rewritten in place on a TTY, skipped off it", () => {
		const b = block({ kind: "thought", text: "weighing\noptions" });
		expect(renderBlock(b, true)).toBe("\x1b[2mweighing\x1b[0m\r");
		expect(renderBlock(b, false)).toBeNull();
	});

	test("a long thought truncates to the terminal width", () => {
		const b = block({ kind: "thought", text: "y".repeat(500) });
		const width = process.stdout.columns ?? 100;
		expect(renderBlock(b, true)).toBe(`\x1b[2m${"y".repeat(width)}\x1b[0m\r`);
	});

	test("tool and diff are one dim line each, never re-rendered", () => {
		expect(renderBlock(block({ kind: "tool", text: "Edit config.json" }), true)).toBe(
			"\x1b[2m· Edit config.json\x1b[0m\n",
		);
		expect(renderBlock(block({ kind: "tool", text: "Edit config.json" }), false)).toBe("· Edit config.json\n");
		expect(renderBlock(block({ kind: "diff", text: "/repo/config.json (+1 −1)" }), true)).toBe(
			"\x1b[2m· /repo/config.json (+1 −1)\x1b[0m\n",
		);
		expect(renderBlock(block({ kind: "diff", text: "/repo/config.json (+1 −1)" }), false)).toBe(
			"· /repo/config.json (+1 −1)\n",
		);
	});

	test("status is one dim line", () => {
		expect(renderBlock(block({ kind: "status", text: "1200/200000 tokens" }), true)).toBe(
			"\x1b[2m— 1200/200000 tokens\x1b[0m\n",
		);
		expect(renderBlock(block({ kind: "status", text: "1200/200000 tokens" }), false)).toBe("— 1200/200000 tokens\n");
	});

	test("a user block is one dim > line", () => {
		expect(renderBlock(block({ role: "user", kind: "text", text: "hello" }), true)).toBe("\x1b[2m> hello\x1b[0m\n");
		expect(renderBlock(block({ role: "user", kind: "text", text: "hello" }), false)).toBe("> hello\n");
	});
});

interface Capture {
	stdout: string;
	stderr: string;
}

function capture(child: ChildProcess): Capture {
	const cap: Capture = { stdout: "", stderr: "" };
	child.stdout?.on("data", (chunk: Buffer) => {
		cap.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		cap.stderr += chunk.toString("utf8");
	});
	return cap;
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
	const deadline = Date.now() + ms;
	for (;;) {
		if (cond()) {
			return;
		}
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((done) => setTimeout(done, 25));
	}
}

function waitExit(child: ChildProcess, ms: number): Promise<number | null> {
	if (child.exitCode !== null) {
		return Promise.resolve(child.exitCode);
	}
	return new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("timed out waiting for the chat to exit"));
		}, ms);
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

async function withChat(fn: (harness: Harness, work: string) => Promise<void>): Promise<void> {
	const harness = await startHarness();
	try {
		const started = await harness.run(["node", "start", "--detach"]);
		expect(started.code).toBe(0);
		const work = await mkdtemp(join(tmpdir(), "neta-chat-work-"));
		try {
			await fn(harness, work);
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	} finally {
		await harness.stop();
	}
}

describe("attached chat", () => {
	test("a piped prompt reaches the fake agent and its reply appears on stdout", async () => {
		await withChat(async (harness, work) => {
			const child = harness.spawn([], { cwd: work });
			const cap = capture(child);
			try {
				child.stdin?.write("hello chat\n");
				await waitFor(() => cap.stdout.includes("echo:hello chat"), 20000, "the agent reply");
				child.stdin?.end();
				expect(await waitExit(child, 20000)).toBe(0);
			} finally {
				if (child.exitCode === null) {
					child.kill("SIGKILL");
				}
			}
		});
	}, 90000);

	test("a streamed reply prints once, not once per delta", async () => {
		await withChat(async (harness, work) => {
			const child = harness.spawn([], { cwd: work });
			const cap = capture(child);
			try {
				// The fake agent streams this reply in three overlapping
				// chunks under one seq; each one carries the whole text so
				// far, so writing them verbatim printed the reply three times.
				child.stdin?.write("STREAM please\n");
				await waitFor(() => cap.stdout.includes("Second paragraph."), 20000, "the streamed reply");
				child.stdin?.end();
				expect(await waitExit(child, 20000)).toBe(0);
				const whole = "First paragraph continues.\n\nSecond paragraph.";
				expect(cap.stdout).toContain(whole);
				expect(cap.stdout.split("First paragraph").length - 1).toBe(1);
				expect(cap.stdout.split("Second paragraph.").length - 1).toBe(1);
			} finally {
				if (child.exitCode === null) {
					child.kill("SIGKILL");
				}
			}
		});
	}, 90000);

	test("replayed history keeps one turn per line instead of running them together", async () => {
		await withChat(async (harness, work) => {
			const first = harness.spawn([], { cwd: work });
			const firstCap = capture(first);
			try {
				first.stdin?.write("one\ntwo\n");
				await waitFor(() => firstCap.stdout.includes("echo:two"), 30000, "both replies");
				first.stdin?.end();
				expect(await waitExit(first, 20000)).toBe(0);
			} finally {
				if (first.exitCode === null) {
					first.kill("SIGKILL");
				}
			}
			// Re-attach: `conversation.tail` replays both turns, and a text
			// block carries no terminator of its own, so without the turn
			// boundary the reply and the next prompt land on one line.
			const second = harness.spawn([], { cwd: work });
			const cap = capture(second);
			try {
				second.stdin?.end();
				expect(await waitExit(second, 20000)).toBe(0);
				expect(cap.stdout).toContain("> one\necho:one\n");
				expect(cap.stdout).toContain("> two\necho:two\n");
				expect(cap.stdout).not.toContain("echo:one> two");
			} finally {
				if (second.exitCode === null) {
					second.kill("SIGKILL");
				}
			}
		});
	}, 120000);

	test("a second client on the same session sees the first client's user turn", async () => {
		await withChat(async (harness, work) => {
			const saved = process.env.NETA_DIR;
			process.env.NETA_DIR = harness.dir;
			let second: NodeClient | undefined;
			try {
				// Open before spawning the chat: two concurrent `workspace.open`
				// calls can each mint a leader, so the session must exist first
				// for both clients to share it.
				second = await NodeClient.connect();
				const opened = await second.request<{ workspace: { id: string }; leader: { sessionId: string } }>(
					"workspace.open",
					{ path: work },
				);
				const seen: unknown[] = [];
				const off = second.on("turn", (params: unknown) => {
					seen.push(params);
				});
				try {
					await second.request("conversation.tail", { sessionId: opened.leader.sessionId, limit: 20 });
					const child = harness.spawn([], { cwd: work });
					const cap = capture(child);
					try {
						child.stdin?.write("hello other\n");
						await waitFor(
							() =>
								seen.some(
									(n) =>
										typeof n === "object" &&
										n !== null &&
										(n as { turn?: { role?: string } }).turn?.role === "user",
								),
							20000,
							"the first client's user turn",
						);
						await waitFor(
							() =>
								seen.some(
									(n) =>
										typeof n === "object" &&
										n !== null &&
										typeof (n as { block?: { text?: string } }).block?.text === "string" &&
										(n as { block: { text: string } }).block.text.includes("echo:hello other"),
								),
							20000,
							"the shared agent reply",
						);
						// The attached chat streams its own turn too.
						await waitFor(() => cap.stdout.includes("echo:hello other"), 20000, "the chat reply");
					} finally {
						child.stdin?.end();
						if (child.exitCode === null) {
							await waitExit(child, 20000).catch(() => null);
						}
						if (child.exitCode === null) {
							child.kill("SIGKILL");
						}
					}
				} finally {
					off();
				}
			} finally {
				second?.close();
				if (saved === undefined) {
					delete process.env.NETA_DIR;
				} else {
					process.env.NETA_DIR = saved;
				}
			}
		});
	}, 120000);

	test("SIGINT mid-turn cancels and stays alive, a second SIGINT exits 0", async () => {
		await withChat(async (harness, work) => {
			const saved = process.env.NETA_DIR;
			process.env.NETA_DIR = harness.dir;
			const observer = await NodeClient.connect();
			const opened = await observer.request<{ leader: { sessionId: string } }>("workspace.open", { path: work });
			const seen: Array<{ turn?: { id: string; endedAt?: string }; block?: { role?: string; text?: string } }> = [];
			observer.on("turn", (value) =>
				seen.push(value as { turn?: { id: string; endedAt?: string }; block?: { role?: string; text?: string } }),
			);
			await observer.request("conversation.tail", { sessionId: opened.leader.sessionId, limit: 20 });
			const child = harness.spawn([], { cwd: work });
			const cap = capture(child);
			try {
				// HOLD_FOREVER keeps the turn streaming until the cancel lands.
				child.stdin?.write("HOLD_FOREVER\n");
				await waitFor(
					() =>
						seen.some(
							(notification) =>
								notification.block?.role === "user" && notification.block.text === "HOLD_FOREVER",
						),
					20000,
					"active held prompt",
				);
				expect(child.exitCode).toBeNull();
				child.kill("SIGINT");
				await waitFor(() => cap.stdout.includes("^C cancelled"), 15000, "^C cancelled");
				await new Promise((done) => setTimeout(done, 500));
				expect(child.exitCode).toBeNull();
				child.kill("SIGINT");
				expect(await waitExit(child, 15000)).toBe(0);
			} finally {
				observer.close();
				if (saved === undefined) delete process.env.NETA_DIR;
				else process.env.NETA_DIR = saved;
				if (child.exitCode === null) {
					child.kill("SIGKILL");
				}
			}
		});
	}, 120000);
});
