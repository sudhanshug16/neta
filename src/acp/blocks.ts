import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import type { BlockKind, Role } from "../core/types.ts";

export interface BlockDraft {
	role: Role;
	kind: BlockKind;
	text: string;
	data?: Record<string, string | number | boolean | null>;
}

export type SessionSignal = { kind: "model"; model: string } | { kind: "mode"; modeId: string };

// One ACP session update becomes zero or more transcript blocks, all with
// role `agent`. Anything unlisted yields [].
export function blocksFromUpdate(update: SessionUpdate): BlockDraft[] {
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			return update.content.type === "text" ? [{ role: "agent", kind: "text", text: update.content.text }] : [];
		case "agent_thought_chunk":
			return update.content.type === "text" ? [{ role: "agent", kind: "thought", text: update.content.text }] : [];
		case "tool_call":
			return toolBlocks(update.toolCallId, update.title, update.kind ?? null, update.status ?? null, update.content);
		case "tool_call_update":
			return toolBlocks(
				update.toolCallId,
				update.title ?? "",
				update.kind ?? null,
				update.status ?? null,
				update.content,
			);
		case "usage_update": {
			const cost = update.cost ?? undefined;
			const text = `${update.used}/${update.size} tokens${cost === undefined ? "" : ` · $${cost.amount}`}`;
			return [
				{
					role: "agent",
					kind: "status",
					text,
					data: {
						used: update.used,
						size: update.size,
						costAmount: cost?.amount ?? null,
						costCurrency: cost?.currency ?? null,
					},
				},
			];
		}
		case "config_option_update":
			return update.configOptions.map((option) => ({
				role: "agent" as Role,
				kind: "status" as BlockKind,
				text: `${option.name}: ${optionValue(option)}`,
			}));
		case "current_mode_update":
			return [{ role: "agent", kind: "status", text: `mode: ${update.currentModeId}` }];
		default:
			return [];
	}
}

function toolBlocks(
	toolCallId: string,
	title: string,
	kind: string | null,
	status: string | null,
	content: readonly ToolCallContent[] | null | undefined,
): BlockDraft[] {
	const blocks: BlockDraft[] = [
		{ role: "agent", kind: "tool", text: title, data: { toolCallId, toolKind: kind, status } },
	];
	for (const item of content ?? []) {
		if (item.type === "diff") {
			const oldText = item.oldText ?? "";
			blocks.push({
				role: "agent",
				kind: "diff",
				text: diffSummary(item.path, oldText, item.newText),
				data: { path: item.path, oldText, newText: item.newText },
			});
		}
	}
	return blocks;
}

function optionValue(option: { type: string; currentValue: string | boolean }): string {
	return String(option.currentValue);
}

// A model or mode change carried beside the blocks, if the update has one.
export function signalFromUpdate(update: SessionUpdate): SessionSignal | undefined {
	if (update.sessionUpdate === "current_mode_update") {
		return { kind: "mode", modeId: update.currentModeId };
	}
	if (update.sessionUpdate === "config_option_update") {
		const model = update.configOptions.find((option) => option.category === "model");
		if (model !== undefined && model.type === "select" && typeof model.currentValue === "string") {
			return { kind: "model", model: model.currentValue };
		}
	}
	return undefined;
}

// Only two text or two thought drafts merge, same role, neither carrying data.
export function canCoalesce(prev: BlockDraft, next: BlockDraft): boolean {
	if (prev.role !== next.role || prev.data !== undefined || next.data !== undefined) {
		return false;
	}
	return (prev.kind === "text" && next.kind === "text") || (prev.kind === "thought" && next.kind === "thought");
}

// `<path> (+<added> −<removed>)` from an LCS line comparison.
export function diffSummary(path: string, oldText: string, newText: string): string {
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	const common = lcsLength(oldLines, newLines);
	const added = newLines.length - common;
	const removed = oldLines.length - common;
	return `${path} (+${added} −${removed})`;
}

function splitLines(text: string): string[] {
	if (text === "") {
		return [];
	}
	const lines = text.split("\n");
	return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

function lcsLength(a: string[], b: string[]): number {
	const prev = new Array<number>(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		let diag = 0;
		for (let j = 1; j <= b.length; j++) {
			const next = prev[j];
			prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
			diag = next;
		}
	}
	return prev[b.length];
}
