import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWorkerChannelCommand, sendChannelRequest } from "../src/channel/client.ts";
import { handleLeaderChannelCommand } from "../src/channel/leader-cli.ts";
import type { ChannelResponse, LeaderChannelRequest } from "../src/channel/protocol.ts";
import { NETA_LEADER_ENV, NETA_SOCKET_ENV, NETA_WORKER_ENV, NETA_WORKER_TOKEN_ENV } from "../src/channel/protocol.ts";
import type { ChannelHandler } from "../src/channel/server.ts";
import { ChannelServer } from "../src/channel/server.ts";
import { writeSessionRecord } from "../src/session.ts";
import { EnvStub, waitFor } from "./helpers.ts";

const env = new EnvStub();

describe("worker channel", () => {
	let tempDir: string;
	let address: string;
	let server: ChannelServer;
	let asked: Array<{ workerId: string; text: string; resolve: (response: ChannelResponse) => void }>;
	let notified: Array<{ workerId: string; text: string }>;
	let leaderRequests: LeaderChannelRequest[];

	const handler: ChannelHandler = {
		authenticateWorker(workerId, token) {
			return workerId === "ro1" || workerId === "ro7"
				? token === "worker-token"
					? { ok: true }
					: { ok: false, error: `Invalid worker token for ${workerId}.` }
				: { ok: false, error: `Invalid worker token for ${workerId}.` };
		},
		progress(workerId, text) {
			notified.push({ workerId, text });
			return { ok: true };
		},
		say(workerId, text) {
			notified.push({ workerId, text: `say:${text}` });
			return { ok: true };
		},
		room(_workerId, tail) {
			return { ok: true, text: `room(tail=${tail ?? "all"})` };
		},
		writerStatus(workerId) {
			notified.push({ workerId, text: "writer-status" });
			return {
				ok: true,
				text: "Neta writers\nFinished:\n  (none)\nActive:\n  rw1 worker | worker: Fix login\nQueued:\n  (none)",
			};
		},
		ask(workerId, text) {
			return new Promise<ChannelResponse>((resolve) => {
				asked.push({ workerId, text, resolve });
			});
		},
		leader(request) {
			leaderRequests.push(request);
			if (request.token !== "leader-token") return Promise.resolve({ ok: false, error: "Invalid leader token." });
			return Promise.resolve({ ok: true, text: `handled:${request.type}` });
		},
	};

	beforeEach(async () => {
		asked = [];
		notified = [];
		leaderRequests = [];
		tempDir = mkdtempSync(join(tmpdir(), "neta-channel-"));
		address = join(tempDir, "channel.sock");
		// Leader commands fall back to the session registry when the environment
		// says nothing, so point it at an empty directory: otherwise a real Neta
		// session running on the developer's machine answers these tests.
		env.set("NETA_DIR", tempDir);
		server = new ChannelServer(address, handler);
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
		rmSync(tempDir, { recursive: true, force: true });
		env.restore();
		// These tests drive CLI handlers that set a failing exit code on purpose.
		// The test runner shares this process, so leaving it set makes the whole
		// run exit non-zero with every test passing — which is exactly how it hid.
		process.exitCode = 0;
	});

	it("answers progress immediately", async () => {
		const response = await sendChannelRequest(address, {
			type: "progress",
			workerId: "ro1",
			token: "worker-token",
			text: "halfway",
		});

		expect(response).toEqual({ ok: true });
		expect(notified).toEqual([{ workerId: "ro1", text: "halfway" }]);
	});

	it("keeps an ask open until the leader answers", async () => {
		const pending = sendChannelRequest(address, {
			type: "ask",
			workerId: "ro1",
			token: "worker-token",
			text: "which db?",
		});
		await waitFor(() => expect(asked).toHaveLength(1));

		asked[0].resolve({ ok: true, text: "postgres" });

		expect(await pending).toEqual({ ok: true, text: "postgres" });
	});

	it("reports a malformed request instead of hanging", async () => {
		const response = await sendChannelRequest(address, { type: "nonsense" } as never);

		expect(response.ok).toBe(false);
		expect(response.ok === false && response.error).toContain("Unknown request type");
	});

	it("rejects missing or incorrect worker tokens before dispatching", async () => {
		const missing = await sendChannelRequest(address, {
			type: "progress",
			workerId: "ro1",
			text: "halfway",
		} as never);
		const wrong = await sendChannelRequest(address, {
			type: "progress",
			workerId: "ro1",
			token: "wrong-token",
			text: "halfway",
		});

		expect(missing).toEqual({ ok: false, error: "Invalid worker token for ro1." });
		expect(wrong).toEqual({ ok: false, error: "Invalid worker token for ro1." });
		expect(notified).toEqual([]);
	});

	describe("CLI subcommands", () => {
		beforeEach(() => {
			env.set(NETA_SOCKET_ENV, address);
			env.set(NETA_WORKER_ENV, "ro7");
			env.set(NETA_WORKER_TOKEN_ENV, "worker-token");
		});

		it("sends progress through the channel", async () => {
			const log = spyOn(console, "log").mockImplementation(() => {});

			await expect(handleWorkerChannelCommand(["progress", "reading", "auth.ts"])).resolves.toBe(true);

			expect(notified).toEqual([{ workerId: "ro7", text: "reading auth.ts" }]);
			expect(log).toHaveBeenCalledWith("ok");
			log.mockRestore();
		});

		it("prints the leader's answer to an ask", async () => {
			const log = spyOn(console, "log").mockImplementation(() => {});

			const handled = handleWorkerChannelCommand(["ask", "which", "db?"]);
			await waitFor(() => expect(asked).toHaveLength(1));
			asked[0].resolve({ ok: true, text: "postgres" });

			await expect(handled).resolves.toBe(true);
			expect(log).toHaveBeenCalledWith("postgres");
			log.mockRestore();
		});

		it("passes --tail through to the room transcript", async () => {
			const log = spyOn(console, "log").mockImplementation(() => {});

			await handleWorkerChannelCommand(["room", "--tail", "5"]);

			expect(log).toHaveBeenCalledWith("room(tail=5)");
			log.mockRestore();
		});

		it("renders writers-only status through the real worker socket", async () => {
			const log = spyOn(console, "log").mockImplementation(() => {});

			await handleWorkerChannelCommand(["status", "--writers"]);

			expect(notified).toEqual([{ workerId: "ro7", text: "writer-status" }]);
			expect(log).toHaveBeenCalledWith(
				"Neta writers\nFinished:\n  (none)\nActive:\n  rw1 worker | worker: Fix login\nQueued:\n  (none)",
			);
			log.mockRestore();
		});

		it("fails with a message when the leader rejects the request", async () => {
			const error = spyOn(console, "error").mockImplementation(() => {});

			const handled = handleWorkerChannelCommand(["ask", "anything"]);
			await waitFor(() => expect(asked).toHaveLength(1));
			asked[0].resolve({ ok: false, error: "Junior workers cannot ask the leader." });
			await handled;

			expect(error).toHaveBeenCalledWith("Junior workers cannot ask the leader.");
			expect(process.exitCode).toBe(1);
			error.mockRestore();
		});
	});

	it("ignores channel words outside a worker so they stay ordinary arguments", async () => {
		env.set(NETA_SOCKET_ENV, "");
		env.set(NETA_WORKER_ENV, "");

		await expect(handleWorkerChannelCommand(["progress", "the team about the outage"])).resolves.toBe(false);
		expect(notified).toEqual([]);
	});

	it("does not resolve a registry target when the caller is a worker", async () => {
		writeSessionRecord(
			{
				id: "leader-session",
				socket: address,
				token: "leader-token",
				cwd: process.cwd(),
				leader: "claude",
				pid: process.pid,
				startedAt: Date.now(),
			},
			tempDir,
		);
		env.set(NETA_WORKER_ENV, "ro7");

		await expect(handleLeaderChannelCommand(["workers"])).resolves.toBe(false);
		expect(leaderRequests).toEqual([]);
	});

	describe("leader CLI subcommands", () => {
		beforeEach(() => {
			env.set(NETA_SOCKET_ENV, address);
			env.set(NETA_LEADER_ENV, "leader-token");
		});

		it("parses spawn flags and keeps the task as the trailing text", async () => {
			const log = spyOn(console, "log").mockImplementation(() => {});

			await expect(
				handleLeaderChannelCommand([
					"spawn",
					"--role",
					"worker",
					"--tier",
					"senior",
					"--writer",
					"--room",
					"db",
					"fix",
					"the",
					"login",
					"bug",
				]),
			).resolves.toBe(true);

			expect(leaderRequests).toEqual([
				{
					type: "spawn",
					token: "leader-token",
					role: "worker",
					tier: "senior",
					task: "fix the login bug",
					writer: true,
					room: "db",
				},
			]);
			expect(log).toHaveBeenCalledWith("handled:spawn");
			log.mockRestore();
		});

		it("defaults writer to false and omits an unset room", async () => {
			const log = spyOn(console, "log").mockImplementation(() => {});

			await handleLeaderChannelCommand(["spawn", "--role", "scout", "--tier", "junior", "map the auth flow"]);

			// JSON drops undefined, so an unset room arrives as an absent key.
			expect(leaderRequests[0]).toEqual({
				type: "spawn",
				token: "leader-token",
				role: "scout",
				tier: "junior",
				task: "map the auth flow",
				writer: false,
			});
			log.mockRestore();
		});

		it("converts a --timeout in seconds to milliseconds", async () => {
			const log = spyOn(console, "log").mockImplementation(() => {});

			await handleLeaderChannelCommand(["wait", "rw1", "ro2", "--timeout", "30"]);

			expect(leaderRequests[0]).toEqual({
				type: "wait",
				token: "leader-token",
				workerIds: ["rw1", "ro2"],
				timeoutMs: 30_000,
			});
			log.mockRestore();
		});

		it("sends status through the leader channel", async () => {
			const log = spyOn(console, "log").mockImplementation(() => {});

			await handleLeaderChannelCommand(["status"]);

			expect(leaderRequests).toEqual([{ type: "status", token: "leader-token" }]);
			expect(log).toHaveBeenCalledWith("handled:status");
			log.mockRestore();
		});

		it("rejects a spawn with no task instead of sending it", async () => {
			const error = spyOn(console, "error").mockImplementation(() => {});

			await expect(handleLeaderChannelCommand(["spawn", "--role", "worker", "--tier", "senior"])).resolves.toBe(
				true,
			);

			expect(leaderRequests).toEqual([]);
			expect(process.exitCode).toBe(1);
			error.mockRestore();
		});

		it("ignores leader commands without the leader token", async () => {
			env.set(NETA_LEADER_ENV, "");

			await expect(handleLeaderChannelCommand(["workers"])).resolves.toBe(false);
			expect(leaderRequests).toEqual([]);
		});
	});
});
