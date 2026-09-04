// Node-side entry point for the thirteen Neta tools: resolve the actor,
// authorise, validate, dispatch, render. The stdio MCP proxy (T5.4) holds no
// state and forwards here over `tools.list` / `tools.call`.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionId, WorkspaceId } from "../core/types.ts";
import type { NodeStore } from "../node/server.ts";
import { reminder } from "./reminder.ts";
import { TOOLS, type ToolDef, type ToolName, type ToolParams, toolsFor, validate } from "./schemas.ts";

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
	| "unavailable";

export type ToolResult =
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; code: ToolErrorCode; message: string };

export interface ToolDeps {
	store: NodeStore;
	// 07's `ModeService.decorate` plugs in here; until then the reminder has
	// no third line and the preamble carries none either.
	modeLine?: (actor: Actor) => string | undefined;
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
	isError: boolean;
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
function render(actor: Actor, deps: ToolDeps, head: string, isError: boolean): McpToolResponse {
	let text = head;
	if (actor.kind !== "agent") {
		const extra = reminder({
			missions: deps.store.listMissions(actor.workspaceId),
			modeLine: deps.modeLine?.(actor),
		});
		if (extra !== "") {
			text += `\n${extra}`;
		}
	}
	return { content: [{ type: "text", text }], isError };
}

function refused(deps: ToolDeps, actor: Actor | undefined, message: string): McpToolResponse {
	if (actor !== undefined) {
		return render(actor, deps, `error notAuthorised: ${message}`, true);
	}
	return { content: [{ type: "text", text: `error notAuthorised: ${message}` }], isError: true };
}

export function createRouter(
	deps: ToolDeps,
	handlers: ToolHandlers,
	tokens: TokenTable,
): {
	list(actorId: string, token: string): ToolDef[] | ToolResult;
	call(actorId: string, token: string, name: string, args: unknown): Promise<McpToolResponse>;
} {
	function authed(actorId: string, token: string): Actor | undefined {
		if (!tokens.verify(actorId, token)) {
			return undefined;
		}
		return resolveActor(deps.store, actorId);
	}

	return {
		list(actorId: string, token: string): ToolDef[] | ToolResult {
			const actor = authed(actorId, token);
			if (actor === undefined) {
				return { ok: false, code: "notAuthorised", message: "bad token or unknown actor" };
			}
			return toolsFor(actor.kind);
		},

		async call(actorId: string, token: string, name: string, args: unknown): Promise<McpToolResponse> {
			const actor = authed(actorId, token);
			if (actor === undefined) {
				return refused(deps, undefined, "bad token or unknown actor");
			}
			const def = TOOLS.find((tool) => tool.name === name);
			if (def === undefined || !toolsFor(actor.kind).some((tool) => tool.name === def.name)) {
				return refused(deps, actor, `no such tool for ${actor.kind}: ${name}`);
			}
			const checked = validate(def.name, args);
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
				return render(actor, deps, JSON.stringify(result.data), false);
			}
			return render(actor, deps, `error ${result.code}: ${result.message}`, true);
		},
	};
}
