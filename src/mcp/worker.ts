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

export function workerTools(address: string, workerId: string, token: string): McpTool[] {
	return [
		{
			name: "neta_progress",
			description:
				"Record a progress milestone in your log. Use it when you start, when a major step completes, and when " +
				"something surprising changes your plan — one line each, not a running commentary. The leader and the user " +
				"read these at a glance; frequent trivial calls bury the signal.",
			inputSchema: {
				type: "object",
				properties: { message: { type: "string" } },
				required: ["message"],
			},
			run: (args) =>
				send(address, { type: "progress", workerId, token, text: requireString(args, "message") }, "ok"),
		},
		{
			name: "neta_ask",
			description:
				"Ask the leader a question and wait for the answer. You are blocked until it replies, so use it only " +
				"when you genuinely cannot proceed; try to answer it from the code first. Journeyman workers cannot ask.",
			inputSchema: {
				type: "object",
				properties: { question: { type: "string" } },
				required: ["question"],
			},
			run: (args) =>
				send(address, { type: "ask", workerId, token, text: requireString(args, "question") }, "(no answer)"),
		},
		{
			name: "neta_say",
			description: "Post a message to your room, visible to the other members. Only works if you are in a room.",
			inputSchema: {
				type: "object",
				properties: { message: { type: "string" } },
				required: ["message"],
			},
			run: (args) => send(address, { type: "say", workerId, token, text: requireString(args, "message") }, "ok"),
		},
		{
			name: "neta_room",
			description: "Read your room's transcript. Read it before you post, so you answer what was actually said.",
			inputSchema: {
				type: "object",
				properties: { tail: { type: "number", description: "Only the last N posts." } },
			},
			run: (args) =>
				send(address, { type: "room", workerId, token, tail: optionalNumber(args, "tail") }, "(room is empty)"),
		},
		{
			name: "neta_status",
			description:
				"Show only active, queued and finished writers. Use this before inspecting files while another worker may " +
				"have uncommitted changes in the shared checkout.",
			inputSchema: { type: "object" },
			run: () => send(address, { type: "writer-status", workerId, token }, "(no writers)"),
		},
	];
}
