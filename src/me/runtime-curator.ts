import type { Turn } from "../core/types.ts";
import type { NodeRuntime } from "../node/server.ts";
import type { MeClassifier } from "./curator.ts";
import type { MeStore } from "./store.ts";

/** A native Filter turn ends by calling send_message or by saying nothing useful. */
export function createRuntimeMeClassifier(input: {
	runtime: Pick<NodeRuntime, "send" | "listInbox" | "onTurn">;
	sessionId: string;
	store: MeStore;
	readTurn?: (sessionId: string, turnId: string) => Promise<{ turn: Turn } | undefined>;
	timeoutMs?: number;
}): MeClassifier {
	const completed = new Map<string, Turn>();
	input.runtime.onTurn((notification) => {
		const turn = notification.turn;
		if (notification.sessionId !== input.sessionId || !turn?.endedAt) return;
		completed.set(turn.id, turn);
		if (completed.size > 30) completed.delete(completed.keys().next().value as string);
	});
	return async ({ source }) => {
		if (!input.runtime.send || !input.runtime.listInbox) throw new Error("Filter native inbox is unavailable");
		const noticeBefore = await input.store.getNotice(source.id);
		const sourceId = `filter-decision:${source.id}${noticeBefore?.retryGeneration ? `:${noticeBefore.retryGeneration}` : ""}`;
		const label = source.kind === "message" ? "Coordinator completed reply" : "Coordinator or runtime update";
		const prompt = `${label} (${source.at}):\n\n${source.text}\n\nCheck the recent Workspace leader conversation. If the leader told the user it was waiting for this answer, call neta.send_message with a self-contained answer now. The leader's earlier statement that it asked the Coordinator did not answer the user. For other replies, decide whether the leader needs an update. Call neta.send_message before ending the turn whenever an update is needed; do not describe a plan to send it. If no update is needed, end without a tool call or final text.`;
		const receipt = await input.runtime.send(input.sessionId, prompt, [], { readerDirected: false, sourceId });
		if (receipt.status === "discarded") {
			await input.store.advanceFilterRetry(source.id);
			throw new Error("Filter decision prompt was discarded before delivery");
		}
		const deadline = Date.now() + (input.timeoutMs ?? 120_000);
		for (;;) {
			const item = (await input.runtime.listInbox(input.sessionId)).find((message) => message.sourceId === sourceId);
			if (item?.status === "discarded") {
				await input.store.advanceFilterRetry(source.id);
				throw new Error("Filter decision prompt was discarded before delivery");
			}
			const turn = item?.turnId
				? (completed.get(item.turnId) ?? (await input.readTurn?.(input.sessionId, item.turnId))?.turn)
				: undefined;
			if (turn) {
				if (turn.failed || turn.cancelled) throw new Error("Filter decision turn did not complete");
				const notice = await input.store.getNotice(source.id);
				if (notice?.decision?.action === "send") return notice.decision;
				if (turn.finalReply?.trim()) {
					await input.store.advanceFilterRetry(source.id);
					throw new Error("Filter wrote a final reply without calling send_message; no update was delivered");
				}
				return { action: "suppress", reason: "Filter chose not to send an update" };
			}
			if (Date.now() >= deadline) throw new Error("Filter decision turn timed out");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
}
