// One module owning every tool's name, description, schema and callers.
// Each `inputSchema` stands alone ($defs expanded, no $refs); `validate` is
// hand-written, no dependency, covering every keyword the schemas use.

import type { Access, Disposition } from "../core/types.ts";
import type { Effort } from "../routing/types.ts";

export type MissionRef = number | string;

export type ActorKind = "leader" | "lead" | "agent";

export type ToolName =
	| "dispatch_mission"
	| "spawn_agent"
	| "change_model"
	| "send_message"
	| "close"
	| "mission_state"
	| "list_models"
	| "setup_diagnostic"
	| "artifacts";

export interface LeadSpec {
	task: string;
	provider?: string;
	model?: string;
	variant?: string;
	effort?: Effort;
	fallbackModels?: string[];
	skills?: string[];
}

export interface AgentSpec {
	task: string;
	access: Access;
	provider?: string;
	model?: string;
	variant?: string;
	effort?: Effort;
	fallbackModels?: string[];
	skills?: string[];
}

export interface MissionParams {
	name: string;
	objective: string;
	access: Access;
	lead: LeadSpec;
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
	variant?: string;
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
	model?: string;
	variant?: string;
	userInstruction?: string;
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

export interface StatusParams {
	limit?: number;
	cursor?: string;
	missionId?: MissionRef;
	section?: "agents" | "attention";
}
export interface ModelsParams {
	query?: string;
	limit?: number;
	cursor?: string;
}
export interface SetupDiagnosticParams {
	number: number;
	stream?: "stdout" | "stderr";
	cursor?: string;
}

export interface ArtifactParams {
	action: "publish" | "inspect" | "open";
	path?: string;
	text?: string;
	title?: string;
	mimeType?: string;
	previousId?: string;
	id?: string;
	offset?: number;
	limit?: number;
}

export interface ToolParams {
	dispatch_mission: MissionParams;
	spawn_agent: AgentParams;
	change_model: ModelParams;
	send_message: SendParams;
	close: CloseParams;
	mission_state: StatusParams;
	list_models: ModelsParams;
	setup_diagnostic: SetupDiagnosticParams;
	artifacts: ArtifactParams;
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
	description: "Workspace mission number, for example 12. Legacy internal IDs are accepted for compatibility.",
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
				"Exact connected model ID from list_models. Omit to let Neta choose using task effort (1–5). Supply only for an explicit model override; it bypasses automatic routing.",
		},
		variant: {
			type: "string",
			minLength: 1,
			description: "Supported thinking level from list_models; with an explicit model or task effort.",
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
				"Exact connected model ID from list_models. Omit to let Neta choose using task effort (1–5). Supply only for an explicit model override; it bypasses automatic routing.",
		},
		variant: {
			type: "string",
			minLength: 1,
			description: "Supported thinking level from list_models; with an explicit model or task effort.",
		},
		effort: EFFORT,
		fallbackModels: FALLBACK_MODELS,
		skills: SKILLS,
	},
};

export const TOOLS: readonly ToolDef[] = [
	{
		name: "dispatch_mission",
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
						"Separate mission lead; supply a task and effort (1–5 unless a model is explicit). The coordinator cannot lead its own mission.",
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
		name: "spawn_agent",
		description:
			"Add a worker to an existing mission. Coordinators pass its mission number; mission leads default to their own mission. For a new delegation, use dispatch_mission with a lead task instead.",
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
						"Exact connected model ID from list_models. Omit to let Neta choose using task effort (1–5). Supply only for an explicit model override; it bypasses automatic routing.",
				},
				variant: {
					type: "string",
					minLength: 1,
					description: "Supported thinking level from list_models; with an explicit model or task effort.",
				},
				effort: EFFORT,
				fallbackModels: FALLBACK_MODELS,
				skills: SKILLS,
			},
		},
		actors: ["leader", "lead"],
	},
	{
		name: "artifacts",
		description:
			"Publish an immutable text, Markdown, CSV, or JSON artifact by local path or small text; inspect or open it by ID. Pass the returned ID and a short finding to your parent instead of copying the whole artifact into chat.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action"],
			properties: {
				action: { type: "string", enum: ["publish", "inspect", "open"] },
				path: { type: "string", minLength: 1, maxLength: 4096 },
				text: { type: "string", minLength: 1, maxLength: 32768 },
				title: { type: "string", minLength: 1, maxLength: 160 },
				mimeType: { type: "string", enum: ["text/plain", "text/markdown", "text/csv", "application/json"] },
				previousId: ULID,
				id: ULID,
				offset: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1, maximum: 2048 },
			},
		},
		actors: ["leader", "lead", "agent"],
	},
	{
		name: "change_model",
		description:
			"Change an existing mission lead or worker's model and thinking level in the same conversation. Use exactly one of task effort 1–5, change up/down, or an exact connected model; variant is an optional supported thinking level with an explicit model. Honor the user's requested model and thinking level. missionId targets that mission's lead; agentId accepts an exact ID or unique name. Mission leads can adjust their own mission only. Ordinary agents can adjust only themselves and must omit missionId and agentId. Does not start, restart, or cancel work.",
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
				model: {
					type: "string",
					minLength: 1,
					description: "Exact connected model ID from list_models.",
				},
				variant: {
					type: "string",
					minLength: 1,
					description: "Supported thinking level for the explicit model, such as medium.",
				},
				userInstruction: {
					type: "string",
					minLength: 1,
					maxLength: 2000,
					description: "The user's model or cost preference in their own words for Jev when routing by effort.",
				},
			},
			oneOf: [
				{ type: "object", required: ["effort"] },
				{ type: "object", required: ["change"] },
				{ type: "object", required: ["model"] },
			],
		},
		actors: ["leader", "lead", "agent"],
	},
	{
		name: "send_message",
		description:
			"Save a follow-up in an agent inbox. Running agents can receive it at the next model step; queued agents retain it until they start. This never interrupts a turn. Returns messageId and delivery status.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["agentId", "text"],
			properties: { agentId: ULID, text: { type: "string", minLength: 1, maxLength: 4000 } },
		},
		actors: ["leader", "lead"],
	},
	{
		name: "close",
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
		name: "mission_state",
		description:
			"Compact open-mission state, paged newest first. Supply missionId for one mission's agent details; use list_models for connected models.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				limit: { type: "integer", minimum: 1, maximum: 20 },
				cursor: { type: "string", minLength: 1 },
				missionId: MISSION_REF,
				section: { type: "string", enum: ["agents", "attention"] },
			},
		},
		actors: ["leader", "lead"],
	},
	{
		name: "list_models",
		description: "Search connected models and supported thinking levels; results are paged.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: { type: "string", minLength: 1, maxLength: 200 },
				limit: { type: "integer", minimum: 1, maximum: 25 },
				cursor: { type: "string", minLength: 1 },
			},
		},
		actors: ["leader", "lead"],
	},
	{
		name: "setup_diagnostic",
		description: "Read a redacted page of a failed worktree setup diagnostic by mission number.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["number"],
			properties: {
				number: { type: "integer", minimum: 1 },
				stream: { type: "string", enum: ["stdout", "stderr"] },
				cursor: { type: "string", minLength: 1 },
			},
		},
		actors: ["leader"],
	},
];

export function toolsFor(kind: ActorKind): ToolDef[] {
	return TOOLS.filter((tool) => tool.actors.includes(kind)).map((tool) => {
		if (kind === "leader" && tool.name === "spawn_agent")
			return {
				...tool,
				inputSchema: { ...tool.inputSchema, required: [...(tool.inputSchema.required ?? []), "missionId"] },
			};
		if (kind === "lead" && tool.name === "send_message")
			return {
				...tool,
				description:
					"Send a follow-up to an agent in your mission. Get its agentId from mission_state. Running agents receive it at the next model step; this does not interrupt a turn.",
			};
		if (
			(kind === "lead" || kind === "agent") &&
			["spawn_agent", "mission_state", "change_model"].includes(tool.name)
		) {
			const { missionId: _missionId, agentId: _agentId, ...ownProperties } = tool.inputSchema.properties ?? {};
			return {
				...tool,
				description:
					tool.name === "spawn_agent"
						? "Add a worker to your mission. For a new mission, ask the Coordinator."
						: tool.name === "mission_state"
							? "Read your mission state and agent details; use list_models for connected models."
							: kind === "agent"
								? "Change your own model or thinking level in this conversation."
								: "Change your own model or an agent's model in your mission. Omit agentId to target yourself.",
				inputSchema: {
					...tool.inputSchema,
					properties:
						kind === "agent" ? ownProperties : { ...ownProperties, ...(_agentId ? { agentId: _agentId } : {}) },
				},
			};
		}
		return tool;
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
					const issue = checkSchema(schema.items, value[index], `${path}[${index}]`);
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
					const issue = checkSchema(prop, record[key], `${path}.${key}`);
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

export function checkSchema(schema: JsonSchema, value: unknown, path: string): string | undefined {
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
		const matches = schema.oneOf.filter((option) => checkSchema(option, value, path) === undefined).length;
		if (matches !== 1) {
			return `${path} must match exactly one option`;
		}
	}
	return undefined;
}

export function validate<N extends ToolName>(
	name: N,
	args: unknown,
	kind?: ActorKind,
): { ok: true; value: ToolParams[N] } | { ok: false; message: string } {
	const def = (kind ? toolsFor(kind) : TOOLS).find((tool) => tool.name === name);
	if (def === undefined) {
		return { ok: false, message: `unknown tool: ${name}` };
	}
	if (
		name === "dispatch_mission" &&
		typeof args === "object" &&
		args !== null &&
		"lead" in args &&
		args.lead === "self"
	) {
		return {
			ok: false,
			message:
				"lead: self is no longer supported. Supply a separate mission lead with a task and effort (1–5 unless a model is explicit).",
		};
	}
	const message = checkSchema(def.inputSchema, args, "params");
	return message === undefined ? { ok: true, value: args as ToolParams[N] } : { ok: false, message };
}
