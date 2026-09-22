import { createHash } from "node:crypto";
import { ulid } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import type { InboxMessage, PromptAttachment, SessionId, TurnId } from "../core/types.ts";
import { createMutex, type Mutex, readJson, writeJsonAtomic } from "./files.ts";
import { paths } from "./paths.ts";

export const MAX_INBOX_MESSAGES = 20;
export const MAX_INBOX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface ConversationInboxStore {
	list(sessionId: SessionId): Promise<InboxMessage[]>;
	enqueue(
		sessionId: SessionId,
		text: string,
		attachments: PromptAttachment[],
		origin?: { readerDirected: boolean; sourceId?: string; sourceHash?: string },
	): Promise<InboxMessage>;
	markMany(
		sessionId: SessionId,
		ids: string[],
		status: InboxMessage["status"],
		turnId?: TurnId,
	): Promise<InboxMessage[]>;
	markDiscarded(sessionId: SessionId, id: string): Promise<InboxMessage>;
	markDelivering(sessionId: SessionId, id: string): Promise<InboxMessage>;
	markQueued(sessionId: SessionId, id: string): Promise<InboxMessage>;
	markDelivered(sessionId: SessionId, id: string, turnId: TurnId): Promise<InboxMessage>;
	markUncertain(sessionId: SessionId, id: string): Promise<InboxMessage>;
	discardQueued(sessionId: SessionId): Promise<InboxMessage[]>;
	discardAll(sessionId: SessionId): Promise<InboxMessage[]>;
}

function bytes(items: InboxMessage[]): number {
	return items
		.filter((item) => item.status === "queued" || item.status === "delivering" || item.status === "uncertain")
		.reduce(
			(sum, item) =>
				sum +
				item.attachments.reduce((n, attachment) => n + Buffer.from(attachment.dataBase64, "base64").byteLength, 0),
			0,
		);
}

export function openConversationInboxStore(): ConversationInboxStore {
	const locks = new Map<SessionId, Mutex>();
	const lock = (id: SessionId): Mutex => {
		let found = locks.get(id);
		if (found === undefined) {
			found = createMutex();
			locks.set(id, found);
		}
		return found;
	};
	const read = async (id: SessionId): Promise<InboxMessage[]> =>
		(await readJson<InboxMessage[]>(paths().conversationInbox(id))) ?? [];
	const write = async (id: SessionId, items: InboxMessage[]): Promise<void> => {
		const live = items.filter(
			(item) => item.status === "queued" || item.status === "delivering" || item.status === "uncertain",
		);
		const receipts = items.filter(
			(item) => item.sourceId && (item.status === "delivered" || item.status === "discarded"),
		);
		const terminal = [
			...receipts,
			...items
				.filter((item) => !item.sourceId && (item.status === "delivered" || item.status === "discarded"))
				.slice(-100),
		];
		await writeJsonAtomic(
			paths().conversationInbox(id),
			[...terminal, ...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
		);
	};
	const update = async (
		sessionId: SessionId,
		ids: string[],
		status: InboxMessage["status"],
		turnId?: TurnId,
	): Promise<InboxMessage[]> =>
		lock(sessionId)(async () => {
			const items = await read(sessionId);
			const updated: InboxMessage[] = [];
			for (const id of ids) {
				const index = items.findIndex((item) => item.id === id);
				if (index < 0) throw new Error(`unknown inbox message ${id}`);
				const current = items[index];
				if (current === undefined) throw new Error(`unknown inbox message ${id}`);
				if (current.status === "delivered" || current.status === "discarded") {
					updated.push(current);
					continue;
				}
				const scrub = status === "delivered" || status === "discarded";
				const next: InboxMessage = {
					...current,
					status,
					...(turnId === undefined ? {} : { turnId }),
					...(status === "delivered" ? { deliveredAt: nowIso() } : {}),
					...(scrub
						? {
								attachments: current.attachments.map(({ dataBase64: _data, ...attachment }) => ({
									...attachment,
									dataBase64: "",
								})),
							}
						: {}),
				};
				items[index] = next;
				updated.push(next);
			}
			await write(sessionId, items);
			return updated;
		});
	const updateOne = async (
		sessionId: SessionId,
		id: string,
		status: InboxMessage["status"],
		turnId?: TurnId,
	): Promise<InboxMessage> => {
		const [message] = await update(sessionId, [id], status, turnId);
		if (!message) throw new Error(`unknown inbox message ${id}`);
		return message;
	};

	return {
		list: (id) => lock(id)(() => read(id)),
		enqueue: (sessionId, text, attachments, origin) =>
			lock(sessionId)(async () => {
				const items = await read(sessionId);
				const existing = origin?.sourceId ? items.find((item) => item.sourceId === origin.sourceId) : undefined;
				const sourceHash = origin?.sourceId
					? (origin.sourceHash ??
						createHash("sha256")
							.update(JSON.stringify([text, attachments, origin.readerDirected]))
							.digest("hex"))
					: undefined;
				if (existing) {
					if (existing.sourceHash && existing.sourceHash !== sourceHash)
						throw new Error("Message ID was reused with different content");
					return existing;
				}
				const active = items.filter(
					(item) => item.status === "queued" || item.status === "delivering" || item.status === "uncertain",
				);
				if (active.length >= MAX_INBOX_MESSAGES) throw new Error("conversation inbox holds 20 messages");
				const item: InboxMessage = {
					id: ulid(),
					...origin,
					sourceHash,
					sessionId,
					createdAt: nowIso(),
					text,
					attachments,
					status: "queued",
				};
				if (bytes([...active, item]) > MAX_INBOX_ATTACHMENT_BYTES)
					throw new Error("conversation inbox attachments exceed 20 MiB");
				items.push(item);
				await write(sessionId, items);
				return item;
			}),
		markMany: update,
		markDiscarded: (sessionId, id) => updateOne(sessionId, id, "discarded"),
		markDelivering: (sessionId, id) => updateOne(sessionId, id, "delivering"),
		markQueued: (sessionId, id) => updateOne(sessionId, id, "queued"),
		markDelivered: (sessionId, id, turnId) => updateOne(sessionId, id, "delivered", turnId),
		markUncertain: (sessionId, id) => updateOne(sessionId, id, "uncertain"),
		discardQueued: (sessionId) =>
			lock(sessionId)(async () => {
				const items = await read(sessionId);
				const changed = items.map((item) =>
					item.status === "queued"
						? {
								...item,
								status: "discarded" as const,
								attachments: item.attachments.map(({ dataBase64: _data, ...attachment }) => ({
									...attachment,
									dataBase64: "",
								})),
							}
						: item,
				);
				await write(sessionId, changed);
				return changed;
			}),
		discardAll: (sessionId) =>
			lock(sessionId)(async () => {
				const items = await read(sessionId);
				const changed = items.map((item) =>
					item.status === "delivered" || item.status === "discarded"
						? item
						: {
								...item,
								status: "discarded" as const,
								attachments: item.attachments.map(({ dataBase64: _data, ...a }) => ({ ...a, dataBase64: "" })),
							},
				);
				await write(sessionId, changed);
				return changed;
			}),
	};
}
