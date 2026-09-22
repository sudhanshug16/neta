import { expect, test } from "bun:test";
import { assertRequiredReport } from "../scripts/conformance-report.ts";

test("required release reports reject skips, failures, and empty discovery", () => {
	expect(() =>
		assertRequiredReport('<testsuite tests="1" skipped="0"><testcase name="native" /></testsuite>'),
	).not.toThrow();
	expect(() => assertRequiredReport('<testsuite tests="0" />')).toThrow("no test cases");
	expect(() => assertRequiredReport('<testsuite skipped="1"><testcase name="native" /></testsuite>')).toThrow(
		"skipped",
	);
	expect(() => assertRequiredReport("<testsuite><testcase><skipped /></testcase></testsuite>")).toThrow("skipped");
	expect(() =>
		assertRequiredReport('<testsuite><testcase><failure message="missing runtime" /></testcase></testsuite>'),
	).toThrow("failed");
});
