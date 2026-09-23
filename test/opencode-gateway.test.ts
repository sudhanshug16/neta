import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeEndpointReady, openCodeEndpoint } from "../src/opencode/attachment.ts";
import { type NativePrompt, nativePrompt, startOpenCodeGateway } from "../src/opencode/gateway.ts";
import { openConversationInboxStore } from "../src/store/conversation-inbox.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});

test("native endpoint rejects remote origins and unauthenticated adapters", () => {
	expect(openCodeEndpoint({})).toBeUndefined();
	expect(() =>
		openCodeEndpoint({ "neta.opencode": { url: "https://example.com", authorization: "Basic fixture" } }),
	).toThrow();
	expect(() => openCodeEndpoint({ "neta.opencode": { url: "http://127.0.0.1:123", authorization: "" } })).toThrow();
});

test("attachment translation preserves text, image bytes, model and effort", async () => {
	expect(
		await nativePrompt({
			model: { providerID: "test", modelID: "model" },
			variant: "high",
			agent: "plan",
			parts: [
				{ type: "text", text: "Look" },
				{ type: "file", mime: "image/png", filename: "one.png", url: "data:image/png;base64,aGVsbG8=" },
			],
		}),
	).toMatchObject({
		text: "Look",
		model: "test/model",
		variant: "high",
		agent: "plan",
		attachments: [{ name: "one.png", dataBase64: "aGVsbG8=", kind: "image" }],
	});
	expect(
		nativePrompt({ parts: [{ type: "file", mime: "text/plain", url: "https://example.com/file" }] }),
	).rejects.toThrow("Attachments must");
});

test("gateway scopes reads, routes turns through Neta, and rejects stale attachments", async () => {
	const reads: { path: string; directory: string | null; auth: string | null }[] = [];
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			reads.push({
				path: url.pathname,
				directory: url.searchParams.get("directory"),
				auth: request.headers.get("authorization"),
			});
			return Response.json(url.pathname === "/session" ? [{ id: "own" }, { id: "other" }] : { ok: true });
		},
	});
	cleanup.push(() => upstream.stop(true));
	let current = true;
	let prompts = 0;
	let cancels = 0;
	const gateway = await startOpenCodeGateway({
		attachment: {
			url: upstream.url.origin,
			authorization: "Basic upstream",
			sessionId: "own",
			directory: "/project",
		},
		isCurrent: () => current,
		prompt: async () => {
			prompts++;
			return {};
		},
		cancel: async () => {
			cancels++;
		},
	});
	cleanup.push(gateway.close);
	const request = (path: string, method = "GET", body?: unknown) =>
		fetch(`${gateway.url}${path}`, {
			method,
			headers: { Authorization: gateway.authorization, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	expect((await fetch(gateway.url)).status).toBe(401);
	expect(await (await request("/session?directory=/wrong")).json()).toEqual([{ id: "own" }]);
	expect(reads[0]).toEqual({ path: "/session", directory: "/project", auth: "Basic upstream" });
	expect((await request("/session/other")).status).toBe(400);
	expect((await request("/session", "POST", {})).status).toBe(400);
	const body = { messageID: "msg_1", parts: [{ type: "text", text: "hello" }] };
	const responses = await Promise.all([
		request("/session/own/message", "POST", body),
		request("/session/own/message", "POST", body),
	]);
	expect(responses.map((response) => response.status)).toEqual([200, 200]);
	expect(prompts).toBe(1);
	expect(
		(await request("/session/own/message", "POST", { ...body, parts: [{ type: "text", text: "changed" }] })).status,
	).toBe(400);
	await request("/session/own/abort", "POST", {});
	expect(cancels).toBe(1);
	expect(reads).toHaveLength(1);
	current = false;
	expect((await request("/session/own")).status).toBe(409);
});

test("native attachment readiness rejects dead endpoints and missing sessions", async () => {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (request) =>
			new Response("{}", {
				status:
					new URL(request.url).pathname === "/session/alive" &&
					request.headers.get("Authorization") === "Basic fixture"
						? 200
						: 404,
			}),
	});
	const attachment = {
		url: server.url.origin,
		authorization: "Basic fixture",
		sessionId: "alive",
		directory: "/fixture",
	};
	try {
		expect(await nativeEndpointReady(attachment)).toBe(true);
		expect(await nativeEndpointReady({ ...attachment, sessionId: "missing" })).toBe(false);
	} finally {
		await server.stop(true);
	}
	expect(await nativeEndpointReady(attachment)).toBe(false);
});

test("V2 gateway admits once through Node and preserves V2 settings and permission boundaries", async () => {
	const paths: string[] = [];
	const upstream = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			paths.push(new URL(request.url).pathname);
			return new Response(null, { status: 204 });
		},
	});
	cleanup.push(() => upstream.stop(true));
	let sends = 0;
	const prompts: NativePrompt[] = [];
	const settings: unknown[] = [];
	const gateway = await startOpenCodeGateway({
		attachment: {
			url: upstream.url.origin,
			authorization: "Basic fixture",
			apiVersion: 2,
			sessionId: "ses_owned",
			directory: "/project",
		},
		isCurrent: () => true,
		prompt: async (input) => {
			prompts.push(input);
			sends++;
			return { messageId: "neta_message" };
		},
		configure: async (input) => {
			settings.push(input);
		},
		cancel: async () => ({}),
	});
	cleanup.push(gateway.close);
	const request = (path: string, body: unknown = {}, method = "POST") =>
		fetch(`${gateway.url}${path}`, {
			method,
			headers: { Authorization: gateway.authorization, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const route = "/api/session/ses_owned";
	const message = {
		id: "repeat",
		text: "hello @typesafe-ai",
		skills: [{ id: "typesafe-ai", mention: { start: 6, end: 18, text: "@typesafe-ai" } }],
		files: [{ uri: "file:///tmp/selected.txt", name: "selected.txt", mention: { start: 0, end: 5, text: "hello" } }],
	};
	expect((await request(`${route}/neta-prompt`, message)).status).toBe(200);
	expect((await request(`${route}/neta-prompt`, message)).status).toBe(200);
	expect(sends).toBe(1);
	const payload = prompts[0]?.attachments[0]?.dataBase64;
	expect(payload).toBeDefined();
	expect(JSON.parse(Buffer.from(payload ?? "", "base64").toString())).toEqual(message);
	expect((await request(`${route}/neta-prompt`, { ...message, text: "different" })).status).toBe(400);
	expect(
		(await request(`${route}/model`, { model: { providerID: "test", id: "model", variant: "high" } })).status,
	).toBe(204);
	expect(settings).toEqual([{ model: "test/model", variant: "high" }]);
	for (const path of [
		`${route}/prompt`,
		`${route}/fork`,
		`${route}/shell`,
		"/api/plugin/update",
		"/api/session/ses_other/permission/per_1/reply",
	])
		expect((await request(path)).status).toBe(400);
	expect((await request(`${route}/permission/rules`, { permissions: [] }, "PUT")).status).toBe(400);
	expect((await request(`${route}/permission/per_1/reply`, { reply: "once" })).status).toBe(204);
	expect((await request("/api/integration/test/connect/key", { key: "fixture" })).status).toBe(204);
	expect((await request("/api/mcp/paper/connect")).status).toBe(204);
	expect((await request("/api/mcp/paper/disconnect")).status).toBe(204);
	expect((await request("/api/mcp/neta/disconnect")).status).toBe(400);
	expect((await request("/api/mcp/paper", {}, "PUT")).status).toBe(400);
	expect(paths).toEqual([
		`${route}/permission/per_1/reply`,
		"/api/integration/test/connect/key",
		"/api/mcp/paper/connect",
		"/api/mcp/paper/disconnect",
	]);
});

test("native message retry after replacing the gateway reuses its durable inbox receipt", async () => {
	const saved = process.env.NETA_DIR;
	const directory = await mkdtemp(join(tmpdir(), "neta-gateway-receipt-"));
	process.env.NETA_DIR = directory;
	const attachment = {
		url: "http://127.0.0.1:1",
		authorization: "Basic fixture",
		sessionId: "vendor-session",
		directory,
	};
	let admitted = 0;
	const gateways: Awaited<ReturnType<typeof startOpenCodeGateway>>[] = [];
	try {
		const send = async (body: unknown) => {
			const inbox = openConversationInboxStore();
			const gateway = await startOpenCodeGateway({
				attachment,
				isCurrent: () => true,
				cancel: async () => {},
				prompt: async (input) => {
					const receipt = await inbox.enqueue("neta-session", input.text, input.attachments, {
						readerDirected: true,
						sourceId: `user:${input.messageId}`,
						sourceHash: input.messageHash,
					});
					if (receipt.status === "queued") {
						admitted++;
						await inbox.markDelivered("neta-session", receipt.id, "parent-turn");
					}
					return receipt;
				},
			});
			gateways.push(gateway);
			const response = await fetch(`${gateway.url}/session/vendor-session/message`, {
				method: "POST",
				headers: { Authorization: gateway.authorization, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			gateway.close();
			return response.status;
		};
		const body = { messageID: "same-message", parts: [{ type: "text", text: "once" }] };
		expect(await send(body)).toBe(200);
		expect(await send(body)).toBe(200);
		expect(admitted).toBe(1);
		expect(await send({ ...body, parts: [{ type: "text", text: "changed" }] })).toBe(400);
		expect(admitted).toBe(1);
	} finally {
		for (const gateway of gateways) gateway.close();
		if (saved === undefined) delete process.env.NETA_DIR;
		else process.env.NETA_DIR = saved;
		await rm(directory, { recursive: true, force: true });
	}
});
