import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWorkerChannelCommand, parseDiscoveryArgs, sendChannelRequest } from "../src/channel/client.ts";
import { LEADER_COMMANDS } from "../src/channel/leader-cli.ts";
import {
	type ChannelRequest,
	LEADER_REQUEST_TYPES,
	NETA_SOCKET_ENV,
	NETA_WORKER_ENV,
	NETA_WORKER_TOKEN_ENV,
} from "../src/channel/protocol.ts";
import type { ChannelHandler } from "../src/channel/server.ts";
import { ChannelServer } from "../src/channel/server.ts";
import { EnvStub } from "./helpers.ts";

describe("settled channel surface", () => {
	const env = new EnvStub();
	let dir: string;
	let server: ChannelServer;
	let address: string;
	let calls: string[];

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "neta-channel-"));
		address = join(dir, "channel.sock");
		calls = [];
		const handler: ChannelHandler = {
			authenticateWorker: (_id, token) => (token === "token" ? { ok: true } : { ok: false, error: "bad token" }),
			progress: (_id, text) => {
				calls.push(`progress:${text}`);
				return { ok: true };
			},
			blocked: (_id, text) => {
				calls.push(`blocked:${text}`);
				return { ok: true, text: "stopping" };
			},
			say: (_id, text) => {
				calls.push(`room-post:${text}`);
				return { ok: true };
			},
			room: () => ({ ok: true, text: "room" }),
			writerStatus: () => ({ ok: true, text: "writers" }),
			goalStatus: () => ({ ok: true, text: "goal" }),
			discover: (_id, impact, finding, suggestion) => {
				calls.push(`discover:${impact}:${finding}:${suggestion ?? ""}`);
				return { ok: true, text: "discovery" };
			},
			leader: async (request) => ({ ok: true, text: request.type }),
		};
		server = new ChannelServer(address, handler);
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
		rmSync(dir, { recursive: true, force: true });
		env.restore();
		process.exitCode = 0;
	});

	it("reports blockers without holding the socket open", async () => {
		expect(
			await sendChannelRequest(address, { type: "blocked", workerId: "ro1", token: "token", text: "which db?" }),
		).toEqual({ ok: true, text: "stopping" });
		expect(calls).toEqual(["blocked:which db?"]);
	});

	it("rejects missing and wrong worker capability tokens", async () => {
		expect(
			await sendChannelRequest(address, {
				type: "progress",
				workerId: "ro1",
				text: "missing",
			} as unknown as ChannelRequest),
		).toEqual({ ok: false, error: "bad token" });
		expect(
			await sendChannelRequest(address, { type: "progress", workerId: "ro1", token: "wrong", text: "wrong" }),
		).toEqual({ ok: false, error: "bad token" });
		expect(calls).toEqual([]);
	});

	it("answers malformed JSON instead of crashing the channel", async () => {
		const response = await new Promise<string>((resolve, reject) => {
			const socket = connect(address);
			let output = "";
			socket.on("connect", () => socket.write("{not-json}\n"));
			socket.on("data", (chunk) => {
				output += chunk.toString();
			});
			socket.on("end", () => resolve(output.trim()));
			socket.on("error", reject);
		});
		expect(JSON.parse(response)).toMatchObject({ ok: false, error: expect.stringContaining("Malformed request") });
	});

	it("renames room posting and keeps progress", async () => {
		await sendChannelRequest(address, { type: "progress", workerId: "ro1", token: "token", text: "started" });
		await sendChannelRequest(address, { type: "room-post", workerId: "ro1", token: "token", text: "evidence" });
		expect(calls).toEqual(["progress:started", "room-post:evidence"]);
	});

	it("removes spawn, log and answer from leader CLI and socket dispatch", () => {
		for (const removed of ["spawn", "log", "answer"]) {
			expect(LEADER_COMMANDS.has(removed)).toBe(false);
			expect(LEADER_REQUEST_TYPES.has(removed)).toBe(false);
		}
	});

	it("worker CLI sends neta_blocked", async () => {
		env.set(NETA_SOCKET_ENV, address);
		env.set(NETA_WORKER_ENV, "ro1");
		env.set(NETA_WORKER_TOKEN_ENV, "token");
		expect(await handleWorkerChannelCommand(["blocked", "need", "owner"])).toBe(true);
		expect(calls).toEqual(["blocked:need owner"]);
	});

	it("parses discovery flags strictly and routes explicit worker requests", async () => {
		expect(parseDiscoveryArgs(["--impact", "goal", "--finding", "conflict", "--suggest", "ask"])).toEqual({
			impact: "goal",
			finding: "conflict",
			suggestion: "ask",
		});
		for (const args of [
			[],
			["--impact", "local"],
			["--impact", "local", "--finding", "x", "--unknown", "y"],
			["--impact", "local", "--impact", "goal", "--finding", "x"],
			["--impact", "other", "--finding", "x"],
		])
			expect(parseDiscoveryArgs(args)).toBeString();

		expect(
			await sendChannelRequest(address, {
				type: "discover",
				workerId: "ro1",
				token: "token",
				impact: "local",
				finding: "evidence",
				suggestion: "continue",
			}),
		).toEqual({ ok: true, text: "discovery" });
		expect(await sendChannelRequest(address, { type: "goal-status", workerId: "ro1", token: "token" })).toEqual({
			ok: true,
			text: "goal",
		});
		env.set(NETA_SOCKET_ENV, address);
		env.set(NETA_WORKER_ENV, "ro1");
		env.set(NETA_WORKER_TOKEN_ENV, "token");
		expect(await handleWorkerChannelCommand(["status", "--writers"])).toBe(true);
		expect(await handleWorkerChannelCommand(["status", "--goal"])).toBe(true);
		expect(calls).toEqual(["discover:local:evidence:continue"]);
	});
});
