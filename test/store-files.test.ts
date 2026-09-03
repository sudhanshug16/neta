import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendLine,
	createMutex,
	ensureDir,
	fileSize,
	readNdjson,
	readNdjsonBackwards,
	readText,
	writeFileAtomic,
} from "../src/store/files.ts";

let dir = "";

afterEach(() => {
	dir = "";
});

function freshDir(): string {
	dir = mkdtempSync(join(tmpdir(), "neta-files-"));
	return dir;
}

describe("atomic files", () => {
	test("a write is 0600 in a 0700 directory with no .tmp left", async () => {
		const root = freshDir();
		const sub = join(root, "sub");
		await ensureDir(sub);
		const path = join(sub, "a.json");
		await writeFileAtomic(path, '{"a":1}');
		expect((await readText(path)) as string).toBe('{"a":1}');
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(sub).mode & 0o777).toBe(0o700);
		expect(readdirSync(sub).filter((n) => n.includes(".tmp"))).toEqual([]);
	});

	test("a concurrent reader never sees a partial write", async () => {
		const root = freshDir();
		const path = join(root, "race.json");
		await writeFileAtomic(path, JSON.stringify({ n: 0 }));
		const seen: number[] = [];
		const reader = (async (): Promise<void> => {
			for (let i = 0; i < 50; i++) {
				const text = (await readText(path)) as string;
				seen.push((JSON.parse(text) as { n: number }).n);
			}
		})();
		const writer = (async (): Promise<void> => {
			for (let n = 1; n <= 50; n++) {
				await writeFileAtomic(path, JSON.stringify({ n }));
			}
		})();
		await Promise.all([reader, writer]);
		for (const n of seen) {
			expect(Number.isInteger(n)).toBe(true);
		}
		expect(await fileSize(join(root, "missing"))).toBe(0);
	});
});

describe("ndjson", () => {
	test("a last line cut mid-JSON reads back with a warning", async () => {
		const root = freshDir();
		const path = join(root, "log.ndjson");
		await appendLine(path, { n: 1 });
		await appendLine(path, { n: 2 });
		const warnings: string[] = [];
		const size = await fileSize(path);
		await writeFileAtomic(path, `${await readText(path)}{"n":3`);
		const read = await readNdjson<{ n: number }>(path, { onWarn: (m) => warnings.push(m) });
		expect(read.records).toEqual([{ n: 1 }, { n: 2 }]);
		expect(read.truncated).toBe(true);
		expect(warnings).toHaveLength(1);
		expect(read.bytes).toBe(size);
	});

	test("a cut middle line throws", async () => {
		const root = freshDir();
		const path = join(root, "log.ndjson");
		await writeFileAtomic(path, '{"n":1}\n{bad\n{"n":3}\n');
		await expect(readNdjson(path)).rejects.toThrow();
	});

	test("readNdjson({from}) resumes at the returned bytes", async () => {
		const root = freshDir();
		const path = join(root, "log.ndjson");
		for (let n = 1; n <= 5; n++) {
			await appendLine(path, { n });
		}
		const first = await readNdjson<{ n: number }>(path, { maxBytes: 16 });
		expect(first.records).toEqual([{ n: 1 }, { n: 2 }]);
		expect(first.truncated).toBe(true);
		const rest = await readNdjson<{ n: number }>(path, { from: first.bytes });
		expect(rest.records).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
		expect(rest.truncated).toBe(false);
	});

	test("readNdjsonBackwards returns the last 10 of 1000 lines", async () => {
		const root = freshDir();
		const path = join(root, "log.ndjson");
		for (let n = 1; n <= 1000; n++) {
			await appendLine(path, { n });
		}
		const read = await readNdjsonBackwards<{ n: number }>(path, 10);
		expect(read.records.map((r) => r.n)).toEqual([991, 992, 993, 994, 995, 996, 997, 998, 999, 1000]);
		expect(read.truncated).toBe(false);
	});
});

describe("mutex", () => {
	test("serialises one counter", async () => {
		const mutex = createMutex();
		let n = 0;
		await Promise.all(
			Array.from({ length: 50 }, () =>
				mutex(async () => {
					const current = n;
					await Bun.sleep(0);
					n = current + 1;
				}),
			),
		);
		expect(n).toBe(50);
	});
});
