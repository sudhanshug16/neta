// The CLI's connection to the Node (08, T8.2): error-to-exit-code mapping
// over `connectNode` from `src/node/client.ts` (T4.4), which owns the
// transport, the `hello` handshake and autostart. This module adds nothing
// else: no framing, no socket handling, no retry loop of its own.
//
// Exit codes (08): 0 ok; 1 usage or any other protocol error; 2 node
// unreachable — no socket, connect failed, start timed out, or a protocol
// version mismatch; 3 refused — `data.code` is UNAUTHORIZED or
// CONFIRMATION_REQUIRED.
import { connectNode, type NodeClient as TransportClient } from "../node/client.ts";
import { netaDir, readDescriptor } from "../node/lockfile.ts";
import { NodeError, PROTOCOL_VERSION } from "../node/protocol.ts";

export class CliError extends Error {
	readonly code: 1 | 2 | 3;

	constructor(code: 1 | 2 | 3, message: string) {
		super(message);
		this.name = "CliError";
		this.code = code;
	}
}

export type NodeNotificationKind = "event" | "state" | "turn" | "node";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH means dead; EPERM means alive but owned by another user.
		return (error as { code?: unknown }).code !== "ESRCH";
	}
}

function isRefused(error: NodeError): boolean {
	if (error.symbol === "UNAUTHORIZED" || error.symbol === "CONFIRMATION_REQUIRED") {
		return true;
	}
	const data = error.data;
	const code = typeof data === "object" && data !== null ? (data as { code?: unknown }).code : undefined;
	return code === "UNAUTHORIZED" || code === "CONFIRMATION_REQUIRED";
}

// The server reports a mismatch as `protocol version N is not M`; the CLI
// reports it as `node speaks protocol N, this CLI speaks M`.
function versionMessage(message: string): string {
	const match = /protocol version (\S+) is not (\S+)/.exec(message);
	if (match?.[1] !== undefined) {
		return `node speaks protocol ${match[1]}, this CLI speaks ${PROTOCOL_VERSION}`;
	}
	return `node speaks protocol unknown, this CLI speaks ${PROTOCOL_VERSION}: ${message}`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Connect-time failures are unreachability (2) unless the node answered and
// refused: a wrong token (3), a version mismatch (2), anything else (1).
function mapConnectError(error: unknown): CliError {
	if (error instanceof CliError) {
		return error;
	}
	if (error instanceof NodeError) {
		if (error.symbol === "PROTOCOL_MISMATCH") {
			return new CliError(2, versionMessage(error.message));
		}
		if (isRefused(error)) {
			return new CliError(3, error.message);
		}
		return new CliError(1, error.message);
	}
	return new CliError(2, messageOf(error));
}

// Request-time failures switch on the symbolic `data.code`: refusals (3),
// any other protocol error (1). A dropped connection is not a protocol
// error — the node went unreachable mid-session (2).
function mapRequestError(error: unknown): CliError {
	if (error instanceof CliError) {
		return error;
	}
	if (error instanceof NodeError) {
		if (isRefused(error)) {
			return new CliError(3, error.message);
		}
		return new CliError(1, error.message);
	}
	return new CliError(2, messageOf(error));
}

const CONNECT_TIMEOUT_MS = 5000;

export class NodeClient {
	private readonly inner: TransportClient;

	private constructor(inner: TransportClient) {
		this.inner = inner;
	}

	// With `start: true` the connect spawns `neta node start --detach` once
	// (via `connectNode` autostart) and retries every 100 ms for up to 5 s;
	// the lock makes that race harmless. With `start` false (the default)
	// nothing is started: a missing `node.json` or a dead pid is CliError(2).
	static async connect(opts?: { start?: boolean }): Promise<NodeClient> {
		const start = opts?.start ?? false;
		if (!start) {
			let descriptor: Awaited<ReturnType<typeof readDescriptor>>;
			try {
				descriptor = await readDescriptor();
			} catch (error) {
				throw new CliError(2, `cannot read the node descriptor in ${netaDir()}: ${messageOf(error)}`);
			}
			if (descriptor === undefined) {
				throw new CliError(
					2,
					`no node is running in ${netaDir()} (no node.json); start it with \`neta node start\``,
				);
			}
			if (!isAlive(descriptor.pid)) {
				throw new CliError(
					2,
					`no node is running in ${netaDir()} (pid ${descriptor.pid} is not alive); start it with \`neta node start\``,
				);
			}
		}
		let inner: TransportClient;
		try {
			inner = await connectNode({ client: "cli", autostart: start, timeoutMs: CONNECT_TIMEOUT_MS });
		} catch (error) {
			throw mapConnectError(error);
		}
		if (inner.hello.protocolVersion !== PROTOCOL_VERSION) {
			const spoken = inner.hello.protocolVersion;
			await inner.close().catch(() => undefined);
			throw new CliError(2, `node speaks protocol ${spoken}, this CLI speaks ${PROTOCOL_VERSION}`);
		}
		return new NodeClient(inner);
	}

	request<T>(method: string, params?: object): Promise<T> {
		return this.inner.request<T>(method, params).catch((error: unknown) => {
			throw mapRequestError(error);
		});
	}

	on(kind: NodeNotificationKind, fn: (params: unknown) => void): () => void {
		return this.inner.on(kind, fn);
	}

	close(): void {
		void this.inner.close();
	}
}
