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
 *   WAIT_FOR_NOTICE - pauses the first turn so a test can queue a notice
 * Anything else is echoed back as the assistant message.
 *
 * Flags:
 *   --config-options - session/new also returns configOptions, with values
 *           that differ from the legacy models/modes extension fields so a
 *           test can tell which one the client preferred
 *   --bare - session/new returns only the sessionId: no models, no modes,
 *           no configOptions, like a backend that reports nothing
 */

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

let _trapSigterm = false;

const useConfigOptions = process.argv.includes("--config-options");
const bare = process.argv.includes("--bare");

const sessions = new Set();
let counter = 0;
/** Whatever the client asked us to launch at session/new, echoed back on request. */
let mcpServers = [];
const selectedConfig = new Map();
let selectedLegacyModel = "test-model";

/** The configOptions wire shape, with the selected model and thought level. */
function configOptions(current, thoughtLevel = "medium") {
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
				{ value: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
				{ value: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
				{ value: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
				{ value: "opus[1m]", name: "Claude Opus 1M" },
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
				{ value: "max", name: "Max" },
			],
		},
		{
			id: "mode",
			name: "Mode",
			category: "mode",
			type: "select",
			currentValue: "ask",
			options: [{ value: "ask", name: "Always Ask" }],
		},
	];
}

async function say(cx, sessionId, text) {
	await cx.notify(acp.methods.client.session.update, {
		sessionId,
		update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
	});
}

async function prompt(params, cx) {
	const sessionId = params.sessionId;
	const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");

	if (text.includes("FAIL")) {
		await say(cx, sessionId, "giving up");
		return { stopReason: "refusal" };
	}

	if (text.includes("WAIT_FOR_NOTICE")) {
		await new Promise((resolve) => setTimeout(resolve, 200));
	}

	if (text.includes("REPORT_PID")) await say(cx, sessionId, `pid:${process.pid}\n\n`);

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

	if (text.includes("EDIT")) {
		const toolCallId = `call_${++counter}`;
		await cx.notify(acp.methods.client.session.update, {
			sessionId,
			update: { sessionUpdate: "tool_call", toolCallId, title: "Edit config.json", kind: "edit", status: "pending" },
		});
		const response = await cx.request(acp.methods.client.session.requestPermission, {
			sessionId,
			toolCall: { toolCallId, title: "Edit config.json", kind: "edit", status: "pending" },
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
			update: { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.42, currency: "USD" } },
		});
		await say(cx, sessionId, "counted");
		return {
			stopReason: "end_turn",
			usage: { totalTokens: 1500, inputTokens: 1000, outputTokens: 500 },
		};
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

	await say(cx, sessionId, `echo:${text.trim().split("\n").pop()}`);
	return { stopReason: "end_turn" };
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

acp.agent({ name: "fake-acp-agent" })
	.onRequest("initialize", () => ({
		protocolVersion: acp.PROTOCOL_VERSION,
		agentCapabilities: {},
		agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
	}))
	.onRequest("session/new", (ctx) => {
		mcpServers = ctx.params.mcpServers ?? [];
		const sessionId = `s${sessions.size + 1}`;
		sessions.add(sessionId);
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
		if (useConfigOptions) {
			selectedConfig.set(sessionId, { model: "fixture-default", thoughtLevel: "medium" });
			response.configOptions = configOptions("fixture-default");
		}
		return response;
	})
	.onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
		const selected = selectedConfig.get(ctx.params.sessionId);
		if (!selected) throw new Error("config options are not supported");
		if (ctx.params.configId === "model") selected.model = ctx.params.value;
		if (ctx.params.configId === "thought-level") selected.thoughtLevel = ctx.params.value;
		return { configOptions: configOptions(selected.model, selected.thoughtLevel) };
	})
	.onRequest("session/set_model", { parse: (params) => params }, (ctx) => {
		if (useConfigOptions) throw new Error("legacy set_model is not supported");
		selectedLegacyModel = ctx.params.modelId;
		return {};
	})
	.onRequest("authenticate", () => ({}))
	.onRequest("session/prompt", (ctx) => prompt(ctx.params, ctx.client))
	.connect(stream);
