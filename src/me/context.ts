import type { InboxMessage } from "../core/types.ts";
import type { NativeVisibleMessage } from "../session/runtime.ts";
import type { FilterContextSnapshot } from "./curator.ts";

/** Render one ordinary native message for the Filter's persistent context. */
export function filterLeaderConversationUpdate(
	messages: readonly NativeVisibleMessage[],
	cursor?: string,
): { text: string; lastId: string } | undefined {
	const index = cursor ? messages.findIndex((message) => message.id === cursor) : -1;
	const selected = index >= 0 ? messages.slice(index + 1) : messages.slice(-40);
	const latestSummary = index < 0 ? messages.findLast((message) => message.role === "summary") : undefined;
	if (latestSummary && !selected.some((message) => message.id === latestSummary.id)) selected.unshift(latestSummary);
	const last = selected.at(-1);
	if (!last) return undefined;
	const conversation = selected
		.map((message) => {
			const speaker =
				message.role === "human"
					? "User"
					: message.role === "assistant"
						? "Workspace leader"
						: message.role === "summary"
							? "Conversation summary"
							: "Internal update";
			return `${speaker} (${message.at}):\n${message.text}`;
		})
		.join("\n\n");
	return {
		text: `Workspace leader conversation update. For information only; do not call a tool.\n\n${conversation}`,
		lastId: last.id,
	};
}

export interface FilterConversation {
	role: "workspace leader" | "coordinator";
	sessionId: string;
}

export interface FilterMissionActivity {
	number: number;
	name: string;
	agents: Array<{ name: string; state: string }>;
}

/** One incremental, ordered view of both native conversations for a filter decision. */
export async function snapshotFilterContext(input: {
	sessions: FilterConversation[];
	cursors: Record<string, string>;
	readMessages(sessionId: string): Promise<NativeVisibleMessage[]>;
	readInbox(sessionId: string): Promise<InboxMessage[]>;
	missions: FilterMissionActivity[];
	commit(cursors: Record<string, string>): Promise<void>;
}): Promise<FilterContextSnapshot> {
	const histories = await Promise.all(
		input.sessions.map(async ({ role, sessionId }) => {
			const messages = await input.readMessages(sessionId);
			const latest = messages.at(-1);
			const last = latest ? { id: latest.id, text: latest.text, boundary: latest.boundary } : undefined;
			const cursor = input.cursors[sessionId];
			const index = cursor ? messages.findIndex((message) => message.id === cursor) : -1;
			const summary = messages.findLast((message) => message.role === "summary");
			const selected = index >= 0 ? messages.slice(index + 1) : messages.slice(-100);
			return {
				role,
				sessionId,
				last,
				messages:
					summary && index < 0 && !selected.some((message) => message.id === summary.id)
						? [summary, ...selected]
						: selected,
			};
		}),
	);
	const inboxes = await Promise.all(
		input.sessions.map(async ({ role, sessionId }) => ({
			role,
			sessionId,
			messages: (await input.readInbox(sessionId))
				.filter((message) => message.readerDirected === false)
				.slice(-20)
				.map((message) => ({
					at: message.createdAt,
					sourceId: message.sourceId,
					text: message.text,
					status: message.status,
					admittedAt: message.deliveredAt,
					consumedAt: message.consumedAt,
				})),
		})),
	);
	return {
		data: {
			timeline: histories
				.flatMap(({ role, sessionId, messages }) =>
					messages.map((message) => ({ conversation: role, sessionId, ...message })),
				)
				.sort((a, b) => a.at.localeCompare(b.at)),
			inboxes,
			missions: input.missions,
		},
		verify: async () => {
			for (const history of histories) {
				const current = await input.readMessages(history.sessionId);
				const last = current.at(-1);
				if (
					last?.id !== history.last?.id ||
					last?.text !== history.last?.text ||
					last?.boundary !== history.last?.boundary
				)
					return false;
			}
			return true;
		},
		commit: async () => {
			await input.commit(
				Object.fromEntries(
					histories.flatMap((history) => (history.last ? [[history.sessionId, history.last.id]] : [])),
				),
			);
		},
	};
}
