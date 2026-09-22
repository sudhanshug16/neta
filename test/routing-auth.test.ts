import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectNode } from "../src/node/client.ts";
import { prepareDiagnosticsFromDisk } from "../src/node/handlers-diagnostics.ts";
import { allHandlers } from "../src/node/lifecycle.ts";
import { createServer, type NodeContext } from "../src/node/server.ts";
import { type RoutingAuthStatus, routingAuthStatus, routingCredential, saveRoutingKey } from "../src/routing/auth.ts";
import { createModelRouter } from "../src/routing/router.ts";

const roots: string[] = [];
const previousDirectory = process.env.NETA_DIR;
const previousKey = process.env.TYPESAFE_API_KEY;
afterEach(async () => {
	if (previousDirectory === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = previousDirectory;
	if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
	else process.env.TYPESAFE_API_KEY = previousKey;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
	const root = await mkdtemp(join(tmpdir(), "neta-key-"));
	roots.push(root);
	return root;
}

test("private saved keys replace environment keys and are refreshed for each delegation", async () => {
	const root = await directory();
	delete process.env.TYPESAFE_API_KEY;
	expect(await routingAuthStatus(root)).toEqual({ configured: false, source: "none" });
	process.env.TYPESAFE_API_KEY = "fixture-environment-key";
	expect(await routingAuthStatus(root)).toEqual({ configured: true, source: "environment" });
	const authorization: string[] = [];
	const route = createModelRouter({
		apiKey: async () => (await routingCredential(root)).key,
		catalog: {
			load: async () => ({
				snapshot: {
					version: 1,
					fetchedAt: Date.now(),
					models: [{ id: "test/small", name: "Small", tools: true, context: 32768 }],
				},
				warnings: [],
			}),
		},
		fetcher: Object.assign(
			async (_url: string | URL | Request, init?: RequestInit) => {
				authorization.push(new Headers(init?.headers).get("Authorization") ?? "");
				return Response.json({
					model: "fixture",
					answers: {
						model: {
							type: "choice",
							choice: "candidate_0",
							confidence: 1,
							probabilities: { candidate_0: 1, none: 0 },
						},
					},
				});
			},
			{ preconnect() {} },
		),
	});
	const task = { task: "Check", objective: "Test", effort: 1 as const };
	await route(task, [{ id: "test/small" }]);
	await saveRoutingKey(root, " fixture-saved-key ");
	await route(task, [{ id: "test/small" }]);
	await saveRoutingKey(root, "fixture-replacement-key");
	const decision = await route(task, [{ id: "test/small" }]);
	expect(authorization).toEqual([
		"Bearer fixture-environment-key",
		"Bearer fixture-saved-key",
		"Bearer fixture-replacement-key",
	]);
	expect(JSON.stringify(decision)).not.toContain("fixture-replacement-key");
	expect(await routingAuthStatus(root)).toEqual({ configured: true, source: "saved" });
	expect((await stat(join(root, "routing-auth.json"))).mode & 0o777).toBe(0o600);
	expect((await stat(root)).mode & 0o777).toBe(0o700);
	expect(await readdir(root)).toEqual(["routing-auth.json"]);
});

test("malformed files and rejected saves never echo secrets and can be repaired", async () => {
	const root = await directory();
	process.env.TYPESAFE_API_KEY = "fixture-env";
	await writeFile(join(root, "routing-auth.json"), "fixture-private-broken-json");
	await expect(routingCredential(root)).rejects.toThrow("saved Jev key is unreadable");
	expect(JSON.stringify(await routingAuthStatus(root))).not.toContain("fixture-private");
	for (const key of ["", "fixture-secret\ninvalid", "x".repeat(4097)]) {
		await expect(saveRoutingKey(root, key)).rejects.toThrow("Enter a Jev API key");
	}
	expect(await readFile(join(root, "routing-auth.json"), "utf8")).toBe("fixture-private-broken-json");
	await saveRoutingKey(root, "fixture-repaired");
	expect((await routingCredential(root)).key).toBe("fixture-repaired");
});

test("saving replaces a linked credential file without modifying its target", async () => {
	const root = await directory();
	const outside = join(root, "outside.json");
	await writeFile(outside, "unchanged");
	await symlink(outside, join(root, "routing-auth.json"));
	await expect(routingCredential(root)).rejects.toThrow("Cannot read");
	await saveRoutingKey(root, "fixture-new-key");
	expect(await readFile(outside, "utf8")).toBe("unchanged");
	expect((await routingCredential(root)).key).toBe("fixture-new-key");
});

test("failed storage is reported safely and leaves no temporary secret", async () => {
	const root = await directory();
	await mkdir(join(root, "routing-auth.json"));
	await expect(saveRoutingKey(root, "fixture-unwritable-secret")).rejects.toThrow("Could not save the Jev key");
	expect(await readdir(root)).toEqual(["routing-auth.json"]);
});

test("authenticated operator RPC saves on the service machine; tools and diagnostics cannot retrieve it", async () => {
	const root = await directory();
	process.env.NETA_DIR = root;
	delete process.env.TYPESAFE_API_KEY;
	const socket = join(root, "node.sock");
	const server = await createServer({
		socketPath: socket,
		token: "fixture-token",
		handlers: allHandlers,
		ctx: {
			store: {
				machine: () => ({ id: "machine", name: "Remote fixture" }),
				listAgents: () => [
					{
						id: "lead",
						workspaceId: "w",
						missionId: "m",
						name: "Mira",
						state: "running",
						startedAt: "2026-09-21",
						routing: { method: "jev" },
					},
					{
						id: "archived",
						workspaceId: "w",
						missionId: "old",
						name: "Cove",
						state: "archived",
						startedAt: "2026-09-20",
						routing: { method: "fixed" },
					},
					{ id: "other", workspaceId: "other", startedAt: "2026-09-21", routing: { method: "jev" } },
					{ id: "unrouted", workspaceId: "w", startedAt: "2026-09-21" },
				],
				listEvents: async ({ cursor }: { cursor: string }) =>
					cursor === "0"
						? {
								events: [{ kind: "agent.modelChanged", agentId: "lead", data: { model: "new" } }],
								nextCursor: "1",
							}
						: { events: [{ kind: "agent.idle" }] },
				listMissions: (workspaceId: string) => [{ id: "m", workspaceId, number: 22 }],
			},
			nodeVersion: "test",
		} as unknown as Omit<NodeContext, "hub">,
	});
	await writeFile(
		join(root, "node.json"),
		JSON.stringify({
			socket,
			token: "fixture-token",
			pid: process.pid,
			protocolVersion: 3,
			startedAt: new Date().toISOString(),
		}),
	);
	await writeFile(join(root, "machine.json"), JSON.stringify({ id: "machine", name: "Remote fixture" }));
	const client = await connectNode({ dir: root });
	const tools = await connectNode({ dir: root, client: "tools" });
	try {
		expect(await client.request<RoutingAuthStatus>("routing.auth.status")).toEqual({
			configured: false,
			source: "none",
		});
		expect(await client.request<RoutingAuthStatus>("routing.auth.save", { apiKey: "fixture-rpc-secret" })).toEqual({
			configured: true,
			source: "saved",
		});
		expect(await client.request<RoutingAuthStatus>("routing.auth.status")).toEqual({
			configured: true,
			source: "saved",
		});
		await expect(tools.request("routing.auth.save", { apiKey: "fixture-agent-secret" })).rejects.toThrow(
			"Configure routing through the Neta UI",
		);
		await expect(tools.request("routing.auth.status")).rejects.toThrow("Configure routing through the Neta UI");
		const logs = await client.request<{
			changes: { agentId: string }[];
			agents: { id: string }[];
			missions: { number: number }[];
		}>("routing.logs", { workspaceId: "w" });
		expect(logs.agents.map((agent) => agent.id)).toEqual(["archived", "lead"]);
		expect(logs.missions[0].number).toBe(22);
		expect(logs.changes.map((event) => event.agentId)).toEqual(["lead"]);
		await expect(tools.request("routing.logs", { workspaceId: "w" })).rejects.toThrow(
			"View routing through the Neta UI",
		);
		expect((await routingCredential(root)).key).toBe("fixture-rpc-secret");
		const exported = await prepareDiagnosticsFromDisk({ root, liveSnapshot: false });
		expect(JSON.stringify(exported.manifest)).not.toContain("routing-auth");
		expect(await readdir(join(exported.path, "data"))).not.toContain("routing-auth.json");
	} finally {
		await client.close();
		await tools.close();
		await server.close();
	}
});
