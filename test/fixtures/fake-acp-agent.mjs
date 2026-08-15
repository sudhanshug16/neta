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
 * Anything else is echoed back as the assistant message.
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

let _trapSigterm = false;

const sessions = new Set();
let counter = 0;
/** Whatever the client asked us to launch at session/new, echoed back on request. */
let mcpServers = [];

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
	.onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
	.onRequest("session/new", (ctx) => {
		mcpServers = ctx.params.mcpServers ?? [];
		const sessionId = `s${sessions.size + 1}`;
		sessions.add(sessionId);
		return {
			sessionId,
			models: {
				availableModels: [{ modelId: "test-model" }],
				currentModelId: "test-model",
			},
			modes: {
				availableModes: [{ id: "test-mode" }],
				currentModeId: "test-mode",
			},
		};
	})
	.onRequest("authenticate", () => ({}))
	.onRequest("session/prompt", (ctx) => prompt(ctx.params, ctx.client))
	.connect(stream);
