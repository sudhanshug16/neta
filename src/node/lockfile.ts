// Exactly one Node per NETA_DIR, discoverable by clients. The descriptor
// (`node.json`) tells clients where to connect; the lock (`node.lock`) makes
// the single-instance race harmless. This module never imports `src/store`.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
	startedAt: IsoTime;
}

export class AlreadyRunningError extends Error {
	readonly pid: number;

	constructor(pid: number) {
		super(`a node is already running as pid ${pid}`);
		this.name = "AlreadyRunningError";
		this.pid = pid;
	}
}

function descriptorPath(): string {
	return join(netaDir(), "node.json");
}

function lockPath(): string {
	return join(netaDir(), "node.lock");
}

export async function readDescriptor(): Promise<NodeDescriptor | undefined> {
	let raw: string;
	try {
		raw = await readFile(descriptorPath(), "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	return JSON.parse(raw) as NodeDescriptor;
}

// Atomic rename, mode 0600: a client never reads a half-written descriptor.
export async function writeDescriptor(descriptor: NodeDescriptor): Promise<void> {
	await mkdir(netaDir(), { recursive: true });
	const target = descriptorPath();
	const tmp = `${target}.tmp.${process.pid}`;
	await writeFile(tmp, JSON.stringify(descriptor), { mode: 0o600 });
	await chmod(tmp, 0o600);
	await rename(tmp, target);
}

export async function clearDescriptor(): Promise<void> {
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
	release(): Promise<void>;
}

async function readLockPid(): Promise<number | undefined> {
	let raw: string;
	try {
		raw = await readFile(lockPath(), "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	const pid = Number.parseInt(raw.trim(), 10);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH means dead; EPERM means alive but owned by another user.
		return (error as { code?: unknown }).code !== "ESRCH";
	}
}

async function takeLock(): Promise<LockHandle> {
	await mkdir(netaDir(), { recursive: true });
	try {
		await writeFile(lockPath(), String(process.pid), { flag: "wx" });
		return { pid: process.pid, release: releaseLock };
	} catch (error) {
		if ((error as { code?: unknown }).code !== "EEXIST") {
			throw error;
		}
	} // A lock file exists; fall through to the stale check below.
	const holder = await readLockPid();
	if (holder !== undefined && isAlive(holder)) {
		throw new AlreadyRunningError(holder);
	}
	try {
		await unlink(lockPath());
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") {
			throw error;
		}
	}
	try {
		await writeFile(lockPath(), String(process.pid), { flag: "wx" });
		return { pid: process.pid, release: releaseLock };
	} catch (error) {
		if ((error as { code?: unknown }).code === "EEXIST") {
			// Lost the race after clearing a stale lock; whoever won is live.
			const winner = await readLockPid();
			throw new AlreadyRunningError(winner ?? -1);
		}
		throw error;
	}
}

// Writes `node.lock` with flag `wx`; a lock held by a dead pid is taken
// over, a lock held by a live pid throws `AlreadyRunningError`.
export async function acquireLock(): Promise<LockHandle> {
	return takeLock();
}

async function releaseLock(): Promise<void> {
	try {
		await unlink(lockPath());
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") {
			throw error;
		}
	}
}
