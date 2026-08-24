/**
 * Crash-safe cooperative ownership for filesystem entries.
 *
 * A canonical entry is never removed after a separate observation.  Reclaim
 * and release first rename that exact entry to a unique sibling quarantine,
 * then validate the moved inode and owner token before removing the quarantine.
 * This is deliberately cooperative: a replacement or an unreadable entry is
 * retained and reported as ambiguous.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface OwnershipInode {
	readonly dev: number;
	readonly ino: number;
}

export interface OwnershipOwner {
	readonly pid: number;
	readonly startedAt?: string;
	readonly token: string;
	readonly dev: number;
	readonly ino: number;
	readonly path: string;
}

export interface OwnedDirectoryLease {
	readonly path: string;
	readonly token: string;
	readonly inode: OwnershipInode;
	readonly owner: {
		readonly pid: number;
		readonly startedAt?: string;
		readonly token?: string;
		readonly dev?: number;
		readonly ino?: number;
		readonly path?: string;
	};
}

export interface OwnedFileLease {
	readonly path: string;
	readonly token: string;
	readonly inode: OwnershipInode;
	readonly owner: OwnershipOwner;
}

export interface OwnershipOptions {
	readonly processIsAlive?: (pid: number) => boolean;
	readonly processStartTime?: (pid: number) => string | undefined;
	readonly diagnostic?: (message: string) => void;
}

export type OwnershipInspection =
	| { readonly state: "absent" }
	| { readonly state: "owned"; readonly owner: OwnershipOwner; readonly inode: OwnershipInode }
	| { readonly state: "legacy"; readonly owner: LegacyOwner; readonly inode: OwnershipInode }
	| { readonly state: "ambiguous"; readonly reason: string };

interface LegacyOwner {
	readonly pid?: number;
	readonly startedAt?: string;
	readonly token?: string;
	readonly dev?: number;
	readonly ino?: number;
	readonly path?: string;
}

interface PreparedOwner extends LegacyOwner {
	readonly token: string;
	readonly dev: number;
	readonly ino: number;
	readonly path: string;
}

const OWNER_FILE = "owner.json";
const RESERVATION_FILE = ".reservation.json";
const QUARANTINE_MARKER = ".quarantine.";
const LOCAL_PROCESS_START = `${Math.floor(Date.now() - process.uptime() * 1_000)}`;

function defaultProcessIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists. Every other non-ESRCH error is treated
		// conservatively as alive/ambiguous; only ESRCH is death proof.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function defaultProcessStartTime(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 1) return undefined;
	try {
		const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
		return value || (pid === process.pid ? LOCAL_PROCESS_START : undefined);
	} catch {
		// Sandboxed macOS runners may deny ps. The monotonic boot-relative value is
		// still stable for this process and is never used to identify another PID.
		return pid === process.pid ? LOCAL_PROCESS_START : undefined;
	}
}

export function processStartIdentity(pid: number): string | undefined {
	return defaultProcessStartTime(pid);
}

function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException).code === code;
}

function fsyncParent(path: string): void {
	const handle = openSync(dirname(path), "r");
	try {
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

function fsyncDirectory(path: string): void {
	const handle = openSync(path, "r");
	try {
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

function inode(stat: { dev: number | bigint; ino: number | bigint } | undefined): OwnershipInode {
	if (!stat) throw new Error("missing filesystem identity");
	return { dev: Number(stat.dev), ino: Number(stat.ino) };
}

function sameInode(left: OwnershipInode, right: OwnershipInode): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function ownerPath(path: string): string {
	return join(path, OWNER_FILE);
}

function reservationPath(path: string): string {
	return join(path, RESERVATION_FILE);
}

function quarantinePrefix(path: string): string {
	return `${basename(path)}${QUARANTINE_MARKER}`;
}

function quarantinePath(path: string): string {
	return join(dirname(path), `${quarantinePrefix(path)}${process.pid}.${randomBytes(12).toString("hex")}`);
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function parseOwner(
	value: Record<string, unknown> | undefined,
	path: string,
): OwnershipOwner | LegacyOwner | undefined {
	if (!value) return undefined;
	const pid = value.pid;
	const startedAt = value.startedAt;
	const token = value.token;
	const dev = value.dev;
	const ino = value.ino;
	if (!Number.isInteger(pid) || (pid as number) <= 1) return undefined;
	if (startedAt !== undefined && typeof startedAt !== "string") return undefined;
	if (token !== undefined && typeof token !== "string") return undefined;
	if (dev !== undefined && (!Number.isInteger(dev) || (dev as number) < 0)) return undefined;
	if (ino !== undefined && (!Number.isInteger(ino) || (ino as number) < 0)) return undefined;
	if (typeof token === "string" && typeof dev === "number" && typeof ino === "number")
		return {
			pid: pid as number,
			...(typeof startedAt === "string" ? { startedAt } : {}),
			token,
			dev,
			ino,
			path,
		};
	return {
		pid: pid as number,
		...(typeof startedAt === "string" ? { startedAt } : {}),
		...(typeof token === "string" ? { token } : {}),
		...(typeof dev === "number" ? { dev } : {}),
		...(typeof ino === "number" ? { ino } : {}),
		...(typeof value.path === "string" ? { path: value.path } : {}),
	};
}

function readEntryOwner(path: string): {
	owner?: OwnershipOwner | LegacyOwner;
	inode?: OwnershipInode;
	reason?: string;
} {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return {};
		return { reason: `could not inspect ownership entry ${path}` };
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) return { reason: `ownership entry is not a directory: ${path}` };
	const owner = parseOwner(readJson(ownerPath(path)), path);
	if (owner) return { owner, inode: inode(stat) };
	const reservation = parseOwner(readJson(reservationPath(path)), path);
	if (reservation) return { owner: reservation, inode: inode(stat) };
	return { reason: `ownership entry has no valid owner metadata: ${path}` };
}

function ownerIsDead(owner: LegacyOwner, options: OwnershipOptions): boolean {
	return typeof owner.pid === "number" && !(options.processIsAlive ?? defaultProcessIsAlive)(owner.pid);
}

function isValidatedMovedEntry(
	path: string,
	owner: LegacyOwner,
	moved: OwnershipInode,
	expectedToken?: string,
): boolean {
	if (expectedToken !== undefined && owner.token !== expectedToken) return false;
	// Legacy owner.json files predate the dev/ino fields. Their exact moved inode
	// is still validated below, but no new owner is ever published this way.
	if (owner.dev !== undefined && owner.ino !== undefined && !sameInode({ dev: owner.dev, ino: owner.ino }, moved))
		return false;
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() && !stat.isSymbolicLink() && sameInode(inode(stat), moved);
	} catch {
		return false;
	}
}

function removeValidatedQuarantine(path: string, owner: LegacyOwner, expectedToken?: string): boolean {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		return false;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
	if (!isValidatedMovedEntry(path, owner, inode(stat), expectedToken)) return false;
	rmSync(path, { recursive: true, force: false });
	fsyncParent(path);
	return true;
}

function removeValidatedFileQuarantine(
	path: string,
	owner: LegacyOwner,
	moved: OwnershipInode,
	expectedToken?: string,
): boolean {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		return false;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || !sameInode(inode(stat), moved)) return false;
	if (expectedToken !== undefined && owner.token !== expectedToken) return false;
	if (owner.dev !== undefined && owner.ino !== undefined && !sameInode({ dev: owner.dev, ino: owner.ino }, moved))
		return false;
	unlinkSync(path);
	fsyncParent(path);
	return true;
}

function readFileOwner(path: string): { owner?: OwnershipOwner | LegacyOwner; inode?: OwnershipInode } {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		return {};
	}
	if (!stat.isFile() || stat.isSymbolicLink()) return {};
	const parsed = parseOwner(readJson(path), path);
	if (parsed) return { owner: parsed, inode: inode(stat) };
	// The original checkpoint lock contained only a decimal PID.
	try {
		const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
		if (Number.isInteger(pid) && pid > 1) return { owner: { pid }, inode: inode(stat) };
	} catch {
		// The entry remains ambiguous and is never removed.
	}
	return {};
}

function restoreQuarantine(path: string, canonical: string, diagnostic?: (message: string) => void): void {
	try {
		lstatSync(canonical);
		// A successor won the canonical name. Preserve the quarantine rather than
		// overwriting it or allowing a later run to guess which owner it belongs to.
		diagnostic?.(`ownership quarantine retained because a successor occupies ${canonical}`);
		return;
	} catch (error) {
		if (!isErrno(error, "ENOENT")) {
			diagnostic?.(`ownership quarantine retained because ${canonical} is ambiguous`);
			return;
		}
	}
	try {
		renameSync(path, canonical);
		fsyncParent(canonical);
	} catch {
		diagnostic?.(`ownership quarantine retained because it could not be restored to ${canonical}`);
	}
}

function quarantineCanonical(path: string, diagnostic?: (message: string) => void): string | undefined {
	const quarantine = quarantinePath(path);
	try {
		renameSync(path, quarantine);
		fsyncParent(path);
		return quarantine;
	} catch (error) {
		if (!isErrno(error, "ENOENT")) diagnostic?.(`could not quarantine ownership entry ${path}`);
		return undefined;
	}
}

function listQuarantines(path: string): string[] | undefined {
	try {
		return readdirSync(dirname(path))
			.filter((name) => name.startsWith(quarantinePrefix(path)))
			.map((name) => join(dirname(path), name));
	} catch {
		return undefined;
	}
}

function recoverQuarantine(path: string, options: OwnershipOptions): boolean {
	const quarantines = listQuarantines(path);
	if (!quarantines) return false;
	for (const quarantine of quarantines) {
		const observed = readEntryOwner(quarantine);
		if (!observed.owner || !observed.inode || !ownerIsDead(observed.owner, options)) {
			options.diagnostic?.(`ownership quarantine is unresolved for ${path}: ${quarantine}`);
			return false;
		}
		if (!removeValidatedQuarantine(quarantine, observed.owner)) {
			options.diagnostic?.(`ownership quarantine failed moved-entry validation: ${quarantine}`);
			return false;
		}
	}
	return true;
}

function writePrepared(path: string, owner: PreparedOwner): void {
	writeFileSync(reservationPath(path), `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 });
	fsyncDirectory(path);
}

function publishOwner(path: string, owner: OwnershipOwner): void {
	const temporary = join(path, `.${OWNER_FILE}.${owner.token}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 });
	const handle = openSync(temporary, "r");
	try {
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	renameSync(temporary, ownerPath(path));
	fsyncDirectory(path);
	try {
		unlinkSync(reservationPath(path));
		fsyncDirectory(path);
	} catch (error) {
		if (!isErrno(error, "ENOENT")) throw error;
	}
}

function releaseMoved(path: string, handle: OwnedDirectoryLease, options: OwnershipOptions): boolean {
	const quarantine = quarantineCanonical(path, options.diagnostic);
	if (!quarantine) return false;
	const observed = readEntryOwner(quarantine);
	const valid =
		observed.owner !== undefined &&
		observed.inode !== undefined &&
		observed.owner.token === handle.token &&
		isValidatedMovedEntry(quarantine, observed.owner, handle.inode, handle.token);
	if (!valid) {
		options.diagnostic?.(`ownership release retained an entry that failed token/inode validation: ${path}`);
		restoreQuarantine(quarantine, path, options.diagnostic);
		return false;
	}
	try {
		return removeValidatedQuarantine(quarantine, observed.owner as LegacyOwner, handle.token);
	} catch {
		options.diagnostic?.(`ownership release left quarantine residue: ${quarantine}`);
		return false;
	}
}

/** Acquire a new owned directory, or recover a proven-dead prior owner first. */
export function tryAcquireOwnedDirectory(
	path: string,
	options: OwnershipOptions = {},
): OwnedDirectoryLease | undefined {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (!recoverQuarantine(path, options)) return undefined;
	const token = randomBytes(16).toString("hex");
	try {
		mkdirSync(path, { recursive: false, mode: 0o700 });
	} catch (error) {
		if (!isErrno(error, "EEXIST")) throw error;
		const observed = readEntryOwner(path);
		if (!observed.owner || !observed.inode || !ownerIsDead(observed.owner, options)) return undefined;
		const quarantine = quarantineCanonical(path, options.diagnostic);
		if (!quarantine) return undefined;
		const moved = readEntryOwner(quarantine);
		if (!moved.owner || !moved.inode || !removeValidatedQuarantine(quarantine, moved.owner, moved.owner.token)) {
			restoreQuarantine(quarantine, path, options.diagnostic);
			return undefined;
		}
		return tryAcquireOwnedDirectory(path, options);
	}
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`ownership entry is not a directory: ${path}`);
		const startedAt = (options.processStartTime ?? defaultProcessStartTime)(process.pid);
		if (!startedAt) return undefined;
		const owner: OwnershipOwner = {
			pid: process.pid,
			startedAt,
			token,
			dev: Number(stat.dev),
			ino: Number(stat.ino),
			path,
		};
		writePrepared(path, owner);
		publishOwner(path, owner);
		fsyncParent(path);
		return Object.freeze({ path, token, inode: { dev: stat.dev, ino: stat.ino }, owner });
	} catch (error) {
		const prepared = readEntryOwner(path);
		if (prepared.owner && prepared.inode && prepared.owner.token === token) {
			releaseMoved(
				path,
				{
					path,
					token,
					inode: prepared.inode,
					owner: prepared.owner as OwnershipOwner,
				},
				options,
			);
		}
		throw error;
	}
}

/** Release only the exact owner represented by this handle. */
export function releaseOwnedDirectory(handle: OwnedDirectoryLease | undefined, options: OwnershipOptions = {}): void {
	if (!handle) return;
	releaseMoved(handle.path, handle, options);
}

/** Validate that a capability still owns the same directory inode and token. */
export function assertOwnedDirectoryHeld(handle: OwnedDirectoryLease): void {
	const observed = readEntryOwner(handle.path);
	if (
		!observed.owner ||
		!observed.inode ||
		observed.owner.token !== handle.token ||
		!sameInode(observed.inode, handle.inode) ||
		!isValidatedMovedEntry(handle.path, observed.owner, handle.inode, handle.token)
	)
		throw new Error(`Owned directory is no longer held: ${handle.path}.`);
}

/** Safely recover one named directory's old-format owner or quarantine residue. */
export function recoverOwnedDirectory(path: string, options: OwnershipOptions = {}): boolean {
	return recoverQuarantine(path, options);
}

/** Inspect a token/maintenance directory without mutating it. */
export function inspectOwnedDirectory(path: string): OwnershipInspection {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return { state: "absent" };
		return { state: "ambiguous", reason: `could not inspect ${path}` };
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) return { state: "ambiguous", reason: `unsafe entry ${path}` };
	const owner = parseOwner(readJson(ownerPath(path)), path) ?? parseOwner(readJson(reservationPath(path)), path);
	if (!owner) return { state: "ambiguous", reason: `malformed owner metadata ${path}` };
	const entry = { inode: inode(stat) };
	if (
		"token" in owner &&
		typeof owner.token === "string" &&
		typeof owner.dev === "number" &&
		typeof owner.ino === "number"
	)
		return { state: "owned", owner: owner as OwnershipOwner, ...entry };
	return { state: "legacy", owner, ...entry };
}

/** Reclaim a proven-dead directory token without ever deleting its canonical name. */
export function reclaimOwnedDirectory(path: string, options: OwnershipOptions = {}): boolean {
	const observed = inspectOwnedDirectory(path);
	if (observed.state !== "owned" && observed.state !== "legacy") return false;
	if (!ownerIsDead(observed.owner, options)) return false;
	const quarantine = quarantineCanonical(path, options.diagnostic);
	if (!quarantine) return false;
	const moved = inspectOwnedDirectory(quarantine);
	if (moved.state === "owned" || moved.state === "legacy") {
		if (removeValidatedQuarantine(quarantine, moved.owner, moved.state === "owned" ? moved.owner.token : undefined))
			return true;
	}
	restoreQuarantine(quarantine, path, options.diagnostic);
	return false;
}

/** Acquire the legacy checkpoint-file equivalent with the same quarantine rules. */
export function tryAcquireOwnedFile(path: string, options: OwnershipOptions = {}): OwnedFileLease | undefined {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const token = randomBytes(16).toString("hex");
	try {
		const handle = openSync(path, "wx", 0o600);
		const stat = fstatOwned(handle);
		const startedAt = (options.processStartTime ?? defaultProcessStartTime)(process.pid);
		if (!startedAt) {
			closeSync(handle);
			return undefined;
		}
		const owner: OwnershipOwner = {
			pid: process.pid,
			startedAt,
			token,
			dev: stat.dev,
			ino: stat.ino,
			path,
		};
		writeSync(handle, `${JSON.stringify(owner)}\n`, undefined, "utf8");
		fsyncSync(handle);
		closeSync(handle);
		fsyncParent(path);
		return Object.freeze({ path, token, inode: inode(stat), owner });
	} catch (error) {
		if (!isErrno(error, "EEXIST")) throw error;
	}
	const observed = readFileOwner(path);
	if (!observed.owner || !observed.inode || !ownerIsDead(observed.owner, options)) return undefined;
	const quarantine = quarantineCanonical(path, options.diagnostic);
	if (!quarantine) return undefined;
	const moved = readFileOwner(quarantine);
	if (!moved.owner || !moved.inode || !removeValidatedFileQuarantine(quarantine, moved.owner, moved.inode)) {
		restoreQuarantine(quarantine, path, options.diagnostic);
		return undefined;
	}
	return tryAcquireOwnedFile(path, options);
}

function fstatOwned(handle: number): OwnershipInode {
	const stat = fstatSync(handle);
	return { dev: stat.dev, ino: stat.ino };
}

/** Release an exact checkpoint-file handle; a replacement can never be removed. */
export function releaseOwnedFile(handle: OwnedFileLease | undefined, options: OwnershipOptions = {}): void {
	if (!handle) return;
	const quarantine = quarantineCanonical(handle.path, options.diagnostic);
	if (!quarantine) return;
	const moved = readFileOwner(quarantine);
	if (
		!moved.owner ||
		!moved.inode ||
		moved.owner.token !== handle.token ||
		!sameInode(moved.inode, handle.inode) ||
		!removeValidatedFileQuarantine(quarantine, moved.owner, moved.inode, handle.token)
	) {
		restoreQuarantine(quarantine, handle.path, options.diagnostic);
	}
}
