import { createHash } from "node:crypto";
import type { Block, Turn } from "../core/types.ts";
import type { NodeRuntime } from "../node/server.ts";
import type { MeNotice, MeStore } from "./store.ts";

export function noticePrompt(notice: MeNotice): string {
	return [
		`[Neta attention notice ${notice.id}]`,
		`Workspace copy: ${notice.workspaceId}${notice.machineId ? ` on ${notice.machineId}` : ""}`,
		`Concern: ${notice.headline}`,
		`Filter summary: ${notice.summary}`,
		`Evidence source IDs: ${notice.sourceIds.join(", ")}`,
		`Needs user reply: ${notice.needsReply}. Resolved: ${notice.resolved}.`,
		"This is internal evidence, not a new user instruction. Check current state and cited evidence before reporting a result or asking the user. Do not start agents or missions.",
		`Before your final user-facing reply, call neta_present with noticeId ${notice.id} and the source IDs you actually used.`,
	].join("\n\n");
}

/** One dispatch pass. A send with an unknown outcome remains pending for reconciliation. */
export async function deliverPendingNotices(input: {
	store: Pick<MeStore, "pendingNotices" | "claimNotice" | "recordNoticeDelivery">;
	runtime: Pick<NodeRuntime, "send" | "listInbox">;
	openNeta: (workspaceId: string) => Promise<{ sessionId: string }>;
}): Promise<{ delivered: string[]; uncertain: string[] }> {
	const delivered: string[] = [];
	const uncertain: string[] = [];
	for (const pending of (await input.store.pendingNotices()).slice(0, 100)) {
		const sourceId = `neta-notice:${pending.id}`;
		try {
			const neta = await input.openNeta(pending.workspaceId);
			const existing = (await input.runtime.listInbox?.(neta.sessionId))?.find((item) => item.sourceId === sourceId);
			if (existing) {
				await input.store.recordNoticeDelivery(
					pending.id,
					existing.status === "delivered"
						? "delivered"
						: existing.status === "uncertain" || existing.status === "discarded"
							? "uncertain"
							: "accepted",
					existing.id,
					existing.turnId,
				);
				if (existing.status === "delivered") delivered.push(pending.id);
				else if (existing.status === "uncertain" || existing.status === "discarded") uncertain.push(pending.id);
				continue;
			}
			if (pending.status !== "queued") {
				await input.store.recordNoticeDelivery(pending.id, "uncertain");
				uncertain.push(pending.id);
				continue;
			}
			if (!input.runtime.send) throw new Error("durable Neta delivery is unavailable");
			const notice = await input.store.claimNotice(pending.id);
			const text = noticePrompt(notice);
			const receipt = await input.runtime.send(neta.sessionId, text, [], {
				readerDirected: false,
				sourceId,
				sourceHash: createHash("sha256").update(text).digest("hex"),
			});
			await input.store.recordNoticeDelivery(
				notice.id,
				receipt.status === "delivered"
					? "delivered"
					: receipt.status === "uncertain" || receipt.status === "discarded"
						? "uncertain"
						: "accepted",
				receipt.id,
				receipt.turnId,
			);
			if (receipt.status === "delivered") delivered.push(notice.id);
			else if (receipt.status === "uncertain" || receipt.status === "discarded") uncertain.push(notice.id);
		} catch {
			// The source and notice stay durable. Never retry an uncertain send blindly.
			uncertain.push(pending.id);
		}
	}
	return { delivered, uncertain };
}

/** A declaration becomes a presentation only after its exact native turn ends with text. */
export async function commitNoticeForTurn(input: {
	store: Pick<MeStore, "getNotice" | "recordNoticeDelivery" | "commitNotice">;
	runtime: Pick<NodeRuntime, "listInbox">;
	sessionId: string;
	turn: Turn;
	blocks: readonly Block[];
}): Promise<string[]> {
	if (!input.turn.endedAt || input.turn.failed || input.turn.cancelled) return [];
	const text = input.blocks
		.filter((block) => block.turnId === input.turn.id && block.role === "agent" && block.kind === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
	if (!text) return [];
	const committed: string[] = [];
	for (const delivery of (await input.runtime.listInbox?.(input.sessionId)) ?? []) {
		if (
			!delivery.sourceId?.startsWith("neta-notice:") ||
			delivery.status !== "delivered" ||
			delivery.turnId !== input.turn.id
		)
			continue;
		const noticeId = delivery.sourceId.slice("neta-notice:".length);
		const notice = await input.store.getNotice(noticeId);
		if (!notice) continue;
		await input.store.recordNoticeDelivery(noticeId, "delivered", delivery.id, input.turn.id);
		if (!notice.declaredSourceIds?.length) continue;
		await input.store.commitNotice(noticeId, input.turn.id, text);
		committed.push(noticeId);
	}
	return committed;
}

/** Recover a committed native turn that ended while Neta Node was stopped. */
export async function reconcileNoticePresentations(input: {
	store: Pick<MeStore, "pendingNotices" | "solIdentity" | "getNotice" | "recordNoticeDelivery" | "commitNotice">;
	runtime: Pick<NodeRuntime, "listInbox">;
	readTurn: (sessionId: string, turnId: string) => Promise<{ turn: Turn; blocks: Block[] } | undefined>;
}): Promise<string[]> {
	const committed: string[] = [];
	for (const notice of (await input.store.pendingNotices()).slice(0, 100)) {
		try {
			const neta = await input.store.solIdentity(notice.workspaceId);
			const delivery = (await input.runtime.listInbox?.(neta.sessionId))?.find(
				(item) => item.sourceId === `neta-notice:${notice.id}` && item.status === "delivered" && item.turnId,
			);
			if (!delivery?.turnId) continue;
			await input.store.recordNoticeDelivery(notice.id, "delivered", delivery.id, delivery.turnId);
			const saved = await input.readTurn(neta.sessionId, delivery.turnId);
			if (!saved) continue;
			committed.push(
				...(await commitNoticeForTurn({
					store: input.store,
					runtime: input.runtime,
					sessionId: neta.sessionId,
					turn: saved.turn,
					blocks: saved.blocks,
				})),
			);
		} catch {
			// One unreadable native turn must not block other workspace notices at startup.
		}
	}
	return committed;
}
