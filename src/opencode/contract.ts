/** The verified version-one native bridge declarations, not a live account probe. */
export interface OpenCodeExecutionContract {
	version: 1;
	runtime: "opencode-native";
	resume: "exact-provider-session";
	instructions: "system-per-request";
	instructionAcknowledgment: "local-request-hook";
	fallback: "ordered-allowlist-or-connected-default";
	fallbackAfterOutput: false;
	modelVariants: "catalog-validated";
	readiness: "configured-connection-not-authentication-proof";
	leaderAccess: "unrestricted";
	workerShellAccess: "instruction-guided";
	workerEditAccess: "assigned-permission-policy";
	delegation: "neta-owned";
}

const expected: OpenCodeExecutionContract = {
	version: 1,
	runtime: "opencode-native",
	resume: "exact-provider-session",
	instructions: "system-per-request",
	instructionAcknowledgment: "local-request-hook",
	fallback: "ordered-allowlist-or-connected-default",
	fallbackAfterOutput: false,
	modelVariants: "catalog-validated",
	readiness: "configured-connection-not-authentication-proof",
	leaderAccess: "unrestricted",
	workerShellAccess: "instruction-guided",
	workerEditAccess: "assigned-permission-policy",
	delegation: "neta-owned",
};

export function openCodeExecutionContract(value: unknown): OpenCodeExecutionContract | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object") throw new Error("OpenCode advertised an invalid Neta execution contract");
	const contract = value as Record<string, unknown>;
	if (!Object.entries(expected).every(([key, entry]) => contract[key] === entry))
		throw new Error("OpenCode advertised an incompatible Neta execution contract; update the paired runtime");
	return { ...expected };
}
