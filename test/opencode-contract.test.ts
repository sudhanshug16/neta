import { expect, test } from "bun:test";
import { openCodeExecutionContract } from "../src/opencode/contract.ts";
import { openCodeEndpoint } from "../src/opencode/attachment.ts";

const contract = {
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
} as const;

test("native capability declarations are verified and never equate connection configuration with authentication", () => {
	expect(openCodeExecutionContract(undefined)).toBeUndefined();
	expect(openCodeExecutionContract(contract)).toEqual(contract);
	for (const altered of [
		{ version: 2 },
		{ workerShellAccess: "sandboxed" },
		{ readiness: "authenticated" },
		{ fallbackAfterOutput: true },
	])
		expect(() => openCodeExecutionContract({ ...contract, ...altered })).toThrow("incompatible");
	const attachment = openCodeEndpoint({
		"neta.opencode": { url: "http://127.0.0.1:1234", authorization: "Basic fixture", apiVersion: 2, contract },
	});
	expect(attachment?.contract).toEqual(contract);
});
