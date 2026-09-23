// One module owning every tool's name, description, schema and callers.
// Each `inputSchema` stands alone ($defs expanded, no $refs); `validate` is
// hand-written, no dependency, covering every keyword the schemas use.

import type { Access, DecisionRecord, Disposition } from "../core/types.ts";
import type { Effort } from "../routing/types.ts";

export type MissionRef = number | string;

export type ActorKind = "leader" | "lead" | "agent";

export type ToolName =
	| "neta_mission"
	| "neta_agent"
	| "neta_model"
	| "neta_send"
	| "neta_scope"
	| "neta_ready"
	| "neta_close"
	| "neta_mode"
	| "neta_pin"
	| "neta_status"
	| "neta_history"
	| "neta_progress"
	| "neta_ask"
	| "neta_done";

export interface LeadSpec {
	task: string;
	provider?: string;
	model?: string;
	effort?: Effort;
	fallbackModels?: string[];
	skills?: string[];
}

export interface AgentSpec {
	task: string;
	access: Access;
	provider?: string;
	model?: string;
	effort?: Effort;
	fallbackModels?: string[];
	skills?: string[];
}

export interface MissionParams {
	name: string;
	objective: string;
	access: Access;
	// Legacy clients may still send "self"; the published schema excludes it and
	// both validation and the handler reject it before any side effects.
	lead: "self" | LeadSpec;
	agents?: AgentSpec[];
	continues?: MissionRef;
	// Explicitly adopt a partial Worktrunk creation recorded for this number.
	// Normal creation never searches for or reuses existing worktrees.
	recoverWorktree?: {
		number: number;
		path: string;
		branch: string;
		base: string;
		setupDisposition: "handled" | "waived";
	};
}

export interface AgentParams {
	task: string;
	access: Access;
	missionId?: MissionRef;
	provider?: string;
	model?: string;
	effort?: Effort;
	fallbackModels?: string[];
	skills?: string[];
}

export interface SendParams {
	agentId: string;
	text: string;
}

export interface ModelParams {
	missionId?: MissionRef;
	agentId?: string;
	effort?: Effort;
	change?: "up" | "down";
}

export interface ScopeParams {
	missionId?: MissionRef;
	text: string;
}

export interface ReadyParams {
	missionId?: MissionRef;
	summary: string;
}

export interface CloseParams {
	missionId: MissionRef;
	evidence?: string;
	disposition: Disposition;
	reason: string;
	// Explicit user confirmation that uncommitted changes may be discarded.
	// Required for removing a dirty worktree on an abandoned close; clean
	// closes never need it.
	discardUncommitted?: boolean;
}

export interface ModeParams {
	mode: "lead" | "leadPlus";
	record?: Omit<DecisionRecord, "missionId"> & { missionId: MissionRef };
}

export interface PinParams {
	turnId: string;
	text: string;
}

// No params; the empty object keeps every tool shaped alike.
export type StatusParams = Record<string, never>;
export interface HistoryParams {
	cursor?: string;
	limit?: number;
}

export interface ProgressParams {
	text: string;
}

export interface AskParams {
	question: string;
	missionId?: MissionRef;
}

export interface DoneParams {
	outcome: string;
}

export interface ToolParams {
	neta_mission: MissionParams;
	neta_agent: AgentParams;
	neta_model: ModelParams;
	neta_send: SendParams;
	neta_scope: ScopeParams;
	neta_ready: ReadyParams;
	neta_close: CloseParams;
	neta_mode: ModeParams;
	neta_pin: PinParams;
	neta_status: StatusParams;
	neta_history: HistoryParams;
	neta_progress: ProgressParams;
	neta_ask: AskParams;
	neta_done: DoneParams;
}

export interface JsonSchema {
	description?: string;
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
	minItems?: number;
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
const FALLBACK_MODELS: JsonSchema = {
	type: "array",
	maxItems: 8,
	items: { type: "string", minLength: 1, maxLength: 200 },
	description:
		"Deprecated compatibility field. Automatic model switching is disabled; nonempty lists are rejected. Omit or pass [].",
};
const EFFORT: JsonSchema = {
	type: "integer",
	minimum: 1,
	maximum: 5,
	description:
		"Required when auto-routing: task difficulty 1 confirmation/lookup, 2 bounded investigation, 3 implementation, 4 difficult debugging/design, 5 exceptional reasoning. This is not provider reasoning effort. Required unless model is explicitly selected; omission never inherits the parent model in OpenCode.",
};
const MISSION_REF: JsonSchema = {
	description:
		"Workspace mission number, for example 12. Legacy internal IDs are accepted for compatibility. A mission lead may omit this to target its own mission.",
	oneOf: [{ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, ULID],
};
const TASK: JsonSchema = {
	type: "string",
	minLength: 1,
	maxLength: 16000,
	description:
		"Task instructions, up to 16000 characters. Include concrete scope and acceptance criteria; shared requirements belong in the mission objective.",
};
const NAME: JsonSchema = { type: "string", minLength: 1, maxLength: 60 };
const LEAD_SPEC: JsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["task"],
	properties: {
		task: TASK,
		provider: { type: "string" },
		model: {
			type: "string",
			description:
				"Exact connected model ID from neta_status.modelCatalog. Omit to let Neta choose using task effort (1–5). Supply only for an explicit model override; it bypasses automatic routing.",
		},
		effort: EFFORT,
		fallbackModels: FALLBACK_MODELS,
		skills: SKILLS,
	},
};
const AGENT_SPEC: JsonSchema = {
	type: "object",
	additionalProperties: false,
	required: ["task", "access"],
	properties: {
		task: TASK,
		access: ACCESS,
		provider: { type: "string" },
		model: {
			type: "string",
			description:
				"Exact connected model ID from neta_status.modelCatalog. Omit to let Neta choose using task effort (1–5). Supply only for an explicit model override; it bypasses automatic routing.",
		},
		effort: EFFORT,
		fallbackModels: FALLBACK_MODELS,
		skills: SKILLS,
	},
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
		missionId: MISSION_REF,
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
		description:
			"Create and start a mission with a separate mission lead. Supply the lead's task and effort (1–5 unless a model is explicit); for sustained work call this promptly before broad exploration or repeated reads.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["name", "objective", "access", "lead"],
			properties: {
				name: NAME,
				objective: { type: "string", minLength: 1, maxLength: 32000 },
				access: ACCESS,
				lead: {
					...LEAD_SPEC,
					description:
						"Separate mission lead; supply a task and effort (1–5 unless a model is explicit). The workspace leader cannot lead its own mission.",
				},
				agents: { type: "array", maxItems: 8, items: AGENT_SPEC },
				continues: MISSION_REF,
				recoverWorktree: {
					type: "object",
					additionalProperties: false,
					required: ["number", "path", "branch", "base", "setupDisposition"],
					properties: {
						number: { type: "integer", minimum: 1 },
						path: { type: "string", minLength: 1 },
						branch: { type: "string", minLength: 1 },
						base: { type: "string", minLength: 1 },
						setupDisposition: {
							type: "string",
							enum: ["handled", "waived"],
							description:
								"Explicit operator confirmation. Recovery adopts an existing worktree, skips all setup hooks, and never claims setup succeeded.",
						},
					},
				},
			},
		},
		actors: ["leader"],
	},
	{
		name: "neta_agent",
		description:
			"Add a worker to an existing mission. Workspace leaders pass its mission number; mission leads default to their own mission. For a new delegation, use neta_mission with a lead task instead.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["task", "access"],
			properties: {
				task: TASK,
				access: ACCESS,
				missionId: MISSION_REF,
				provider: { type: "string" },
				model: {
					type: "string",
					description:
						"Exact connected model ID from neta_status.modelCatalog. Omit to let Neta choose using task effort (1–5). Supply only for an explicit model override; it bypasses automatic routing.",
				},
				effort: EFFORT,
				fallbackModels: FALLBACK_MODELS,
				skills: SKILLS,
			},
		},
		actors: ["leader", "lead"],
	},
	{
		name: "neta_model",
		description:
			"Adjust an existing mission lead or worker's intelligence in the same conversation. Set task effort 1–5 or move one level up/down using Neta routing. Use only when the user requests a model/effort change; never as an automatic workaround for routing failure. missionId targets that mission's lead; agentId accepts an exact ID or unique name. Mission leads can adjust their own mission only. Ordinary agents can adjust only themselves and must omit missionId and agentId. Does not start, restart, or cancel work.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				missionId: MISSION_REF,
				agentId: {
					type: "string",
					minLength: 1,
					description:
						"Exact agent ID or unique name, such as Cove. Omit to target the mission lead, or yourself when you are an ordinary agent.",
				},
				effort: {
					type: "integer",
					minimum: 1,
					maximum: 5,
					description:
						"New task difficulty, independent of provider reasoning settings. Use this when no previous effort is recorded.",
				},
				change: {
					type: "string",
					enum: ["up", "down"],
					description: "Change the recorded effort by one level; bounded at 1 and 5.",
				},
			},
			oneOf: [
				{ type: "object", required: ["effort"] },
				{ type: "object", required: ["change"] },
			],
		},
		actors: ["leader", "lead", "agent"],
	},
	{
		name: "neta_send",
		description:
			"Save a follow-up in an agent inbox. Busy or queued agents retain it until they can receive it; this never interrupts a turn. Returns messageId and delivery status.",
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
			required: ["text"],
			properties: { missionId: MISSION_REF, text: { type: "string", minLength: 1, maxLength: 1000 } },
		},
		actors: ["leader", "lead"],
	},
	{
		name: "neta_ready",
		description:
			"Report successful mission completion and hand off to the workspace leader. Mission leads may omit missionId; this never merges or closes the mission.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["summary"],
			properties: { missionId: MISSION_REF, summary: { type: "string", minLength: 1, maxLength: 2000 } },
		},
		actors: ["leader", "lead"],
	},
	{
		name: "neta_close",
		description:
			"Close and archive a mission: completed for work with a committed branch (no merge required; the branch is retained even when unmerged); merged requires commit evidence; abandoned discards the work. A dirty worktree must be committed first, or closed as abandoned with discardUncommitted true to explicitly discard uncommitted changes including untracked content.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["missionId", "disposition", "reason"],
			properties: {
				missionId: MISSION_REF,
				evidence: {
					type: "string",
					maxLength: 1000,
					description:
						"Required for merged; for a Git mission name the commit already integrated into the base branch.",
				},
				disposition: { type: "string", enum: ["merged", "completed", "abandoned"] },
				reason: { type: "string", minLength: 1, maxLength: 1000 },
				discardUncommitted: {
					type: "boolean",
					description:
						"Required true to remove a dirty worktree on an abandoned close; confirms uncommitted changes may be discarded. Clean closes never need it.",
				},
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
		name: "neta_history",
		description: "read earlier user and assistant messages from this conversation",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				cursor: { type: "string" },
				limit: { type: "integer", minimum: 1, maximum: 50 },
			},
		},
		actors: ["leader", "lead", "agent"],
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
		description:
			"ask the user about a mission; the workspace leader can target a delegated mission by its numeric ID",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["question"],
			properties: { question: { type: "string", minLength: 1, maxLength: 1000 }, missionId: MISSION_REF },
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
	return TOOLS.filter((tool) => tool.actors.includes(kind)).map((tool) => {
		if (kind !== "leader" || !["neta_agent", "neta_ready", "neta_scope"].includes(tool.name)) return tool;
		return {
			...tool,
			inputSchema: { ...tool.inputSchema, required: [...(tool.inputSchema.required ?? []), "missionId"] },
		};
	});
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
	if (name === "neta_mission" && typeof args === "object" && args !== null && "lead" in args && args.lead === "self") {
		return {
			ok: false,
			message:
				"lead: self is no longer supported. Supply a separate mission lead with a task and effort (1–5 unless a model is explicit).",
		};
	}
	const message = check(def.inputSchema, args, "params");
	return message === undefined ? { ok: true, value: args as ToolParams[N] } : { ok: false, message };
}
