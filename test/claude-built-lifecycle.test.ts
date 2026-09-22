import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectNode, type NodeClient } from "../src/node/client.ts";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const nodeBinary = process.env.NETA_TEST_NODE ?? "node";
const nodePath = Bun.which(nodeBinary) ?? nodeBinary;
type AuditEntry = {
	kind: "spawn" | "initialize" | "session-new" | "prompt" | "steer";
	text?: string;
	idleBehavior?: string;
};

function runNode(
	file: string,
	args: string[],
	environment: Record<string, string>,
	cwd: string,
): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(nodePath, [file, ...args], { env: environment, cwd, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
	});
}

async function waitFor<T>(description: string, check: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = await check();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
		await new Promise((done) => setTimeout(done, 20));
	}
}

async function auditEntries(path: string): Promise<AuditEntry[]> {
	try {
		return (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as AuditEntry);
	} catch {
		return [];
	}
}

function replaceOnce(source: string, from: string, to: string): string {
	const index = source.indexOf(from);
	if (index < 0 || source.indexOf(from, index + from.length) >= 0)
		throw new Error(`fixture instrumentation point changed: ${from}`);
	return `${source.slice(0, index)}${to}${source.slice(index + from.length)}`;
}

async function buildFakeAdapter(output: string): Promise<void> {
	const sourceDir = await mkdtemp(join(tmpdir(), "neta-claude-fake-source-"));
	try {
		let source = await readFile(fixture, "utf8");
		if (!source.includes("appendFileSync"))
			source = replaceOnce(
				source,
				'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
				'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
			);
		source = replaceOnce(
			source,
			"let _trapSigterm = false;",
			`const auditPath = process.env.NETA_CLAUDE_ADAPTER_AUDIT;
function audit(event) { if (auditPath) appendFileSync(auditPath, JSON.stringify(event) + "\\n", "utf8"); }
process.argv.push("--config-options", "--unrestricted-mode", "bypassPermissions");
audit({ kind: "spawn" });
let _trapSigterm = false;`,
		);
		source = replaceOnce(
			source,
			'const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");',
			'const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");\n\taudit({ kind: "prompt", text });',
		);
		source = replaceOnce(
			source,
			"protocolVersion: acp.PROTOCOL_VERSION,",
			'protocolVersion: (audit({ kind: "initialize" }), acp.PROTOCOL_VERSION),',
		);
		source = replaceOnce(
			source,
			'.onRequest("session/new", (ctx) => {',
			'.onRequest("session/new", (ctx) => {\n\t\taudit({ kind: "session-new" });',
		);
		source = replaceOnce(
			source,
			'.onRequest("_session/steering", { parse: (params) => params }, async (ctx) => {',
			`.onRequest("_session/steering", { parse: (params) => params }, async (ctx) => {
		audit({ kind: "steer", text: ctx.params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\\n"), idleBehavior: ctx.params._meta?.steering?.idleBehavior });`,
		);
		const entry = join(sourceDir, "adapter.mjs");
		await writeFile(entry, source);
		const built = await Bun.build({
			entrypoints: [entry],
			target: "node",
			format: "esm",
			outdir: dirname(output),
			external: ["@agentclientprotocol/sdk"],
		});
		if (!built.success) throw new Error(`fake Claude adapter build failed: ${built.logs.join("\n")}`);
		await copyFile(join(dirname(output), "adapter.js"), output);
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
	}
}

test("the built CLI initializes, prompts, and steers through its installed default Claude adapter without npx", async () => {
	const nodeVersion = Bun.spawnSync([nodePath, "-p", "process.versions.node"]);
	expect(nodeVersion.exitCode).toBe(0);
	expect(Number.parseInt(nodeVersion.stdout.toString(), 10)).toBeGreaterThanOrEqual(22);
	const temp = await mkdtemp(join(tmpdir(), "neta-claude-built-e2e-"));
	const dist = join(temp, "dist");
	const state = join(temp, "state");
	const workspace = join(temp, "workspace");
	const bin = join(temp, "bin");
	const audit = join(temp, "adapter.ndjson");
	const shadowLog = join(temp, "workspace-shadow.log");
	const main = join(dist, "main.js");
	let client: NodeClient | undefined;
	try {
		await mkdir(dist, { recursive: true });
		const built = await Bun.build({
			entrypoints: [join(root, "src", "cli", "main.ts")],
			target: "node",
			outdir: dist,
		});
		if (!built.success) throw new Error(`production bundle build failed: ${built.logs.join("\n")}`);
		await Promise.all([mkdir(state), mkdir(workspace), mkdir(bin)]);
		await writeFile(
			join(state, "settings.json"),
			JSON.stringify({
				providers: {
					claude: {
						command: "npx",
						args: ["-y", "@agentclientprotocol/claude-agent-acp@0.74.0"],
						env: { PATH: bin },
						resume: true,
						defaultModel: "",
						unsandboxedMode: "bypassPermissions",
					},
				},
				leader: { provider: "claude" },
				forbiddenModels: [],
			}),
		);
		const adapterRoot = join(temp, "node_modules", "@agentclientprotocol", "claude-agent-acp");
		await mkdir(join(adapterRoot, "dist"), { recursive: true });
		await writeFile(
			join(adapterRoot, "package.json"),
			JSON.stringify({
				name: "@agentclientprotocol/claude-agent-acp",
				version: "0.74.0",
				type: "module",
				exports: { ".": "./dist/lib.js", "./*": "./*" },
				bin: { "claude-agent-acp": "dist/index.js" },
			}),
		);
		await buildFakeAdapter(join(adapterRoot, "dist", "index.js"));
		await cp(
			join(root, "node_modules", "@agentclientprotocol", "sdk"),
			join(temp, "node_modules", "@agentclientprotocol", "sdk"),
			{ recursive: true },
		);
		await cp(join(root, "node_modules", "zod"), join(temp, "node_modules", "zod"), { recursive: true });
		const shadow = join(workspace, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist");
		await mkdir(shadow, { recursive: true });
		await writeFile(
			join(dirname(shadow), "package.json"),
			JSON.stringify({ version: "0.74.0", bin: { "claude-agent-acp": "dist/index.js" } }),
		);
		await writeFile(
			join(shadow, "index.js"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(shadowLog)}, "workspace shadow");`,
		);
		const environment = {
			...process.env,
			NETA_DIR: state,
			NETA_CLAUDE_ADAPTER_AUDIT: audit,
			PATH: `${bin}:${dirname(nodePath)}`,
		};
		const started = await runNode(main, ["node", "start", "--detach"], environment, workspace);
		if (started.code !== 0) throw new Error(`node start exited ${started.code}: ${started.stderr}`);
		const opened = await runNode(main, ["open", workspace], environment, workspace);
		if (opened.code !== 0) throw new Error(`open exited ${opened.code}: ${opened.stderr}`);
		client = await connectNode({ dir: state, client: "desktop", timeoutMs: 10_000 });
		const providers = await client.request<{
			providers: Array<{ id: string; label: string; defaultModel: string; available: boolean; note?: string }>;
		}>("providers.list", {});
		expect(providers.providers.find((provider) => provider.id === "claude")).toEqual({
			id: "claude",
			label: "Claude",
			defaultModel: "",
			available: true,
		});
		const snapshot = await client.request<{ leaders: Array<{ sessionId: string }> }>("snapshot", {});
		const sessionId = snapshot.leaders[0]?.sessionId;
		if (sessionId === undefined) throw new Error("CLI open did not create a leader session");
		let startedTurn: { status: string };
		try {
			startedTurn = await client.request<{ status: string }>("conversation.prompt", {
				sessionId,
				text: "HOLD_FOR_STEER",
			});
		} catch (error) {
			throw new Error(`first prompt failed; adapter audit: ${JSON.stringify(await auditEntries(audit))}`, {
				cause: error,
			});
		}
		expect(startedTurn.status).toBe("delivered");
		expect(
			(await client.request<{ status: string }>("conversation.prompt", { sessionId, text: "CLAUDE_STEER_MESSAGE" }))
				.status,
		).toBe("delivered");
		const entries = await waitFor("Claude adapter steering", async () => {
			const seen = await auditEntries(audit);
			return seen.some((entry) => entry.kind === "steer") ? seen : undefined;
		});
		expect(entries.some((entry) => entry.kind === "initialize")).toBe(true);
		expect(entries.some((entry) => entry.kind === "session-new")).toBe(true);
		expect(entries.filter((entry) => entry.kind === "prompt" && entry.text === "HOLD_FOR_STEER")).toHaveLength(1);
		expect(entries.filter((entry) => entry.kind === "prompt" && entry.text === "CLAUDE_STEER_MESSAGE")).toHaveLength(
			0,
		);
		expect(entries.filter((entry) => entry.kind === "steer")).toEqual([
			expect.objectContaining({ text: "CLAUDE_STEER_MESSAGE", idleBehavior: "promptRequired" }),
		]);
		expect(existsSync(shadowLog)).toBe(false);
	} finally {
		if (client !== undefined) await client.close().catch(() => undefined);
		await runNode(main, ["node", "stop"], { ...process.env, NETA_DIR: state }, workspace).catch(() => undefined);
		await rm(temp, { recursive: true, force: true });
	}
}, 120_000);
