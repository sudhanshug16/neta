/**
 * Orchestrator side of the worker channel.
 *
 * Accepts one request per connection and answers it.
 */

import { unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
	type ChannelRequest,
	type ChannelResponse,
	LEADER_REQUEST_TYPES,
	type LeaderChannelRequest,
} from "./protocol.ts";

export interface ChannelHandler {
	/** Reject a caller that does not hold the capability issued for this worker. */
	authenticateWorker(workerId: string, token: string | undefined): ChannelResponse;
	progress(workerId: string, text: string): ChannelResponse;
	blocked(workerId: string, text: string): ChannelResponse;
	say(workerId: string, text: string): ChannelResponse;
	room(workerId: string, tail: number | undefined): ChannelResponse;
	/** Read-only writer status, available to every worker without a leader token. */
	writerStatus(workerId: string): ChannelResponse;
	/** Token-authorized leader operations. `wait` may block on the signal. */
	leader(request: LeaderChannelRequest, signal: AbortSignal): Promise<ChannelResponse>;
}

export class ChannelServer {
	private readonly server: Server;
	private readonly sockets = new Set<Socket>();
	private readonly removeOnExit: () => void;
	readonly address: string;

	constructor(address: string, handler: ChannelHandler) {
		this.address = address;
		this.server = createServer((socket) => this.handleConnection(socket, handler));
		// A hard exit (crash, auth failure, Ctrl-C) never reaches shutdown, and a
		// socket file left in the temp directory stays there forever.
		this.removeOnExit = () => this.unlinkAddress();
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.address, () => {
				this.server.removeListener("error", reject);
				resolve();
			});
		});
		process.once("exit", this.removeOnExit);
	}

	async stop(): Promise<void> {
		process.removeListener("exit", this.removeOnExit);
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		if (!this.isPipe()) {
			await unlink(this.address).catch(() => {});
		}
	}

	private isPipe(): boolean {
		return this.address.startsWith("\\\\.\\pipe\\");
	}

	private unlinkAddress(): void {
		if (this.isPipe()) return;
		try {
			unlinkSync(this.address);
		} catch {
			// Already gone, or never created.
		}
	}

	private handleConnection(socket: Socket, handler: ChannelHandler): void {
		this.sockets.add(socket);
		const abort = new AbortController();
		socket.on("close", () => {
			this.sockets.delete(socket);
			abort.abort();
		});
		socket.on("error", () => {
			this.sockets.delete(socket);
			abort.abort();
		});

		let buffer = "";
		let handled = false;
		socket.on("data", async (chunk) => {
			if (handled) return;
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			handled = true;

			const respond = (response: ChannelResponse) => {
				if (socket.destroyed) return;
				socket.write(`${JSON.stringify(response)}\n`);
				socket.end();
			};

			let request: ChannelRequest;
			try {
				request = JSON.parse(buffer.slice(0, newline)) as ChannelRequest;
			} catch (error) {
				respond({ ok: false, error: `Malformed request: ${error}` });
				return;
			}

			try {
				switch (request.type) {
					case "progress":
						if (!this.authenticateWorker(request, handler, respond)) return;
						respond(handler.progress(request.workerId, request.text));
						break;
					case "room-post":
						if (!this.authenticateWorker(request, handler, respond)) return;
						respond(handler.say(request.workerId, request.text));
						break;
					case "room":
						if (!this.authenticateWorker(request, handler, respond)) return;
						respond(handler.room(request.workerId, request.tail));
						break;
					case "writer-status":
						if (!this.authenticateWorker(request, handler, respond)) return;
						respond(handler.writerStatus(request.workerId));
						break;
					case "blocked":
						if (!this.authenticateWorker(request, handler, respond)) return;
						respond(handler.blocked(request.workerId, request.text));
						break;
					default:
						if (LEADER_REQUEST_TYPES.has(request.type)) {
							respond(await handler.leader(request as LeaderChannelRequest, abort.signal));
						} else {
							respond({ ok: false, error: `Unknown request type: ${(request as { type: string }).type}` });
						}
				}
			} catch (error) {
				respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		});
	}

	private authenticateWorker(
		request: Extract<ChannelRequest, { workerId: string }> & { token?: string },
		handler: ChannelHandler,
		respond: (response: ChannelResponse) => void,
	): boolean {
		const response = handler.authenticateWorker(request.workerId, request.token);
		if (response.ok) return true;
		respond(response);
		return false;
	}
}
