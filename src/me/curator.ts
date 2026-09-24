import type { MeCard, MeDecision, MeNotice, MeSource, MeStore } from "./store.ts";

export interface MeCurator {
	run(limit?: number): Promise<{ processed: MeCard[]; pending: number; failed: string[] }>;
	drain(limit?: number, maxBatches?: number): Promise<{ processed: MeCard[]; pending: number; failed: string[] }>;
}

export interface MeClassifierInput {
	source: MeSource;
	relatedSources?: MeSource[];
	recentCards: MeCard[];
	recentPresentations?: MeNotice[];
	details?: { sourceId: string; text: string; complete: boolean }[];
	instructions: string;
}

export type MeClassifier = (input: MeClassifierInput) => Promise<unknown>;

export const ME_CURATOR_INSTRUCTIONS = `You filter attention for one workspace on one machine. Read this source, bounded recent concerns, and what Neta already presented in its native chat.
Return one JSON object with action (surface, update, suppress, defer, resolve, request_detail). For surface, update, suppress, and resolve include concernKey, headline, summary, evidenceSourceIds, needsReply, resolved, and destinationSessionIds. Related sources are a small same-work batch; cite each source ID your decision covers so Node can checkpoint them together. For defer include concernKey, reason, and until as an ISO date within 24 hours. For request_detail include sourceIds (one to three from this workspace, including the current source). Detail may be requested once for this source; the next answer must decide.
Surface direct questions, permission requests and failures requiring attention. Update an existing concern only when there is new information or resolution. Resolve only with new evidence that answers or clears the prior concern and cite both sources. Defer routine progress with a deadline. Suppress redundant progress; do not create one card per tool event. Keep the summary short and evidence-linked. Never invent evidence, destinations, permissions, answers, or a resolution. A question awaiting a reply must remain visible. Permission records include the native runtime's actual disposition: do not ask the user to approve a request that has already been accepted or rejected. A transcript pointer means the text field is only a bounded preview; do not claim to have read omitted transcript material. You do not issue commands or act on the user's behalf. Replies are forwarded verbatim by the delivery service to a selected actual session.`;

/** A caller supplies the configured exact model transport. No alternate provider or local heuristic classifier is used. */
export function createMeCurator(options: {
	store: MeStore;
	classify: MeClassifier;
	loadDetail?: (source: MeSource) => Promise<{ text: string; complete: boolean }>;
}): MeCurator {
	const run = async (limit = 20) => {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid Me curator batch limit");
		const sources = (await options.store.pendingSources()).slice(0, limit);
		const processed: MeCard[] = [];
		const failed: string[] = [];
		const consumed = new Set<string>();
		for (const source of sources) {
			if (consumed.has(source.id)) continue;
			try {
				const at = Date.parse(source.at);
				const relatedSources = sources
					.filter(
						(item) =>
							item.id !== source.id &&
							!consumed.has(item.id) &&
							item.workspaceId === source.workspaceId &&
							item.sessionId === source.sessionId &&
							item.missionId === source.missionId &&
							!item.questionId &&
							!source.questionId &&
							Math.abs(Date.parse(item.at) - at) <= 10_000,
					)
					.slice(0, 4);
				const page = await options.store.list({
					workspaceId: source.workspaceId,
					includeSuppressed: true,
					limit: 30,
				});
				const recentCards = page.cards;
				const recentPresentations = await options.store.listPresentations(source.workspaceId, 8);
				const classifierInput: MeClassifierInput = {
					source,
					relatedSources,
					recentCards,
					recentPresentations,
					instructions: ME_CURATOR_INSTRUCTIONS,
				};
				let decision: unknown = await options.classify(classifierInput);
				if (typeof decision !== "object" || decision === null || Array.isArray(decision))
					throw new Error("invalid filter decision");
				let value = decision as Record<string, unknown>;
				if (value.action === "request_detail") {
					const ids = value.sourceIds;
					if (
						!options.loadDetail ||
						!Array.isArray(ids) ||
						ids.length < 1 ||
						ids.length > 3 ||
						!ids.includes(source.id) ||
						ids.some((id) => typeof id !== "string")
					)
						throw new Error("invalid filter detail request");
					const details: NonNullable<MeClassifierInput["details"]> = [];
					for (const id of ids as string[]) {
						const selected = await options.store.getSource(id);
						if (!selected || selected.workspaceId !== source.workspaceId)
							throw new Error("cross-workspace filter detail");
						const detail = await options.loadDetail(selected);
						details.push({
							sourceId: id,
							text: detail.text.slice(0, 12_000),
							complete: detail.complete && detail.text.length <= 12_000,
						});
					}
					decision = await options.classify({ ...classifierInput, details });
					if (typeof decision !== "object" || decision === null || Array.isArray(decision))
						throw new Error("invalid filter detail decision");
					value = decision as Record<string, unknown>;
					if (value.action === "request_detail") throw new Error("filter detail budget exhausted");
				}
				if (value.action === "defer") {
					await options.store.defer(
						source.id,
						value.until as string,
						value.reason as string,
						value.concernKey as string,
					);
					continue;
				}
				const card = await options.store.decide(source.id, value as unknown as MeDecision);
				if (card) {
					processed.push(card);
					for (const id of card.evidenceSourceIds) consumed.add(id);
				}
			} catch {
				// Transport failure, invalid model JSON, or failed persistence leaves the source pending.
				// Never log raw model output or source text.
				const attempts = await options.store.recordClassifierFailure(source.id);
				if (source.forceVisible && attempts >= 3) {
					try {
						const card = await options.store.decide(source.id, {
							action: "surface",
							concernKey: `urgent:${source.id}`,
							headline: source.questionId ? "Question needs your answer" : "Workspace attention needed",
							summary: source.text.slice(0, 1_200),
							evidenceSourceIds: [source.id],
							needsReply: source.questionId !== undefined,
							resolved: false,
							destinationSessionIds: source.destinationSessionIds,
						});
						if (card) processed.push(card);
					} catch {
						failed.push(source.id);
					}
				} else failed.push(source.id);
			}
		}
		return { processed, failed, pending: (await options.store.pendingSources()).length };
	};
	return {
		run,
		drain: async (limit = 20, maxBatches = 5) => {
			if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 20)
				throw new Error("invalid Me curator drain batch limit");
			const processed: MeCard[] = [];
			const failed = new Set<string>();
			let pending = 0;
			for (let batch = 0; batch < maxBatches; batch += 1) {
				const result = await run(limit);
				processed.push(...result.processed);
				for (const id of result.failed) failed.add(id);
				pending = result.pending;
				if (pending === 0 || result.processed.length === 0 || result.failed.length > 0) break;
			}
			return { processed, pending, failed: [...failed] };
		},
	};
}
