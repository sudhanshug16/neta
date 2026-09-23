import { describe, expect, test } from "bun:test";
import { TOOLS, type ToolName, toolsFor, validate } from "../src/tools/schemas.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

test("old clients receive actionable validation for lead: self", () => {
	const result = validate("neta_mission", {
		name: "legacy",
		objective: "work",
		access: "readOnly",
		lead: "self",
	});
	expect(result).toMatchObject({ ok: false, message: expect.stringContaining("separate mission lead") });
	const schema = TOOLS.find((tool) => tool.name === "neta_mission")?.inputSchema.properties?.lead;
	expect(schema?.oneOf).toBeUndefined();
	expect(schema?.type).toBe("object");
});

interface SchemaCase {
	name: ToolName;
	valid: unknown;
	// Omit when the schema has no required properties.
	missing?: unknown;
	wrongType: unknown;
}

const CASES: SchemaCase[] = [
	{
		name: "neta_mission",
		valid: {
			name: "payments retry",
			objective: "Retry failed payments.",
			access: "readWrite",
			lead: { task: "Lead the retry", effort: 2 },
		},
		missing: { name: "x", objective: "y", access: "readOnly" },
		wrongType: { name: "x", objective: "y", access: "readOnly", lead: 42 },
	},
	{
		name: "neta_agent",
		valid: { task: "Write the retry.", access: "readOnly", missionId: ID },
		missing: { task: "x" },
		wrongType: { task: "x", access: "everything" },
	},
	{
		name: "neta_model",
		valid: { missionId: 4, change: "up" },
		missing: { agentId: "Cove" },
		wrongType: { agentId: "Cove", effort: 2.5 },
	},
	{
		name: "neta_send",
		valid: { agentId: ID, text: "go on" },
		missing: { agentId: ID },
		wrongType: { agentId: ID, text: "" },
	},
	{
		name: "neta_scope",
		valid: { missionId: ID, text: "Also cover refunds." },
		missing: { missionId: ID },
		wrongType: { missionId: "nope", text: "x" },
	},
	{
		name: "neta_ready",
		valid: { missionId: ID, summary: "All green." },
		missing: { missionId: ID },
		wrongType: { missionId: ID, summary: 7 },
	},
	{
		name: "neta_close",
		valid: { missionId: ID, disposition: "merged", reason: "Landed." },
		missing: { missionId: ID, disposition: "merged" },
		wrongType: { missionId: ID, disposition: "vaporized", reason: "x" },
	},
	{
		name: "neta_mode",
		valid: { mode: "leadPlus" },
		missing: {},
		wrongType: { mode: "turbo" },
	},
	{
		name: "neta_pin",
		valid: { turnId: ID, text: "Remember this." },
		missing: { turnId: ID },
		wrongType: { turnId: ID, text: "" },
	},
	{
		name: "neta_status",
		valid: {},
		wrongType: "everything",
	},
	{
		name: "neta_progress",
		valid: { text: "First green run." },
		missing: {},
		wrongType: { text: "" },
	},
	{
		name: "neta_ask",
		valid: { question: "Which API?" },
		missing: {},
		wrongType: { question: 42 },
	},
	{
		name: "neta_done",
		valid: { outcome: "Shipped." },
		missing: {},
		wrongType: {},
	},
];

describe("tool schemas", () => {
	test("fourteen tools, unique names, standalone schemas", () => {
		expect(TOOLS).toHaveLength(14);
		expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(14);
		for (const tool of TOOLS) {
			expect(typeof tool.description).toBe("string");
			expect(JSON.stringify(tool.inputSchema).includes("$ref")).toBe(false);
		}
	});

	test("the live mission tool tells existing leaders to delegate sustained work promptly", () => {
		const mission = TOOLS.find((tool) => tool.name === "neta_mission");
		expect(mission?.description).toContain("before broad exploration or repeated reads");
	});

	for (const schemaCase of CASES) {
		test(`${schemaCase.name} round-trips valid params and rejects bad ones`, () => {
			const roundTrip = validate(schemaCase.name, schemaCase.valid);
			expect(roundTrip.ok).toBe(true);
			if (roundTrip.ok) {
				expect(JSON.stringify(roundTrip.value)).toBe(JSON.stringify(schemaCase.valid));
			}
			const withUnknown = { ...(schemaCase.valid as Record<string, unknown>), bogus: 1 };
			const unknown = validate(schemaCase.name, withUnknown);
			expect(unknown.ok).toBe(false);
			if (!unknown.ok) {
				expect(unknown.message).toContain("params.bogus");
			}
			if (schemaCase.missing !== undefined) {
				const missing = validate(schemaCase.name, schemaCase.missing);
				expect(missing.ok).toBe(false);
			}
			const wrong = validate(schemaCase.name, schemaCase.wrongType);
			expect(wrong.ok).toBe(false);
			if (!wrong.ok) {
				expect(wrong.message).toContain("params");
			}
		});
	}

	test("expanded forms validate: agents, lead objects, decision records", () => {
		const mission = validate("neta_mission", {
			name: "n",
			objective: "o",
			access: "readWrite",
			lead: { task: "Lead it.", skills: ["a", "b"] },
			agents: [{ task: "Do it.", access: "readOnly" }],
			continues: ID,
		});
		expect(mission.ok).toBe(true);
		const record = {
			objective: "o",
			whyLeadInsufficient: "w",
			missionId: ID,
			mutationKind: "m",
			estimatedFiles: 3,
			validation: "v",
			estimatedMinutes: 30,
			externalEffects: "none",
		};
		expect(validate("neta_mode", { mode: "leadPlus", record }).ok).toBe(true);
		expect(
			validate("neta_mode", { mode: "leadPlus", record: { ...record, worktreePath: "/tmp/x", estimatedFiles: 1.5 } })
				.ok,
		).toBe(false);
		expect(
			validate("neta_mission", {
				name: "n",
				objective: "o",
				access: "readWrite",
				lead: { task: "x", access: "readOnly", bogus: 1 },
			}).ok,
		).toBe(false);
	});
});

describe("actor tool sets", () => {
	test("agents see reporting, history and their own model adjustment", () => {
		expect(
			toolsFor("agent")
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["neta_done", "neta_history", "neta_model", "neta_progress"]);
	});

	test("leads see everything but mission, close and pin", () => {
		const names = toolsFor("lead").map((tool) => tool.name);
		expect(names).toHaveLength(11);
		for (const excluded of ["neta_mission", "neta_close", "neta_pin"]) {
			expect(names).not.toContain(excluded);
		}
	});

	test("leaders see everything but progress and done", () => {
		const names = toolsFor("leader").map((tool) => tool.name);
		expect(names).toHaveLength(12);
		expect(names).not.toContain("neta_progress");
		expect(names).not.toContain("neta_done");
	});
});

test("task difficulty accepts only integer effort levels 1 through 5 independently of model override", () => {
	for (const effort of [1, 2, 3, 4, 5]) {
		expect(validate("neta_agent", { task: "check", access: "readOnly", effort }).ok).toBe(true);
		expect(
			validate("neta_mission", {
				name: "check",
				objective: "check",
				access: "readOnly",
				lead: { task: "confirm", effort },
			}).ok,
		).toBe(true);
	}
	for (const effort of [0, 6, 1.5, "high", null])
		expect(validate("neta_agent", { task: "check", access: "readOnly", effort }).ok).toBe(false);
	expect(validate("neta_agent", { task: "check", access: "readOnly", model: "openai/luna" }).ok).toBe(true);
});

test("model adjustments require exactly one bounded effort or direction", () => {
	for (const params of [{ missionId: 4, effort: 3 }, { agentId: "Cove", change: "down" }, { change: "up" }])
		expect(validate("neta_model", params).ok).toBe(true);
	for (const params of [{ effort: 3, change: "up" }, {}, { effort: 6 }, { effort: 0 }, { change: "sideways" }])
		expect(validate("neta_model", params).ok).toBe(false);
});

test("public mission numbers and lead-local references work without guessing internal IDs", () => {
	for (const missionId of [12, ID]) {
		expect(validate("neta_agent", { missionId, task: "check", access: "readOnly", effort: 1 }).ok).toBe(true);
		expect(validate("neta_ready", { missionId, summary: "checked" }).ok).toBe(true);
		expect(validate("neta_close", { missionId, disposition: "completed", reason: "checked" }).ok).toBe(true);
	}
	for (const missionId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "12"]) {
		expect(validate("neta_ready", { missionId, summary: "checked" }).ok).toBe(false);
	}
	for (const name of ["neta_agent", "neta_ready", "neta_scope"]) {
		expect(toolsFor("leader").find((tool) => tool.name === name)?.inputSchema.required).toContain("missionId");
		expect(toolsFor("lead").find((tool) => tool.name === name)?.inputSchema.required).not.toContain("missionId");
	}
	expect(validate("neta_ready", { summary: "checked" }).ok).toBe(true);
});

test("delegation accepts detailed briefs while keeping bounded payloads", () => {
	expect(validate("neta_agent", { task: "x".repeat(16000), access: "readOnly", missionId: ID }).ok).toBe(true);
	expect(validate("neta_agent", { task: "x".repeat(16001), access: "readOnly", missionId: ID }).ok).toBe(false);
});
