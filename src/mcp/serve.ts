/**
 * The MCP plumbing shared by Neta's two servers.
 *
 * Neta exposes worker control as MCP tools rather than as a CLI because the
 * MCP server runs in the agent's own host process, outside whatever sandbox
 * the agent's shell commands are confined to. A read-only Codex leader cannot
 * open a Unix socket from bash; it can always call a tool.
 *
 * Tools are declared with plain JSON Schema and hand-validated. That keeps the
 * dependency surface to the MCP SDK itself, and the arguments are simple enough
 * that a schema library would not earn its place.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../config.ts";

export interface JsonSchema {
	type: "object";
	properties?: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
}

export interface McpTool {
	name: string;
	description: string;
	inputSchema: JsonSchema;
	/** Routable compatibility tools may be hidden from MCP discovery. */
	advertise?: boolean;
	run(args: Record<string, unknown>): Promise<CallToolResult>;
}

export function text(body: string, isError = false): CallToolResult {
	return { content: [{ type: "text", text: body }], isError };
}

/** Tool arguments arrive as unstructured JSON; these turn them into typed values or a clear error. */
export function requireString(args: Record<string, unknown>, name: string): string {
	const value = args[name];
	if (typeof value !== "string" || value.trim() === "") throw new Error(`"${name}" is required and must be text.`);
	return value;
}

export function optionalString(args: Record<string, unknown>, name: string): string | undefined {
	const value = args[name];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`"${name}" must be text.`);
	return value.trim() === "" ? undefined : value;
}

export function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
	const value = args[name];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") throw new Error(`"${name}" must be true or false.`);
	return value;
}

export function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
	const value = args[name];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`"${name}" must be a number.`);
	return value;
}

export function optionalStringArray(args: Record<string, unknown>, name: string): string[] | undefined {
	const value = args[name];
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`"${name}" must be a list of strings.`);
	}
	return value as string[];
}

/**
 * Build an MCP server over a set of tools.
 *
 * Errors come back as tool results rather than protocol errors: a leader that
 * asks for a second writer needs to read why and choose again, not see its tool
 * call fail.
 */
export function createMcpServer(name: string, tools: McpTool[], instructions?: string): Server {
	const server = new Server({ name, version: VERSION }, { capabilities: { tools: {} }, instructions });
	const byName = new Map(tools.map((tool) => [tool.name, tool]));

	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: tools
			.filter((tool) => tool.advertise !== false)
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = byName.get(request.params.name);
		if (!tool) return text(`Unknown tool "${request.params.name}".`, true);
		try {
			return await tool.run((request.params.arguments ?? {}) as Record<string, unknown>);
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error), true);
		}
	});

	return server;
}
