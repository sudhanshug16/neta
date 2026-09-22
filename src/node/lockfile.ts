// Exactly one Node per NETA_DIR, discoverable by clients. The descriptor
// (`node.json`) tells clients where to connect; the lock (`node.lock`) makes
// the single-instance race harmless. This module never imports `src/store`.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IsoTime } from "../core/types.ts";

// Resolved on every call and never cached, so a test can point NETA_DIR at a
// temp directory between calls.
export function netaDir(): string {
	const override = process.env.NETA_DIR;
	if (override !== undefined && override !== "") {
		return override;
	}
	return join(homedir(), ".neta");
}

export interface NodeDescriptor {
	socket: string;
	token: string;
	pid: number;
	protocolVersion: number;
	runtimeBuild?: string;
	instanceId?: string;
	startedAt: IsoTime;
}

export class DescriptorInvalidError extends Error {
	readonly code = "NETA_DESCRIPTOR_INVALID";
	constructor() {
		super(
			"The saved Neta service descriptor is malformed. Its process ownership must be checked before recovery; no work was stopped.",
		);
		this.name = "DescriptorInvalidError";
	}
}

export class AlreadyRunningError extends Error {
	readonly pid: number;

	constructor(pid: number) {
		super(`a node is already running as pid ${pid}`);
		this.name = "AlreadyRunningError";
		this.pid = pid;
	}
}

function descriptorPath(dir?: string): string {
	return join(dir ?? netaDir(), "node.json");
}

// The descriptor in a named directory. The socket always sits beside
// `node.json` in the same NETA_DIR, so a client handed only `NETA_SOCKET`
// (which is all `netaMcpServer` puts in an ACP session's environment) can
// still find the node token by looking next to the socket.
export async function readDescriptorIn(dir: string): Promise<NodeDescriptor | undefined> {
	return readDescriptorAt(descriptorPath(dir));
}

export async function readDescriptor(): Promise<NodeDescriptor | undefined> {
	return readDescriptorAt(descriptorPath());
}

async function readDescriptorAt(path: string): Promise<NodeDescriptor | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new DescriptorInvalidError();
	}
	if (typeof value !== "object" || value === null) throw new DescriptorInvalidError();
	const descriptor = value as Partial<NodeDescriptor>;
	if (
		typeof descriptor.socket !== "string" ||
		typeof descriptor.token !== "string" ||
		!Number.isInteger(descriptor.pid) ||
		(descriptor.pid ?? 0) <= 0 ||
		!Number.isInteger(descriptor.protocolVersion) ||
		typeof descriptor.startedAt !== "string"
	)
		throw new DescriptorInvalidError();
	return descriptor as NodeDescriptor;
}

// Atomic rename, mode 0600: a client never reads a half-written descriptor.
export async function writeDescriptor(descriptor: NodeDescriptor): Promise<void> {
	await mkdir(netaDir(), { recursive: true, mode: 0o700 });
	const target = descriptorPath();
	const tmp = `${target}.tmp.${process.pid}`;
	await writeFile(tmp, JSON.stringify(descriptor), { mode: 0o600 });
	await chmod(tmp, 0o600);
	await rename(tmp, target);
}

export async function clearDescriptor(expectedInstanceId?: string): Promise<void> {
	if (expectedInstanceId !== undefined && (await readDescriptor())?.instanceId !== expectedInstanceId) return;
	try {
		await unlink(descriptorPath());
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") {
			throw error;
		}
	}
}

// 32 random bytes as hex.
export function newToken(): string {
	return randomBytes(32).toString("hex");
}

export interface LockHandle {
	pid: number;
	instanceId: string;
	release(): Promise<void>;
}

export class LockUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LockUnavailableError";
	}
}

interface LockIdentity {
	netaLock: 1;
	key: string;
	pid: number;
	instanceId: string;
}

async function identityAt(port: number): Promise<LockIdentity | undefined> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		let text = "";
		let done = false;
		const finish = (identity?: LockIdentity) => {
			if (done) return;
			done = true;
			socket.destroy();
			resolve(identity);
		};
		socket.setTimeout(1000, () => finish());
		socket.on("error", () => finish());
		socket.on("end", () => finish());
		socket.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
			if (text.length > 1024) return finish();
			if (!text.includes("\n")) return;
			try {
				const value: unknown = JSON.parse(text.split("\n")[0] ?? "");
				if (typeof value !== "object" || value === null) return finish();
				const item = value as Partial<LockIdentity>;
				if (
					item.netaLock === 1 &&
					typeof item.key === "string" &&
					Number.isInteger(item.pid) &&
					typeof item.instanceId === "string"
				)
					return finish(item as LockIdentity);
			} catch {
				/* An occupied port is never grounds to remove another owner. */
			}
			finish();
		});
	});
}

async function closeLockServer(server: Server): Promise<void> {
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
}

/** A TCP bind is a kernel-owned lifetime lock, automatically released on crash.
 * The file is diagnostic/legacy compatibility state, never the ownership proof.
 * Unidentified port collisions fail closed; no foreign process is terminated.
 */
export async function acquireLock(): Promise<LockHandle> {
	await mkdir(netaDir(), { recursive: true, mode: 0o700 });
	const dir = await realpath(netaDir());
	const key = createHash("sha256").update(dir).digest("hex");
	const port = 20000 + (Number.parseInt(key.slice(0, 8), 16) % 40000);
	const identity: LockIdentity = { netaLock: 1, key, pid: process.pid, instanceId: randomUUID() };
	const server = createServer((socket) => {
		socket.on("error", () => undefined);
		socket.end(`${JSON.stringify(identity)}\n`);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
		const owner = await identityAt(port);
		if (owner?.key === key) throw new AlreadyRunningError(owner.pid);
		throw new LockUnavailableError(
			`Neta cannot establish process ownership: loopback lock port ${port} is occupied by an unrelated or unresponsive listener. No process was stopped.`,
		);
	}
	server.unref();
	const path = join(dir, "node.lock");
	try {
		// Old releases used a PID-only lock. Do not run beside a live legacy
		// process during upgrade; new JSON records never use PID liveness.
		const previous = await readFile(path, "utf8").catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
			throw error;
		});
		if (/^\d+\s*$/.test(previous)) {
			const pid = Number.parseInt(previous, 10);
			let alive = true;
			try {
				process.kill(pid, 0);
			} catch (error) {
				alive = !(error instanceof Error && "code" in error && error.code === "ESRCH");
			}
			if (alive) throw new AlreadyRunningError(pid);
		}
		await writeFile(path, JSON.stringify(identity), { mode: 0o600 });
		await chmod(path, 0o600);
	} catch (error) {
		await closeLockServer(server);
		throw error;
	}
	let released = false;
	return {
		pid: process.pid,
		instanceId: identity.instanceId,
		release: async () => {
			if (released) return;
			released = true;
			try {
				const current = await readFile(path, "utf8").catch(() => "");
				if (current === JSON.stringify(identity))
					await unlink(path).catch((error: unknown) => {
						if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
					});
			} finally {
				await closeLockServer(server);
			}
		},
	};
}
