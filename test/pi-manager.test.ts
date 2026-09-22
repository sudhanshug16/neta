import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiTerminalManager } from "../src/pi/manager.ts";

const managers: ReturnType<typeof createPiTerminalManager>[] = [];
afterEach(() => {
	for (const manager of managers) manager.closeAll();
	managers.length = 0;
});

test("Pi PTY survives detach and reattach with ordered replay and stale input rejection", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "neta-pi-"));
	const manager = createPiTerminalManager({
		dataDir,
		nodeCommand: "node",
		piCommand: "node",
		piArgs: [new URL("fixtures/fake-pi-tui.mjs", import.meta.url).pathname],
	});
	managers.push(manager);
	const live: unknown[] = [];
	const first = await manager.attach("s1", process.cwd(), 80, 24, "c1", (_method, payload) => live.push(payload));
	for (let attempts = 0; attempts < 100 && live.length === 0; attempts += 1) await Bun.sleep(5);
	await manager.input("s1", first.attachmentId, "c1", Buffer.from("hello\n").toString("base64"));
	for (let attempts = 0; attempts < 100 && live.length < 2; attempts += 1) await Bun.sleep(5);
	manager.detach("s1", first.attachmentId, "c1");
	await expect(manager.input("s1", first.attachmentId, "c1", "YQ==")).rejects.toThrow("stale terminal attachment");
	const resized: Array<{ dataBase64?: string }> = [];
	const second = await manager.attach("s1", process.cwd(), 100, 30, "c2", (_method, payload) =>
		resized.push(payload as { dataBase64?: string }),
	);
	expect(second.pid).toBe(first.pid);
	expect(second.replay.map((chunk) => chunk.seq)).toEqual(second.replay.map((_, index) => index + 1));
	expect(Buffer.concat(second.replay.map((chunk) => Buffer.from(chunk.dataBase64, "base64"))).toString()).toContain(
		"input:hello",
	);
	for (let attempts = 0; attempts < 100; attempts += 1) {
		const bytes = [...second.replay, ...resized]
			.flatMap((chunk) => (chunk.dataBase64 === undefined ? [] : [Buffer.from(chunk.dataBase64, "base64")]))
			.reduce((all, chunk) => Buffer.concat([all, chunk]), Buffer.alloc(0));
		if (bytes.toString().includes("size:100x30")) break;
		await Bun.sleep(5);
	}
	const resizedText = [...second.replay, ...resized]
		.flatMap((chunk) => (chunk.dataBase64 === undefined ? [] : [Buffer.from(chunk.dataBase64, "base64")]))
		.reduce((all, chunk) => Buffer.concat([all, chunk]), Buffer.alloc(0))
		.toString();
	expect(resizedText).toContain("size:100x30");
	const telemetry = readFileSync(join(dataDir, "runtime", "terminal.ndjson"), "utf8");
	expect(telemetry).toContain('"event":"terminal.input"');
	expect(telemetry).toContain('"byteCount":6');
	expect(telemetry).not.toContain("hello");
});

test("concurrent attaches start one process and only the latest connection owns input", async () => {
	const manager = createPiTerminalManager({
		dataDir: mkdtempSync(join(tmpdir(), "neta-pi-")),
		nodeCommand: "node",
		piCommand: "node",
		piArgs: [new URL("fixtures/fake-pi-tui.mjs", import.meta.url).pathname],
	});
	managers.push(manager);
	const [first, second] = await Promise.all([
		manager.attach("s2", process.cwd(), 80, 24, "c1", () => undefined),
		manager.attach("s2", process.cwd(), 80, 24, "c2", () => undefined),
	]);
	expect(first.pid).toBe(second.pid);
	const attempts = await Promise.allSettled([
		manager.input("s2", first.attachmentId, "c1", "YQ=="),
		manager.input("s2", second.attachmentId, "c2", "YQ=="),
	]);
	expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
});

test("a missing Pi executable rejects instead of hanging", async () => {
	const manager = createPiTerminalManager({
		dataDir: mkdtempSync(join(tmpdir(), "neta-pi-")),
		nodeCommand: "node",
		hostPath: "/definitely/missing/neta-pty-host.mjs",
		requestTimeoutMs: 1_000,
	});
	managers.push(manager);
	await expect(manager.startSession("s3", process.cwd())).rejects.toThrow();
});

test("closing one Pi session rejects stale input without affecting another", async () => {
	const manager = createPiTerminalManager({
		dataDir: mkdtempSync(join(tmpdir(), "neta-pi-")),
		nodeCommand: "node",
		piCommand: "node",
		piArgs: [new URL("fixtures/fake-pi-tui.mjs", import.meta.url).pathname],
	});
	managers.push(manager);
	const first = await manager.attach("closed", process.cwd(), 80, 24, "c1", () => undefined);
	const second = await manager.attach("live", process.cwd(), 80, 24, "c2", () => undefined);
	manager.closeSession("closed");
	await expect(manager.input("closed", first.attachmentId, "c1", "YQ==")).rejects.toThrow("stale");
	await expect(manager.input("live", second.attachmentId, "c2", "YQ==")).resolves.toBeUndefined();
});

test("Claude discovery augments rather than replaces an explicit bridge configuration", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "neta-pi-"));
	const configDir = join(dataDir, "pi-config");
	mkdirSync(configDir);
	writeFileSync(
		join(configDir, "claude-bridge.json"),
		JSON.stringify({
			provider: { pathToClaudeCodeExecutable: "/chosen/claude", permissionMode: "plan" },
			theme: "dark",
		}),
	);
	const manager = createPiTerminalManager({
		dataDir,
		nodeCommand: "node",
		piCommand: "node",
		piArgs: [new URL("fixtures/fake-pi-tui.mjs", import.meta.url).pathname],
		claudeExecutable: "/discovered/claude",
	});
	managers.push(manager);
	await manager.startSession("configured", process.cwd());
	const config = JSON.parse(readFileSync(join(configDir, "claude-bridge.json"), "utf8"));
	expect(config).toEqual({
		provider: { pathToClaudeCodeExecutable: "/chosen/claude", permissionMode: "plan" },
		theme: "dark",
	});
});
