import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvStub, waitFor } from "./helpers.ts";

const env = new EnvStub();

import { handleWorkerChannelCommand, sendChannelRequest } from "../src/channel/client.ts";
import { handleLeaderChannelCommand } from "../src/channel/leader-cli.ts";
import type { ChannelResponse, LeaderChannelRequest } from "../src/channel/protocol.ts";
import { NETA_LEADER_ENV, NETA_SOCKET_ENV, NETA_WORKER_ENV } from "../src/channel/protocol.ts";
import type { ChannelHandler } from "../src/channel/server.ts";
import { ChannelServer } from "../src/channel/server.ts";

describe("worker channel", () => {
	let tempDir: string;
	let address: string;
	let server: ChannelServer;
	let asked: Array<{ workerId: string; text: string; resolve: (response: ChannelResponse) => void }>;
	let notified: Array<{ workerId: string; text: string }>;
	let leaderRequests: LeaderChannelRequest[];

	const handler: ChannelHandler = {
		notify(workerId, text) {
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
		server = new ChannelServer(address, handler);
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
		rmSync(tempDir, { recursive: true, force: true });
		env.restore();
	});

	it("answers notify immediately", async () => {
		const response = await sendChannelRequest(address, { type: "notify", workerId: "w1", text: "halfway" });

		expect(response).toEqual({ ok: true });
		expect(notified).toEqual([{ workerId: "w1", text: "halfway" }]);
	});

	it("keeps an ask open until the leader answers", async () => {
		const pending = sendChannelRequest(address, { type: "ask", workerId: "w1", text: "which db?" });
		await waitFor(() => expect(asked).toHaveLength(1));

		asked[0].resolve({ ok: true, text: "postgres" });

		expect(await pending).toEqual({ ok: true, text: "postgres" });
	});

	it("reports a malformed request instead of hanging", async () => {
		const response = await sendChannelRequest(address, { type: "nonsense" } as never);

		expect(response.ok).toBe(false);
		expect(response.ok === false && response.error).toContain("Unknown request type");
	});

	describe("CLI subcommands", () => {
		beforeEach(() => {
			env.set(NETA_SOCKET_ENV, address);
			env.set(NETA_WORKER_ENV, "w7");
		});

		it("sends notify through the channel", async () => {
			const log = spyOn(console, "log").mockImplementation(() => {});

			await expect(handleWorkerChannelCommand(["notify", "reading", "auth.ts"])).resolves.toBe(true);

			expect(notified).toEqual([{ workerId: "w7", text: "reading auth.ts" }]);
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

		it("fails with a message when the leader rejects the request", async () => {
			const error = spyOn(console, "error").mockImplementation(() => {});
			const previousExitCode = process.exitCode;

			const handled = handleWorkerChannelCommand(["ask", "anything"]);
			await waitFor(() => expect(asked).toHaveLength(1));
			asked[0].resolve({ ok: false, error: "Junior workers cannot ask the leader." });
			await handled;

			expect(error).toHaveBeenCalledWith("Junior workers cannot ask the leader.");
			expect(process.exitCode).toBe(1);
			process.exitCode = previousExitCode;
			error.mockRestore();
		});
	});

	it("ignores channel words outside a worker so they stay ordinary arguments", async () => {
		env.set(NETA_SOCKET_ENV, "");
		env.set(NETA_WORKER_ENV, "");

		await expect(handleWorkerChannelCommand(["notify", "the team about the outage"])).resolves.toBe(false);
		expect(notified).toEqual([]);
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

			await handleLeaderChannelCommand(["wait", "w1", "w2", "--timeout", "30"]);

			expect(leaderRequests[0]).toEqual({
				type: "wait",
				token: "leader-token",
				workerIds: ["w1", "w2"],
				timeoutMs: 30_000,
			});
			log.mockRestore();
		});

		it("rejects a spawn with no task instead of sending it", async () => {
			const error = spyOn(console, "error").mockImplementation(() => {});
			const previousExitCode = process.exitCode;

			await expect(handleLeaderChannelCommand(["spawn", "--role", "worker", "--tier", "senior"])).resolves.toBe(
				true,
			);

			expect(leaderRequests).toEqual([]);
			expect(process.exitCode).toBe(1);
			process.exitCode = previousExitCode;
			error.mockRestore();
		});

		it("ignores leader commands without the leader token", async () => {
			env.set(NETA_LEADER_ENV, "");

			await expect(handleLeaderChannelCommand(["workers"])).resolves.toBe(false);
			expect(leaderRequests).toEqual([]);
		});
	});
});
