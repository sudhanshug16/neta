// Node-side entry point for Neta tools: resolve the actor,
// authorise, validate, dispatch, render. The stdio MCP proxy (T5.4) holds no
// state and forwards here over `tools.list` / `tools.call`.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionId, WorkspaceId } from "../core/types.ts";
import type { NodeStore } from "../node/server.ts";
import { reminder } from "./reminder.ts";
import { type JsonSchema, type ToolName, type ToolParams, toolsFor, validate } from "./schemas.ts";

export type Actor =
	| { kind: "leader"; workspaceId: WorkspaceId; sessionId: SessionId }
	| { kind: "lead" | "agent"; workspaceId: WorkspaceId; missionId: string; agentId: string; sessionId: SessionId };

export type ToolErrorCode =
	| "notAuthorised"
	| "badParams"
	| "notFound"
	| "refused"
	| "timeout"
	| "missingSkill"
	| "setupFailed"
	| "unavailable";

export type ToolResult =
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; code: ToolErrorCode; message: string };

export interface ToolDeps {
	store: NodeStore;
}

export interface ToolContext {
	actor: Actor;
	deps: ToolDeps;
}

export type ToolHandlers = {
	[N in ToolName]: (ctx: ToolContext, args: ToolParams[N]) => Promise<ToolResult>;
};

export interface TokenTable {
	mint(actorId: string): string;
	verify(actorId: string, token: string): boolean;
	revoke(actorId: string): void;
}

export interface McpTextBlock {
	type: "text";
	text: string;
}

export interface McpToolResponse {
	content: McpTextBlock[];
	structuredContent?: Record<string, unknown>;
	isError: boolean;
}

export interface SessionToolBridge {
	actorId: string;
	tools: Array<{ name: string; description: string; inputSchema: JsonSchema }>;
	call(name: string, args: unknown): Promise<McpToolResponse>;
}

// Memory only, never written to disk: a Node restart wipes the table, so a
// stale proxy fails closed with `notAuthorised`.
export function createTokenTable(): TokenTable {
	const tokens = new Map<string, string>();
	return {
		mint(actorId: string): string {
			const token = randomBytes(32).toString("hex");
			tokens.set(actorId, token);
			return token;
		},
		verify(actorId: string, token: string): boolean {
			const expected = tokens.get(actorId);
			if (expected === undefined || typeof token !== "string") {
				return false;
			}
			const a = Buffer.from(expected, "utf8");
			const b = Buffer.from(token, "utf8");
			return a.length === b.length && timingSafeEqual(a, b);
		},
		revoke(actorId: string): void {
			tokens.delete(actorId);
		},
	};
}

function resolveActor(store: NodeStore, actorId: string): Actor | undefined {
	for (const leader of store.listLeaders()) {
		if (leader.sessionId === actorId) {
			return { kind: "leader", workspaceId: leader.workspaceId, sessionId: leader.sessionId };
		}
	}
	// An agent's actor id is its `agentId`: the Node mints that session's
	// token under it, so the proxy's `--actor` is the agent id and nothing
	// else resolves here.
	const agent = store.getAgent(actorId);
	if (agent === undefined) {
		return undefined;
	}
	return {
		kind: agent.canSpawn ? "lead" : "agent",
		workspaceId: agent.workspaceId,
		missionId: agent.missionId,
		agentId: agent.id,
		sessionId: agent.sessionId,
	};
}

// A success answers compact JSON on the first line; a failure answers
// `error <code>: <message>`. Leader and lead responses then carry the
// open-mission reminder; an agent's never does.
async function render(actor: Actor, deps: ToolDeps, head: string, isError: boolean): Promise<McpToolResponse> {
	let text = head;
	if (actor.kind !== "agent") {
		const extra = reminder({ missions: deps.store.listMissions(actor.workspaceId) });
		if (extra !== "") {
			text += `\n${extra}`;
		}
	}
	return { content: [{ type: "text", text }], isError };
}

async function refused(deps: ToolDeps, actor: Actor | undefined, message: string): Promise<McpToolResponse> {
	if (actor !== undefined) {
		return render(actor, deps, `error notAuthorised: ${message}`, true);
	}
	return { content: [{ type: "text", text: `error notAuthorised: ${message}` }], isError: true };
}

export function createRouter(
	deps: ToolDeps,
	handlers: ToolHandlers,
	tokens: TokenTable,
	sessionTools?: SessionToolBridge | ((actorId: string) => SessionToolBridge | undefined),
): {
	list(
		actorId: string,
		token: string,
	): Array<{ name: string; description: string; inputSchema: JsonSchema }> | ToolResult;
	call(actorId: string, token: string, name: string, args: unknown): Promise<McpToolResponse>;
} {
	function authed(actorId: string, token: string): Actor | undefined {
		if (!tokens.verify(actorId, token)) {
			return undefined;
		}
		return resolveActor(deps.store, actorId);
	}
	const sessionBridge = (actorId: string): SessionToolBridge | undefined =>
		typeof sessionTools === "function"
			? sessionTools(actorId)
			: sessionTools?.actorId === actorId
				? sessionTools
				: undefined;

	return {
		list(
			actorId: string,
			token: string,
		): Array<{ name: string; description: string; inputSchema: JsonSchema }> | ToolResult {
			const bridge = sessionBridge(actorId);
			if (bridge)
				return tokens.verify(actorId, token)
					? bridge.tools
					: { ok: false, code: "notAuthorised", message: "bad token or unknown session tools actor" };
			const actor = authed(actorId, token);
			if (actor === undefined) {
				return { ok: false, code: "notAuthorised", message: "bad token or unknown actor" };
			}
			return toolsFor(actor.kind);
		},

		async call(actorId: string, token: string, name: string, args: unknown): Promise<McpToolResponse> {
			const bridge = sessionBridge(actorId);
			if (bridge) {
				if (!tokens.verify(actorId, token))
					return { content: [{ type: "text", text: "error notAuthorised: bad token" }], isError: true };
				if (!bridge.tools.some((tool) => tool.name === name))
					return {
						content: [{ type: "text", text: `error notAuthorised: no such session tool: ${name}` }],
						isError: true,
					};
				try {
					return await bridge.call(name, args);
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `error unavailable: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						isError: true,
					};
				}
			}
			const actor = authed(actorId, token);
			if (actor === undefined) {
				return refused(deps, undefined, "bad token or unknown actor");
			}
			const def = toolsFor(actor.kind).find((tool) => tool.name === name);
			if (def === undefined) {
				return refused(deps, actor, `no such tool for ${actor.kind}: ${name}`);
			}
			const checked = validate(def.name, args, actor.kind);
			if (!checked.ok) {
				return render(actor, deps, `error badParams: ${checked.message}`, true);
			}
			let result: ToolResult;
			try {
				const handler = handlers[def.name] as (ctx: ToolContext, handlerArgs: unknown) => Promise<ToolResult>;
				result = await handler({ actor, deps }, checked.value);
			} catch (error) {
				result = {
					ok: false,
					code: "unavailable",
					message: error instanceof Error ? error.message : String(error),
				};
			}
			if (result.ok) {
				const response = await render(actor, deps, JSON.stringify(result.data), false);
				if (result.data !== null && typeof result.data === "object" && !Array.isArray(result.data))
					response.structuredContent = result.data as Record<string, unknown>;
				return response;
			}
			return render(actor, deps, `error ${result.code}: ${result.message}`, true);
		},
	};
}
