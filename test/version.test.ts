import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { netaVersion } from "../src/version.ts";

describe("netaVersion", () => {
	test("equals the version field of package.json", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version: string;
		};
		expect(netaVersion()).toBe(pkg.version);
	});

	test("looks like a release version", () => {
		expect(netaVersion()).toMatch(/^\d+\.\d+\.\d+/);
	});
});


test("source runtime build identity changes with code and stays fixed in a running process", async () => {
 const root = mkdtempSync(join(tmpdir(), "neta-build-"));
 try {
  writeFileSync(join(root, "version.ts"), readFileSync(new URL("../src/version.ts", import.meta.url)));
  writeFileSync(join(root, "worker.ts"), "export const revision = 1;");
  writeFileSync(join(root, "probe.ts"), `import { netaBuildId } from "./version.ts";
import { writeFileSync } from "node:fs";
const before = netaBuildId();
if (process.argv[2]) writeFileSync(new URL("./worker.ts", import.meta.url), "export const revision = 2;");
console.log(JSON.stringify([before, netaBuildId()]));`);
  const first = Bun.spawn([process.execPath, join(root, "probe.ts"), "change"], { stdout: "pipe" });
  const before = JSON.parse(await new Response(first.stdout).text()) as string[];
  expect(await first.exited).toBe(0);
  expect(before[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(before[1]).toBe(before[0]);
  const second = Bun.spawn([process.execPath, join(root, "probe.ts")], { stdout: "pipe" });
  const after = JSON.parse(await new Response(second.stdout).text()) as string[];
  expect(await second.exited).toBe(0);
  expect(after[0]).not.toBe(before[0]);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
