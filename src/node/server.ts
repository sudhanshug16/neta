import { chmod, stat, unlink } from "node:fs/promises";
import { connect, createServer, type Server as NetServer, type Socket } from "node:net";
import { join } from "node:path";
import { nowIso } from "../core/time.ts";
import { writeJsonAtomic } from "../store/files.ts";
import { netaDir } from "../store/paths.ts";
import { decodeFrame, encodeFrame, type Frame, FramingError, isEnvelope, PROTOCOL_VERSION } from "./protocol.ts";

export interface ClientConnection {
	send(method: string, params: unknown): void;
	close(): void;
}

export interface ServerOptions {
	onRequest(method: string, params: unknown): Promise<unknown> | unknown;
	maxLineBytes?: number;
	onError?(error: Error): void;
}

export interface NodeServer {
	readonly socketPath: string;
	readonly clients: number;
	broadcast(method: string, params: unknown): void;
	close(): Promise<void>;
}

export interface NodeFile {
	version: number;
	pid: number;
	startedAt: string;
	socketPath: string;
}

// The only writer of node.json: { version, pid, startedAt, socketPath }.
export async function nodeFile(o?: { socketPath?: string; pid?: number }): Promise<NodeFile> {
	const record: NodeFile = {
		version: PROTOCOL_VERSION,
		pid: o?.pid ?? process.pid,
		startedAt: nowIso(),
		socketPath: o?.socketPath ?? join(netaDir(), "node.sock"),
	};
	await writeJsonAtomic(join(netaDir(), "node.json"), record);
	return record;
}

async function liveServer(socketPath: string): Promise<boolean> {
	try {
		await stat(socketPath);
	} catch {
		return false;
	}
	return new Promise<boolean>((done) => {
		const probe: Socket = connect(socketPath);
		probe.on("connect", () => {
			probe.destroy();
			done(true);
		});
		probe.on("error", () => done(false));
	});
}

function sendLine(socket: Socket, line: string): void {
	if (socket.destroyed) {
		return;
	}
	try {
		socket.write(`${line}\n`);
	} catch {
		// A closed socket never throws the server.
	}
}

export async function serveFile(o: { socketPath: string; options: ServerOptions }): Promise<NodeServer> {
	// A live server wins; a stale file is unlinked. Two racers may both pass
	// the probe — then the last bind wins, same as any Unix socket.
	if (await liveServer(o.socketPath)) {
		throw new Error(`a node is already listening on ${o.socketPath}`);
	}
	try {
		await unlink(o.socketPath);
	} catch {
		// No stale file; listen anyway.
	}
	const maxLineBytes = o.options.maxLineBytes ?? 64 * 1024 * 1024;
	const clients = new Set<Socket>();
	const server: NetServer = createServer((socket) => {
		clients.add(socket);
		let buffer = "";
		const fail = (error: Error): void => {
			try {
				o.options.onError?.(error);
			} catch {
				// Error reporting must not take the server down.
			}
			clients.delete(socket);
			socket.destroy();
		};
		socket.on("error", () => {
			clients.delete(socket);
		});
		socket.on("close", () => {
			clients.delete(socket);
		});
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) {
					if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
						fail(new FramingError("line exceeds the limit"));
					}
					return;
				}
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
					fail(new FramingError("line exceeds the limit"));
					return;
				}
				if (line === "") {
					continue;
				}
				let frame: Frame;
				try {
					frame = decodeFrame(line);
				} catch (error) {
					fail(error as Error);
					return;
				}
				if (!isEnvelope(frame)) {
					continue;
				}
				const id = frame.id;
				const method = frame.method;
				const params = frame.params;
				void (async (): Promise<void> => {
					try {
						const result = await o.options.onRequest(method, params);
						sendLine(socket, encodeFrame({ v: 1, id, ok: true, result }));
					} catch (error) {
						const code =
							typeof (error as { code?: unknown }).code === "string"
								? (error as { code: string }).code
								: "INTERNAL";
						const message = error instanceof Error ? error.message : String(error);
						sendLine(socket, encodeFrame({ v: 1, id, ok: false, error: { code, message } }));
					}
				})();
			}
		});
	});
	await new Promise<void>((done, reject) => {
		server.on("error", reject);
		server.listen(o.socketPath, done);
	});
	await chmod(o.socketPath, 0o600);
	await nodeFile({ socketPath: o.socketPath });
	let closed = false;
	return {
		get socketPath() {
			return o.socketPath;
		},
		get clients() {
			return clients.size;
		},
		broadcast: (method: string, params: unknown): void => {
			const line = encodeFrame({ v: 1, method, params });
			for (const socket of clients) {
				sendLine(socket, line);
			}
		},
		close: async (): Promise<void> => {
			if (closed) {
				return;
			}
			closed = true;
			for (const socket of clients) {
				socket.destroy();
			}
			clients.clear();
			await new Promise<void>((done) => server.close(() => done()));
			try {
				await unlink(o.socketPath);
			} catch {
				// A restart's stale-file path covers leftovers.
			}
		},
	};
}
