import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { blocksFromUpdate, canCoalesce, diffSummary, signalFromUpdate } from "../src/acp/blocks.ts";

describe("blocksFromUpdate", () => {
	test("agent_message_chunk becomes text", () => {
		const update: SessionUpdate = {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "hello" },
		};
		expect(blocksFromUpdate(update)).toEqual([{ role: "agent", kind: "text", text: "hello" }]);
	});

	test("agent_thought_chunk becomes thought", () => {
		const update: SessionUpdate = {
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "weighing options" },
		};
		expect(blocksFromUpdate(update)).toEqual([{ role: "agent", kind: "thought", text: "weighing options" }]);
	});

	test("a tool_call with a diff yields two blocks in order", () => {
		const update: SessionUpdate = {
			sessionUpdate: "tool_call",
			toolCallId: "call_1",
			title: "Edit config.json",
			kind: "edit",
			status: "in_progress",
			content: [{ type: "diff", path: "/repo/config.json", oldText: "a\nb\nc\n", newText: "a\nB\nc\n" }],
		};
		expect(blocksFromUpdate(update)).toEqual([
			{
				role: "agent",
				kind: "tool",
				text: "Edit config.json",
				data: { toolCallId: "call_1", toolKind: "edit", status: "in_progress" },
			},
			{
				role: "agent",
				kind: "diff",
				text: "/repo/config.json (+1 −1)",
				data: { path: "/repo/config.json", oldText: "a\nb\nc\n", newText: "a\nB\nc\n" },
			},
		]);
	});

	test("tool_call_update carries the new status", () => {
		const update: SessionUpdate = {
			sessionUpdate: "tool_call_update",
			toolCallId: "call_1",
			status: "completed",
		};
		const blocks = blocksFromUpdate(update);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].kind).toBe("tool");
		expect(blocks[0].data?.status).toBe("completed");
	});

	test("usage_update becomes a priced status block", () => {
		const update: SessionUpdate = {
			sessionUpdate: "usage_update",
			used: 1200,
			size: 200000,
			cost: { amount: 0.42, currency: "USD" },
		};
		expect(blocksFromUpdate(update)).toEqual([
			{
				role: "agent",
				kind: "status",
				text: "1200/200000 tokens · $0.42",
				data: { used: 1200, size: 200000, costAmount: 0.42, costCurrency: "USD" },
			},
		]);
	});

	test("usage without cost omits the price", () => {
		const update: SessionUpdate = { sessionUpdate: "usage_update", used: 10, size: 100 };
		expect(blocksFromUpdate(update)[0].text).toBe("10/100 tokens");
	});

	test("a changed model yields a status block and a model signal", () => {
		const update: SessionUpdate = {
			sessionUpdate: "config_option_update",
			configOptions: [
				{
					id: "model",
					name: "Model",
					type: "select",
					category: "model",
					currentValue: "fixture-fast",
					options: [{ value: "fixture-fast", name: "Fixture Fast" }],
				},
			],
		};
		expect(blocksFromUpdate(update)).toEqual([{ role: "agent", kind: "status", text: "Model: fixture-fast" }]);
		expect(signalFromUpdate(update)).toEqual({ kind: "model", model: "fixture-fast" });
	});

	test("current_mode_update yields a status block and a mode signal", () => {
		const update: SessionUpdate = { sessionUpdate: "current_mode_update", currentModeId: "plan" };
		expect(blocksFromUpdate(update)).toEqual([{ role: "agent", kind: "status", text: "mode: plan" }]);
		expect(signalFromUpdate(update)).toEqual({ kind: "mode", modeId: "plan" });
	});

	test("unlisted updates yield nothing and no signal", () => {
		const userChunk: SessionUpdate = {
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "hi" },
		};
		expect(blocksFromUpdate(userChunk)).toEqual([]);
		expect(signalFromUpdate(userChunk)).toBeUndefined();
		const imageChunk: SessionUpdate = {
			sessionUpdate: "agent_message_chunk",
			content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		};
		expect(blocksFromUpdate(imageChunk)).toEqual([]);
	});
});

describe("canCoalesce", () => {
	test("accepts two text chunks, rejects text beside thought", () => {
		const text = { role: "agent" as const, kind: "text" as const, text: "a" };
		const thought = { role: "agent" as const, kind: "thought" as const, text: "b" };
		expect(canCoalesce(text, { ...text, text: "b" })).toBe(true);
		expect(canCoalesce(thought, { ...thought, text: "c" })).toBe(true);
		expect(canCoalesce(text, thought)).toBe(false);
		expect(canCoalesce(text, { ...text, text: "b", data: { toolCallId: "c" } })).toBe(false);
		expect(canCoalesce({ ...text, role: "user" as const }, text)).toBe(false);
	});
});

describe("diffSummary", () => {
	test("counts added and removed lines", () => {
		expect(diffSummary("/a", "a\nb\nc\n", "a\nB\nc\n")).toBe("/a (+1 −1)");
		expect(diffSummary("/new", "", "x\ny\n")).toBe("/new (+2 −0)");
		expect(diffSummary("/same", "a\n", "a\n")).toBe("/same (+0 −0)");
	});
});
