import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
test("rmux current screen loads older remote history once", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neta-history-screen-")),
		descriptor = join(dir, "node.json"),
		socket = join(dir, "node.sock");
	let tails = 0;
	const prompts: string[] = [];
	const server = createServer((c) => {
		let input = "";
		c.setEncoding("utf8");
		c.on("data", (chunk) => {
			input += chunk;
			for (;;) {
				const end = input.indexOf("\n");
				if (end < 0) return;
				const r = JSON.parse(input.slice(0, end)) as {
					id: string;
					method: string;
					params?: { sessionId?: string; cursor?: string };
				};
				input = input.slice(end + 1);
				const reply = (result: unknown) => c.write(`${JSON.stringify({ jsonrpc: "2.0", id: r.id, result })}\n`);
				const notify = (params: unknown) =>
					c.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn", params })}\n`);
				if (r.method === "hello")
					reply({
						machine: { id: "m", name: "local", createdAt: new Date().toISOString() },
						protocolVersion: 3,
						nodeVersion: "test",
						pid: process.pid,
					});
				else if (r.method === "conversation.tail") {
					const old = r.params?.cursor !== undefined;
					tails++;
					reply({
						sessionId: r.params?.sessionId,
						turns: [
							{
								id: old ? "old" : "new",
								sessionId: r.params?.sessionId,
								role: "user",
								startedAt: old ? "2025-01-01T00:00:00Z" : "2026-01-01T00:00:00Z",
								endedAt: old ? "2025-01-01T00:00:01Z" : "2026-01-01T00:00:01Z",
							},
						],
						blocks: [
							{
								turnId: old ? "old" : "new",
								seq: 1,
								at: new Date().toISOString(),
								role: "agent",
								kind: "text",
								text: old ? "REMOTE_OLDER_HISTORY" : "REMOTE_NEWER_HISTORY",
							},
						],
						prevCursor: old ? null : "older",
						provider: "fake",
						model: "test-model",
					});
				} else if (r.method === "conversation.prompt") {
					const sessionId = r.params?.sessionId ?? "";
					prompts.push(sessionId);
					reply({ turnId: "fresh" });
					notify({
						sessionId,
						turn: { id: "fresh", sessionId, role: "user", startedAt: new Date().toISOString() },
					});
					notify({
						sessionId,
						block: {
							turnId: "fresh",
							seq: 1,
							at: new Date().toISOString(),
							role: "agent",
							kind: "text",
							text: "REMOTE_FRESH_HISTORY_MARKER",
						},
					});
					notify({
						sessionId,
						turn: {
							id: "fresh",
							sessionId,
							role: "user",
							startedAt: new Date().toISOString(),
							endedAt: new Date().toISOString(),
						},
					});
				} else if (r.method === "models.list")
					reply({ models: [{ id: "test-model", name: "Test", provider: "fake" }] });
				else reply({});
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, resolve);
	});
	try {
		const bin = join(dir, "bin");
		await mkdir(join(dir, "pi"), { recursive: true });
		await mkdir(bin, { recursive: true });
		for (const n of ["fd", "rg"]) {
			const p = join(bin, n);
			await writeFile(p, "#!/bin/sh\nexit 0\n");
			await chmod(p, 0o700);
		}
		await writeFile(
			descriptor,
			JSON.stringify({
				socket,
				token: "test",
				pid: process.pid,
				protocolVersion: 3,
				startedAt: new Date().toISOString(),
			}),
		);
		const child = Bun.spawn(["python3", join(root, "test/fixtures/pi-history-screen.py")], {
			cwd: root,
			env: {
				...process.env,
				NETA_RMUX: join(root, ".cache/rmux/bin/rmux"),
				NETA_RMUX_SOCKET: join(dir, "rmux.sock"),
				NETA_DESCRIPTOR: descriptor,
				NETA_TARGET_SESSION_ID: "session-history",
				NETA_TARGET_PROVIDER: "fake",
				NETA_TARGET_MODEL: "test-model",
				NETA_PI_READY_MARKER: "fake · test-model",
				NETA_PI_VERIFY_ROOT: root,
				NETA_PI_VERIFY_SESSION_DIR: join(dir, "pi"),
				PI_CODING_AGENT_DIR: join(dir, "pi-config"),
				PI_OFFLINE: "1",
				PATH: `${bin}:${process.env.PATH ?? ""}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, status] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(status, err).toBe(0);
		expect(out).toContain("REMOTE_NEWER_HISTORY");
		expect(out).toContain("REMOTE_OLDER_HISTORY");
		expect(out).toContain("REMOTE_FRESH_HISTORY_MARKER");
		expect(out.indexOf("REMOTE_OLDER_HISTORY")).toBeLessThan(out.indexOf("REMOTE_NEWER_HISTORY"));
		expect(tails).toBe(2);
		expect(prompts).toEqual(["session-history"]);
	} finally {
		server.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30000);
