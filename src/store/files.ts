import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";

export interface NdjsonRead<T> {
	records: T[];
	bytes: number;
	truncated: boolean;
}

export interface NdjsonOptions {
	from?: number;
	maxBytes?: number;
	onWarn?: (message: string) => void;
}

export type Mutex = <T>(fn: () => Promise<T>) => Promise<T>;

// Recursive, 0700. The mode is set explicitly so a loose umask cannot widen it.
export async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const handle = await open(dir, "r");
	try {
		await handle.chmod(0o700);
	} finally {
		await handle.close();
	}
}

// Temp sibling, write, 0600, fsync, close, rename, fsync the directory.
export async function writeFileAtomic(path: string, data: string): Promise<void> {
	await ensureDir(dirname(path));
	const tmp = `${path}.tmp-${process.pid}-${writeCounter++}`;
	const handle = await open(tmp, "w");
	try {
		await handle.writeFile(data);
		await handle.chmod(0o600);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(tmp, path);
	await fsyncDir(dirname(path));
}

let writeCounter = 0;

async function fsyncDir(dir: string): Promise<void> {
	const handle = await open(dir, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await writeFileAtomic(path, `${JSON.stringify(value)}\n`);
}

export async function readJson<T>(path: string): Promise<T | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	return JSON.parse(text) as T;
}

export async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

// Append one JSON line, fsync, return the EOF offset after the write.
export async function appendLine(path: string, value: unknown): Promise<number> {
	const handle = await open(path, "a");
	try {
		await handle.write(`${JSON.stringify(value)}\n`);
		await handle.sync();
		const st = await handle.stat();
		return st.size;
	} finally {
		await handle.close();
	}
}

// Forward read from `opts.from ?? 0`, at most `maxBytes`. A trailing fragment
// or an unparsable final line is dropped with one warning (`truncated: true`);
// any other bad line throws. `bytes` is the offset past the last good line,
// so the caller resumes by passing it back as `from`.
export async function readNdjson<T>(path: string, opts?: NdjsonOptions): Promise<NdjsonRead<T>> {
	const from = opts?.from ?? 0;
	const onWarn = opts?.onWarn ?? ((message: string): void => console.warn(message));
	const size = await fileSize(path);
	const end = opts?.maxBytes === undefined ? size : Math.min(size, from + opts.maxBytes);
	if (end <= from) {
		return { records: [], bytes: from, truncated: false };
	}
	const handle = await open(path, "r");
	let text: string;
	try {
		const buf = Buffer.alloc(end - from);
		await handle.read(buf, 0, buf.length, from);
		text = buf.toString("utf8");
	} finally {
		await handle.close();
	}
	const terminated = text.endsWith("\n");
	const parts = text.split("\n");
	// Drop the trailing piece: "" after a final newline, or the fragment cut by
	// maxBytes / a torn write.
	const complete = parts.slice(0, -1);
	const atEof = end === size;
	const records: T[] = [];
	let bytes = from;
	for (let i = 0; i < complete.length; i++) {
		const line = complete[i];
		try {
			records.push(JSON.parse(line) as T);
			bytes += Buffer.byteLength(line, "utf8") + 1;
		} catch {
			if (atEof && i === complete.length - 1 && terminated) {
				onWarn(`dropping unparsable last line in ${basename(path)}`);
				return { records, bytes, truncated: true };
			}
			throw new Error(`corrupt line ${i + 1} in ${path}`);
		}
	}
	if (!terminated) {
		if (atEof) {
			onWarn(`dropping truncated last line in ${basename(path)}`);
		}
		return { records, bytes, truncated: true };
	}
	return { records, bytes, truncated: end < size };
}

const BACKWARDS_CHUNK = 64 * 1024;

// The last `lines` whole lines before `opts.endAt` (default EOF), in file
// order. Reads 64 KiB chunks backwards; an unterminated trailing fragment is
// dropped and reported via `truncated`. `bytes` is the offset the read ran to.
export async function readNdjsonBackwards<T>(
	path: string,
	lines: number,
	opts?: { endAt?: number },
): Promise<NdjsonRead<T>> {
	const size = await fileSize(path);
	const stop = opts?.endAt === undefined ? size : Math.min(opts.endAt, size);
	if (stop === 0 || lines <= 0) {
		return { records: [], bytes: 0, truncated: false };
	}
	const handle = await open(path, "r");
	const collected: string[] = [];
	let truncated = false;
	try {
		let position = stop;
		let carry = "";
		let first = true;
		let sawNewline = false;
		while (position > 0 && collected.length < lines) {
			const length = Math.min(BACKWARDS_CHUNK, position);
			position -= length;
			const buf = Buffer.alloc(length);
			await handle.read(buf, 0, length, position);
			const text = buf.toString("utf8") + carry;
			const parts = text.split("\n");
			if (parts.length > 1) {
				sawNewline = true;
			}
			carry = parts[0];
			const rest = parts.slice(1);
			if (first) {
				first = false;
				// Drop "" after a final newline, or a torn write at EOF (which
				// the caller reports; lines before it are intact).
				if (!text.endsWith("\n")) {
					truncated = true;
				}
				rest.pop();
			}
			collected.unshift(...rest);
			if (position === 0 && carry !== "" && sawNewline) {
				collected.unshift(carry);
			}
		}
	} finally {
		await handle.close();
	}
	const wanted = collected.slice(-lines);
	const records = wanted.map((line) => JSON.parse(line) as T);
	return { records, bytes: stop, truncated };
}

export async function fileSize(path: string): Promise<number> {
	try {
		const st = await stat(path);
		return st.size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return 0;
		}
		throw error;
	}
}

// A promise chain: every fn runs after the previous one settles.
export function createMutex(): Mutex {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(fn, fn);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}
