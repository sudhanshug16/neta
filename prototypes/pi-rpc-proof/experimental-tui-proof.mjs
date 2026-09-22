#!/usr/bin/env node
// Exercises Pi's upstream experimental remote client TUI; it is not RPC mode.
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import pty from "node-pty";

const root = resolve(import.meta.dirname);
const cli = resolve(root, "../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (check, label) => {
	for (let i = 0; i < 800; i += 1) { if (check()) return; await wait(10); }
	throw new Error(`timed out waiting for ${label}`);
};

// Unix socket paths have a small kernel limit; macOS's TMPDIR is too deep.
const temp = await mkdtemp("/private/tmp/neta-pi-experimental-tui-");
let requests = 0;
const model = createServer(async (request, response) => {
	let body = ""; for await (const chunk of request) body += chunk;
	requests += 1;
	response.writeHead(200, { "content-type": "text/event-stream" });
	const send = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
	if (requests === 1) {
		send({ id: "tui-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "read-proof", type: "function", function: { name: "read", arguments: "{\"path\":\"package.json\"}" } }] }, finish_reason: null }] });
		send({ id: "tui-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
	} else {
		await wait(250);
		send({ id: "tui-2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "REMOTE TUI STREAM COMPLETE" }, finish_reason: null }] });
		send({ id: "tui-2", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
	}
	response.end("data: [DONE]\n\n");
});
model.listen(0, "127.0.0.1"); await once(model, "listening");
const port = model.address().port;
const agentDir = join(temp, "agent"); const sessions = join(temp, "sessions"); const serverDir = join(temp, "server");
await mkdir(agentDir, { recursive: true });
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { proof: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local", models: [{ id: "proof-model", contextWindow: 4096, maxTokens: 128, input: ["text"] }] } } }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", retry: { enabled: false } }));
const env = { ...process.env, PI_EXPERIMENTAL: "1", PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_SERVER_DIR: serverDir };
let client; let probe;
const server = spawn(process.execPath, [cli, "server", "--session-dir", sessions, "--provider", "proof", "--model", "proof-model"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let serverText = ""; let serverError = ""; server.stdout.setEncoding("utf8"); server.stdout.on("data", (chunk) => { serverText += chunk; }); server.stderr.setEncoding("utf8"); server.stderr.on("data", (chunk) => { serverError += chunk; });
try {
	try { await until(() => /Socket: (.+\.sock)/.test(serverText), "experimental server socket"); }
	catch (error) { throw new Error(`${error.message}; stdout=${serverText}; stderr=${serverError}`); }
	const socket = /Socket: (.+\.sock)/.exec(serverText)[1];
	probe = spawn(process.execPath, [cli, "client", "--connect", `unix://${socket}`, "probe"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	let probeText = ""; probe.stdout.setEncoding("utf8"); probe.stderr.setEncoding("utf8"); probe.stdout.on("data", (chunk) => { probeText += chunk; }); probe.stderr.on("data", (chunk) => { probeText += chunk; });
	await Promise.race([once(probe, "exit"), wait(3000)]);
	if (probeText.includes("EPIPE")) throw new Error(`experimental client service probe failed: ${probeText}; server=${serverText}; serverErr=${serverError}`);
	let capture = "";
	client = pty.spawn(process.execPath, [cli, "client", "--connect", `unix://${socket}`], { cwd: root, env, cols: 100, rows: 30 });
	client.onData((chunk) => { capture += chunk; });
	try { await until(() => capture.includes("Starting Session") || capture.includes("Working"), "client TUI"); }
	catch (error) { throw new Error(`${error.message}; client=${capture}; server=${serverText}; serverErr=${serverError}`); }
	client.write("run proof\r");
	await until(() => capture.includes("read") || capture.includes("Reading"), "remote tool visible in TUI");
	client.write("steer from TUI\r");
	await until(() => capture.includes("REMOTE TUI STREAM COMPLETE"), "remote streamed completion");
	client.write("\u0004");
	await wait(100);
	console.log(JSON.stringify({ result: "DIAGNOSTIC_ONLY", requests, captured: ["REMOTE TUI STREAM COMPLETE", "read"].filter((text) => capture.includes(text)), transport: "upstream experimental Unix service", limitations: ["Not Pi RPC mode", "No extension dialog bridge in this experimental worker"] }, null, 2));
} finally {
	try { client?.kill(); } catch {}
	probe?.kill("SIGTERM");
	server.kill("SIGTERM");
	model.closeAllConnections();
	await new Promise((done) => model.close(done));
}
