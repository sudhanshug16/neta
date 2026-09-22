import { RequestError } from "@agentclientprotocol/sdk";

export function redactProviderText(text: string): string {
	return text
		.replace(/(Bearer|Basic)\s+[^\s"']+/gi, "$1 [redacted]")
		.replace(/((?:access_token|refresh_token|api_key|authorization|password)\s*[=:]\s*)[^\s,}]+/gi, "$1[redacted]")
		.replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]");
}

/** Preserve diagnostic text from ACP errors without dumping arbitrary payloads. */
export function providerErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (!(error instanceof RequestError)) return message;
	const details: string[] = [];
	const visit = (value: unknown, depth: number): void => {
		if (depth > 3) return;
		if (typeof value === "string") {
			if (value && value !== message && !details.includes(value)) details.push(value);
		} else if (value !== null && typeof value === "object") {
			for (const key of ["message", "details", "detail", "reason", "cause", "error"]) {
				if (key in value) visit((value as Record<string, unknown>)[key], depth + 1);
			}
		}
	};
	visit(error.data, 0);
	return `${message} (ACP ${error.code})${details.length ? `\n${details.join("\n").slice(0, 8000)}` : "\nThe provider returned no additional error details."}`;
}

/** Only surface recent diagnostic lines, with common credential forms removed. */
export function providerFailureDetails(error: unknown, stderr: string): string {
	const lines = stderr
		.split("\n")
		.filter((line) => /error|failed|unauthorized|rate.limit|expired|not.supported/i.test(line))
		.slice(-12);
	const diagnostic = redactProviderText(lines.join("\n").slice(-6000));
	return (
		redactProviderText(providerErrorMessage(error)) + (diagnostic ? `\n\nProvider diagnostics:\n${diagnostic}` : "")
	);
}
