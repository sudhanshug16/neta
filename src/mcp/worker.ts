/**
 * The worker's tools.
 *
 * A worker reports back either by running the `neta` CLI or by calling these
 * tools. Both doors reach the same socket; the tools exist because a sandboxed
 * worker's shell may not be allowed to open one, while its MCP servers run
 * outside that sandbox.
 *
 * `neta_blocked` records a terminal blocker; the leader later revives the exact
 * ACP conversation with `neta_send`.
 */

import { sendChannelRequest } from "../channel/client.ts";
import type { ChannelRequest } from "../channel/protocol.ts";
import { type McpTool, optionalNumber, optionalString, requireString, text } from "./serve.ts";

function discoveryImpact(value: string): "local" | "goal" {
	if (value !== "local" && value !== "goal") throw new Error('"impact" must be local or goal.');
	return value;
}

async function send(address: string, request: ChannelRequest, okText: string) {
	const response = await sendChannelRequest(address, request);
	if (!response.ok) return text(response.error, true);
	return text(response.text ?? okText);
}

export function workerTools(address: string, workerId: string, token: string, team?: string): McpTool[] {
	const tools: McpTool[] = [
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
			name: "neta_blocked",
			description:
				"Report a genuine blocker. This ends the current turn and releases all resources; the leader resumes " +
				"this exact conversation with neta_send.",
			inputSchema: {
				type: "object",
				properties: { question: { type: "string" } },
				required: ["question"],
			},
			run: (args) =>
				send(address, { type: "blocked", workerId, token, text: requireString(args, "question") }, "blocked"),
		},
		{
			name: "neta_discover",
			description:
				"Report a finding. Local findings are recorded and the worker continues; goal-impact findings stop this turn for leader resolution.",
			inputSchema: {
				type: "object",
				properties: {
					impact: { type: "string", enum: ["local", "goal"] },
					finding: { type: "string" },
					suggestion: { type: "string" },
				},
				required: ["impact", "finding"],
			},
			run: (args) =>
				send(
					address,
					{
						type: "discover",
						workerId,
						token,
						impact: discoveryImpact(requireString(args, "impact")),
						finding: requireString(args, "finding"),
						suggestion: optionalString(args, "suggestion"),
					},
					"discovery recorded",
				),
		},
	];
	if (team)
		tools.push(
			{
				name: "neta_room_post",
				description: "Post a message to your room, visible to the other members. Only works if you are in a room.",
				inputSchema: {
					type: "object",
					properties: { message: { type: "string" } },
					required: ["message"],
				},
				run: (args) =>
					send(address, { type: "room-post", workerId, token, text: requireString(args, "message") }, "ok"),
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
		);
	tools.push({
		name: "neta_status",
		description: "Show writer status or the compact current goal. Writers remains the default for compatibility.",
		inputSchema: {
			type: "object",
			properties: { view: { type: "string", enum: ["writers", "goal"] } },
		},
		run: (args) => {
			const view = optionalString(args, "view") ?? "writers";
			if (view !== "writers" && view !== "goal") throw new Error('"view" must be writers or goal.');
			return view === "writers"
				? send(address, { type: "writer-status", workerId, token }, "(no writers)")
				: send(address, { type: "goal-status", workerId, token }, "No session goal initialized.");
		},
	});
	return tools;
}
