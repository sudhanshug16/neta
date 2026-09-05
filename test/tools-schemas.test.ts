import { describe, expect, test } from "bun:test";
import { TOOLS, type ToolName, toolsFor, validate } from "../src/tools/schemas.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

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
		valid: { name: "payments retry", objective: "Retry failed payments.", access: "readWrite", lead: "self" },
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
		name: "neta_wait",
		valid: { missionId: ID, timeoutMs: 5000 },
		wrongType: { timeoutMs: 5 },
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
	test("agents see exactly progress and done", () => {
		expect(
			toolsFor("agent")
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["neta_done", "neta_history", "neta_progress"]);
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
