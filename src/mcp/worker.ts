/**
 * The worker's tools.
 *
 * A worker reports back either by running the `neta` CLI or by calling these
 * tools. Both doors reach the same socket; the tools exist because a sandboxed
 * worker's shell may not be allowed to open one, while its MCP servers run
 * outside that sandbox.
 *
 * `neta_ask` blocks until the leader answers. That is the point: a worker that
 * cannot proceed stops, and the leader is woken with the question.
 */

import { sendChannelRequest } from "../channel/client.ts";
import type { ChannelRequest } from "../channel/protocol.ts";
import { type McpTool, optionalNumber, requireString, text } from "./serve.ts";

async function send(address: string, request: ChannelRequest, okText: string) {
	const response = await sendChannelRequest(address, request);
	if (!response.ok) return text(response.error, true);
	return text(response.text ?? okText);
}

export function workerTools(address: string, workerId: string): McpTool[] {
	return [
		{
			name: "neta_notify",
			description:
				"Record progress in your log. The leader reads it when it chooses, so narrate freely; it costs the " +
				"leader nothing and never interrupts anyone.",
			inputSchema: {
				type: "object",
				properties: { message: { type: "string" } },
				required: ["message"],
			},
			run: (args) => send(address, { type: "notify", workerId, text: requireString(args, "message") }, "ok"),
		},
		{
			name: "neta_ask",
			description:
				"Ask the leader a question and wait for the answer. You are blocked until it replies, so use it only " +
				"when you genuinely cannot proceed; try to answer it from the code first. Junior workers cannot ask.",
			inputSchema: {
				type: "object",
				properties: { question: { type: "string" } },
				required: ["question"],
			},
			run: (args) => send(address, { type: "ask", workerId, text: requireString(args, "question") }, "(no answer)"),
		},
		{
			name: "neta_say",
			description: "Post a message to your room, visible to the other members. Only works if you are in a room.",
			inputSchema: {
				type: "object",
				properties: { message: { type: "string" } },
				required: ["message"],
			},
			run: (args) => send(address, { type: "say", workerId, text: requireString(args, "message") }, "ok"),
		},
		{
			name: "neta_room",
			description: "Read your room's transcript. Read it before you post, so you answer what was actually said.",
			inputSchema: {
				type: "object",
				properties: { tail: { type: "number", description: "Only the last N posts." } },
			},
			run: (args) =>
				send(address, { type: "room", workerId, tail: optionalNumber(args, "tail") }, "(room is empty)"),
		},
		{
			name: "neta_status",
			description:
				"Show only active, queued and finished writers. Use this before inspecting files while another worker may " +
				"have uncommitted changes in the shared checkout.",
			inputSchema: { type: "object" },
			run: () => send(address, { type: "writer-status", workerId }, "(no writers)"),
		},
	];
}
