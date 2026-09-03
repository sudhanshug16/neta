// One module owning every tool's name, description, schema and callers.
// Each `inputSchema` stands alone ($defs expanded, no $refs); `validate` is
// hand-written, no dependency, covering every keyword the schemas use.
import type { Access, DecisionRecord } from "../core/types.ts";

export type ActorKind = "leader" | "lead" | "agent";

export type ToolName =
	| "neta_mission"
	| "neta_agent"
	| "neta_wait"
	| "neta_send"
	| "neta_scope"
	| "neta_ready"
	| "neta_close"
	| "neta_mode"
	| "neta_pin"
	| "neta_status"
	| "neta_progress"
	| "neta_ask"
	| "neta_done";

export interface LeadSpec {
	task: string;
	provider?: string;
	model?: string;
	skills?: string[];
}

export interface AgentSpec {
	task: string;
	access: Access;
	provider?: string;
	model?: string;
	skills?: string[];
}

export interface MissionParams {
	name: string;
	objective: string;
	access: Access;
	lead: "self" | LeadSpec;
	agents?: AgentSpec[];
	continues?: string;
}

export interface AgentParams {
	task: string;
	access: Access;
	missionId?: string;
	provider?: string;
	model?: string;
	skills?: string[];
}

export interface WaitParams {
	missionId?: string;
	agentIds?: string[];
	timeoutMs?: number;
}

export interface SendParams {
	agentId: string;
	text: string;
}

export interface ScopeParams {
	missionId: string;
	text: string;
}

export interface ReadyParams {
	missionId: string;
	summary: string;
}

export interface CloseParams {
	missionId: string;
	evidence?: string;
	disposition: "merged" | "abandoned";
	reason: string;
}

export interface ModeParams {
	mode: "lead" | "leadPlus";
	record?: DecisionRecord;
}

export interface PinParams {
	turnId: string;
	text: string;
}

// No params; the empty object keeps every tool shaped alike.
export type StatusParams = Record<string, never>;

export interface ProgressParams {
	text: string;
}

export interface AskParams {
	question: string;
}

export interface DoneParams {
	outcome: string;
}

export interface ToolParams {
	neta_mission: MissionParams;
	neta_agent: AgentParams;
	neta_wait: WaitParams;
	neta_send: SendParams;
	neta_scope: ScopeParams;
	neta_ready: ReadyParams;
	neta_close: CloseParams;
	neta_mode: ModeParams;
	neta_pin: PinParams;
	neta_status: StatusParams;
	neta_progress: ProgressParams;
	neta_ask: AskParams;
	neta_done: DoneParams;
}

export interface JsonSchema {
	type?: string;
	const?: unknown;
	enum?: unknown[];
	required?: string[];
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	oneOf?: JsonSchema[];
	pattern?: string;
	minLength?: number;
	maxLength?: number;
	maxItems?: number;
	minimum?: number;
	maximum?: number;
	additionalProperties?: boolean;
}

export interface ToolDef {
	name: ToolName;
	description: string;
	inputSchema: JsonSchema;
	actors: ActorKind[];
}

const ULID: JsonSchema = { type: "string", pattern: "^[0-9A-HJKMNP-TV-Z]{26}$" };
const ACCESS: JsonSchema = { type: "string", enum: ["readOnly", "readWrite"] };
const SKILLS: JsonSchema = { type: "array", maxItems: 8, items: { type: "string", minLength: 1 } };
const TASK: JsonSchema = { type: "string", minLength: 1, maxLength: 400 };
const NAME: JsonSchema = { type: "string", minLength: 1, maxLength: 60 };
const LEAD_SPEC: JsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["task"],
	properties: { task: TASK, provider: { type: "string" }, model: { type: "string" }, skills: SKILLS },
};
const AGENT_SPEC: JsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["task", "access"],
	properties: { task: TASK, access: ACCESS, provider: { type: "string" }, model: { type: "string" }, skills: SKILLS },
};
const DECISION_RECORD: JsonSchema = {
	type: "object",
	additionalProperties: false,
	required: [
		"objective",
		"whyLeadInsufficient",
		"missionId",
		"mutationKind",
		"estimatedFiles",
		"validation",
		"estimatedMinutes",
		"externalEffects",
	],
	properties: {
		objective: { type: "string" },
		whyLeadInsufficient: { type: "string" },
		missionId: ULID,
		worktreePath: { type: "string" },
		mutationKind: { type: "string" },
		estimatedFiles: { type: "integer" },
		validation: { type: "string" },
		estimatedMinutes: { type: "integer" },
		externalEffects: { type: "string" },
	},
};

export const TOOLS: readonly ToolDef[] = [
	{
		name: "neta_mission",
		description: "create and start a mission, the only way one starts",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["name", "objective", "access", "lead"],
			properties: {
				name: NAME,
				objective: { type: "string", minLength: 1, maxLength: 2000 },
				access: ACCESS,
				lead: { oneOf: [{ const: "self" }, LEAD_SPEC] },
				agents: { type: "array", maxItems: 8, items: AGENT_SPEC },
				continues: ULID,
			},
		},
		actors: ["leader"],
	},
	{
		name: "neta_agent",
		description: "add an agent",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["task", "access"],
			properties: {
				task: TASK,
				access: ACCESS,
				missionId: ULID,
				provider: { type: "string" },
				model: { type: "string" },
				skills: SKILLS,
			},
		},
		actors: ["leader", "lead"],
	},
	{
		name: "neta_wait",
		description: "block until an agent finishes, fails or asks",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				missionId: ULID,
				agentIds: { type: "array", maxItems: 32, items: ULID },
				timeoutMs: { type: "integer", minimum: 1000, maximum: 1800000 },
			},
		},
		actors: ["leader", "lead"],
	},
	{
		name: "neta_send",
		description: "answer or redirect an agent",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["agentId", "text"],
			properties: { agentId: ULID, text: { type: "string", minLength: 1, maxLength: 4000 } },
		},
		actors: ["leader", "lead"],
	},
	{
		name: "neta_scope",
		description: "record accepted scope",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["missionId", "text"],
			properties: { missionId: ULID, text: { type: "string", minLength: 1, maxLength: 1000 } },
		},
		actors: ["leader", "lead"],
	},
	{
		name: "neta_ready",
		description: "hand over, ready to close",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["missionId", "summary"],
			properties: { missionId: ULID, summary: { type: "string", minLength: 1, maxLength: 2000 } },
		},
		actors: ["leader", "lead"],
	},
	{
		name: "neta_close",
		description: "close it as merged or abandoned",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["missionId", "disposition", "reason"],
			properties: {
				missionId: ULID,
				evidence: { type: "string", maxLength: 1000 },
				disposition: { type: "string", enum: ["merged", "abandoned"] },
				reason: { type: "string", minLength: 1, maxLength: 1000 },
			},
		},
		actors: ["leader"],
	},
	{
		name: "neta_mode",
		description: "switch Lead / Lead++",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["mode"],
			properties: { mode: { type: "string", enum: ["lead", "leadPlus"] }, record: DECISION_RECORD },
		},
		actors: ["leader", "lead"],
	},
	{
		name: "neta_pin",
		description: "pin a turn",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["turnId", "text"],
			properties: { turnId: ULID, text: { type: "string", minLength: 1, maxLength: 400 } },
		},
		actors: ["leader"],
	},
	{
		name: "neta_status",
		description: "open-mission state",
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
		actors: ["leader", "lead"],
	},
	{
		name: "neta_progress",
		description: "a start, a major step or a surprise",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["text"],
			properties: { text: TASK },
		},
		actors: ["lead", "agent"],
	},
	{
		name: "neta_ask",
		description: "ask the user",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["question"],
			properties: { question: { type: "string", minLength: 1, maxLength: 1000 } },
		},
		actors: ["leader", "lead"],
	},
	{
		name: "neta_done",
		description: "the final outcome",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["outcome"],
			properties: { outcome: { type: "string", minLength: 1, maxLength: 4000 } },
		},
		actors: ["lead", "agent"],
	},
];

export function toolsFor(kind: ActorKind): ToolDef[] {
	return TOOLS.filter((tool) => tool.actors.includes(kind));
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (typeof a !== typeof b || typeof a !== "object" || a === null || b === null) {
		return false;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((entry, index) => deepEqual(entry, b[index]))
		);
	}
	const aKeys = Object.keys(a as Record<string, unknown>);
	const bKeys = Object.keys(b as Record<string, unknown>);
	return (
		aKeys.length === bKeys.length &&
		aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
	);
}

function checkType(schema: JsonSchema, value: unknown, path: string): string | undefined {
	switch (schema.type) {
		case undefined:
			return undefined;
		case "string":
			if (typeof value !== "string") {
				return `${path} must be a string`;
			}
			if (schema.minLength !== undefined && value.length < schema.minLength) {
				return `${path} must be at least ${schema.minLength} characters`;
			}
			if (schema.maxLength !== undefined && value.length > schema.maxLength) {
				return `${path} must be at most ${schema.maxLength} characters`;
			}
			if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
				return `${path} must match ${schema.pattern}`;
			}
			return undefined;
		case "integer":
			if (typeof value !== "number" || !Number.isInteger(value)) {
				return `${path} must be an integer`;
			}
			if (schema.minimum !== undefined && value < schema.minimum) {
				return `${path} must be at least ${schema.minimum}`;
			}
			if (schema.maximum !== undefined && value > schema.maximum) {
				return `${path} must be at most ${schema.maximum}`;
			}
			return undefined;
		case "number":
			if (typeof value !== "number") {
				return `${path} must be a number`;
			}
			if (schema.minimum !== undefined && value < schema.minimum) {
				return `${path} must be at least ${schema.minimum}`;
			}
			if (schema.maximum !== undefined && value > schema.maximum) {
				return `${path} must be at most ${schema.maximum}`;
			}
			return undefined;
		case "boolean":
			return typeof value === "boolean" ? undefined : `${path} must be a boolean`;
		case "array": {
			if (!Array.isArray(value)) {
				return `${path} must be an array`;
			}
			if (schema.maxItems !== undefined && value.length > schema.maxItems) {
				return `${path} must have at most ${schema.maxItems} items`;
			}
			if (schema.items !== undefined) {
				for (let index = 0; index < value.length; index++) {
					const issue = check(schema.items, value[index], `${path}[${index}]`);
					if (issue !== undefined) {
						return issue;
					}
				}
			}
			return undefined;
		}
		case "object": {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return `${path} must be an object`;
			}
			const record = value as Record<string, unknown>;
			for (const key of schema.required ?? []) {
				if (record[key] === undefined) {
					return `missing required property '${path}.${key}'`;
				}
			}
			for (const [key, prop] of Object.entries(schema.properties ?? {})) {
				if (record[key] !== undefined) {
					const issue = check(prop, record[key], `${path}.${key}`);
					if (issue !== undefined) {
						return issue;
					}
				}
			}
			if (schema.additionalProperties === false) {
				const known = new Set(Object.keys(schema.properties ?? {}));
				for (const key of Object.keys(record)) {
					if (!known.has(key)) {
						return `unknown property '${path}.${key}'`;
					}
				}
			}
			return undefined;
		}
		default:
			return `${path} has an unsupported type '${schema.type}'`;
	}
}

function check(schema: JsonSchema, value: unknown, path: string): string | undefined {
	if (schema.const !== undefined && !deepEqual(value, schema.const)) {
		return `${path} must be ${JSON.stringify(schema.const)}`;
	}
	if (schema.enum !== undefined && !schema.enum.some((option) => deepEqual(option, value))) {
		return `${path} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`;
	}
	const typed = checkType(schema, value, path);
	if (typed !== undefined) {
		return typed;
	}
	if (schema.oneOf !== undefined) {
		const matches = schema.oneOf.filter((option) => check(option, value, path) === undefined).length;
		if (matches !== 1) {
			return `${path} must match exactly one option`;
		}
	}
	return undefined;
}

export function validate<N extends ToolName>(
	name: N,
	args: unknown,
): { ok: true; value: ToolParams[N] } | { ok: false; message: string } {
	const def = TOOLS.find((tool) => tool.name === name);
	if (def === undefined) {
		return { ok: false, message: `unknown tool: ${name}` };
	}
	const message = check(def.inputSchema, args, "params");
	return message === undefined ? { ok: true, value: args as ToolParams[N] } : { ok: false, message };
}
