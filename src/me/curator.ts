import type { MeCard, MeDecision, MeSource, MeStore } from "./store.ts";

export interface MeCurator {
	run(limit?: number): Promise<{ processed: MeCard[]; pending: number; failed: string[] }>;
}

export interface MeClassifierInput {
	source: MeSource;
	recentCards: MeCard[];
	instructions: string;
}

export type MeClassifier = (input: MeClassifierInput) => Promise<unknown>;

export const ME_CURATOR_INSTRUCTIONS = `You curate one person's cross-workspace attention feed. Read this source and the bounded recent card context.
Return exactly one JSON object with action (surface, update, suppress), concernKey, headline, summary, evidenceSourceIds, needsReply, resolved, and destinationSessionIds.
Surface direct questions, permission requests and failures requiring attention. Update an existing concern only when there is new information or resolution. Suppress redundant or routine progress; do not create one card per tool event. Keep the summary short and evidence-linked. Never invent evidence, destinations, permissions, answers, or a resolution. A question awaiting a reply must remain visible. Permission records include the native runtime's actual disposition: do not ask the user to approve a request that has already been accepted or rejected. A transcript pointer means the text field is only a bounded preview; do not claim to have read omitted transcript material. You do not issue commands or act on the user's behalf. Replies are forwarded verbatim by the delivery service to a selected actual session.`;

/** A caller supplies the configured exact model transport. No alternate provider or local heuristic classifier is used. */
export function createMeCurator(options: { store: MeStore; classify: MeClassifier }): MeCurator {
	return {
		run: async (limit = 20) => {
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
				throw new Error("invalid Me curator batch limit");
			const sources = (await options.store.pendingSources()).slice(0, limit);
			const processed: MeCard[] = [];
			const failed: string[] = [];
			for (const source of sources) {
				try {
					const page = await options.store.list({ includeSuppressed: true, limit: 30 });
					const recentCards = page.cards.filter((card) => card.workspaceId === source.workspaceId);
					const decision = (await options.classify({
						source,
						recentCards,
						instructions: ME_CURATOR_INSTRUCTIONS,
					})) as MeDecision;
					const card = await options.store.decide(source.id, decision);
					if (card) processed.push(card);
				} catch {
					// Transport failure, invalid model JSON, or failed persistence leaves the source pending.
					// Never log raw model output or source text.
					failed.push(source.id);
				}
			}
			return { processed, failed, pending: (await options.store.pendingSources()).length };
		},
	};
}
