import { createHash } from "node:crypto";
import type { Block } from "../core/types.ts";
import type { MeSource } from "./store.ts";

export async function readMeEvidence(
	store: {
		tailConversation(
			sessionId: string,
			options: { limit: number; cursor?: string },
		): Promise<{ blocks: Block[]; nextCursor?: string }>;
	},
	source: MeSource,
): Promise<{ text: string; complete: boolean }> {
	const pointer = source.transcriptPointer;
	if (!pointer) return { text: source.text, complete: true };
	const blocks: Block[] = [];
	let cursor = pointer.firstSeq - 1;
	let reachedEnd = false;
	for (let pageCount = 0; cursor < pointer.lastSeq && pageCount < 100; pageCount += 1) {
		const page = await store.tailConversation(pointer.sessionId, { limit: 200, cursor: String(cursor) });
		blocks.push(...page.blocks.filter((block) => block.seq >= pointer.firstSeq && block.seq <= pointer.lastSeq));
		if (page.blocks.some((block) => block.seq >= pointer.lastSeq)) reachedEnd = true;
		const next = page.nextCursor === undefined ? undefined : Number.parseInt(page.nextCursor, 10);
		if (next === undefined || !Number.isSafeInteger(next) || next <= cursor) break;
		cursor = next;
	}
	const text = blocks
		.filter((block) => block.turnId === pointer.turnId && block.role === "agent" && block.kind === "text")
		.map((block) => block.text)
		.join("\n\n");
	if (reachedEnd && createHash("sha256").update(text).digest("hex") === pointer.sourceHash)
		return { text, complete: true };
	return {
		text: `${source.text}\n[Original transcript available at ${pointer.sessionId}/${pointer.turnId}, blocks ${pointer.firstSeq}-${pointer.lastSeq}; full source was not verified.]`,
		complete: false,
	};
}
