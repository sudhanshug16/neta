import { rm } from "node:fs/promises";
import type { IsoTime, SessionId, TurnId, WorkspaceId } from "../core/types.ts";
import { createMutex, readJson, writeJsonAtomic } from "./files.ts";
import { paths } from "./paths.ts";

export const GLANCE_MAX_SOURCE_BYTES = 256 * 1024;
export const GLANCE_MAX_REVIEWED_CARDS = 100;
export type GlanceResult =
	| { kind: "onDeviceSummary"; headline: string; bullets: string[]; engine: "apple-on-device"; schemaVersion: number }
	| { kind: "excerptFallback"; excerpt: string; reason: "unavailable" | "generationFailed" | "sourceTooLarge" };
export interface GlanceCard {
	id: string;
	workspaceId: WorkspaceId;
	glanceSeq: number;
	at: IsoTime;
	sessionId: SessionId;
	turnId: TurnId;
	firstBlockSeq: number;
	lastBlockSeq: number;
	sourceHash: string;
	source: string;
	preview: string;
	sourceTruncated?: boolean;
	interrupted: boolean;
	actorKind: "leader" | "agent";
	missionId?: string;
	agentId?: string;
	agentLabel?: string;
	result?: GlanceResult;
}
interface Document {
	version: 1;
	nextSeq: number;
	reviewedThroughGlanceSeq: number;
	cards: GlanceCardMetadata[];
}
export type GlanceCardMetadata = Omit<GlanceCard, "source">;
const empty = (): Document => ({ version: 1, nextSeq: 1, reviewedThroughGlanceSeq: 0, cards: [] });
export interface GlanceStore {
	upsert(card: Omit<GlanceCard, "glanceSeq">): Promise<GlanceCard>;
	list(
		workspaceId: WorkspaceId,
		after?: number,
		limit?: number,
	): Promise<{ cards: GlanceCardMetadata[]; reviewedThroughGlanceSeq: number; hasMore: boolean }>;
	get(workspaceId: WorkspaceId, id: string): Promise<GlanceCard | undefined>;
	complete(
		workspaceId: WorkspaceId,
		id: string,
		sourceHash: string,
		result: GlanceResult,
	): Promise<GlanceCardMetadata | undefined>;
	markReviewed(workspaceId: WorkspaceId, through: number): Promise<number>;
}
function truncateUTF8(value: string, bytes: number): { value: string; truncated: boolean } {
	const source = Buffer.from(value, "utf8");
	if (source.byteLength <= bytes) return { value, truncated: false };
	let valueBytes = source.subarray(0, bytes);
	while (valueBytes.length > 0 && valueBytes.toString("utf8").endsWith("�")) valueBytes = valueBytes.subarray(0, -1);
	return { value: valueBytes.toString("utf8"), truncated: true };
}
export function validateGlanceResult(result: GlanceResult): GlanceResult {
	if (typeof result !== "object" || result === null) throw new Error("invalid Glance result");
	if (result.kind === "onDeviceSummary") {
		if (
			typeof result.headline !== "string" ||
			!Array.isArray(result.bullets) ||
			!result.bullets.every((x) => typeof x === "string")
		)
			throw new Error("invalid on-device Glance summary");
		const headline = result.headline.trim();
		const bullets = result.bullets.map((x) => x.trim()).filter(Boolean);
		if (
			!headline ||
			headline.length > 160 ||
			bullets.length > 3 ||
			bullets.some((x) => x.length > 300) ||
			result.engine !== "apple-on-device" ||
			!Number.isSafeInteger(result.schemaVersion) ||
			result.schemaVersion < 1
		)
			throw new Error("invalid on-device Glance summary");
		return { ...result, headline, bullets };
	}
	if (
		result.kind !== "excerptFallback" ||
		typeof result.excerpt !== "string" ||
		!["unavailable", "generationFailed", "sourceTooLarge"].includes(result.reason)
	)
		throw new Error("invalid Glance fallback reason");
	const excerpt = result.excerpt.trim();
	if (!excerpt || excerpt.length > 1200) throw new Error("invalid Glance fallback excerpt");
	return { ...result, excerpt };
}
export function openGlanceStore(): GlanceStore {
	const mutex = createMutex();
	const load = async (id: WorkspaceId): Promise<Document> =>
		(await readJson<Document>(paths().glanceLog(id))) ?? empty();
	const save = (id: WorkspaceId, doc: Document) => writeJsonAtomic(paths().glanceLog(id), doc);
	const loadSource = async (workspaceId: WorkspaceId, id: string): Promise<string | undefined> =>
		(await readJson<{ source: string }>(paths().glanceSource(workspaceId, id)))?.source;
	return {
		upsert: (draft) =>
			mutex(async () => {
				const doc = await load(draft.workspaceId);
				const existing = doc.cards.find((x) => x.id === draft.id);
				if (existing?.sourceHash === draft.sourceHash) {
					const source = await loadSource(draft.workspaceId, draft.id);
					if (source !== undefined) return { ...existing, source };
				}
				const bounded = truncateUTF8(draft.source, GLANCE_MAX_SOURCE_BYTES);
				const card: GlanceCardMetadata = {
					...draft,
					...(bounded.truncated ? { sourceTruncated: true } : {}),
					glanceSeq: existing?.glanceSeq ?? doc.nextSeq++,
				};
				delete (card as Partial<GlanceCard>).source;
				await writeJsonAtomic(paths().glanceSource(draft.workspaceId, card.id), { source: bounded.value });
				doc.cards = [...doc.cards.filter((x) => x.id !== card.id), card].sort((a, b) => a.glanceSeq - b.glanceSeq);
				await save(draft.workspaceId, doc);
				return { ...card, source: bounded.value };
			}),
		list: (workspaceId, after = 0, limit = 20) =>
			mutex(async () => {
				const doc = await load(workspaceId);
				// Glance is an unread queue. Reviewed history is retained only to keep
				// the durable cursor and source links stable, not replayed on every load.
				const candidates = doc.cards.filter((x) => x.glanceSeq > Math.max(after, doc.reviewedThroughGlanceSeq));
				const take = candidates.slice(0, Math.min(Math.max(limit, 1), 100));
				return {
					cards: take,
					reviewedThroughGlanceSeq: doc.reviewedThroughGlanceSeq,
					hasMore: candidates.length > take.length,
				};
			}),
		get: (workspaceId, id) =>
			mutex(async () => {
				const card = (await load(workspaceId)).cards.find((x) => x.id === id);
				if (!card) return undefined;
				const source = await loadSource(workspaceId, id);
				return source === undefined ? undefined : { ...card, source };
			}),
		complete: (workspaceId, id, sourceHash, result) =>
			mutex(async () => {
				const doc = await load(workspaceId);
				const index = doc.cards.findIndex((x) => x.id === id);
				const existing = doc.cards[index];
				if (existing === undefined || existing.sourceHash !== sourceHash) return undefined;
				const card = { ...existing, result: validateGlanceResult(result) };
				doc.cards[index] = card;
				await save(workspaceId, doc);
				return card;
			}),
		markReviewed: (workspaceId, through) =>
			mutex(async () => {
				const doc = await load(workspaceId);
				const latest = doc.nextSeq - 1;
				if (through > latest) throw new Error("Glance review cursor is beyond the latest card");
				doc.reviewedThroughGlanceSeq = Math.max(doc.reviewedThroughGlanceSeq, through);
				const reviewed = doc.cards
					.filter((x) => x.glanceSeq <= doc.reviewedThroughGlanceSeq)
					.slice(-GLANCE_MAX_REVIEWED_CARDS);
				const unread = doc.cards.filter((x) => x.glanceSeq > doc.reviewedThroughGlanceSeq);
				const kept = [...reviewed, ...unread];
				const keptIds = new Set(kept.map((card) => card.id));
				const removed = doc.cards.filter((card) => !keptIds.has(card.id));
				doc.cards = kept;
				await save(workspaceId, doc);
				await Promise.all(removed.map((card) => rm(paths().glanceSource(workspaceId, card.id), { force: true })));
				return doc.reviewedThroughGlanceSeq;
			}),
	};
}
