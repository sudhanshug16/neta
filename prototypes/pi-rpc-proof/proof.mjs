#!/usr/bin/env node
// Runs real Pi RPC mode against a local OpenAI-compatible deterministic server.
// It intentionally proves the documented headless protocol, not TUI remoting.
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const root = resolve(import.meta.dirname);
const piCli = resolve(root, "../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const extension = join(root, "proof-extension.ts");
const timeout = (ms, message) => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

function sse(response, value) {
	response.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function startModel() {
	let requests = 0;
	const requestBodies = [];
	const server = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		requests += 1;
		let body = "";
		for await (const chunk of request) body += chunk;
		requestBodies.push(JSON.parse(body));
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		if (requests === 1) {
			sse(response, { id: "proof-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_proof", type: "function", function: { name: "proof_tool", arguments: "{\"note\":\"confirm remote dialog\"}" } }] }, finish_reason: null }] });
			sse(response, { id: "proof-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
		} else {
			sse(response, { id: "proof-2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "streamed completion after tool and steering" }, finish_reason: null }] });
			sse(response, { id: "proof-2", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		}
		response.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("model server did not bind TCP");
	return { server, requestBodies, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function writeConfig(dir, baseUrl) {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { proof: { baseUrl, api: "openai-completions", apiKey: "local-proof", models: [{ id: "proof-model", contextWindow: 4096, maxTokens: 256, input: ["text"] }] } } }));
	await writeFile(join(dir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", retry: { enabled: false } }));
}

function startPi({ configDir, sessionDir, sessionFile }) {
	const args = [piCli, "--mode", "rpc", "--provider", "proof", "--model", "proof-model", "--session-dir", sessionDir, "--extension", extension, "--no-extensions", "--no-context-files", "--offline", "--no-builtin-tools"];
	if (sessionFile) args.push("--session", sessionFile);
	const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: configDir, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
	const events = [];
	let stderr = "";
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const end = buffer.indexOf("\n");
			if (end < 0) break;
			const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
			if (line) events.push(JSON.parse(line));
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
	const until = async (predicate, label) => Promise.race([
		(async () => { while (!predicate()) await new Promise((resolveWait) => setTimeout(resolveWait, 10)); })(),
		timeout(8000, `timed out waiting for ${label}`),
	]);
	return { child, events, get stderr() { return stderr; }, send, until };
}

async function stopPi(pi) {
	pi.child.stdin.end();
	await Promise.race([once(pi.child, "exit"), timeout(4000, "Pi did not exit")]);
}

const evidence = { piVersion: "0.85.0", checks: {}, limitations: ["No SSH transport was exercised.", "This does not attach RpcClient to InteractiveMode; Pi exposes no such adapter seam."] };
const temp = await mkdtemp(join(tmpdir(), "neta-pi-rpc-proof-"));
const model = await startModel();
try {
	const configDir = join(temp, "agent");
	const sessionDir = join(temp, "sessions");
	await writeConfig(configDir, model.baseUrl);
	const first = startPi({ configDir, sessionDir });
	first.send({ id: "prompt", type: "prompt", message: "start proof" });
	try {
		await first.until(() => first.events.some((event) => event.type === "extension_ui_request" && event.method === "confirm"), "extension confirm request");
	} catch (error) {
		throw new Error(`${error.message}; Pi stderr: ${first.stderr}; events: ${JSON.stringify(first.events)}`);
	}
	evidence.checks.dialogRequest = first.events.some((event) => event.type === "extension_ui_request" && event.method === "confirm");
	first.send({ id: "steer", type: "steer", message: "continue after confirmation" });
	await first.until(() => first.events.some((event) => event.type === "response" && event.id === "steer" && event.success), "steer acknowledgement");
	const dialog = first.events.find((event) => event.type === "extension_ui_request" && event.method === "confirm");
	first.send({ type: "extension_ui_response", id: dialog.id, confirmed: true });
	await first.until(() => first.events.some((event) => event.type === "agent_settled"), "agent settled");
	first.send({ id: "entries", type: "get_entries" });
	await first.until(() => first.events.some((event) => event.type === "response" && event.id === "entries"), "entry history");
	const entries = first.events.find((event) => event.type === "response" && event.id === "entries").data.entries;
	first.send({ id: "state", type: "get_state" });
	await first.until(() => first.events.some((event) => event.type === "response" && event.id === "state"), "session state");
	const sessionFile = first.events.find((event) => event.type === "response" && event.id === "state").data.sessionFile;
	evidence.checks.streaming = first.events.some((event) => event.type === "message_update") && first.events.some((event) => event.type === "agent_settled");
	evidence.checks.steering = first.events.some((event) => event.type === "response" && event.id === "steer" && event.success)
		&& JSON.stringify(model.requestBodies[1]).includes("continue after confirmation");
	evidence.checks.toolUpdates = first.events.some((event) => event.type === "tool_execution_update") && first.events.some((event) => event.type === "tool_execution_end");
	evidence.checks.dialogRoundTrip = first.events.some((event) => event.type === "extension_ui_request" && event.method === "notify");
	evidence.checks.historyEntries = entries.length;
	await stopPi(first);

	const second = startPi({ configDir, sessionDir, sessionFile });
	second.send({ id: "reconnect", type: "get_entries" });
	await second.until(() => second.events.some((event) => event.type === "response" && event.id === "reconnect"), "reconnected history");
	evidence.checks.reconnectHistoryEntries = second.events.find((event) => event.type === "response" && event.id === "reconnect").data.entries.length;
	await stopPi(second);
	evidence.result = Object.values(evidence.checks).every((value) => value === true || (typeof value === "number" && value > 0)) ? "PASS" : "FAIL";
	console.log(JSON.stringify(evidence, null, 2));
} finally {
	await new Promise((resolveClose) => model.server.close(resolveClose));
}
