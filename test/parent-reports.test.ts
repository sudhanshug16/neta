import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openParentReportStore, type ParentReport, parentReportId } from "../src/store/parent-reports.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
function report(turnId: string): ParentReport {
	return {
		id: parentReportId("s", turnId),
		actorId: "a",
		sessionId: "s",
		turnId,
		workspaceId: "w",
		missionId: "m",
		model: "small/model",
		text: `result ${turnId}`,
		createdAt: "2026-01-01",
		status: "pending",
	};
}
test("immutable turn results survive restart and terminal receipts survive many later results", async () => {
	const directory = await mkdtemp(join(tmpdir(), "neta-results-"));
	directories.push(directory);
	const first = openParentReportStore(directory);
	await Promise.all([
		first.record(report("a")),
		first.record({ ...report("a"), text: "replacement" }),
		first.record(report("b")),
	]);
	const reopened = openParentReportStore(directory);
	expect((await reopened.pending()).map((item) => item.turnId)).toEqual(["a", "b"]);
	expect((await reopened.pending()).map((item) => item.text).sort()).toEqual(["result a", "result b"]);
	await reopened.settle(report("a").id, "accepted", "receipt", "parent");
	for (let i = 0; i < 105; i++) {
		const item = report(String(i));
		await reopened.record(item);
		await reopened.settle(item.id, "accepted");
	}
	const retained = await openParentReportStore(directory).record({ ...report("a"), text: "duplicate" });
	expect(retained.status).toBe("accepted");
	expect(retained.text).toBe("");
	expect(retained.receiptId).toBe("receipt");
	expect((await reopened.pending()).map((item) => item.turnId)).toEqual(["b"]);
	expect((await stat(join(directory, "parent-results", `${report("a").id}.json`))).mode & 0o777).toBe(0o600);
});
test("settlement is idempotent and identity rejects unsafe filenames", async () => {
	const directory = await mkdtemp(join(tmpdir(), "neta-results-"));
	directories.push(directory);
	const store = openParentReportStore(directory);
	await store.record(report("a"));
	await store.settle(report("a").id, "suppressed");
	await store.settle(report("a").id, "accepted");
	expect((await store.record(report("a"))).status).toBe("suppressed");
	await expect(store.record({ ...report("b"), id: "../other" })).rejects.toThrow("invalid result identity");
});
