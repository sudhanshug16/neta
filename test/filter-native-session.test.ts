import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMeStore } from "../src/me/store.ts";
import { conversationHandlers, sessionSystemContext } from "../src/node/handlers-conversation.ts";
import { filterSessionIds, openFilterSession } from "../src/node/handlers-me.ts";
import { adaptStore } from "../src/node/lifecycle.ts";
import type { Connection, NodeContext, NodeRuntime, SessionRequest } from "../src/node/server.ts";
import type { OpenCodeAttachment } from "../src/opencode/attachment.ts";
import { openStore } from "../src/store/index.ts";

const original = process.env.NETA_DIR;
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	if (original === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = original;
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "neta-filter-native-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	process.env.NETA_DIR = dir;
	const real = await openStore();
	const store = await adaptStore(real);
	const workspace = {
		id: "w",
		name: "Workspace",
		kind: "folder" as const,
		roots: [{ machineId: store.machine().id, path: dir }],
		createdAt: new Date().toISOString(),
	};
	await store.putWorkspace(workspace);
	const creates: SessionRequest[] = [];
	const restores: Array<SessionRequest & { forceRelaunch?: boolean }> = [];
	const sends: { id: string; text: string }[] = [];
	const cancels: string[] = [];
	let model = "openai/gpt-6-luna";
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ id: "native-filter", title: "Filter", messages: ["Existing classification"] }),
	});
	cleanup.push(() => upstream.stop(true));
	const attachment: OpenCodeAttachment = {
		url: upstream.url.origin,
		authorization: "Basic fixture",
		sessionId: "native-filter",
		directory: dir,
		apiVersion: 2,
	};
	const runtime = {
		createSession: async (request: SessionRequest) => {
			expect(filterSessionIds.has(request.sessionId ?? "")).toBe(true);
			creates.push(request);
			return { sessionId: request.sessionId ?? "", provider: request.provider, model: request.model };
		},
		ensureSession: async (request: SessionRequest) => {
			restores.push(request);
			return { sessionId: request.sessionId ?? "", provider: request.provider, model: request.model };
		},
		runtimeDiagnostics: async () => ({ model }),
		nativeAttachment: () => attachment,
		send: async (id: string, text: string) => {
			sends.push({ id, text });
			return { id: "message", status: "queued" };
		},
		cancel: async (id: string) => {
			cancels.push(id);
		},
		setModel: async (_id: string, next: string) => {
			model = next;
		},
	} as unknown as NodeRuntime;
	const ctx = { store, runtime, hub: { broadcast() {} } } as unknown as NodeContext;
	cleanup.push(async () => {
		for (const entry of await openMeStore().listFilterIdentities()) filterSessionIds.delete(entry.sessionId);
	});
	return { ctx, creates, restores, sends, cancels };
}

test("filter UI and classifier share one saved native session without prompting on open", async () => {
	const { ctx, creates, restores, sends } = await fixture();
	const [first, simultaneous] = await Promise.all([openFilterSession(ctx, "w"), openFilterSession(ctx, "w")]);
	expect(first.sessionId).toBe(simultaneous.sessionId);
	expect(creates).toHaveLength(1);
	expect(creates[0]).toMatchObject({ access: "readOnly", netaTools: true, unsandboxed: false });
	const reopened = await openFilterSession(ctx, "w");
	expect(reopened.sessionId).toBe(first.sessionId);
	expect(restores.at(-1)).toMatchObject({ sessionId: first.sessionId, allowFresh: false });
	expect(sends).toEqual([]);
	expect(await sessionSystemContext({ store: ctx.store, filterSessionIds }, first.sessionId)).toContain(
		"filter between the Coordinator and Workspace leader",
	);
});

test("a saved Filter chat relaunches once to gain its MCP tool", async () => {
	const { ctx, restores } = await fixture();
	const store = openMeStore();
	await store.markFilterRuntimeInitialized("w");
	const identity = await openFilterSession(ctx, "w");
	expect(restores[0]).toMatchObject({
		sessionId: identity.sessionId,
		netaTools: true,
		forceRelaunch: true,
	});
	expect((await store.filterIdentity("w")).toolsEnabled).toBe(true);
	await openFilterSession(ctx, "w");
	expect(restores.at(-1)?.forceRelaunch).toBe(false);
});

test("filter native chat reads its session and uses ordinary message and cancel delivery", async () => {
	const { ctx, sends, cancels } = await fixture();
	const identity = await openFilterSession(ctx, "w");
	const conn: Connection = {
		id: "filter-ui",
		client: "cli",
		send() {},
		tailed: new Set(),
		close() {},
		onClose: (close) => {
			cleanup.push(close);
		},
	};
	const gateway = (await conversationHandlers["conversation.native"]?.(
		ctx,
		{ sessionId: identity.sessionId },
		conn,
	)) as OpenCodeAttachment;
	const request = (path: string, method = "GET", body?: unknown) =>
		fetch(`${gateway.url}${path}`, {
			method,
			headers: { authorization: gateway.authorization, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	expect((await request("/api/session/native-filter")).status).toBe(200);
	expect(sends).toEqual([]);
	const body = {
		id: "user-message",
		text: "Explain this decision",
		model: { providerID: "openai", modelID: "gpt-6-luna" },
	};
	expect((await request("/api/session/native-filter/neta-prompt", "POST", body)).status).toBe(200);
	expect(sends).toHaveLength(1);
	expect(sends[0]?.id).toBe(identity.sessionId);
	expect(sends[0]?.text).toContain("Explain this decision");
	expect((await request("/api/session/native-filter/abort", "POST", {})).status).toBe(200);
	expect(cancels).toEqual([identity.sessionId]);
});

test("resetting the filter changes only its native session and retains the saved workspace leader", async () => {
	const { ctx } = await fixture();
	const me = openMeStore();
	const leader = await me.workspaceLeaderIdentity("w");
	const filter = await openFilterSession(ctx, "w");
	ctx.runtime.resetSession = async (sessionId, brief, rebind) => {
		expect(sessionId).toBe(filter.sessionId);
		expect(brief).toContain("filter between the Coordinator and Workspace leader");
		const next = { sessionId: "next-filter", provider: "opencode", model: "openai/gpt-6-luna" };
		await rebind(next);
		return next;
	};
	await conversationHandlers["conversation.reset"]?.(ctx, { sessionId: filter.sessionId }, {} as Connection);
	expect((await me.filterIdentity("w")).sessionId).toBe("next-filter");
	expect((await me.workspaceLeaderIdentity("w")).sessionId).toBe(leader.sessionId);
});
