import { expect, test } from "bun:test";
import type { InboxMessage } from "../src/core/types.ts";
import { filterLeaderConversationUpdate, snapshotFilterContext } from "../src/me/context.ts";
import type { NativeVisibleMessage } from "../src/session/runtime.ts";

const at = (minute: number): string => new Date(Date.UTC(2026, 8, 27, 12, minute)).toISOString();
function message(
	id: string,
	minute: number,
	role: NativeVisibleMessage["role"],
	text: string,
	boundary: NativeVisibleMessage["boundary"],
): NativeVisibleMessage {
	return { id, at: at(minute), role, text, boundary };
}

test("filter context orders both chats, keeps origin and receipts, and advances only after a decision", async () => {
	const histories = new Map<string, NativeVisibleMessage[]>([
		[
			"leader",
			[
				message("u1", 1, "human", "Please review", "input"),
				message("l1", 4, "assistant", "Review requested", "final"),
			],
		],
		[
			"coordinator",
			[
				{ ...message("w1", 2, "internal", "Kai says complete", "input"), origin: "kai/final" },
				message("c1", 3, "assistant", "Correction still needed", "final"),
			],
		],
	]);
	const receipt: InboxMessage = {
		id: "report",
		sessionId: "coordinator",
		createdAt: at(2),
		text: "Kai says complete",
		attachments: [],
		status: "delivered",
		readerDirected: false,
		sourceId: "kai/final",
		deliveredAt: at(2),
	};
	let cursors: Record<string, string> = {};
	const input = {
		sessions: [
			{ role: "workspace leader" as const, sessionId: "leader" },
			{ role: "coordinator" as const, sessionId: "coordinator" },
		],
		readMessages: async (sessionId: string) => histories.get(sessionId) ?? [],
		readInbox: async (sessionId: string) => (sessionId === "coordinator" ? [receipt] : []),
		missions: [{ number: 59, name: "Review", agents: [{ name: "Kai", state: "idle" }] }],
		commit: async (next: Record<string, string>) => {
			cursors = { ...cursors, ...next };
		},
	};
	const first = await snapshotFilterContext({ ...input, cursors });
	const data = first.data as {
		timeline: Array<{ id: string; conversation: string; role: string; origin?: string; boundary: string }>;
		inboxes: Array<{ role: string; messages: Array<{ status: string; admittedAt?: string; consumedAt?: string }> }>;
		missions: Array<{ number: number }>;
	};
	expect(data.timeline.map((entry) => entry.id)).toEqual(["u1", "w1", "c1", "l1"]);
	expect(data.timeline[1]).toMatchObject({ conversation: "coordinator", role: "internal", origin: "kai/final" });
	expect(data.timeline[2]).toMatchObject({ boundary: "final", conversation: "coordinator" });
	expect(data.inboxes[1]?.messages[0]).toMatchObject({ status: "delivered", admittedAt: at(2) });
	expect(data.inboxes[1]?.messages[0]?.consumedAt).toBeUndefined();
	expect(data.missions[0]?.number).toBe(59);
	expect(await first.verify()).toBe(true);
	expect(cursors).toEqual({});
	await first.commit();
	expect(cursors).toEqual({ leader: "l1", coordinator: "c1" });
	histories.get("coordinator")?.push(message("c2", 5, "assistant", "Now accepted", "final"));
	const next = await snapshotFilterContext({ ...input, cursors });
	expect((next.data as { timeline: Array<{ id: string }> }).timeline.map((entry) => entry.id)).toEqual(["c2"]);
	const latest = histories.get("coordinator")?.at(-1);
	if (!latest) throw new Error("missing coordinator reply");
	latest.text = "Now accepted after correction";
	expect(await next.verify()).toBe(false);
	histories.get("leader")?.push(message("u2", 6, "human", "What changed?", "input"));
	expect(await next.verify()).toBe(false);
});

test("initial context includes the latest compaction and at most 100 recent visible messages", async () => {
	const messages = [
		message("summary", 0, "summary", "Earlier discussion", "summary"),
		...Array.from({ length: 110 }, (_, index) => message(`m${index}`, 1, "human", `message ${index}`, "input")),
	];
	const snapshot = await snapshotFilterContext({
		sessions: [{ role: "workspace leader", sessionId: "leader" }],
		cursors: {},
		readMessages: async () => messages,
		readInbox: async () => [],
		missions: [],
		commit: async () => {},
	});
	const timeline = (snapshot.data as { timeline: Array<{ id: string }> }).timeline;
	expect(timeline).toHaveLength(101);
	expect(timeline[0]?.id).toBe("summary");
	expect(timeline[1]?.id).toBe("m10");
});

test("leader context is informational and advances from the last delivered message", () => {
	const messages = [
		message("u1", 1, "human", "How is Jev doing?", "input"),
		message("l1", 2, "assistant", "I asked for a live check.", "final"),
		message("u2", 3, "human", "Please keep the PR moving.", "input"),
		message("l2", 4, "assistant", "I will.", "final"),
	];
	const first = filterLeaderConversationUpdate(messages);
	expect(first?.lastId).toBe("l2");
	expect(first?.text).toContain("For information only; do not call a tool.");
	expect(first?.text).toContain(`User (${at(3)}):\nPlease keep the PR moving.`);
	expect(first?.text).toContain(`Workspace leader (${at(4)}):\nI will.`);
	expect(filterLeaderConversationUpdate(messages, "l2")).toBeUndefined();
	const next = filterLeaderConversationUpdate([...messages, message("u3", 5, "human", "Any news?", "input")], "l2");
	expect(next?.text).toContain("Any news?");
	expect(next?.text).not.toContain("How is Jev doing?");
});
