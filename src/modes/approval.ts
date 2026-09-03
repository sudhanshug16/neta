// The Lead++ grant rule. Only a `## Reserved for the user` section is
// parsed out of the charter; the rest is prose for the model, never parsed.
// A denial is a reason, not an error, and never a question put to the user
// on the leader's behalf.
import type { DecisionRecord, Mission } from "../core/types.ts";
import type { ModeSubject } from "./records.ts";

export type DenialReason =
	| "incompleteRecord"
	| "missionMissing"
	| "missionClosed"
	| "notAuthorised"
	| "reservedByCharter";

export type Approval = { approved: true } | { approved: false; reason: DenialReason; detail: string };

function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function parseReservations(charter: string): string[] {
	const lines = charter.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^#{1,6}\s+reserved for the user\s*$/i.test(lines[i]?.trim() ?? "")) {
			start = i + 1;
			break;
		}
	}
	if (start === -1) {
		return [];
	}
	const reservations: string[] = [];
	for (let i = start; i < lines.length; i++) {
		const line = lines[i]?.trim() ?? "";
		if (line.startsWith("#")) {
			break;
		}
		const bullet = /^[-*]\s+(.*)$/.exec(line)?.[1];
		if (bullet === undefined) {
			continue;
		}
		const text = bullet
			.replaceAll("**", "")
			.trim()
			.replace(/[.,;:!?]+$/, "")
			.trim();
		if (text !== "") {
			reservations.push(text);
		}
	}
	return reservations;
}

export function isReserved(reservations: string[], value: string): boolean {
	const wanted = normalize(value);
	if (wanted === "") {
		return false;
	}
	return reservations.some((reservation) => {
		const bullet = normalize(reservation);
		return bullet !== "" && (bullet.includes(wanted) || wanted.includes(bullet));
	});
}

// The matching bullet text, checking `mutationKind` then `externalEffects`.
export function reservationFor(reservations: string[], record: DecisionRecord): string | undefined {
	for (const value of [record.mutationKind, record.externalEffects]) {
		const wanted = normalize(value);
		if (wanted === "") {
			continue;
		}
		for (const reservation of reservations) {
			const bullet = normalize(reservation);
			if (bullet !== "" && (bullet.includes(wanted) || wanted.includes(bullet))) {
				return reservation;
			}
		}
	}
	return undefined;
}

export function missingFields(record: DecisionRecord): string[] {
	const missing: string[] = [];
	for (const field of [
		"objective",
		"whyLeadInsufficient",
		"missionId",
		"mutationKind",
		"validation",
		"externalEffects",
	] as const) {
		if (record[field].trim() === "") {
			missing.push(field);
		}
	}
	for (const field of ["estimatedFiles", "estimatedMinutes"] as const) {
		const value = record[field];
		if (!Number.isInteger(value) || value <= 0 || !Number.isFinite(value)) {
			missing.push(field);
		}
	}
	return missing;
}

export function evaluateRequest(input: {
	record: DecisionRecord;
	mission: Mission | undefined;
	caller: ModeSubject;
	reservations: string[];
}): Approval {
	const missing = missingFields(input.record);
	if (missing.length > 0) {
		return { approved: false, reason: "incompleteRecord", detail: `record is missing: ${missing.join(", ")}` };
	}
	if (input.mission === undefined) {
		return { approved: false, reason: "missionMissing", detail: `mission ${input.record.missionId} does not exist` };
	}
	if (input.mission.state === "closed") {
		return { approved: false, reason: "missionClosed", detail: `mission ${input.mission.number} is closed` };
	}
	const caller = input.caller;
	const authorised =
		(caller.kind === "leader" && caller.workspaceId === input.mission.workspaceId) ||
		(caller.kind === "lead" && input.mission.lead.kind === "agent" && input.mission.lead.agentId === caller.agentId);
	if (!authorised) {
		return {
			approved: false,
			reason: "notAuthorised",
			detail: "caller is not this mission's lead or workspace leader",
		};
	}
	const bullet = reservationFor(input.reservations, input.record);
	if (bullet !== undefined) {
		return { approved: false, reason: "reservedByCharter", detail: `charter reserves "${bullet}"` };
	}
	return { approved: true };
}
