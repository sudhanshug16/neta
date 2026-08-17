/**
 * `neta watch` against a real socket and a real manager: this is what runs in
 * every worker pane.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NETA_LEADER_ENV, NETA_SOCKET_ENV } from "../src/channel/protocol.ts";
import { ChannelServer } from "../src/channel/server.ts";
import { WorkerManager } from "../src/orchestrator/manager.ts";
import type { PromptOutcome, TransportOptions, WorkerTransportDriver } from "../src/orchestrator/transport.ts";
import { writeSessionRecord } from "../src/session.ts";
import { isWorkerId, watchRoom, watchWorker } from "../src/watch.ts";
import { EnvStub, fixtureBackendConfig } from "./helpers.ts";

const env = new EnvStub();

class FakeTransport implements WorkerTransportDriver {
	private pending: Array<(outcome: PromptOutcome) => void> = [];
	readonly options: TransportOptions;

	constructor(options: TransportOptions) {
		this.options = options;
	}

	start(): Promise<void> {
		return Promise.resolve();
	}
	prompt(): Promise<PromptOutcome> {
		return new Promise((resolve) => this.pending.push(resolve));
	}
	async kill(): Promise<void> {}
	cancels = 0;

	cancel(): boolean {
		this.cancels += 1;
		return true;
	}

	markTerminal(): void {}
	finish(outcome: PromptOutcome): void {
		this.pending.shift()?.(outcome);
	}
}

describe("watch", () => {
	let dir: string;
	let agentDir: string;
	let address: string;
	let server: ChannelServer;
	let manager: WorkerManager;
	let transports: FakeTransport[];
	let lines: string[];

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "neta-watch-"));
		agentDir = mkdtempSync(join(tmpdir(), "neta-watch-home-"));
		address = join(dir, "channel.sock");
		lines = [];
		transports = [];
		manager = new WorkerManager({
			cwd: process.cwd(),
			agentDir: "/nonexistent-agent-dir",
			config: fixtureBackendConfig(),
			channelAddress: address,
			leaderToken: "tok",
			onEvent: () => {},
			createTransport: (options) => {
				const transport = new FakeTransport(options);
				transports.push(transport);
				return transport;
			},
		});
		server = new ChannelServer(address, manager);
		await server.start();
		env.set(NETA_SOCKET_ENV, address);
		env.set(NETA_LEADER_ENV, "tok");
	});

	afterEach(async () => {
		env.restore();
		await manager.dispose();
		await server.stop();
		rmSync(dir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	const write = (line: string) => {
		lines.push(line);
	};

	// A pane is read at a glance: it has to say who this worker is and what it
	// was asked to do, not just stream unlabelled lines.
	it("introduces the worker, then prints its log", async () => {
		const worker = await manager.spawn({ role: "scout", tier: "expert", task: "map the auth flow" });
		manager.progress(worker.id, "reading auth.ts");

		const code = await watchWorker({ workerId: worker.id, once: true, hold: false, write });

		expect(code).toBe(0);
		expect(lines[0]).toBe(`${worker.id} · scout/expert · claude · read-only · model unknown — backend default`);
		expect(lines[1]).toBe("task: map the auth flow");
		expect(lines[2]).toBe("last: reading auth.ts");
		expect(lines).toContain("» reading auth.ts");
		// The metadata line every state change reprints, here for the first state seen.
		expect(lines).toContain(`· ${worker.id} · model unknown — backend default · running`);
		// The tag-per-line noise is gone.
		expect(lines.join("\n")).not.toContain("[progress]");
	});

	// The leader reads its log by draining it. If a pane drained the same log,
	// lines would vanish before the leader ever saw them.
	it("does not consume the lines the leader has not read", async () => {
		const worker = await manager.spawn({ role: "scout", tier: "expert", task: "look" });
		manager.progress(worker.id, "found the bug");

		await watchWorker({ workerId: worker.id, once: true, hold: false, write });

		expect(manager.drainLog(worker.id).map((entry) => entry.text)).toContain("found the bug");
	});

	it("follows until the worker finishes and says how it ended", async () => {
		const worker = await manager.spawn({ role: "scout", tier: "expert", task: "look" });
		const watching = watchWorker({ workerId: worker.id, hold: false, write });
		manager.progress(worker.id, "halfway");
		transports[0].finish({ ok: true, summary: "done looking" });

		expect(await watching).toBe(0);
		expect(lines).toContain("» halfway");
		expect(lines.at(-1)).toBe(`── ${worker.id} done ──`);
	});

	// A headless reader scrolls too: the metadata reprints on every state change,
	// current as of the newest model and usage reports from the backend.
	it("reprints current metadata when the state changes", async () => {
		const worker = await manager.spawn({ role: "scout", tier: "expert", task: "look" });
		const watching = watchWorker({ workerId: worker.id, hold: false, write });
		transports[0].options.events.session({ model: "Claude Opus 4.5", modelId: "claude-opus-4-5" });
		transports[0].options.events.usage({ inputTokens: 60_000, outputTokens: 8_000 });
		transports[0].finish({ ok: true, summary: "done looking" });

		expect(await watching).toBe(0);
		expect(lines).toContain(`· ${worker.id} · Claude Opus 4.5 · done · 68,000 tokens · est. $0.50`);
		expect(lines.at(-1)).toBe(`── ${worker.id} done ──`);
	});

	it("reports an unknown worker instead of hanging", async () => {
		const code = await watchWorker({ workerId: "ro42", once: true, hold: false, write });

		expect(code).toBe(1);
		expect(lines.join(" ")).toContain('Unknown worker "ro42"');
	});

	// A pane is started by the multiplexer's own process, which does not inherit
	// our environment, so watch looks the session up in the registry instead.
	it("finds its session in the registry when the environment says nothing", async () => {
		const worker = await manager.spawn({ role: "scout", tier: "expert", task: "look" });
		manager.progress(worker.id, "from the registry");
		env.set(NETA_SOCKET_ENV, "");
		env.set(NETA_LEADER_ENV, "");
		env.set("NETA_DIR", agentDir);
		writeSessionRecord(
			{
				id: "s7",
				socket: address,
				token: "tok",
				cwd: process.cwd(),
				leader: "claude",
				pid: process.pid,
				startedAt: Date.now(),
			},
			agentDir,
		);

		const code = await watchWorker({ workerId: worker.id, sessionId: "s7", once: true, hold: false, write });

		expect(code).toBe(0);
		expect(lines).toContain("» from the registry");
	});

	it("says so when there is no session to watch", async () => {
		env.set(NETA_SOCKET_ENV, "");
		env.set(NETA_LEADER_ENV, "");
		env.set("NETA_DIR", agentDir);

		const code = await watchWorker({ workerId: "ro1", once: true, hold: false, write, cwd: "/nowhere" });

		expect(code).toBe(1);
		expect(lines.join(" ")).toContain("No Neta session found");
	});

	// A debate argument spans paragraphs; squeezing it onto the arrow line made
	// real debates unreadable. The arrow attributes, the body reads as prose.
	it("renders a room post as an attribution line over the full body", async () => {
		const worker = await manager.spawn({
			role: "debater",
			tier: "architect",
			task: "argue for",
			room: "db",
			name: "pro",
		});
		manager.say(worker.id, "First paragraph of the argument.\n\nSecond paragraph.");

		const code = await watchWorker({ workerId: worker.id, once: true, hold: false, write });

		expect(code).toBe(0);
		const text = lines.join("\n");
		expect(text).toContain(
			`→ ${worker.id} pro · debater/architect\nFirst paragraph of the argument.\n\nSecond paragraph.`,
		);
	});

	// Alignment does not exist in the plain view, so the "«" marker carries the
	// direction instead: everything sent TO the worker — the opening brief, the
	// leader's messages, answers — is prefixed and printed whole.
	it("marks everything sent to the worker and opens with the full brief", async () => {
		const worker = await manager.spawn({
			role: "worker",
			tier: "expert",
			task: "Fix the auth flow.\n\nStart from login.ts, keep the tests green.",
		});
		manager.send(worker.id, "keep going");
		manager.send(worker.id, "Two more things:\n\nstop short of the tests.");

		const code = await watchWorker({ workerId: worker.id, once: true, hold: false, write });

		expect(code).toBe(0);
		const text = lines.join("\n");
		// The header's truncated "task:" line stays; the whole brief follows it.
		expect(lines[1]).toBe("task: Fix the auth flow. Start from login.ts, keep the tests green.");
		expect(text).toContain("« task:\nFix the auth flow.\n\nStart from login.ts, keep the tests green.");
		expect(text).toContain("« leader queued: keep going");
		// A multi-line message reads like a "say": attribution, then the whole body.
		expect(text).toContain("« leader queued:\nTwo more things:\n\nstop short of the tests.");
		expect(text).not.toContain("· Leader:");
	});

	it("renders queued, delivering, and historical leader phases in the plain view", async () => {
		const worker = await manager.spawn({ role: "worker", tier: "expert", task: "inspect" });
		manager.send(worker.id, "follow up");
		transports[0].finish({ ok: true, summary: "first done" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		transports[0].options.events.log("status", "Leader: historical checkpoint message");

		const code = await watchWorker({ workerId: worker.id, once: true, hold: false, write });
		expect(code).toBe(0);
		const text = lines.join("\n");
		expect(text).toContain("« leader queued: follow up");
		expect(text).toContain("« leader delivering: follow up");
		expect(text).toContain("« leader: historical checkpoint message");
	});

	describe("room view", () => {
		it("merges two posters into one transcript, in posting order, with authors", async () => {
			const pro = await manager.spawn({
				role: "debater",
				tier: "architect",
				task: "argue for",
				room: "db",
				name: "pro",
			});
			const con = await manager.spawn({
				role: "debater",
				tier: "architect",
				task: "argue against",
				room: "db",
				name: "con",
			});
			manager.say(pro.id, "Postgres: we already run it.");
			manager.say(con.id, "SQLite: one file, no ops.\n\nBackups become a copy.");
			manager.say(pro.id, "Ops is already paid for here.");

			const code = await watchRoom({ room: "db", once: true, hold: false, write });

			expect(code).toBe(0);
			const text = lines.join("\n");
			// Debaters in one room are spread across vendors; the header says which.
			expect(lines[0]).toBe(`room db · members: ${pro.id} pro (${pro.backend}), ${con.id} con (${con.backend})`);
			expect(text).toContain(`→ ${pro.id} pro · debater/architect\nPostgres: we already run it.`);
			expect(text).toContain(
				`→ ${con.id} con · debater/architect\nSQLite: one file, no ops.\n\nBackups become a copy.`,
			);
			const first = text.indexOf("Postgres: we already run it.");
			const second = text.indexOf("SQLite: one file, no ops.");
			const third = text.indexOf("Ops is already paid for here.");
			expect(first).toBeGreaterThan(-1);
			expect(second).toBeGreaterThan(first);
			expect(third).toBeGreaterThan(second);
		});

		it("follows the room until its last member finishes", async () => {
			const solo = await manager.spawn({ role: "debater", tier: "architect", task: "argue", room: "db" });
			const watching = watchRoom({ room: "db", hold: false, write });
			manager.say(solo.id, "opening statement");
			transports[0].finish({ ok: true, summary: "done arguing" });

			expect(await watching).toBe(0);
			expect(lines.join("\n")).toContain("opening statement");
			expect(lines.at(-1)).toBe("── room db done ──");
		});

		it("reports an unknown room instead of hanging", async () => {
			await manager.spawn({ role: "debater", tier: "architect", task: "argue", room: "db" });

			const code = await watchRoom({ room: "bd", once: true, hold: false, write });

			expect(code).toBe(1);
			expect(lines.join(" ")).toContain('Unknown room "bd"');
		});
	});
});

// `neta watch` routes by the target's shape: minted worker ids go to the
// worker view, everything else is a room name.
describe("isWorkerId", () => {
	it("tells worker ids from room names", () => {
		expect(isWorkerId("ro1")).toBe(true);
		expect(isWorkerId("rw12")).toBe(true);
		expect(isWorkerId("db")).toBe(false);
		expect(isWorkerId("auth-debate")).toBe(false);
		expect(isWorkerId("ro")).toBe(false);
		expect(isWorkerId("ro1x")).toBe(false);
		expect(isWorkerId("rooms")).toBe(false);
	});
});
