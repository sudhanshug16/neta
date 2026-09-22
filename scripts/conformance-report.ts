/** Required certification may not count missing or skipped probes as passing. */
export function assertRequiredReport(xml: string): void {
	if (!/<testcase\b/.test(xml)) throw new Error("Required conformance produced no test cases");
	if (/<skipped\b/.test(xml) || /\bskipped=["'][1-9]\d*["']/.test(xml))
		throw new Error("Required conformance contains skipped tests");
	if (/<(?:failure|error)\b/.test(xml) || /\b(?:failures|errors)=["'][1-9]\d*["']/.test(xml))
		throw new Error("Required conformance contains failed tests");
}
