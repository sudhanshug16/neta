/**
 * Orchestrator side of the worker channel.
 *
 * Accepts one request per connection and answers it. `ask` connections stay
 * open until the leader answers, which is what makes a worker block; every
 * other request answers immediately.
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
	notify(workerId: string, text: string): ChannelResponse;
	ask(workerId: string, text: string, signal: AbortSignal): Promise<ChannelResponse>;
	say(workerId: string, text: string): ChannelResponse;
	room(workerId: string, tail: number | undefined): ChannelResponse;
	/** Read-only writer status, available to every worker without a leader token. */
	writerStatus(workerId: string): ChannelResponse;
	/** Token-authorized leader operations. `wait` may block on the signal like `ask`. */
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
					case "notify":
						respond(handler.notify(request.workerId, request.text));
						break;
					case "say":
						respond(handler.say(request.workerId, request.text));
						break;
					case "room":
						respond(handler.room(request.workerId, request.tail));
						break;
					case "writer-status":
						respond(handler.writerStatus(request.workerId));
						break;
					case "ask":
						respond(await handler.ask(request.workerId, request.text, abort.signal));
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
}
