import type { BlockKind, Role } from "../core/types.ts";

export interface BlockDraft {
	role: Role;
	kind: BlockKind;
	text: string;
	data?: Record<string, string | number | boolean | null>;
	key?: string;
}

export function canCoalesce(prev: BlockDraft, next: BlockDraft): boolean {
	if (prev.role !== next.role || prev.data !== undefined || next.data !== undefined) return false;
	return (prev.kind === "text" && next.kind === "text") || (prev.kind === "thought" && next.kind === "thought");
}
