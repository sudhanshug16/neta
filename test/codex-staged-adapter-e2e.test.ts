// Production-artifact proof for the staged Codex ACP launch path. The service
// runs only from a temporary copy of dist, where the staged adapter is a
// bundled fake ACP process and PATH contains an npx trap.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	CODEX_PATH?: string;
	INITIAL_AGENT_MODE?: string;
};

function runNode(
	file: string,
	args: string[],
	environment: Record<string, string>,
	cwd?: string,
): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(nodePath, [file, ...args], {
			env: environment,
			...(cwd === undefined ? {} : { cwd }),
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
	});
}

function nodeMajor(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(nodePath, ["-p", "process.versions.node.split('.')[0]"], {
			env: { ...process.env, PATH: process.env.PATH ?? "" },
			stdio: ["ignore", "pipe", "ignore"],
		});
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`Node version probe exited ${code}`));
			else resolve(Number.parseInt(stdout, 10));
		});
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
	if (!existsSync(path)) return [];
	return (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as AuditEntry);
}

function replaceOnce(source: string, from: string, to: string): string {
	const index = source.indexOf(from);
	if (index < 0 || source.indexOf(from, index + from.length) >= 0) {
		throw new Error(`fake ACP fixture no longer contains one expected instrumentation point: ${from.slice(0, 60)}`);
	}
	return `${source.slice(0, index)}${to}${source.slice(index + from.length)}`;
}

async function buildFakeAdapter(output: string): Promise<void> {
	const fixtureDir = await mkdtemp(join(root, "test", "fixtures", ".codex-staged-adapter-"));
	const entry = join(fixtureDir, "adapter.mjs");
	try {
		let source = await readFile(fixture, "utf8");
		if (!source.includes("appendFileSync")) {
			source = replaceOnce(
				source,
				'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
				'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
			);
		}
		source = replaceOnce(
			source,
			"let _trapSigterm = false;",
			`const stagedAudit = process.env.NETA_STAGED_CODEX_AUDIT;
function audit(event) {
	if (!stagedAudit) return;
	appendFileSync(stagedAudit, JSON.stringify({ ...event, CODEX_PATH: process.env.CODEX_PATH, INITIAL_AGENT_MODE: process.env.INITIAL_AGENT_MODE }) + "\\n", "utf8");
}
process.argv.push("--config-options", "--unrestricted-mode", "agent-full-access");
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
	\taudit({
	\t\tkind: "steer",
	\t\ttext: ctx.params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\\n"),
	\t\tidleBehavior: ctx.params._meta?.steering?.idleBehavior,
	\t});`,
		);
		await writeFile(entry, source);
		const result = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", outdir: dirname(output) });
		if (!result.success) throw new Error(`fake Codex adapter build failed: ${result.logs.join("\n")}`);
		await copyFile(join(dirname(output), "adapter.js"), output);
	} finally {
		await rm(fixtureDir, { recursive: true, force: true });
	}
}

test("the production bundle stages the default Codex adapter and injects live steering", async () => {
	expect(await nodeMajor()).toBe(22);
	const temp = await mkdtemp(join(tmpdir(), "neta-codex-stage-e2e-"));
	const dist = join(temp, "dist");
	const state = join(temp, "state");
	const workspace = join(temp, "workspace");
	const bin = join(temp, "bin");
	const audit = join(temp, "adapter.ndjson");
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
		await Promise.all([
			copyFile(join(root, "package.json"), join(temp, "package.json")),
			mkdir(state),
			mkdir(workspace),
			mkdir(bin),
		]);
		await buildFakeAdapter(join(dist, "codex-acp.mjs"));
		await writeFile(
			join(state, "settings.json"),
			JSON.stringify({
				providers: {
					codex: {
						command: "npx",
						args: ["-y", "@agentclientprotocol/codex-acp@1.10.0"],
						env: { CODEX_PATH: "/configured/codex", PATH: bin },
						resume: true,
						defaultModel: "",
					},
				},
				leader: { provider: "codex" },
				forbiddenModels: [],
			}),
		);
		const environment = {
			...process.env,
			NETA_DIR: state,
			NETA_STAGED_CODEX_AUDIT: audit,
			PATH: `${bin}:${dirname(nodePath)}`,
		};
		const started = await runNode(main, ["node", "start", "--detach"], environment, workspace);
		if (started.code !== 0) throw new Error(`node start exited ${started.code}: ${started.stderr}`);
		expect(started.stderr).toBe("");
		const opened = await runNode(main, ["open", workspace], environment, workspace);
		expect(opened.code).toBe(0);
		expect(opened.stderr).toBe("");

		client = await connectNode({ dir: state, client: "desktop", timeoutMs: 10_000 });
		const providers = await client.request<{
			providers: Array<{ id: string; label: string; defaultModel: string; available: boolean; note?: string }>;
		}>("providers.list", {});
		expect(providers.providers.find((provider) => provider.id === "codex")).toEqual({
			id: "codex",
			label: "Codex",
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
		const steered = await client.request<{ status: string }>("conversation.prompt", {
			sessionId,
			text: "STAGED_STEER_MESSAGE",
		});
		expect(steered.status).toBe("delivered");

		const entries = await waitFor("adapter steering", async () => {
			const seen = await auditEntries(audit);
			return seen.some((entry) => entry.kind === "steer") ? seen : undefined;
		});
		expect(entries.some((entry) => entry.kind === "initialize")).toBe(true);
		expect(entries.some((entry) => entry.kind === "session-new")).toBe(true);
		expect(entries.filter((entry) => entry.kind === "prompt" && entry.text === "HOLD_FOR_STEER")).toHaveLength(1);
		expect(entries.filter((entry) => entry.kind === "prompt" && entry.text === "STAGED_STEER_MESSAGE")).toHaveLength(
			0,
		);
		expect(entries.filter((entry) => entry.kind === "steer")).toEqual([
			expect.objectContaining({ text: "STAGED_STEER_MESSAGE", idleBehavior: "promptRequired" }),
		]);
		for (const entry of entries) {
			expect(entry.CODEX_PATH).toBe("/configured/codex");
			expect(entry.INITIAL_AGENT_MODE).toBe("read-only");
		}
	} finally {
		if (client !== undefined) await client.close().catch(() => undefined);
		await runNode(main, ["node", "stop"], { ...process.env, NETA_DIR: state }).catch(() => undefined);
		await rm(temp, { recursive: true, force: true });
	}
}, 120_000);
