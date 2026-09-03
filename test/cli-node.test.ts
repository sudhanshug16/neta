// T8.3: `neta node start|stop|status` and `neta open` through the built
// bundle against a temp `NETA_DIR` (the T8.2 harness). One test per spec
// row: empty-dir status, the detached lifecycle, open idempotence, the `~`
// and `/` refusals, and the double stop.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../src/node/protocol.ts";
import { type Harness, startNode as startHarness } from "./helpers/cli-harness.ts";

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
	const harness = await startHarness();
	try {
		await fn(harness);
	} finally {
		await harness.stop();
	}
}

describe("node status without a node", () => {
	test("prints not running, exit 0", async () => {
		await withHarness(async (harness) => {
			const result = await harness.run(["node", "status"]);
			expect(result.code).toBe(0);
			expect(result.stdout).toBe("not running\n");
		});
	});

	test("--json parses to the not-running shape", async () => {
		await withHarness(async (harness) => {
			const result = await harness.run(["node", "status", "--json"]);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				running: false,
				pid: null,
				socket: null,
				protocol: null,
				startedAt: null,
			});
		});
	});
});

describe("node lifecycle", () => {
	test("start --detach, status, open, stop, stop", async () => {
		await withHarness(async (harness) => {
			const started = await harness.run(["node", "start", "--detach"]);
			expect(started.code).toBe(0);
			expect(started.stdout).toMatch(/^started {2}pid \d+ {2}\S+\n$/);
			const pid = Number.parseInt(/^started {2}pid (\d+)/.exec(started.stdout)?.[1] as string, 10);
			expect(Number.isInteger(pid) && pid > 0).toBe(true);

			const status = await harness.run(["node", "status"]);
			expect(status.code).toBe(0);
			expect(status.stdout).toMatch(
				new RegExp(`^running  pid ${pid}  socket \\S+  protocol ${PROTOCOL_VERSION}  uptime \\S+\n$`),
			);

			const json = await harness.run(["node", "status", "--json"]);
			expect(json.code).toBe(0);
			const parsed = JSON.parse(json.stdout) as {
				running: boolean;
				pid: number | null;
				socket: string | null;
				protocol: number | null;
				startedAt: string | null;
			};
			expect(parsed.running).toBe(true);
			expect(parsed.pid).toBe(pid);
			expect(typeof parsed.socket).toBe("string");
			expect(parsed.protocol).toBe(PROTOCOL_VERSION);
			expect(typeof parsed.startedAt).toBe("string");

			const work = await mkdtemp(join(tmpdir(), "neta-work-"));
			try {
				const first = await harness.run(["open", work]);
				expect(first.code).toBe(0);
				const second = await harness.run(["open", work]);
				expect(second.code).toBe(0);
				const firstId = first.stdout.split("  ")[0];
				const secondId = second.stdout.split("  ")[0];
				expect(firstId?.length).toBeGreaterThan(0);
				expect(secondId).toBe(firstId);
			} finally {
				await rm(work, { recursive: true, force: true });
			}

			const stopped = await harness.run(["node", "stop"]);
			expect(stopped.code).toBe(0);
			expect(stopped.stdout).toBe("stopped\n");

			const again = await harness.run(["node", "stop"]);
			expect(again.code).toBe(0);
			expect(again.stdout).toBe("not running\n");
		});
	}, 120000);
});

describe("open refusals", () => {
	test("open ~ exits 1", async () => {
		await withHarness(async (harness) => {
			const result = await harness.run(["open", "~"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("neta:");
		});
	});

	test("open / exits 1", async () => {
		await withHarness(async (harness) => {
			const result = await harness.run(["open", "/"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("neta:");
		});
	});
});
