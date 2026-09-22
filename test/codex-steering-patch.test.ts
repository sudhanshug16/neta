import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the bundled Codex adapter preserves promptRequired through the idle race", () => {
	const directory = mkdtempSync(join(tmpdir(), "neta-codex-steer-"));
	const installed = join(import.meta.dir, "../node_modules/@agentclientprotocol/codex-acp/dist/index.js");
	execFileSync("bun", ["run", "build"], { cwd: join(import.meta.dir, ".."), stdio: "pipe" });
	const staged = join(import.meta.dir, "../dist/codex-acp.mjs");
	expect(readFileSync(staged, "utf8")).toBe(readFileSync(installed, "utf8"));
	let source = readFileSync(staged, "utf8");
	source = source.replace(
		"} else {\n  startAcpServer();\n}\nfunction startAcpServer()",
		"}\nfunction startAcpServer()",
	);
	source += "\nexport { CodexAcpServer };\n";
	const modulePath = join(directory, "adapter.mjs");
	writeFileSync(modulePath, source);
	const runner = join(directory, "runner.mjs");
	writeFileSync(
		runner,
		`
import { CodexAcpServer } from ${JSON.stringify(modulePath)};
const server = Object.create(CodexAcpServer.prototype);
server.getSessionState = () => ({ supportedInputModalities: ["text"] });
server.getSteerableTurnId = async () => null;
server.startNewTurnFromSteering = async () => { throw new Error("detached turn started"); };
const parsed = server.parseSessionSteerParams({ sessionId: "s1", prompt: [{ type: "text", text: "steer" }], _meta: { steering: { idleBehavior: "promptRequired" } } });
const result = await server.performSteeringRequest(parsed);
if (result.outcome !== "promptRequired") throw new Error(JSON.stringify(result));

server.getSteerableTurnId = async () => "t1";
server.injectSteerIntoActiveTurn = async () => true;
const injected = await server.performSteeringRequest(parsed);
if (injected.outcome !== "injected") throw new Error("active injection failed");

server.injectSteerIntoActiveTurn = async () => false;
const raced = await server.performSteeringRequest(parsed);
if (raced.outcome !== "promptRequired") throw new Error("active-to-idle race detached a turn");

for (const invalid of [{ _meta: [] }, { _meta: { steering: [] } }, { _meta: { steering: { idleBehavior: "start" } } }]) {
  let rejected = false;
  try { server.parseSessionSteerParams({ sessionId: "s1", prompt: [], ...invalid }); } catch { rejected = true; }
  if (!rejected) throw new Error("invalid steering meta accepted");
}

server.getSteerableTurnId = async () => null;
server.startNewTurnFromSteering = async () => ({ outcome: "prompted" });
const legacy = await server.performSteeringRequest(server.parseSessionSteerParams({ sessionId: "s1", prompt: [] }));
if (legacy.outcome !== "prompted") throw new Error("legacy steering no longer starts a turn");
`,
	);
	const result = spawnSync(process.execPath, [runner], { encoding: "utf8" });
	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
});
