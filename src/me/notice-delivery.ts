import type { Block, Turn } from "../core/types.ts";
import type { NodeRuntime } from "../node/server.ts";
import type { MeNotice, MeStore } from "./store.ts";

export function noticePrompt(notice: MeNotice): string {
	return `Workspace update:\n\n${notice.text ?? ""}`;
}
export async function canDeliverNetaNotice(
	message: { sessionId: string; sourceId?: string },
	store: MeStore,
	machineId: string,
): Promise<boolean> {
	if (!message.sourceId?.startsWith("neta-notice:")) return false;
	const notice = await store.getNotice(message.sourceId.slice(12));
	if (!notice || notice.state !== "delivery pending" || (notice.machineId && notice.machineId !== machineId))
		return false;
	const owner = (await store.listWorkspaceLeaderIdentities()).find((n) => n.workspaceId === notice.workspaceId);
	return owner?.sessionId === message.sessionId && (!owner.machineId || owner.machineId === machineId);
}
export async function deliverPendingNotices(input: {
	store: MeStore;
	runtime: Pick<NodeRuntime, "send" | "listInbox">;
	openNeta: (workspaceId: string) => Promise<{ sessionId: string }>;
	readTurn?: (sessionId: string, turnId: string) => Promise<{ turn: Turn; blocks: Block[] } | undefined>;
	workspaceId?: string;
}): Promise<{ delivered: string[]; uncertain: string[] }> {
	const delivered: string[] = [];
	const uncertain: string[] = [];
	for (const notice of await input.store.pendingNotices(input.workspaceId)) {
		try {
			const owner = await input.openNeta(notice.workspaceId);
			const sourceId = `neta-notice:${notice.id}`;
			const inbox = (await input.runtime.listInbox?.(owner.sessionId)) ?? [];
			let receipt = inbox.find((m) => m.sourceId === sourceId);
			if (!receipt) {
				if (!input.runtime.send) throw new Error("Durable delivery unavailable");
				receipt = await input.runtime.send(owner.sessionId, noticePrompt(notice), [], {
					readerDirected: false,
					sourceId,
				});
			}
			await input.store.recordNoticeDelivery(notice.id, receipt);
			if (receipt.status === "delivered") delivered.push(notice.id);
			if (receipt.status === "uncertain") uncertain.push(notice.id);
		} catch (error) {
			await input.store.recordNoticeDelivery(notice.id, { status: "uncertain", error: String(error) });
			uncertain.push(notice.id);
		}
	}
	return { delivered, uncertain };
}
export async function commitNoticeForTurn(input: {
	store: MeStore;
	runtime: Pick<NodeRuntime, "listInbox">;
	sessionId: string;
	turn: Turn;
	blocks: readonly Block[];
}): Promise<string[]> {
	if (!input.turn.endedAt || input.turn.failed || input.turn.cancelled || !input.turn.finalReply) return [];
	const ids: string[] = [];
	for (const item of (await input.runtime.listInbox?.(input.sessionId)) ?? []) {
		if (!item.sourceId?.startsWith("neta-notice:") || item.status !== "delivered" || item.turnId !== input.turn.id)
			continue;
		const id = item.sourceId.slice(12);
		if (!(await input.store.getNotice(id))) continue;
		await input.store.recordNoticeDelivery(id, item);
		await input.store.commitNotice(id, input.turn.id, input.turn.finalReply);
		ids.push(id);
	}
	return ids;
}
export async function reconcileNoticePresentations(input: {
	store: MeStore;
	runtime: Pick<NodeRuntime, "listInbox">;
	readTurn: (sessionId: string, turnId: string) => Promise<{ turn: Turn; blocks: Block[] } | undefined>;
}): Promise<string[]> {
	const ids: string[] = [];
	for (const notice of await input.store.diagnostics()) {
		if (notice.presentedAt || (notice.state !== "delivered" && notice.state !== "delivery pending")) continue;
		const owner = await input.store.workspaceLeaderIdentity(notice.workspaceId);
		const item = (await input.runtime.listInbox?.(owner.sessionId))?.find(
			(m) => m.sourceId === `neta-notice:${notice.id}`,
		);
		if (item?.status !== "delivered" || !item.turnId) continue;
		const saved = await input.readTurn(owner.sessionId, item.turnId);
		if (saved) ids.push(...(await commitNoticeForTurn({ ...input, sessionId: owner.sessionId, ...saved })));
	}
	return ids;
}
