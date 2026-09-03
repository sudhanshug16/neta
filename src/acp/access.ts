import type { Access } from "../core/types.ts";
import type { AcpSession } from "./session.ts";

export interface ConfigQuirk {
	configId: string;
	readWriteValue: string | boolean;
	readOnlyValue: string | boolean;
}

export interface AccessSwitch {
	modes: string[];
	modeId: string;
	quirks: ConfigQuirk[];
}

export interface AccessSwitchOptions {
	// Whether the provider supports session/resume. The caller (which owns
	// settings) passes its resume flag; a false here fails before any side
	// effect. Omitted means resumable — a failed resume still throws, never
	// silently opening new.
	resume?: boolean;
}

// The agreed shape for now: same access needs nothing, anything else gets the
// one mode quirk. The session's current modeId is unavailable, so modes stays
// empty; T12.3 corrects this from the field.
export function planAccessSwitch(s: AcpSession, access: Access): AccessSwitch | undefined {
	if (s.access === access) {
		return undefined;
	}
	return {
		modes: [],
		modeId: "",
		quirks: [{ configId: "mode", readWriteValue: "bypassPermissions", readOnlyValue: "ask" }],
	};
}

export function quirkValue(q: ConfigQuirk, access: Access): string | boolean {
	return access === "readWrite" ? q.readWriteValue : q.readOnlyValue;
}

export class AccessSwitchUnsupported extends Error {
	readonly from: Access;
	readonly to: Access;

	constructor(from: Access, to: Access) {
		super(`access switch from ${from} to ${to} is not supported`);
		this.name = "AccessSwitchUnsupported";
		this.from = from;
		this.to = to;
	}
}

// Cancel, wait the turn boundary, apply quirks, relaunch — never downgrading
// (or upgrading) an agent mid-turn. Throws AccessSwitchUnsupported before
// cancelling when the session cannot resume (resume flag false) or when an
// upgrade to readWrite arrives without the quirk plan.
export async function switchAccess(
	session: AcpSession,
	to: Access,
	plan?: AccessSwitch,
	opts?: AccessSwitchOptions,
): Promise<void> {
	const from = session.access;
	if (from === to) {
		return;
	}
	if (opts?.resume === false) {
		throw new AccessSwitchUnsupported(from, to);
	}
	if (to === "readWrite" && plan === undefined) {
		throw new AccessSwitchUnsupported(from, to);
	}
	await session.cancel();
	while (session.openTurnId !== undefined) {
		await new Promise((done) => setTimeout(done, 10));
	}
	for (const quirk of plan?.quirks ?? []) {
		await session.setConfigOption(quirk.configId, quirkValue(quirk, to));
	}
	await session.relaunch(to);
}
