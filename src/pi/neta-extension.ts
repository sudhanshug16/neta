import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
	const descriptorPath = process.env.NETA_DESCRIPTOR;
	const actorId = process.env.NETA_ACTOR_ID;
	const actorToken = process.env.NETA_ACTOR_TOKEN;
	if (descriptorPath === undefined || actorId === undefined || actorToken === undefined)
		throw new Error("Neta extension credentials are missing");
	const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as {
		socket: string;
		token: string;
		protocolVersion: number;
	};
	return new Promise((resolve, reject) => {
		const socket = createConnection(descriptor.socket);
		let buffer = "";
		let settled = false;
		const id = 2;
		const finish = (error?: Error, result?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error !== undefined) reject(error);
			else resolve(result);
		};
		const timer = setTimeout(() => finish(new Error(`Neta ${method} timed out`)), 30_000);
		socket.on("connect", () =>
			socket.write(
				`${JSON.stringify({ id: 1, method: "hello", params: { token: descriptor.token, protocolVersion: descriptor.protocolVersion, client: "cli" } })}\n`,
			),
		);
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			if (buffer.length > 4 * 1024 * 1024) return finish(new Error("Neta response exceeds 4 MiB"));
			for (;;) {
				const at = buffer.indexOf("\n");
				if (at < 0) return;
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
				if (message.id === 1 && message.error !== undefined) return finish(new Error(message.error.message));
				if (message.id === 1)
					socket.write(`${JSON.stringify({ id, method, params: { ...params, actorId, token: actorToken } })}\n`);
				if (message.id === id) {
					if (message.error) finish(new Error(message.error.message));
					else finish(undefined, message.result);
				}
			}
		});
		socket.on("end", () => finish(new Error("Neta connection ended before a response")));
		socket.on("error", (error) => finish(error));
	});
}

export default async function neta(pi: ExtensionAPI) {
	let initialPromptSent = false;
	pi.on("session_start", () => {
		const prompt = process.env.NETA_INITIAL_PROMPT;
		if (!initialPromptSent && prompt !== undefined) {
			initialPromptSent = true;
			pi.sendUserMessage(prompt, { expandPromptTemplates: true });
		}
	});
	const listed = (await request("tools.list", {})) as {
		tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
	};
	for (const tool of listed.tools)
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: Type.Unsafe(tool.inputSchema),
			async execute(_id, params) {
				const result = (await request("tools.call", { name: tool.name, arguments: params })) as {
					content: Array<{ type: "text"; text: string }>;
					isError: boolean;
				};
				if (result.isError) throw new Error(result.content.map((item) => item.text).join("\n"));
				return { content: result.content, details: {} };
			},
		});
}
