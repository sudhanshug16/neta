import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectNode, type NodeClient } from "../src/node/client.ts";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const nodePath = Bun.which("node") ?? "node";

function run(file: string, args: string[], env: Record<string, string>, cwd: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(nodePath, [file, ...args], { env, cwd, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) console.error(stderr);
			resolve(code ?? 1);
		});
	});
}

async function waitFor(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (true) {
		try {
			await readFile(path);
			return;
		} catch {}
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
		await Bun.sleep(20);
	}
}

test("the built CLI routes the default OpenCode ACP through its installed launcher", async () => {
	const temp = await mkdtemp(join(tmpdir(), "neta-opencode-built-"));
	const dist = join(temp, "dist");
	const state = join(temp, "state");
	const workspace = join(temp, "workspace");
	const bin = join(temp, "bin");
	const audit = join(temp, "native-launch");
	const promptAudit = join(temp, "native-prompts");
	const shadowAudit = join(temp, "workspace-shadow");
	const main = join(dist, "main.js");
	let client: NodeClient | undefined;
	try {
		await Promise.all([mkdir(dist, { recursive: true }), mkdir(state), mkdir(workspace), mkdir(bin)]);
		const built = await Bun.build({
			entrypoints: [join(root, "src", "cli", "main.ts")],
			target: "node",
			outdir: dist,
		});
		if (!built.success) throw new Error(`bundle failed: ${built.logs.join("\n")}`);
		const fake = await Bun.build({ entrypoints: [fixture], target: "node", format: "esm", outdir: dist });
		if (!fake.success) throw new Error(`fake ACP build failed: ${fake.logs.join("\n")}`);
		const packageRoot = join(temp, "node_modules", "opencode-ai");
		await mkdir(join(packageRoot, "bin"), { recursive: true });
		await writeFile(
			join(packageRoot, "package.json"),
			JSON.stringify({ name: "opencode-ai", version: "1.2.26", bin: { opencode: "bin/opencode" } }),
		);
		await writeFile(
			join(packageRoot, "bin", "opencode"),
			'const { spawnSync } = require("node:child_process"); const result = spawnSync(process.env.OPENCODE_BIN_PATH, process.argv.slice(2), { stdio: "inherit" }); process.exit(result.status ?? 1);',
		);
		const shadowRoot = join(workspace, "node_modules", "opencode-ai", "bin");
		await mkdir(shadowRoot, { recursive: true });
		await writeFile(
			join(dirname(shadowRoot), "package.json"),
			JSON.stringify({ version: "1.2.26", bin: { opencode: "bin/opencode" } }),
		);
		await writeFile(
			join(shadowRoot, "opencode"),
			`require("node:fs").writeFileSync(${JSON.stringify(shadowAudit)}, "shadow");`,
		);
		const native = join(temp, "native-opencode");
		await writeFile(
			native,
			`#!/bin/sh\nprintf launched > "${audit}"\nexec "${nodePath}" "${join(dist, "fake-acp-agent.js")}" --config-options --unrestricted-mode build --prompt-capture "${promptAudit}"\n`,
		);
		await chmod(native, 0o755);
		await writeFile(
			join(state, "settings.json"),
			JSON.stringify({
				providers: {
					opencode: {
						command: "opencode",
						args: ["acp"],
						env: { OPENCODE_BIN_PATH: native, PATH: bin },
						resume: true,
						defaultModel: "",
						unsandboxedMode: "build",
					},
				},
				leader: { provider: "opencode" },
				forbiddenModels: [],
			}),
		);
		const env = { ...process.env, NETA_DIR: state, PATH: `${bin}:${dirname(nodePath)}` };
		expect(await run(main, ["node", "start", "--detach"], env, workspace)).toBe(0);
		expect(await run(main, ["open", workspace], env, workspace)).toBe(0);
		await waitFor(audit);
		client = await connectNode({ dir: state, client: "desktop", timeoutMs: 10_000 });
		const snapshot = await client.request<{ leaders: Array<{ sessionId: string }> }>("snapshot", {});
		const sessionId = snapshot.leaders[0]?.sessionId;
		if (sessionId === undefined) throw new Error("no OpenCode session");
		expect(
			(await client.request<{ status: string }>("conversation.prompt", { sessionId, text: "OPENCODE_DEFAULT" }))
				.status,
		).toBe("delivered");
		await waitFor(promptAudit);
		expect(await readFile(promptAudit, "utf8")).toContain("OPENCODE_DEFAULT");
		await expect(readFile(shadowAudit, "utf8")).rejects.toThrow();
		expect(
			(await client.request<{ model: string }>("conversation.setModel", { sessionId, model: "fixture-fast" })).model,
		).toBe("fixture-fast");
	} finally {
		if (client !== undefined) await client.close().catch(() => undefined);
		await run(main, ["node", "stop"], { ...process.env, NETA_DIR: state, PATH: dirname(nodePath) }, workspace).catch(
			() => undefined,
		);
		await rm(temp, { recursive: true, force: true });
	}
}, 120_000);
