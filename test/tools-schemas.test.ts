import { describe, expect, test } from "bun:test";
import { TOOLS, type ToolName, validate } from "../src/tools/schemas.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

test("old clients receive actionable validation for lead: self", () => {
	const result = validate("dispatch_mission", {
		name: "legacy",
		objective: "work",
		access: "readOnly",
		lead: "self",
	});
	expect(result).toMatchObject({ ok: false, message: expect.stringContaining("separate mission lead") });
	const schema = TOOLS.find((tool) => tool.name === "dispatch_mission")?.inputSchema.properties?.lead;
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
		name: "dispatch_mission",
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
		name: "spawn_agent",
		valid: { task: "Write the retry.", access: "readOnly", missionId: ID },
		missing: { task: "x" },
		wrongType: { task: "x", access: "everything" },
	},
	{
		name: "change_model",
		valid: { missionId: 4, change: "up" },
		missing: { agentId: "Cove" },
		wrongType: { agentId: "Cove", effort: 2.5 },
	},
	{
		name: "send_message",
		valid: { agentId: ID, text: "go on" },
		missing: { agentId: ID },
		wrongType: { agentId: ID, text: "" },
	},
	{
		name: "close",
		valid: { missionId: ID, disposition: "merged", reason: "Landed." },
		missing: { missionId: ID, disposition: "merged" },
		wrongType: { missionId: ID, disposition: "vaporized", reason: "x" },
	},
	{
		name: "mission_state",
		valid: {},
		wrongType: "everything",
	},
];

describe("tool schemas", () => {
	test("artifacts publish without audience or review fields", () => {
		expect(validate("artifacts", { action: "inspect", id: ID }).ok).toBe(true);
		expect(
			validate("artifacts", { action: "publish", text: "Report", title: "Report", mimeType: "text/plain" }).ok,
		).toBe(true);
		for (const args of [
			{ action: "review", id: ID, verdict: "accepted", note: "checked" },
			{ action: "inspect", id: ID, verdict: "accepted" },
			{ action: "inspect", id: ID, note: "checked" },
			{ action: "publish", text: "Report", title: "Report", mimeType: "text/plain", audience: "parent" },
		]) {
			expect(validate("artifacts", args).ok).toBe(false);
		}
	});

	test("tools have unique names and standalone schemas", () => {
		expect(TOOLS).toHaveLength(9);
		expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(9);
		for (const tool of TOOLS) {
			expect(typeof tool.description).toBe("string");
			expect(JSON.stringify(tool.inputSchema).includes("$ref")).toBe(false);
		}
	});

	test("the live mission tool tells existing leaders to delegate sustained work promptly", () => {
		const mission = TOOLS.find((tool) => tool.name === "dispatch_mission");
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
});

describe("actor tool sets", () => {});

test("task difficulty accepts only integer effort levels 1 through 5 independently of model override", () => {
	for (const effort of [1, 2, 3, 4, 5]) {
		expect(validate("spawn_agent", { task: "check", access: "readOnly", effort }).ok).toBe(true);
		expect(
			validate("dispatch_mission", {
				name: "check",
				objective: "check",
				access: "readOnly",
				lead: { task: "confirm", effort },
			}).ok,
		).toBe(true);
	}
	for (const effort of [0, 6, 1.5, "high", null])
		expect(validate("spawn_agent", { task: "check", access: "readOnly", effort }).ok).toBe(false);
	expect(validate("spawn_agent", { task: "check", access: "readOnly", model: "openai/luna" }).ok).toBe(true);
});

test("model adjustments require one effort, direction, or exact model with optional thinking level", () => {
	for (const params of [
		{ missionId: 4, effort: 3 },
		{ agentId: "Cove", change: "down", userInstruction: "Use something cheaper" },
		{ change: "up" },
		{ missionId: 12, model: "openai/gpt-6-sol", variant: "medium" },
	])
		expect(validate("change_model", params).ok).toBe(true);
	for (const params of [
		{ effort: 3, change: "up" },
		{ effort: 3, model: "openai/gpt-6-sol" },
		{ variant: "medium" },
		{},
		{ effort: 6 },
		{ effort: 0 },
		{ change: "sideways" },
	])
		expect(validate("change_model", params).ok).toBe(false);
});

test("delegation accepts detailed briefs while keeping bounded payloads", () => {
	expect(validate("spawn_agent", { task: "x".repeat(16000), access: "readOnly", missionId: ID }).ok).toBe(true);
	expect(validate("spawn_agent", { task: "x".repeat(16001), access: "readOnly", missionId: ID }).ok).toBe(false);
});
