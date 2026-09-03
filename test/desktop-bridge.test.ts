import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

class BridgeHarness {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly lines: Interface;
	private readonly iterator: AsyncIterableIterator<string>;
	private serial = 0;

	constructor(options: { cwd: string; agentDir: string; path: string }) {
		this.child = spawn(process.execPath, [CLI, "desktop-bridge"], {
			cwd: options.cwd,
			env: { ...process.env, NETA_DIR: options.agentDir, PATH: options.path },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.lines = createInterface({ input: this.child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		this.iterator = this.lines[Symbol.asyncIterator]();
	}

	async request(command: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const id = `request-${++this.serial}`;
		this.child.stdin.write(`${JSON.stringify({ id, command, ...fields })}\n`);
		const line = await this.iterator.next();
		if (line.done) throw new Error("Desktop bridge closed before responding.");
		const response = JSON.parse(line.value) as Record<string, unknown>;
		expect(response.id).toBe(id);
		return response;
	}

	async close(): Promise<void> {
		if (!this.child.killed) {
			await this.request("shutdown").catch(() => {});
			this.child.stdin.end();
			await new Promise<void>((resolve) => this.child.once("close", () => resolve()));
		}
		this.lines.close();
	}
}

describe("desktop ACP bridge", () => {
	let root: string | undefined;
	let bridge: BridgeHarness | undefined;

	afterEach(async () => {
		await bridge?.close();
		if (root) rmSync(root, { recursive: true, force: true });
		bridge = undefined;
		root = undefined;
	});

	it("owns a leader ACP session, registers its real control plane, and returns its transcript", async () => {
		root = mkdtempSync(join(tmpdir(), "neta-desktop-"));
		const project = join(root, "project");
		const agentDir = join(root, "agent-dir");
		const bin = join(root, "bin");
		mkdirSync(project);
		mkdirSync(agentDir);
		mkdirSync(bin);
		const codex = join(bin, "codex");
		writeFileSync(codex, "#!/bin/sh\nexit 0\n", "utf-8");
		chmodSync(codex, 0o755);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				leader: { backend: "codex" },
				backends: {
					codex: { command: process.execPath, args: [FAKE_AGENT, "--launch-mcp"] },
				},
			}),
			"utf-8",
		);
		bridge = new BridgeHarness({
			cwd: project,
			agentDir,
			path: `${bin}:${process.env.PATH ?? ""}`,
		});

		const opened = await bridge.request("open", { cwd: project });
		expect(opened.ok).toBe(true);
		const sessionId = (opened.data as { sessionId: string }).sessionId;

		const listed = await bridge.request("list");
		const projects = (listed.data as { projects: Array<{ id: string; owned: boolean }> }).projects;
		expect(projects).toEqual([expect.objectContaining({ id: sessionId, owned: true })]);

		const prompted = await bridge.request("prompt", {
			sessionId,
			actorId: "leader",
			text: "hello from desktop",
		});
		expect(prompted.ok).toBe(true);
		const transcript = await bridge.request("tail", { sessionId, actorId: "leader", since: 0 });
		const messages = (transcript.data as { messages: Array<{ author: string; text: string }> }).messages;
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ author: "user", text: "hello from desktop" }),
				expect.objectContaining({ author: "agent", text: "echo:hello from desktop" }),
			]),
		);
	}, 20_000);

	it("archives a closed desktop session and resumes its exact ACP conversation", async () => {
		root = mkdtempSync(join(tmpdir(), "neta-desktop-resume-"));
		const project = join(root, "project");
		const agentDir = join(root, "agent-dir");
		const bin = join(root, "bin");
		const sessionStore = join(root, "fake-sessions.json");
		mkdirSync(project);
		mkdirSync(agentDir);
		mkdirSync(bin);
		const codex = join(bin, "codex");
		writeFileSync(codex, "#!/bin/sh\nexit 0\n", "utf-8");
		chmodSync(codex, 0o755);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				leader: { backend: "codex" },
				backends: {
					codex: {
						command: process.execPath,
						args: [FAKE_AGENT, "--launch-mcp", "--uuid-session", "--session-store", sessionStore],
					},
				},
			}),
			"utf-8",
		);
		bridge = new BridgeHarness({
			cwd: project,
			agentDir,
			path: `${bin}:${process.env.PATH ?? ""}`,
		});

		const opened = await bridge.request("open", { cwd: project });
		const firstSessionId = (opened.data as { sessionId: string }).sessionId;
		const listed = await bridge.request("list");
		const logicalId = (listed.data as { projects: Array<{ logicalId: string }> }).projects[0]?.logicalId;
		expect(logicalId).toBeTruthy();
		expect(
			await bridge.request("prompt", {
				sessionId: firstSessionId,
				actorId: "leader",
				text: "remember this desktop turn",
			}),
		).toMatchObject({ ok: true });

		expect(await bridge.request("close", { sessionId: firstSessionId })).toMatchObject({ ok: true });
		const archived = await bridge.request("archives");
		const projects = (
			archived.data as {
				projects: Array<{ id: string; logicalId: string; lifecycle: string; resumable: boolean }>;
			}
		).projects;
		expect(projects).toEqual([
			expect.objectContaining({
				id: `archive:${logicalId}`,
				logicalId,
				lifecycle: "archived",
				resumable: true,
			}),
		]);

		const resumed = await bridge.request("resume", { sessionId: `archive:${logicalId}` });
		expect(resumed.ok).toBe(true);
		const resumedSessionId = (resumed.data as { sessionId: string }).sessionId;
		expect(resumedSessionId).not.toBe(firstSessionId);
		expect(
			await bridge.request("prompt", {
				sessionId: resumedSessionId,
				actorId: "leader",
				text: "HISTORY",
			}),
		).toMatchObject({ ok: true });
		const transcript = await bridge.request("tail", {
			sessionId: resumedSessionId,
			actorId: "leader",
			since: 0,
		});
		const messages = (transcript.data as { messages: Array<{ author: string; text: string }> }).messages;
		const history = messages.find(
			(message) => message.author === "agent" && message.text.includes("remember this desktop turn"),
		);
		expect(history).toBeTruthy();
	}, 30_000);
});
