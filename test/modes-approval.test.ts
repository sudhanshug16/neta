import { describe, expect, test } from "bun:test";
import type { AgentId, DecisionRecord, Mission } from "../src/core/types.ts";
import {
	evaluateRequest,
	isReserved,
	missingFields,
	parseReservations,
	reservationFor,
} from "../src/modes/approval.ts";
import type { ModeSubject } from "../src/modes/records.ts";

function mission(extra?: Partial<Mission>): Mission {
	return {
		id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
		number: 4,
		workspaceId: "w",
		machineId: "m",
		name: "lens port",
		objective: "port the lens",
		changes: [],
		lead: { kind: "agent", agentId: "a1" as AgentId },
		agentIds: ["a1" as AgentId],
		access: "readOnly",
		state: "running",
		createdAt: new Date(0).toISOString(),
		...extra,
	};
}

function record(extra?: Partial<DecisionRecord>): DecisionRecord {
	return {
		objective: "port the lens",
		whyLeadInsufficient: "needs a writer",
		missionId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
		mutationKind: "code",
		estimatedFiles: 3,
		validation: "tests pass",
		estimatedMinutes: 30,
		externalEffects: "none",
		...extra,
	};
}

const LEAD: ModeSubject = { kind: "lead", workspaceId: "w", agentId: "a1" as AgentId };
const LEADER: ModeSubject = { kind: "leader", workspaceId: "w" };

describe("charter reservations", () => {
	test("an empty charter and one without the section yield nothing", () => {
		expect(parseReservations("")).toEqual([]);
		expect(parseReservations("# Charter\n\n## You decide\n\n- ship it\n")).toEqual([]);
	});

	test("bullets under other headings are ignored and the section ends at the next heading", () => {
		const charter = [
			"# Charter",
			"",
			"## You decide",
			"",
			"- ship it",
			"",
			"## Reserved for the user",
			"",
			"- **Force-push** to main.",
			"* Deploying!",
			"",
			"## Defaults",
			"",
			"- whatever",
			"",
		].join("\n");
		expect(parseReservations(charter)).toEqual(["Force-push to main", "Deploying"]);
	});

	test("matching ignores case and spacing, in both directions", () => {
		expect(isReserved(["Force-push to main"], "force-push to   main")).toBe(true);
		expect(isReserved(["force-push to main"], "Force-Push")).toBe(true);
		expect(isReserved(["deploys"], "Friday deploys")).toBe(true);
		expect(isReserved(["Friday deploys"], "deploys")).toBe(true);
		expect(isReserved(["deploys"], "tests")).toBe(false);
	});
});

describe("the grant rule", () => {
	test("a complete record on an open mission led by the caller approves", () => {
		expect(evaluateRequest({ record: record(), mission: mission(), caller: LEAD, reservations: [] })).toEqual({
			approved: true,
		});
	});

	test("each missing field and each non-positive estimate denies incompleteRecord", () => {
		for (const field of ["objective", "validation", "externalEffects"] as const) {
			const result = evaluateRequest({
				record: record({ [field]: "  " }),
				mission: mission(),
				caller: LEAD,
				reservations: [],
			});
			expect(result).toEqual({ approved: false, reason: "incompleteRecord", detail: `record is missing: ${field}` });
		}
		for (const value of [0, -2, 1.5, Number.NaN]) {
			const result = evaluateRequest({
				record: record({ estimatedFiles: value }),
				mission: mission(),
				caller: LEAD,
				reservations: [],
			});
			expect(result).toEqual({
				approved: false,
				reason: "incompleteRecord",
				detail: "record is missing: estimatedFiles",
			});
		}
		expect(missingFields(record())).toEqual([]);
	});

	test("an unknown missionId denies missionMissing, a closed one missionClosed", () => {
		expect(evaluateRequest({ record: record(), mission: undefined, caller: LEAD, reservations: [] })).toEqual({
			approved: false,
			reason: "missionMissing",
			detail: "mission 01ARZ3NDEKTSV4RRFFQ69G5FAW does not exist",
		});
		expect(
			evaluateRequest({ record: record(), mission: mission({ state: "closed" }), caller: LEAD, reservations: [] }),
		).toEqual({ approved: false, reason: "missionClosed", detail: "mission 4 is closed" });
	});

	test("another agent's mission denies notAuthorised while the workspace leader passes", () => {
		const other: ModeSubject = { kind: "lead", workspaceId: "w", agentId: "a9" as AgentId };
		expect(evaluateRequest({ record: record(), mission: mission(), caller: other, reservations: [] })).toEqual({
			approved: false,
			reason: "notAuthorised",
			detail: "caller is not this mission's lead or workspace leader",
		});
		expect(evaluateRequest({ record: record(), mission: mission(), caller: LEADER, reservations: [] })).toEqual({
			approved: true,
		});
	});

	test("a bullet matching mutationKind or externalEffects denies reservedByCharter", () => {
		const kind = evaluateRequest({
			record: record({ mutationKind: "database migration" }),
			mission: mission(),
			caller: LEAD,
			reservations: ["Database migrations"],
		});
		expect(kind).toEqual({
			approved: false,
			reason: "reservedByCharter",
			detail: 'charter reserves "Database migrations"',
		});
		const effects = evaluateRequest({
			record: record({ externalEffects: "no server restarts tonight" }),
			mission: mission(),
			caller: LEAD,
			reservations: ["server restarts"],
		});
		expect(effects).toEqual({
			approved: false,
			reason: "reservedByCharter",
			detail: 'charter reserves "server restarts"',
		});
		expect(reservationFor(["server restarts"], record({ externalEffects: "no server restarts tonight" }))).toBe(
			"server restarts",
		);
	});
});
