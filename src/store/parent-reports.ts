import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createMutex, readJson, writeJsonAtomic } from "./files.ts";

export interface ParentReport {
	id: string;
	actorId: string;
	sessionId: string;
	turnId: string;
	bindingGeneration?: string;
	workspaceId: string;
	missionId: string;
	parentActorId?: string;
	model: string;
	text: string;
	createdAt: string;
	status: "pending" | "accepted" | "suppressed";
	receiptId?: string;
	parentSessionId?: string;
}
export interface ParentReportStore {
	get(id: string): Promise<ParentReport | undefined>;
	record(report: ParentReport): Promise<ParentReport>;
	pending(): Promise<ParentReport[]>;
	settle(id: string, status: "accepted" | "suppressed", receiptId?: string, parentSessionId?: string): Promise<void>;
}
export function parentReportId(
	sessionId: string,
	turnId: string,
	bindingGeneration?: string,
	actorId?: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify([sessionId, turnId, bindingGeneration ?? "legacy", actorId ?? "legacy"]))
		.digest("hex");
}
/** One immutable report per turn; small terminal receipts survive transcript compaction. */
export function openParentReportStore(root: string): ParentReportStore {
	const directory = join(root, "parent-results");
	const lock = createMutex();
	const path = (id: string) => {
		if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid result identity");
		return join(directory, `${id}.json`);
	};
	return {
		get: (id) => lock(() => readJson<ParentReport>(path(id))),
		record: (report) =>
			lock(async () => {
				const existing = await readJson<ParentReport>(path(report.id));
				if (existing) return existing;
				await writeJsonAtomic(path(report.id), report);
				return report;
			}),
		pending: () =>
			lock(async () => {
				const names = await readdir(directory).catch((error: unknown) => {
					if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
					throw error;
				});
				const pending: ParentReport[] = [];
				for (const name of names) {
					if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
					const report = await readJson<ParentReport>(join(directory, name));
					if (report?.status === "pending") pending.push(report);
				}
				return pending.sort(
					(a, b) =>
						a.createdAt.localeCompare(b.createdAt) ||
						a.turnId.localeCompare(b.turnId) ||
						a.id.localeCompare(b.id),
				);
			}),
		settle: (id, status, receiptId, parentSessionId) =>
			lock(async () => {
				const report = await readJson<ParentReport>(path(id));
				if (!report || report.status !== "pending") return;
				await writeJsonAtomic(path(id), { ...report, status, text: "", receiptId, parentSessionId });
			}),
	};
}
