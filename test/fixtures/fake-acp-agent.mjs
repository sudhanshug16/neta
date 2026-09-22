#!/usr/bin/env node

/**
 * Minimal ACP agent used to test the ACP worker transport without any real CLI
 * or model.
 *
 * It reacts to directives in the prompt text:
 *   EDIT  - asks permission for an "edit" tool call and reports the outcome
 *   DELAYED_EDIT - ends its turn, then asks permission for an "edit" tool call
 *           after the turn is over, the way a harness re-invokes a session when
 *           a backgrounded command finishes
 *   FAIL  - returns a "refusal" stop reason
 *   THINK - emits a thought chunk before the assistant message
 *   USAGE - emits a usage_update and returns per-turn token usage
 *   MCP   - reports the MCP servers it was given at session/new
 *   STREAM - streams an assistant message in mid-paragraph chunks
 *   DIFF  - emits a tool call whose content is a file diff, then repeats the
 *           same content in a tool_call_update, the way real bridges do
 *   TRAP_SIGTERM - traps SIGTERM and ignores it (to test kill escalation)
 *   CONFIG_UPDATE - emits a config_option_update switching the model to
 *           "fixture-fast", the way a backend reports a mid-session change
 *   MODE_UPDATE - emits a current_mode_update switching the mode to "plan"
 *   EXIT_MID_TURN - emits one chunk and disconnects before a terminal response
 *   MCP_E2E_CREATE/RUN/READY/CLOSE - drives the injected Neta MCP proxy
 *           through a controlled mission lifecycle; requires
 *           --mission-e2e-control <directory>
 *   WAIT_FOR_NOTICE - pauses the first turn so a test can queue a notice
 *   WAIT_FOR_BARRIER - pauses until the test releases its file barrier
 * Anything else is echoed back as the assistant message.
 *
 * Flags:
 *   --config-options - session/new also returns configOptions, with values
 *           that differ from the legacy models/modes extension fields so a
 *           test can tell which one the client preferred
 *   --bare - session/new returns only the sessionId: no models, no modes,
 *           no configOptions, like a backend that reports nothing
 *   --claude-fable-default - a Claude-shaped model list whose current value is
 *           the Fable model Neta's policy forbids, so a test can prove which
 *           model a Claude tier actually ran on
 *   --missing-sonnet - drops "sonnet" from that list
 *   --launch-mcp - launches session/new MCP servers for desktop-host tests
 *   --uuid-session - uses a capture-compatible UUID session id
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

let _trapSigterm = false;

const useConfigOptions = process.argv.includes("--config-options");
const unrestrictedModeIndex = process.argv.indexOf("--unrestricted-mode");
const unrestrictedMode = unrestrictedModeIndex === -1 ? undefined : process.argv[unrestrictedModeIndex + 1];
const bare = process.argv.includes("--bare");
const missingExactOpus = process.argv.includes("--missing-exact-opus");
const missingMax = process.argv.includes("--missing-max");
const failSetConfig = process.argv.includes("--fail-set-config");
const unsupportedResume = process.argv.includes("--unsupported-resume");
const rejectResume = process.argv.includes("--reject-resume");
const allowResumeCwdChange = process.argv.includes("--allow-resume-cwd-change");
const sessionStoreIndex = process.argv.indexOf("--session-store");
const sessionStore = sessionStoreIndex === -1 ? undefined : process.argv[sessionStoreIndex + 1];
// A Claude-shaped backend whose own default is the model Neta must never run.
const claudeShaped = process.argv.includes("--claude-fable-default");
const missingSonnet = process.argv.includes("--missing-sonnet");
const launchMcp = process.argv.includes("--launch-mcp");
const uuidSession = process.argv.includes("--uuid-session");
const promptMarkerIndex = process.argv.indexOf("--prompt-marker");
const promptMarker = promptMarkerIndex === -1 ? undefined : process.argv[promptMarkerIndex + 1];
const promptCaptureIndex = process.argv.indexOf("--prompt-capture");
const promptCapture = promptCaptureIndex === -1 ? undefined : process.argv[promptCaptureIndex + 1];
const barrierFileIndex = process.argv.indexOf("--barrier-file");
const barrierFile = barrierFileIndex === -1 ? undefined : process.argv[barrierFileIndex + 1];
const barrierReadyFileIndex = process.argv.indexOf("--barrier-ready-file");
const barrierReadyFile = barrierReadyFileIndex === -1 ? undefined : process.argv[barrierReadyFileIndex + 1];
const missionControlIndex = process.argv.indexOf("--mission-e2e-control");
const missionControl = missionControlIndex === -1 ? undefined : process.argv[missionControlIndex + 1];

const stored =
	sessionStore && existsSync(sessionStore)
		? JSON.parse(readFileSync(sessionStore, "utf-8"))
		: { counter: 0, sessions: {} };
const sessions = new Set(Object.keys(stored.sessions));
const ownedSessions = new Set();
const activePrompts = new Map();
const pendingSteers = new Map();
let counter = 0;
/** Whatever the client asked us to launch at session/new, echoed back on request. */
let mcpServers = [];
const selectedConfig = new Map();
let selectedLegacyModel = "test-model";
const mcpChildren = [];

function missionState() {
	if (!missionControl) throw new Error("MCP_E2E requires --mission-e2e-control");
	const path = `${missionControl}/state.json`;
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function saveMissionState(next) {
	if (!missionControl) throw new Error("MCP_E2E requires --mission-e2e-control");
	writeFileSync(`${missionControl}/state.json`, JSON.stringify(next), "utf8");
}

function recordMcp(entry) {
	if (!missionControl) return;
	const path = `${missionControl}/mcp.ndjson`;
	writeFileSync(path, `${existsSync(path) ? readFileSync(path, "utf8") : ""}${JSON.stringify(entry)}\n`, "utf8");
}

function mcpActorId() {
	const server = mcpServers.find((item) => item.name === "neta");
	if (!server) throw new Error("MCP_E2E has no Neta MCP server");
	const index = server.args.indexOf("--actor");
	return index === -1 ? undefined : server.args[index + 1];
}

/** Call the exact MCP command ACP injected, never the Node socket directly. */
function callNetaTool(name, args) {
	const server = mcpServers.find((item) => item.name === "neta");
	if (!server) return Promise.reject(new Error("MCP_E2E has no Neta MCP server"));
	const env = Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value]));
	return new Promise((resolve, reject) => {
		const child = spawn(server.command, server.args ?? [], {
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let buffer = "";
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(
			() => fail(new Error("MCP_E2E timed out waiting for Neta MCP after 10 seconds")),
			10_000,
		);
		const settle = (fn) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				fn();
			}
		};
		const fail = (error) =>
			settle(() => {
				child.kill();
				reject(error);
			});
		child.on("error", fail);
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				let frame;
				try {
					frame = JSON.parse(line);
				} catch {
					fail(new Error("MCP_E2E received invalid MCP JSON"));
					return;
				}
				if (frame.id === 1) {
					if (frame.error) {
						fail(new Error(frame.error.message ?? "MCP initialize failed"));
						return;
					}
					recordMcp({
						phase: "initialized",
						command: server.command,
						args: server.args.filter((arg, index, all) => arg !== "--token" && all[index - 1] !== "--token"),
						result: frame.result,
					});
					child.stdin.write(
						`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
					);
					child.stdin.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })}\n`,
					);
					continue;
				}
				if (frame.id !== 2) continue;
				child.stdin.end();
				recordMcp({ phase: "tool", name, arguments: args, result: frame.result, error: frame.error, stderr });
				if (frame.error) {
					settle(() => reject(new Error(frame.error.message ?? "MCP tool failed")));
					return;
				}
				settle(() => resolve(frame.result));
			}
		});
		child.on("close", (code) => {
			if (code !== 0 && buffer === "") settle(() => reject(new Error(stderr || `MCP exited ${code}`)));
		});
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-acp-e2e", version: "1" } } })}\n`,
		);
	});
}

function toolData(result) {
	const text = result?.content?.[0]?.text;
	if (result?.isError || typeof text !== "string") throw new Error(`MCP tool failed: ${text ?? "no result"}`);
	return JSON.parse(text.split("\n")[0]);
}

function launchMcpServers(servers) {
	if (!launchMcp) return;
	for (const server of servers) {
		const env = Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value]));
		const child = spawn(server.command, server.args ?? [], {
			env: { ...process.env, ...env },
			stdio: ["pipe", "ignore", "ignore"],
		});
		mcpChildren.push(child);
	}
}

process.on("exit", () => {
	for (const child of mcpChildren) child.kill("SIGTERM");
});

function persist() {
	if (!sessionStore) return;
	const latest = existsSync(sessionStore) ? JSON.parse(readFileSync(sessionStore, "utf-8")) : { counter: 0, sessions: {} };
	for (const id of ownedSessions) latest.sessions[id] = stored.sessions[id];
	latest.counter = Math.max(latest.counter, stored.counter);
	writeFileSync(sessionStore, JSON.stringify(latest), "utf-8");
}

/** The configOptions wire shape, with the selected model and thought level. */
function configOptions(current, thoughtLevel = "medium", mode = "ask") {
	const opusOption = missingExactOpus
		? { value: "opus[1m][high]", name: "Claude Opus 1M High" }
		: { value: "opus[1m]", name: "Claude Opus 1M" };
	if (claudeShaped) {
		return [
			{
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: current,
				options: [
					// The user-global default a Claude worker inherits when nothing is
					// selected exactly. Neta's policy forbids running on it.
					{ value: "claude-fable-5", name: "Claude Fable 5" },
					{ value: "haiku", name: "Claude Haiku" },
					...(missingSonnet ? [] : [{ value: "sonnet", name: "Claude Sonnet" }]),
					opusOption,
				],
			},
			{
				id: "mode",
				name: "Mode",
				category: "mode",
				type: "select",
				currentValue: mode,
				options: [
					{ value: "ask", name: "Always Ask" },
					...(unrestrictedMode === undefined ? [] : [{ value: unrestrictedMode, name: "Unrestricted" }]),
				],
			},
		];
	}
	return [
		{
			id: "model",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: current,
			options: [
				{ value: "fixture-default", name: "Fixture Default" },
				{ value: "fixture-fast", name: "Fixture Fast" },
				...(process.argv.includes("--opencode-models") ? [
					{ value: "openai/gpt-5.6-luna", name: "Luna fixture" },
					{ value: "openai/gpt-6-astra", name: "Astra fixture" },
				] : []),
				{ value: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
				{ value: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
				{ value: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
				opusOption,
			],
		},
		{
			id: "thought-level",
			name: "Thought Level",
			category: "thought_level",
			type: "select",
			currentValue: thoughtLevel,
			options: [
				{ value: "medium", name: "Medium" },
				{ value: "high", name: "High" },
				{ value: "xhigh", name: "Extra High" },
				...(!missingMax ? [{ value: "max", name: "Max" }] : []),
			],
		},
		{
			id: "mode",
			name: "Mode",
			category: "mode",
			type: "select",
			currentValue: mode,
			options: [
				{ value: "ask", name: "Always Ask" },
				...(unrestrictedMode === undefined ? [] : [{ value: unrestrictedMode, name: "Unrestricted" }]),
			],
		},
	];
}

async function say(cx, sessionId, text) {
	await cx.notify(acp.methods.client.session.update, {
		sessionId,
		update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
	});
}

async function waitForBarrier(signal) {
	if (!barrierFile) throw new Error("WAIT_FOR_BARRIER requires --barrier-file");
	if (barrierReadyFile) writeFileSync(barrierReadyFile, "ready\n", "utf-8");
	while (!existsSync(barrierFile) && !signal.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
	return !signal.aborted;
}

async function runPrompt(params, cx, signal) {
	if (promptMarker) writeFileSync(promptMarker, "prompted\n", "utf-8");
	const sessionId = params.sessionId;
	const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
	if (promptCapture) appendFileSync(promptCapture, `${JSON.stringify(text)}\n`, "utf8");
	const attachmentKinds = params.prompt.filter((block) => block.type !== "text").map((block) => block.type);
	const saved = stored.sessions[sessionId];
	if (saved) {
		saved.history.push(text);
		persist();
	}
	if (text.includes("HISTORY")) {
		await say(cx, sessionId, JSON.stringify(saved?.history ?? []));
		return { stopReason: "end_turn" };
	}

	if (text.includes("FAIL")) {
		await say(cx, sessionId, "giving up");
		return { stopReason: "refusal" };
	}

	if (text.includes("WAIT_FOR_NOTICE")) {
		await new Promise((resolve) => setTimeout(resolve, 200));
	}

	if (text.includes("WAIT_FOR_BARRIER") && !(await waitForBarrier(signal))) {
		return { stopReason: "cancelled" };
	}

	if (text.includes("REPORT_PID")) await say(cx, sessionId, `pid:${process.pid}\n\n`);
	if (text.includes("REPORT_SANDBOX_POLICY")) {
		await say(cx, sessionId, `mode:${selectedConfig.get(sessionId)?.mode ?? "unconfigured"}`);
		return { stopReason: "end_turn" };
	}

	if (text.includes("DELAYED_EDIT")) {
		await say(cx, sessionId, "armed");
		setTimeout(async () => {
			try {
				const toolCallId = `call_${++counter}`;
				await cx.request(acp.methods.client.session.requestPermission, {
					sessionId,
					toolCall: { toolCallId, title: "Edit config.json", kind: "edit", status: "pending" },
					options: [
						{ kind: "allow_once", name: "Allow", optionId: "allow" },
						{ kind: "reject_once", name: "Reject", optionId: "reject" },
					],
				});
			} catch {
				// The client may have closed the session by then.
			}
		}, 300);
		return { stopReason: "end_turn" };
	}

	if (text.includes("EDIT") || text.includes("SHELL") || text.includes("PERMISSION_")) {
		const kind = text.includes("PERMISSION_")
			? text.split("PERMISSION_")[1].trim().toLowerCase()
			: text.includes("SHELL")
				? "execute"
				: "edit";
		const toolCallId = `call_${++counter}`;
		await cx.notify(acp.methods.client.session.update, {
			sessionId,
			update: {
				sessionUpdate: "tool_call",
				toolCallId,
				title: "Edit config.json",
				kind: "edit",
				status: "pending",
			},
		});
		const response = await cx.request(acp.methods.client.session.requestPermission, {
			sessionId,
			toolCall: { toolCallId, title: "Check tool permission", kind, status: "pending" },
			options: [
				{ kind: "allow_once", name: "Allow", optionId: "allow" },
				{ kind: "reject_once", name: "Reject", optionId: "reject" },
			],
		});
		const outcome =
			response.outcome.outcome === "cancelled" ? "cancelled" : `permission=${response.outcome.optionId}`;
		await say(cx, sessionId, outcome);
		return { stopReason: "end_turn" };
	}

	// A deterministic desktop acceptance script.  Each operation travels from
	// this ACP process through the injected `neta mcp` stdio command, so it
	// exercises the same proxy and actor-token boundary as a real provider.
	if (text.includes("MCP_E2E_CREATE")) {
		let result;
		try {
			result = toolData(
				await callNetaTool("neta_mission", {
					name: "Checkout verification",
					objective: "Exercise the Neta mission lifecycle",
					access: "readOnly",
					// The lead calls Neta from its initial brief. This is deliberate:
					// an agent must not need a second user prompt before its injected
					// MCP tools are usable.
					lead: { task: "MCP_E2E_BLOCK" },
				}),
			);
		} catch (error) {
			saveMissionState({ stage: "error", error: String(error) });
			throw error;
		}
		const current = missionState();
		saveMissionState({
			...current,
			missionId: result.id,
			stage: current.stage === "blocked" ? "blocked" : "created",
		});
		await say(cx, sessionId, `created mission ${result.id}`);
		return { stopReason: "end_turn" };
	}
	if (text.includes("MCP_E2E_BLOCK")) {
		const current = missionState();
		saveMissionState({ ...current, agentId: mcpActorId(), stage: "blocking" });
		await callNetaTool("neta_ask", { question: "Choose the checkout refund policy" });
		saveMissionState({ ...missionState(), stage: "blocked" });
		await say(cx, sessionId, "waiting for refund policy");
		return { stopReason: "end_turn" };
	}
	if (text.includes("MCP_E2E_RUN")) {
		const current = missionState();
		if (!current.agentId) throw new Error("MCP_E2E agent did not report its actor id");
		await callNetaTool("neta_send", { agentId: current.agentId, text: "MCP_E2E_COMPLETE_WAIT" });
		await say(cx, sessionId, "agent resumed");
		return { stopReason: "end_turn" };
	}
	if (text.includes("MCP_E2E_COMPLETE_WAIT")) {
		const current = missionState();
		saveMissionState({ ...current, stage: "running" });
		if (!missionControl) throw new Error("MCP_E2E requires --mission-e2e-control");
		const release = `${missionControl}/complete.release`;
		while (!existsSync(release) && !signal.aborted) await new Promise((resolve) => setTimeout(resolve, 20));
		if (signal.aborted) return { stopReason: "cancelled" };
		await callNetaTool("neta_done", { outcome: "Checkout behavior verified" });
		saveMissionState({ ...missionState(), stage: "completed" });
		await say(cx, sessionId, "checkout verified");
		return { stopReason: "end_turn" };
	}
	if (text.includes("MCP_E2E_READY")) {
		const current = missionState();
		if (!current.missionId) throw new Error("MCP_E2E has no mission id");
		await callNetaTool("neta_ready", { missionId: current.missionId, summary: "Checkout behavior verified" });
		saveMissionState({ ...missionState(), stage: "ready" });
		await say(cx, sessionId, "ready to close");
		return { stopReason: "end_turn" };
	}
	if (text.includes("MCP_E2E_CLOSE")) {
		const current = missionState();
		if (!current.missionId) throw new Error("MCP_E2E has no mission id");
		await callNetaTool("neta_close", {
			missionId: current.missionId,
			disposition: "abandoned",
			reason: "fixture complete",
		});
		saveMissionState({ ...missionState(), stage: "closed" });
		await say(cx, sessionId, "mission closed");
		return { stopReason: "end_turn" };
	}

	if (text.includes("MCP")) {
		await say(cx, sessionId, `mcp:${JSON.stringify(mcpServers)}`);
		return { stopReason: "end_turn" };
	}

	if (text.includes("REPORT_NETA_ENV")) {
		await say(
			cx,
			sessionId,
			JSON.stringify({
				leaderToken: process.env.NETA_LEADER_TOKEN ?? null,
				leaderBackend: process.env.NETA_LEADER_BACKEND ?? null,
				sessionId: process.env.NETA_SESSION_ID ?? null,
				mux: process.env.NETA_MUX ?? null,
				panes: process.env.NETA_PANES ?? null,
			}),
		);
		return { stopReason: "end_turn" };
	}

	if (text.includes("TOOL_STREAM")) {
		await say(cx, sessionId, "Before tool call.");
		const toolCallId = `call_${++counter}`;
		await cx.notify(acp.methods.client.session.update, {
			sessionId,
			update: { sessionUpdate: "tool_call", toolCallId, title: "Read File", kind: "read", status: "completed" },
		});
		await say(cx, sessionId, "After tool call.");
		return { stopReason: "end_turn" };
	}

	if (text.includes("STREAM")) {
		await say(cx, sessionId, "First paragraph");
		await say(cx, sessionId, " continues.\n\nSecond");
		await say(cx, sessionId, " paragraph.");
		return { stopReason: "end_turn" };
	}

	if (text.includes("DIFF")) {
		const toolCallId = `call_${++counter}`;
		const diff = { type: "diff", path: "/repo/config.json", oldText: "a\nb\nc\n", newText: "a\nB\nc\n" };
		await cx.notify(acp.methods.client.session.update, {
			sessionId,
			update: {
				sessionUpdate: "tool_call",
				toolCallId,
				title: "Edit config.json",
				kind: "edit",
				status: "in_progress",
				content: [diff],
			},
		});
		await cx.notify(acp.methods.client.session.update, {
			sessionId,
			update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [diff] },
		});
		await say(cx, sessionId, "edited");
		return { stopReason: "end_turn" };
	}

	if (text.includes("USAGE")) {
		await cx.notify(acp.methods.client.session.update, {
			sessionId,
			update: {
				sessionUpdate: "usage_update",
				used: 1200,
				size: 200000,
				cost: { amount: 0.42, currency: "USD" },
			},
		});
		await say(cx, sessionId, "counted");
		return {
			stopReason: "end_turn",
			usage: { totalTokens: 1500, inputTokens: 1000, outputTokens: 500 },
		};
	}

	if (text.includes("FULL_SEQUENCE")) {
		await cx.notify(acp.methods.client.session.update, {
			sessionId,
			update: {
				sessionUpdate: "plan",
				entries: [{ content: "Inspect the workspace", priority: "high", status: "in_progress" }],
			},
		});
		const toolCallId = `call_${++counter}`;
		for (const status of ["pending", "in_progress", "completed"]) {
			await new Promise((resolve) => setTimeout(resolve, 15));
			await cx.notify(acp.methods.client.session.update, {
				sessionId,
				update: {
					sessionUpdate: status === "pending" ? "tool_call" : "tool_call_update",
					toolCallId,
					title: status === "pending" ? "Inspect files" : undefined,
					kind: "read",
					status,
					...(status === "completed"
						? { content: [{ type: "diff", path: "/repo/example.ts", oldText: "old\n", newText: "new\n" }] }
						: {}),
				},
			});
		}
		await cx.notify(acp.methods.client.session.update, {
			sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId,
				content: [{ type: "content", content: { type: "text", text: "inspection metadata" } }],
			},
		});
		await cx.notify(acp.methods.client.session.update, {
			sessionId,
			update: { sessionUpdate: "usage_update", used: 100, size: 1000 },
		});
		await say(
			cx,
			sessionId,
			`Finished.${attachmentKinds.length === 0 ? "" : `\n\nAttachments received: ${attachmentKinds.join(", ")}`}\n\n- one\n- two\n\n| Item | State |\n| --- | --- |\n| Runtime | Ready |\n\n\`\`\`ts\nconst ready = true;\n\`\`\``,
		);
		return { stopReason: "end_turn", usage: { totalTokens: 12, inputTokens: 8, outputTokens: 4, currency: "USD" } };
	}

	if (text.includes("EXIT_MID_TURN")) {
		await say(cx, sessionId, "partial before disconnect");
		setTimeout(() => process.exit(23), 10);
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	if (text.includes("THINK")) {
		await cx.notify(acp.methods.client.session.update, {
			sessionId,
			update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "weighing options" } },
		});
	}

	if (text.includes("CONFIG_UPDATE")) {
		await cx.notify(acp.methods.client.session.update, {
			sessionId,
			update: { sessionUpdate: "config_option_update", configOptions: configOptions("fixture-fast") },
		});
		await say(cx, sessionId, "config updated");
		return { stopReason: "end_turn" };
	}

	if (text.includes("MODE_UPDATE")) {
		await cx.notify(acp.methods.client.session.update, {
			sessionId,
			update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
		});
		await say(cx, sessionId, "mode updated");
		return { stopReason: "end_turn" };
	}

	if (text.includes("SPAWN_TRAP_SIGTERM_CHILD")) {
		const child = spawn(process.execPath, [new URL("./sigterm-ignoring-child.mjs", import.meta.url).pathname], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		await new Promise((resolve) => child.stdout.once("data", resolve));
		child.stdout.destroy();
		process.once("SIGTERM", () => process.exit(0));
		await say(cx, sessionId, `grandchild:${child.pid}`);
		return { stopReason: "end_turn" };
	}

	if (text.includes("TRAP_SIGTERM")) {
		_trapSigterm = true;
		process.on("SIGTERM", () => {
			// Trap and ignore SIGTERM to test kill escalation to SIGKILL.
		});
		await say(cx, sessionId, "sigterm trapped");
		return { stopReason: "end_turn" };
	}

	if (text.includes("HOLD_FOREVER")) {
		// A worker that is still running when its manager is killed. Recovery has
		// to prove this process group is gone before it may hydrate.
		await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
		return { stopReason: "cancelled" };
	}
	if (text.includes("HOLD_FOR_STEER")) {
		for (let attempts = 0; attempts < 40 && !pendingSteers.has(params.sessionId); attempts += 1)
			await new Promise((resolve) => setTimeout(resolve, 5));
		pendingSteers.delete(params.sessionId);
		return { stopReason: "end_turn" };
	}

	if (text.includes("COPY_MULTILINE")) {
		await say(cx, sessionId, "copy α\ncopy β");
		return { stopReason: "end_turn" };
	}

	if (text.includes("SUBSTANTIVE_HANDOFF")) {
		await say(cx, sessionId, "Substantive report: audited the control path, found the race, and verified the fix.");
		return { stopReason: "end_turn" };
	}

	await say(cx, sessionId, `echo:${text.trim().split("\n").pop()}`);
	return { stopReason: "end_turn" };
}

async function prompt(params, cx) {
	const controller = new AbortController();
	activePrompts.set(params.sessionId, controller);
	try {
		return await runPrompt(params, cx, controller.signal);
	} finally {
		if (activePrompts.get(params.sessionId) === controller) activePrompts.delete(params.sessionId);
	}
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

acp.agent({ name: "fake-acp-agent" })
	.onRequest("initialize", () => ({
		protocolVersion: acp.PROTOCOL_VERSION,
		agentCapabilities: {
			promptCapabilities: { image: true, embeddedContext: true },
			...(unsupportedResume ? {} : { sessionCapabilities: { resume: {} } }),
		},
		agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
		_meta: { steering: { supported: true } },
	}))
	.onRequest("session/new", (ctx) => {
		mcpServers = ctx.params.mcpServers ?? [];
		launchMcpServers(mcpServers);
		if (sessionStore && existsSync(sessionStore)) stored.counter = Math.max(stored.counter, JSON.parse(readFileSync(sessionStore, "utf-8")).counter);
		const nextSession = ++stored.counter;
		const sessionId = uuidSession
			? `00000000-0000-4000-8000-${String(nextSession).padStart(12, "0")}`
			: `s${nextSession}`;
		sessions.add(sessionId);
		ownedSessions.add(sessionId);
		stored.sessions[sessionId] = {
			cwd: ctx.params.cwd,
			mcpServers,
			history: [],
			model: "fixture-default",
			thoughtLevel: "medium",
			mode: "test-mode",
		};
		persist();
		if (bare) return { sessionId };
		const response = {
			sessionId,
			models: {
				availableModels: [{ modelId: "test-model" }, { modelId: "legacy-other" }],
				currentModelId: selectedLegacyModel,
			},
			modes: {
				availableModes: [{ id: "test-mode" }],
				currentModeId: "test-mode",
			},
		};
		if (useConfigOptions || claudeShaped) {
			const current = claudeShaped ? "claude-fable-5" : "fixture-default";
			selectedConfig.set(sessionId, { model: current, thoughtLevel: "medium", mode: "ask" });
			response.configOptions = configOptions(current);
		}
		return response;
	})
	.onRequest(acp.methods.agent.session.resume, (ctx) => {
		if (rejectResume) throw new Error("fixture rejected resume");
		ownedSessions.add(ctx.params.sessionId);
		const saved = stored.sessions[ctx.params.sessionId];
		if (!saved) throw new Error(`unknown session ${ctx.params.sessionId}`);
		if (saved.cwd !== ctx.params.cwd && !allowResumeCwdChange) throw new Error("resume cwd mismatch");
		saved.cwd = ctx.params.cwd;
		mcpServers = ctx.params.mcpServers ?? [];
		launchMcpServers(mcpServers);
		saved.mcpServers = mcpServers;
		selectedConfig.set(ctx.params.sessionId, {
			model: saved.model,
			thoughtLevel: saved.thoughtLevel,
			mode: saved.configMode ?? "ask",
		});
		persist();
		return {
			modes: { availableModes: [{ id: "test-mode" }], currentModeId: saved.mode },
			configOptions: useConfigOptions
				? configOptions(saved.model, saved.thoughtLevel, saved.configMode ?? "ask")
				: undefined,
		};
	})
	.onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
		if (failSetConfig) throw new Error("fixture setConfig failure");
		const selected = selectedConfig.get(ctx.params.sessionId);
		if (!selected) throw new Error("config options are not supported");
		if (ctx.params.configId === "neta_refresh_models") {
			const options = configOptions(selected.model, selected.thoughtLevel, selected.mode);
			options.find((option) => option.id === "model").options.push({ value: "xai/new-model", name: "New connected model" });
			return { configOptions: options };
		}
		if (ctx.params.configId === "model") selected.model = ctx.params.value;
		if (ctx.params.configId === "thought-level") selected.thoughtLevel = ctx.params.value;
		if (ctx.params.configId === "mode") selected.mode = ctx.params.value;
		const saved = stored.sessions[ctx.params.sessionId];
		if (saved) {
			saved.model = selected.model;
			saved.thoughtLevel = selected.thoughtLevel;
			saved.configMode = selected.mode;
			persist();
		}
		return { configOptions: configOptions(selected.model, selected.thoughtLevel, selected.mode) };
	})
	.onRequest("session/set_model", { parse: (params) => params }, (ctx) => {
		if (useConfigOptions || claudeShaped) throw new Error("legacy set_model is not supported");
		const saved = stored.sessions[ctx.params.sessionId];
		if (!saved) throw new Error(`unknown session ${ctx.params.sessionId}`);
		if (!["test-model", "legacy-other"].includes(ctx.params.modelId)) throw new Error("legacy model is not advertised");
		selectedLegacyModel = ctx.params.modelId;
		saved.model = ctx.params.modelId;
		persist();
		return {};
	})
	.onRequest("session/set_mode", { parse: (params) => params }, (ctx) => {
		const saved = stored.sessions[ctx.params.sessionId];
		if (!saved || ctx.params.modeId !== "test-mode") throw new Error("legacy mode is not advertised");
		saved.mode = ctx.params.modeId;
		selectedConfig.set(ctx.params.sessionId, { model: saved.model, thoughtLevel: saved.thoughtLevel, mode: saved.mode });
		persist();
		return {};
	})
	.onRequest("authenticate", () => ({}))
	.onNotification(acp.methods.agent.session.cancel, (ctx) => {
		activePrompts.get(ctx.params.sessionId)?.abort();
	})
	.onRequest("session/prompt", (ctx) => prompt(ctx.params, ctx.client))
	.onRequest("_session/steering", { parse: (params) => params }, async (ctx) => {
		if (!activePrompts.has(ctx.params.sessionId)) {
			if (ctx.params._meta?.steering?.idleBehavior === "promptRequired")
				return { outcome: "promptRequired", reason: "noRunningTurn" };
			throw new Error("fixture refuses detached steering turns");
		}
		const text = ctx.params.prompt
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		pendingSteers.set(ctx.params.sessionId, text);
		await say(ctx.client, ctx.params.sessionId, `steered:${text}`);
		activePrompts.get(ctx.params.sessionId)?.abort();
		return { outcome: "injected" };
	})
	.connect(stream);
