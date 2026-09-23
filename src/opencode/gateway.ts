import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename } from "node:path";
import { Readable } from "node:stream";
import type { PromptAttachment } from "../core/types.ts";
import type { OpenCodeAttachment } from "./attachment.ts";

export interface NativePrompt {
	messageId?: string;
	messageHash?: string;
	text: string;
	attachments: PromptAttachment[];
	model?: string;
	variant?: string;
	agent?: string;
}

export interface GatewayOptions {
	attachment: OpenCodeAttachment;
	isCurrent(): boolean;
	prompt(input: NativePrompt): Promise<unknown>;
	cancel(): Promise<unknown>;
	configure?(input: Pick<NativePrompt, "model" | "variant" | "agent">): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object");
	return value as Record<string, unknown>;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.from(chunk);
		size += bytes.length;
		if (size > 7 * 1024 * 1024) throw new Error("Message is too large (7 MiB maximum)");
		chunks.push(bytes);
	}
	return Buffer.concat(chunks);
}

export async function nativePrompt(value: unknown): Promise<NativePrompt> {
	const input = record(value);
	const text: string[] = [];
	const attachments: PromptAttachment[] = [];
	if (!Array.isArray(input.parts)) throw new Error("Message needs parts");
	for (const raw of input.parts) {
		const part = record(raw);
		if (part.type === "text" && typeof part.text === "string") {
			text.push(part.text);
			continue;
		}
		if (part.type !== "file" || typeof part.url !== "string" || typeof part.mime !== "string")
			throw new Error(`Unsupported message attachment: ${String(part.type)}`);
		const url = new URL(part.url);
		let bytes: Buffer;
		if (url.protocol === "data:") {
			const comma = part.url.indexOf(",");
			if (!part.url.slice(0, comma).endsWith(";base64")) throw new Error("Attachment needs base64 encoding");
			bytes = Buffer.from(part.url.slice(comma + 1), "base64");
		} else if (url.protocol === "file:") {
			bytes = await readFile(url);
		} else throw new Error("Attachments must be a selected file or embedded data");
		if (bytes.length > 4 * 1024 * 1024) throw new Error("An attachment exceeds 4 MiB");
		attachments.push({
			id: typeof part.id === "string" ? part.id : `attachment-${attachments.length}`,
			kind: part.mime.startsWith("image/") ? "image" : "file",
			name: typeof part.filename === "string" ? part.filename : basename(url.pathname) || "attachment",
			mimeType: part.mime,
			dataBase64: bytes.toString("base64"),
		});
	}
	const model = input.model === undefined ? undefined : record(input.model);
	if (model && (typeof model.providerID !== "string" || typeof model.modelID !== "string"))
		throw new Error("Invalid model");
	return {
		text: text.join("\n\n"),
		attachments,
		...(model ? { model: `${model.providerID}/${model.modelID}` } : {}),
		...(typeof input.variant === "string" ? { variant: input.variant } : {}),
		...(typeof input.agent === "string" ? { agent: input.agent } : {}),
	};
}

/** The renderer can read native data; all agent turns still enter through Neta. */
export async function startOpenCodeGateway(options: GatewayOptions): Promise<OpenCodeAttachment & { close(): void }> {
	const authorization = `Basic ${Buffer.from(`opencode:${randomBytes(32).toString("hex")}`).toString("base64")}`;
	const attachment = options.attachment;
	const sessionPath = `${attachment.apiVersion === 2 ? "/api" : ""}/session/${attachment.sessionId}`;
	const pending = new Map<string, { body: string; result: Promise<unknown> }>();
	const abort = new AbortController();
	const json = (response: ServerResponse, status: number, value: unknown): void => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(value));
	};
	const server = createServer((request, response) => {
		void (async () => {
			if (request.headers.authorization !== authorization)
				return json(response, 401, { name: "Unauthorized", data: { message: "Reconnect to Neta" } });
			if (!options.isCurrent())
				return json(response, 409, {
					name: "SessionReplaced",
					data: { message: "This conversation was replaced. Reopen its tab." },
				});
			const url = new URL(request.url ?? "/", attachment.url);
			const method = request.method ?? "GET";
			if (url.origin !== new URL(attachment.url).origin) throw new Error("Invalid runtime request");
			// A per-session runtime is isolated from other actors even in the same worktree.
			if (
				/^\/(?:api\/)?session\/[^/]+/.test(url.pathname) &&
				!url.pathname.startsWith(`${sessionPath}/`) &&
				url.pathname !== sessionPath &&
				!(attachment.apiVersion === 2 && ["/api/session/active", "/api/session/stats"].includes(url.pathname))
			)
				throw new Error("This tab belongs to a different session");
			const body = await readBody(request);
			if (attachment.apiVersion === 2 && method === "POST") {
				const input = body.length ? record(JSON.parse(body.toString("utf8"))) : {};
				if (url.pathname === `${sessionPath}/model` || url.pathname === `${sessionPath}/agent`) {
					if (!options.configure) throw new Error("Native settings are unavailable");
					const model = input.model === undefined ? undefined : record(input.model);
					await options.configure({
						...(model
							? {
									model: `${model.providerID}/${model.id}`,
									variant: typeof model.variant === "string" ? model.variant : undefined,
								}
							: {}),
						...(typeof input.agent === "string" ? { agent: input.agent } : {}),
					});
					response.writeHead(204);
					return response.end();
				}
				if (url.pathname === `${sessionPath}/interrupt`) {
					await options.cancel();
					return json(response, 200, { interrupted: true });
				}
				if (url.pathname === `${sessionPath}/neta-prompt`) {
					if (Array.isArray(input.agents) && input.agents.length)
						throw new Error("Use Neta missions to delegate work");
					const key = typeof input.id === "string" ? input.id : randomBytes(16).toString("hex");
					const previous = pending.get(key);
					if (previous && previous.body !== body.toString("utf8"))
						throw new Error("Message ID was reused with different content");
					if (!previous && pending.size >= 1000)
						throw new Error("Reconnect this view before sending more messages");
					const result =
						previous?.result ??
						options.prompt({
							text: typeof input.text === "string" ? input.text : "",
							attachments: [
								{
									id: "opencode-prompt",
									kind: "file",
									name: "opencode-prompt.json",
									mimeType: "application/vnd.neta.opencode-prompt+json",
									dataBase64: body.toString("base64"),
								},
							],
							messageId: `${attachment.sessionId}:${key}`,
							messageHash: createHash("sha256").update(body).digest("hex"),
						});
					pending.set(key, { body: body.toString("utf8"), result });
					return json(response, 200, await result);
				}
			}
			if (
				method === "POST" &&
				(url.pathname === `${sessionPath}/message` || url.pathname === `${sessionPath}/prompt_async`)
			) {
				const input = record(JSON.parse(body.toString("utf8")));
				const key = typeof input.messageID === "string" ? input.messageID : randomBytes(16).toString("hex");
				const previous = pending.get(key);
				if (previous && previous.body !== body.toString("utf8"))
					throw new Error("Message ID was reused with different content");
				if (!previous && pending.size >= 1000) throw new Error("Reconnect this view before sending more messages");
				const result =
					previous?.result ??
					nativePrompt(input).then((prompt) =>
						options.prompt({
							...prompt,
							messageId: `${attachment.sessionId}:${key}`,
							messageHash: createHash("sha256").update(body).digest("hex"),
						}),
					);
				pending.set(key, { body: body.toString("utf8"), result });
				await result;
				return json(response, 200, { info: { id: key, sessionID: attachment.sessionId }, parts: [] });
			}
			if (method === "POST" && url.pathname === `${sessionPath}/abort`) {
				await options.cancel();
				return json(response, 200, true);
			}
			if (method !== "GET" && method !== "HEAD") {
				const auth = /^\/(auth\/[^/]+|provider\/[^/]+\/oauth\/(authorize|callback))$/.test(url.pathname);
				const question = /^\/question\/[^/]+\/(reply|reject)$/.test(url.pathname);
				const rename =
					method === "PATCH" &&
					url.pathname === sessionPath &&
					Object.keys(record(JSON.parse(body.toString("utf8")))).every((key) => key === "title");
				const mcpControl = /^\/api\/mcp\/([^/]+)\/(connect|disconnect)$/.exec(url.pathname);
				if (
					attachment.apiVersion === 2 &&
					method === "POST" &&
					mcpControl?.[2] === "disconnect" &&
					decodeURIComponent(mcpControl[1] ?? "") === "neta"
				)
					throw new Error("Neta manages this connection. Use /reconnect to restore it.");
				const v2Write =
					attachment.apiVersion === 2 &&
					((method === "POST" && mcpControl !== null) ||
						/^\/api\/(credential\/[^/]+(?:\/activate)?|integration\/[^/]+\/connect\/(?:key|oauth|command)(?:\/[^/]+(?:\/callback)?)?)$/.test(
							url.pathname,
						) ||
						(method === "POST" &&
							url.pathname.startsWith(`${sessionPath}/`) &&
							/\/(?:permission\/[^/]+\/reply|form\/[^/]+\/(?:reply|cancel)|view|rename)$/.test(url.pathname)));
				if (!auth && !question && !rename && !v2Write)
					throw new Error(
						"This action must use Neta's session controls. Use /reset to start a fresh conversation.",
					);
			}
			if (attachment.apiVersion !== 2) url.searchParams.set("directory", attachment.directory);
			const upstream = await fetch(url, {
				method,
				headers: {
					Authorization: attachment.authorization,
					"content-type": request.headers["content-type"] ?? "application/json",
				},
				...(body.length ? { body } : {}),
				signal: abort.signal,
				redirect: "error",
			});

			if (
				attachment.apiVersion === 2 &&
				method === "GET" &&
				upstream.ok &&
				["/api/session", "/api/session/active"].includes(url.pathname)
			) {
				const result = record(await upstream.json());
				const data = result.data;
				return json(response, 200, {
					...result,
					...(Array.isArray(data)
						? { data: data.filter((session) => record(session).id === attachment.sessionId) }
						: {}),
				});
			}
			if (url.pathname === "/session" && method === "GET" && upstream.ok) {
				const sessions: unknown = await upstream.json();
				return json(
					response,
					200,
					Array.isArray(sessions)
						? sessions.filter((session) => record(session).id === attachment.sessionId)
						: sessions,
				);
			}
			response.writeHead(upstream.status, {
				"content-type": upstream.headers.get("content-type") ?? "application/json",
			});
			if (!upstream.body) return response.end();
			const stream = Readable.fromWeb(upstream.body);
			response.once("close", () => stream.destroy());
			stream.on("error", () => response.destroy());
			stream.pipe(response);
		})().catch((error: unknown) => {
			if (response.headersSent) return response.destroy();
			json(response, 400, {
				name: "NetaError",
				data: { message: error instanceof Error ? error.message : String(error) },
			});
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Native chat listener did not start");
	return {
		...attachment,
		url: `http://127.0.0.1:${address.port}`,
		authorization,
		close: () => {
			abort.abort();
			server.closeAllConnections();
			server.close();
		},
	};
}
