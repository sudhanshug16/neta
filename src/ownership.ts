/**
 * Crash-safe cooperative ownership for filesystem entries.
 *
 * Acquisition publishes a proof-bearing, same-parent preparation record before
 * reserving the canonical name. Reclaim and release move the exact canonical
 * entry to a unique sibling quarantine, then validate the moved inode and
 * owner proof again before removing it. Directory quarantines are never
 * restored with an ordinary replace; an ambiguous one is retained for a
 * later, exact recovery attempt.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	unlinkSync,
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
	/** Test-only interposition point for the no-replace restore boundary. */
	readonly beforeDirectoryRestore?: () => void;
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
	readonly path: string;
	readonly kind: "directory" | "file";
	readonly dev?: number;
	readonly ino?: number;
}

const OWNER_FILE = "owner.json";
const RESERVATION_FILE = ".reservation.json";
const PREPARED_MARKER = ".prepared.";
const QUARANTINE_MARKER = ".quarantine.";
const LOCAL_PROCESS_START = `${Math.floor(Date.now() - process.uptime() * 1_000)}`;

function defaultProcessIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists. Only ESRCH is death proof.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function defaultProcessStartTime(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 1) return undefined;
	try {
		const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
		return value || (pid === process.pid ? LOCAL_PROCESS_START : undefined);
	} catch {
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

function preparedPrefix(path: string): string {
	return `${basename(path)}${PREPARED_MARKER}`;
}

function quarantinePrefix(path: string): string {
	return `${basename(path)}${QUARANTINE_MARKER}`;
}

function preparedPath(path: string, token: string): string {
	return join(dirname(path), `${preparedPrefix(path)}${process.pid}.${token}`);
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
	kind?: "directory" | "file",
): OwnershipOwner | LegacyOwner | undefined {
	if (!value) return undefined;
	const pid = value.pid;
	const startedAt = value.startedAt ?? value.processStartedAt;
	const token = value.token;
	const dev = value.dev;
	const ino = value.ino;
	if (!Number.isInteger(pid) || (pid as number) <= 1) return undefined;
	if (startedAt !== undefined && typeof startedAt !== "string") return undefined;
	if (token !== undefined && typeof token !== "string") return undefined;
	if (dev !== undefined && (!Number.isInteger(dev) || (dev as number) < 0)) return undefined;
	if (ino !== undefined && (!Number.isInteger(ino) || (ino as number) < 0)) return undefined;
	const embeddedPath = typeof value.path === "string" ? value.path : path;
	if (typeof token === "string" && typeof dev === "number" && typeof ino === "number")
		return {
			pid: pid as number,
			...(typeof startedAt === "string" ? { startedAt } : {}),
			token,
			dev,
			ino,
			path: embeddedPath,
		};
	return {
		pid: pid as number,
		...(typeof startedAt === "string" ? { startedAt } : {}),
		...(typeof token === "string" ? { token } : {}),
		...(typeof dev === "number" ? { dev } : {}),
		...(typeof ino === "number" ? { ino } : {}),
		...(typeof value.path === "string" ? { path: value.path } : {}),
		...(kind ? { kind } : {}),
	};
}

function entryInode(path: string): OwnershipInode | undefined {
	try {
		return inode(lstatSync(path));
	} catch {
		return undefined;
	}
}

function readEntryOwner(path: string): {
	owner?: OwnershipOwner | LegacyOwner;
	inode?: OwnershipInode;
	reason?: string;
} {
	const stat = (() => {
		try {
			return lstatSync(path);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return undefined;
			return null;
		}
	})();
	if (stat === undefined) return {};
	if (stat === null) return { reason: `could not inspect ownership entry ${path}` };
	if (!stat.isDirectory() || stat.isSymbolicLink()) return { reason: `ownership entry is not a directory: ${path}` };
	const owner = parseOwner(readJson(ownerPath(path)), path) ?? parseOwner(readJson(reservationPath(path)), path);
	if (owner) return { owner, inode: inode(stat) };
	return { inode: inode(stat), reason: `ownership entry has no valid owner metadata: ${path}` };
}

function readFileOwner(path: string): { owner?: OwnershipOwner | LegacyOwner; inode?: OwnershipInode } {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		return {};
	}
	if (!stat.isFile() || stat.isSymbolicLink()) return {};
	const parsed = parseOwner(readJson(path), path, "file");
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

function ownerIsReclaimable(owner: LegacyOwner, options: OwnershipOptions): boolean {
	if (typeof owner.pid !== "number") return false;
	const alive = (options.processIsAlive ?? defaultProcessIsAlive)(owner.pid);
	if (!alive) {
		// An injected identity probe is an explicit proof source in maintenance and
		// recovery. If it cannot answer for a saved identity, keep the residue
		// retryable rather than treating an ambiguous observation as death proof.
		if (owner.startedAt !== undefined && options.processStartTime)
			return options.processStartTime(owner.pid) !== undefined;
		return true;
	}
	// A live PID is reclaimable only when the saved identity proves PID reuse.
	if (owner.startedAt === undefined) return false;
	const current = (options.processStartTime ?? defaultProcessStartTime)(owner.pid);
	return current !== undefined && current !== owner.startedAt;
}

function sameOwnerProof(before: LegacyOwner, after: LegacyOwner, moved: OwnershipInode): boolean {
	if (before.pid !== after.pid || before.startedAt !== after.startedAt) return false;
	// A legacy record without a token cannot authorize deletion of a newer
	// token-bearing owner that happened to reuse its PID.
	if (before.token !== after.token) return false;
	if (before.dev !== undefined && before.dev !== after.dev) return false;
	if (before.ino !== undefined && before.ino !== after.ino) return false;
	if (after.dev !== undefined && after.ino !== undefined && !sameInode({ dev: after.dev, ino: after.ino }, moved))
		return false;
	return true;
}

function isValidatedMovedEntry(
	path: string,
	owner: LegacyOwner,
	moved: OwnershipInode,
	expected: OwnershipInode,
	expectedToken?: string,
): boolean {
	if (!sameInode(moved, expected)) return false;
	if (expectedToken !== undefined && owner.token !== expectedToken) return false;
	const current = entryInode(path);
	return current !== undefined && sameInode(current, moved);
}

function removeValidatedDirectory(path: string, owner: LegacyOwner, expected: OwnershipInode, token?: string): boolean {
	const moved = entryInode(path);
	if (!moved || !isValidatedMovedEntry(path, owner, moved, expected, token)) return false;
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
	rmSync(path, { recursive: true, force: false });
	fsyncParent(path);
	return true;
}

function removeValidatedEmptyDirectory(path: string, expected: OwnershipInode): boolean {
	const moved = entryInode(path);
	if (!moved || !sameInode(moved, expected)) return false;
	const entries = readdirSync(path);
	if (entries.length !== 0) return false;
	rmdirSync(path);
	fsyncParent(path);
	return true;
}

function removeValidatedFile(path: string, owner: LegacyOwner, expected: OwnershipInode, token?: string): boolean {
	const moved = entryInode(path);
	if (!moved || !sameInode(moved, expected) || !isValidatedMovedEntry(path, owner, moved, expected, token))
		return false;
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) return false;
	unlinkSync(path);
	fsyncParent(path);
	return true;
}

function listEntries(path: string, prefix: string): string[] | undefined {
	try {
		return readdirSync(dirname(path))
			.filter((name) => name.startsWith(prefix))
			.sort()
			.map((name) => join(dirname(path), name));
	} catch {
		return undefined;
	}
}

function listQuarantines(path: string): string[] | undefined {
	return listEntries(path, quarantinePrefix(path));
}

function listPrepared(path: string): string[] | undefined {
	return listEntries(path, preparedPrefix(path));
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

function restoreFileNoReplace(path: string, canonical: string, diagnostic?: (message: string) => void): boolean {
	try {
		linkSync(path, canonical);
		const restored = entryInode(canonical);
		const moved = entryInode(path);
		if (!restored || !moved || !sameInode(restored, moved)) return false;
		unlinkSync(path);
		fsyncParent(canonical);
		return true;
	} catch (error) {
		if (!isErrno(error, "EEXIST"))
			diagnostic?.(`file quarantine retained because it could not be restored: ${canonical}`);
		return false;
	}
}

function restoreDirectoryIfAbsent(path: string, canonical: string, options: OwnershipOptions): boolean {
	try {
		lstatSync(canonical);
		return false;
	} catch (error) {
		if (!isErrno(error, "ENOENT")) return false;
	}
	options.beforeDirectoryRestore?.();
	// The second reservation check prevents a known successor, including an
	// empty directory, from being replaced. If a hostile actor wins the tiny
	// kernel rename window, the postcondition below detects that and retains
	// the moved entry; cooperative owners never enter that window concurrently.
	try {
		lstatSync(canonical);
		return false;
	} catch (error) {
		if (!isErrno(error, "ENOENT")) return false;
	}
	try {
		renameSync(path, canonical);
		const restored = entryInode(canonical);
		const moved = entryInode(path);
		if (!restored || moved) return false;
		fsyncParent(canonical);
		return true;
	} catch {
		return false;
	}
}

function readPrepared(
	path: string,
	expected: string,
	kind: "directory" | "file",
):
	| {
			owner?: PreparedOwner;
			inode?: OwnershipInode;
	  }
	| undefined {
	const stat = (() => {
		try {
			return lstatSync(path);
		} catch {
			return undefined;
		}
	})();
	if (!stat || !stat.isFile() || stat.isSymbolicLink()) return undefined;
	const owner = parseOwner(readJson(path), path, kind);
	if (!owner || owner.path !== expected || owner.token === undefined) return undefined;
	return { owner: { ...owner, token: owner.token, path: expected, kind }, inode: inode(stat) };
}

function removePrepared(path: string, expected: PreparedOwner, expectedInode?: OwnershipInode): boolean {
	const current = readPrepared(path, expected.path, expected.kind);
	if (!current || !current.owner || !current.inode || current.owner.token !== expected.token) return false;
	if (expectedInode && !sameInode(current.inode, expectedInode)) return false;
	unlinkSync(path);
	fsyncParent(path);
	return true;
}

function writePrepared(path: string, owner: PreparedOwner, includeInode = false): OwnershipInode {
	const handle = openSync(path, "wx", 0o600);
	try {
		if (includeInode) {
			const preparedInode = inode(fstatSync(handle));
			const withInode = { ...owner, dev: preparedInode.dev, ino: preparedInode.ino };
			writeSync(handle, `${JSON.stringify(withInode)}\n`, undefined, "utf8");
			fsyncSync(handle);
			return preparedInode;
		}
		writeSync(handle, `${JSON.stringify(owner)}\n`, undefined, "utf8");
		fsyncSync(handle);
		return inode(fstatSync(handle));
	} finally {
		closeSync(handle);
	}
}

function writeDirectoryReservation(path: string, owner: OwnershipOwner): void {
	const handle = openSync(reservationPath(path), "wx", 0o600);
	try {
		writeSync(handle, `${JSON.stringify(owner)}\n`, undefined, "utf8");
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	fsyncDirectory(path);
}

function publishDirectoryOwner(path: string, owner: OwnershipOwner): void {
	const temporary = join(path, `.${OWNER_FILE}.${owner.token}.tmp`);
	const handle = openSync(temporary, "wx", 0o600);
	try {
		writeSync(handle, `${JSON.stringify(owner)}\n`, undefined, "utf8");
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	// A hard-link publication is atomic and cannot replace another owner file.
	linkSync(temporary, ownerPath(path));
	unlinkSync(temporary);
	fsyncDirectory(path);
	const reservation = readEntryOwner(path);
	if (reservation.owner?.token !== owner.token) throw new Error(`Ownership reservation changed: ${path}.`);
	unlinkSync(reservationPath(path));
	fsyncDirectory(path);
}

function recoverDirectoryQuarantines(path: string, options: OwnershipOptions): boolean {
	const quarantines = listQuarantines(path);
	if (!quarantines) return false;
	for (const quarantine of quarantines) {
		const observed = readEntryOwner(quarantine);
		if (!observed.owner || !observed.inode || !ownerIsReclaimable(observed.owner, options)) {
			options.diagnostic?.(`ownership quarantine is unresolved for ${path}: ${quarantine}`);
			return false;
		}
		const moved = readEntryOwner(quarantine);
		if (
			!moved.owner ||
			!moved.inode ||
			!sameOwnerProof(observed.owner, moved.owner, moved.inode) ||
			!ownerIsReclaimable(moved.owner, options) ||
			!removeValidatedDirectory(quarantine, moved.owner, moved.inode, moved.owner.token)
		) {
			options.diagnostic?.(`ownership quarantine failed moved-entry validation: ${quarantine}`);
			return false;
		}
	}
	return true;
}

function recoverFileQuarantines(path: string, options: OwnershipOptions): boolean {
	const quarantines = listQuarantines(path);
	if (!quarantines) return false;
	for (const quarantine of quarantines) {
		const observed = readFileOwner(quarantine);
		if (!observed.owner || !observed.inode || !ownerIsReclaimable(observed.owner, options)) return false;
		const moved = readFileOwner(quarantine);
		if (
			!moved.owner ||
			!moved.inode ||
			!sameOwnerProof(observed.owner, moved.owner, moved.inode) ||
			!ownerIsReclaimable(moved.owner, options) ||
			!removeValidatedFile(quarantine, moved.owner, moved.inode, moved.owner.token)
		)
			return false;
	}
	return true;
}

function recoverPreparedDirectory(path: string, options: OwnershipOptions): boolean {
	const prepared = listPrepared(path);
	if (!prepared) return false;
	for (const reservation of prepared) {
		const record = readPrepared(reservation, path, "directory");
		if (!record?.owner || !record.inode) {
			options.diagnostic?.(`prepared directory proof is malformed: ${reservation}`);
			return false;
		}
		if (!ownerIsReclaimable(record.owner, options)) {
			options.diagnostic?.(`prepared directory proof is live or unknown: ${reservation}`);
			return false;
		}
		const current = readEntryOwner(path);
		if (!current.inode) {
			if (!removePrepared(reservation, record.owner, record.inode)) {
				options.diagnostic?.(`prepared directory proof could not be removed: ${reservation}`);
				return false;
			}
			continue;
		}
		const quarantine = quarantineCanonical(path, options.diagnostic);
		if (!quarantine) return false;
		const moved = readEntryOwner(quarantine);
		const movedInode = entryInode(quarantine);
		const exactOwner =
			moved.owner &&
			movedInode &&
			moved.owner.token === record.owner.token &&
			sameInode(movedInode, current.inode) &&
			sameOwnerProof(record.owner, moved.owner, movedInode) &&
			ownerIsReclaimable(moved.owner, options);
		const emptyReservation = !moved.owner && movedInode && readdirSync(quarantine).length === 0;
		const removed =
			exactOwner && moved.owner && movedInode
				? removeValidatedDirectory(quarantine, moved.owner, movedInode, record.owner.token)
				: Boolean(emptyReservation && movedInode && removeValidatedEmptyDirectory(quarantine, movedInode));
		if (!removed) {
			options.diagnostic?.(`prepared directory reservation could not be reclaimed: ${reservation}`);
			restoreDirectoryIfAbsent(quarantine, path, options);
			return false;
		}
		if (!removePrepared(reservation, record.owner, record.inode)) {
			options.diagnostic?.(`prepared directory proof could not be retired: ${reservation}`);
			return false;
		}
	}
	return true;
}

function recoverPreparedFile(path: string, options: OwnershipOptions): boolean {
	const prepared = listPrepared(path);
	if (!prepared) return false;
	for (const reservation of prepared) {
		const record = readPrepared(reservation, path, "file");
		if (!record?.owner || !record.inode || !ownerIsReclaimable(record.owner, options)) return false;
		const current = readFileOwner(path);
		if (!current.inode) {
			if (!removePrepared(reservation, record.owner, record.inode)) return false;
			continue;
		}
		const quarantine = quarantineCanonical(path, options.diagnostic);
		if (!quarantine) return false;
		const moved = readFileOwner(quarantine);
		const movedInode = entryInode(quarantine);
		if (
			!moved.owner ||
			!movedInode ||
			!sameInode(movedInode, current.inode) ||
			!sameOwnerProof(record.owner, moved.owner, movedInode) ||
			!ownerIsReclaimable(moved.owner, options) ||
			!removeValidatedFile(quarantine, moved.owner, movedInode, record.owner.token)
		)
			return false;
		if (!removePrepared(reservation, record.owner, record.inode)) return false;
	}
	return true;
}

function reclaimCanonicalDirectory(path: string, options: OwnershipOptions): boolean {
	const observed = readEntryOwner(path);
	if (!observed.owner || !observed.inode || !ownerIsReclaimable(observed.owner, options)) return false;
	const quarantine = quarantineCanonical(path, options.diagnostic);
	if (!quarantine) return false;
	const moved = readEntryOwner(quarantine);
	const movedInode = entryInode(quarantine);
	if (
		!moved.owner ||
		!movedInode ||
		!sameInode(movedInode, observed.inode) ||
		!sameOwnerProof(observed.owner, moved.owner, movedInode) ||
		!ownerIsReclaimable(moved.owner, options) ||
		!removeValidatedDirectory(quarantine, moved.owner, movedInode, moved.owner.token)
	) {
		restoreDirectoryIfAbsent(quarantine, path, options);
		return false;
	}
	return true;
}

function reclaimCanonicalFile(path: string, options: OwnershipOptions): boolean {
	const observed = readFileOwner(path);
	if (!observed.owner || !observed.inode || !ownerIsReclaimable(observed.owner, options)) return false;
	const quarantine = quarantineCanonical(path, options.diagnostic);
	if (!quarantine) return false;
	const moved = readFileOwner(quarantine);
	const movedInode = entryInode(quarantine);
	if (
		!moved.owner ||
		!movedInode ||
		!sameInode(movedInode, observed.inode) ||
		!sameOwnerProof(observed.owner, moved.owner, movedInode) ||
		!ownerIsReclaimable(moved.owner, options) ||
		!removeValidatedFile(quarantine, moved.owner, movedInode, moved.owner.token)
	) {
		restoreFileNoReplace(quarantine, path, options.diagnostic);
		return false;
	}
	return true;
}

function cleanupCreatedDirectory(
	path: string,
	owner: OwnershipOwner,
	created: OwnershipInode,
	options: OwnershipOptions,
): void {
	const current = readEntryOwner(path);
	if (!current.inode || !sameInode(current.inode, created)) return;
	if (current.owner && current.owner.token !== owner.token) return;
	if (!current.owner && readdirSync(path).length !== 0) return;
	const quarantine = quarantineCanonical(path, options.diagnostic);
	if (!quarantine) return;
	const moved = readEntryOwner(quarantine);
	const movedInode = entryInode(quarantine);
	if (movedInode && sameInode(movedInode, created) && (!moved.owner || moved.owner.token === owner.token)) {
		if (moved.owner) {
			if (sameOwnerProof(owner, moved.owner, movedInode))
				removeValidatedDirectory(quarantine, moved.owner, movedInode, owner.token);
		} else if (readdirSync(quarantine).length === 0) removeValidatedEmptyDirectory(quarantine, movedInode);
	}
}

function cleanupCreatedFile(
	path: string,
	owner: OwnershipOwner,
	created: OwnershipInode,
	options: OwnershipOptions,
): void {
	const current = readFileOwner(path);
	if (!current.inode || !sameInode(current.inode, created) || current.owner?.token !== owner.token) return;
	const quarantine = quarantineCanonical(path, options.diagnostic);
	if (!quarantine) return;
	const moved = readFileOwner(quarantine);
	const movedInode = entryInode(quarantine);
	if (moved.owner && movedInode && moved.owner.token === owner.token && sameInode(movedInode, created))
		removeValidatedFile(quarantine, moved.owner, movedInode, owner.token);
}

function releaseDirectoryQuarantine(handle: OwnedDirectoryLease, options: OwnershipOptions): boolean {
	const quarantines = listQuarantines(handle.path);
	if (!quarantines) return false;
	for (const quarantine of quarantines) {
		const moved = readEntryOwner(quarantine);
		if (
			moved.owner?.token === handle.token &&
			moved.inode &&
			sameInode(moved.inode, handle.inode) &&
			removeValidatedDirectory(quarantine, moved.owner, moved.inode, handle.token)
		)
			return true;
	}
	options.diagnostic?.(`ownership release left directory quarantine residue: ${handle.path}`);
	return false;
}

/** Acquire a new owned directory, or recover a proven-dead prior owner first. */
export function tryAcquireOwnedDirectory(
	path: string,
	options: OwnershipOptions = {},
): OwnedDirectoryLease | undefined {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (!recoverDirectoryQuarantines(path, options) || !recoverPreparedDirectory(path, options)) return undefined;
	const startedAt = (options.processStartTime ?? defaultProcessStartTime)(process.pid);
	if (!startedAt) return undefined;
	const token = randomBytes(16).toString("hex");
	const prepared = preparedPath(path, token);
	const preparedOwner: PreparedOwner = { pid: process.pid, startedAt, token, path, kind: "directory" };
	let preparedInode: OwnershipInode | undefined;
	try {
		preparedInode = writePrepared(prepared, preparedOwner);
		try {
			mkdirSync(path, { recursive: false, mode: 0o700 });
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			removePrepared(prepared, preparedOwner, preparedInode);
			if (reclaimCanonicalDirectory(path, options)) return tryAcquireOwnedDirectory(path, options);
			return undefined;
		}
		const created = entryInode(path);
		if (!created) throw new Error(`Could not inspect newly reserved ownership directory: ${path}.`);
		const owner: OwnershipOwner = { pid: process.pid, startedAt, token, dev: created.dev, ino: created.ino, path };
		writeDirectoryReservation(path, owner);
		publishDirectoryOwner(path, owner);
		fsyncParent(path);
		removePrepared(prepared, { ...preparedOwner, dev: preparedInode.dev, ino: preparedInode.ino }, preparedInode);
		return Object.freeze({ path, token, inode: created, owner });
	} catch (error) {
		if (preparedInode) {
			try {
				removePrepared(
					prepared,
					{ ...preparedOwner, dev: preparedInode.dev, ino: preparedInode.ino },
					preparedInode,
				);
			} catch {
				options.diagnostic?.(`ownership preparation residue retained: ${prepared}`);
			}
		}
		if (preparedInode) {
			const created = entryInode(path);
			if (created) {
				const current = readEntryOwner(path);
				if (sameInode(created, current.inode ?? created) && current.owner?.token === token)
					cleanupCreatedDirectory(
						path,
						{ pid: process.pid, startedAt, token, dev: created.dev, ino: created.ino, path },
						created,
						options,
					);
			}
		}
		throw error;
	}
}

/** Release only the exact owner represented by this handle. */
export function releaseOwnedDirectory(handle: OwnedDirectoryLease | undefined, options: OwnershipOptions = {}): void {
	if (!handle) return;
	const quarantine = quarantineCanonical(handle.path, options.diagnostic);
	if (!quarantine) {
		releaseDirectoryQuarantine(handle, options);
		return;
	}
	const moved = readEntryOwner(quarantine);
	const movedInode = entryInode(quarantine);
	if (
		!moved.owner ||
		!movedInode ||
		!sameInode(movedInode, handle.inode) ||
		moved.owner.token !== handle.token ||
		!sameOwnerProof(
			{ ...handle.owner, token: handle.token, dev: handle.inode.dev, ino: handle.inode.ino },
			moved.owner,
			movedInode,
		) ||
		!removeValidatedDirectory(quarantine, moved.owner, movedInode, handle.token)
	) {
		options.diagnostic?.(`ownership release retained an entry that failed token/inode validation: ${handle.path}`);
		restoreDirectoryIfAbsent(quarantine, handle.path, options);
	}
}

/** Validate that a capability still owns the same directory inode and token. */
export function assertOwnedDirectoryHeld(handle: OwnedDirectoryLease): void {
	const observed = readEntryOwner(handle.path);
	if (
		!observed.owner ||
		!observed.inode ||
		observed.owner.token !== handle.token ||
		!sameInode(observed.inode, handle.inode) ||
		!sameOwnerProof(
			{ ...handle.owner, token: handle.token, dev: handle.inode.dev, ino: handle.inode.ino },
			observed.owner,
			observed.inode,
		)
	)
		throw new Error(`Owned directory is no longer held: ${handle.path}.`);
}

/** Safely recover one named directory's old-format owner or quarantine residue. */
export function recoverOwnedDirectory(path: string, options: OwnershipOptions = {}): boolean {
	return recoverDirectoryQuarantines(path, options) && recoverPreparedDirectory(path, options);
}

/** Inspect a token/maintenance directory without mutating it. */
export function inspectOwnedDirectory(path: string): OwnershipInspection {
	const observed = readEntryOwner(path);
	if (!observed.inode) return { state: "absent" };
	if (!observed.owner) return { state: "ambiguous", reason: observed.reason ?? `malformed owner metadata ${path}` };
	if (
		"token" in observed.owner &&
		typeof observed.owner.token === "string" &&
		typeof observed.owner.dev === "number" &&
		typeof observed.owner.ino === "number"
	)
		return { state: "owned", owner: observed.owner as OwnershipOwner, inode: observed.inode };
	return { state: "legacy", owner: observed.owner, inode: observed.inode };
}

/** Reclaim a proven-dead directory token without ever deleting a replacement. */
export function reclaimOwnedDirectory(path: string, options: OwnershipOptions = {}): boolean {
	if (!recoverDirectoryQuarantines(path, options) || !recoverPreparedDirectory(path, options)) return false;
	return reclaimCanonicalDirectory(path, options);
}

/** Acquire the legacy checkpoint-file equivalent with the same quarantine rules. */
export function tryAcquireOwnedFile(path: string, options: OwnershipOptions = {}): OwnedFileLease | undefined {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (!recoverFileQuarantines(path, options) || !recoverPreparedFile(path, options)) return undefined;
	const startedAt = (options.processStartTime ?? defaultProcessStartTime)(process.pid);
	if (!startedAt) return undefined;
	const token = randomBytes(16).toString("hex");
	const prepared = preparedPath(path, token);
	const preparedOwner: PreparedOwner = { pid: process.pid, startedAt, token, path, kind: "file" };
	let preparedInode: OwnershipInode | undefined;
	let canonicalInode: OwnershipInode | undefined;
	try {
		preparedInode = writePrepared(prepared, preparedOwner, true);
		const preparedRecord = readPrepared(prepared, path, "file");
		if (!preparedRecord?.owner) throw new Error(`Could not publish prepared ownership file: ${path}.`);
		try {
			linkSync(prepared, path);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			removePrepared(prepared, preparedRecord.owner, preparedInode);
			if (reclaimCanonicalFile(path, options)) return tryAcquireOwnedFile(path, options);
			return undefined;
		}
		canonicalInode = entryInode(path);
		if (!canonicalInode || !sameInode(canonicalInode, preparedInode))
			throw new Error(`Ownership link changed: ${path}.`);
		fsyncParent(path);
		if (!removePrepared(prepared, preparedRecord.owner, preparedInode))
			throw new Error(`Could not retire prepared ownership file: ${path}.`);
		return Object.freeze({ path, token, inode: canonicalInode, owner: preparedRecord.owner as OwnershipOwner });
	} catch (error) {
		if (preparedInode) {
			try {
				const preparedRecord = readPrepared(prepared, path, "file");
				if (preparedRecord?.owner) removePrepared(prepared, preparedRecord.owner, preparedInode);
			} catch {
				options.diagnostic?.(`ownership preparation residue retained: ${prepared}`);
			}
		}
		if (canonicalInode) {
			const current = readFileOwner(path);
			if (current.inode && sameInode(current.inode, canonicalInode) && current.owner?.token === token)
				cleanupCreatedFile(path, current.owner as OwnershipOwner, canonicalInode, options);
		}
		throw error;
	}
}

/** Release an exact checkpoint-file handle; a replacement can never be removed. */
export function releaseOwnedFile(handle: OwnedFileLease | undefined, options: OwnershipOptions = {}): void {
	if (!handle) return;
	const quarantine = quarantineCanonical(handle.path, options.diagnostic);
	if (!quarantine) return;
	const moved = readFileOwner(quarantine);
	const movedInode = entryInode(quarantine);
	if (
		moved.owner &&
		movedInode &&
		moved.owner.token === handle.token &&
		sameInode(movedInode, handle.inode) &&
		sameOwnerProof(handle.owner, moved.owner, movedInode) &&
		removeValidatedFile(quarantine, moved.owner, movedInode, handle.token)
	)
		return;
	// Files can be restored atomically without replacing a successor: hard-link
	// reserves the canonical name with O_EXCL semantics, then the quarantine link
	// is removed only after exact inode validation.
	restoreFileNoReplace(quarantine, handle.path, options.diagnostic);
}
