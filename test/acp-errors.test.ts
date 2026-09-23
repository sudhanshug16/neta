import { expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { providerErrorMessage, providerFailureDetails, redactProviderText } from "../src/session/errors.ts";

test("retains nested provider causes and RPC code without dumping unrelated fields", () => {
	const error = new RequestError(-32603, "Internal error", {
		message: "Provider request failed",
		cause: { reason: "OAuth session expired" },
		accessToken: "private-value",
	});
	const text = providerErrorMessage(error);
	expect(text).toContain("provider -32603");
	expect(text).toContain("Provider request failed");
	expect(text).toContain("OAuth session expired");
	expect(text).not.toContain("private-value");
});

test("states when provider supplies no cause and preserves ordinary errors", () => {
	expect(providerErrorMessage(new RequestError(-32603, "Internal error"))).toContain("no additional error details");
	expect(providerErrorMessage(new Error("Socket closed"))).toBe("Socket closed");
});

test("captures actionable provider stderr and masks credential forms", () => {
	const text = providerFailureDetails(
		new Error("Internal error"),
		"debug startup\nERROR model not supported\nfailed Bearer private-token api_key=secret-value sk-secretkey",
	);
	expect(text).toContain("model not supported");
	expect(text).not.toContain("debug startup");
	for (const secret of ["private-token", "secret-value", "sk-secretkey"]) expect(text).not.toContain(secret);
});

test("startup diagnostics mask credentials in the error itself", () => {
	const message = "launch failed: Basic private-value password=secret-value sk-private-key";
	for (const text of [redactProviderText(message), providerFailureDetails(new Error(message), "")]) {
		expect(text).toContain("launch failed");
		for (const secret of ["private-value", "secret-value", "sk-private-key"]) expect(text).not.toContain(secret);
	}
});
