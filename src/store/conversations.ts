import { join } from "node:path";
import type { Block, IsoTime, SessionId, Turn, TurnId } from "../core/types.ts";
import {
	appendLine,
	createMutex,
	ensureDir,
	fileSize,
	type Mutex,
	readJson,
	readNdjson,
	readNdjsonBackwards,
	repairTornTail,
	writeJsonAtomic,
} from "./files.ts";
import { paths } from "./paths.ts";

export interface ConversationMeta {
	sessionId: SessionId;
	provider: string;
	model: string;
	vendorSessionId?: string;
	createdAt: IsoTime;
}

export type ConversationLine = { t: "turn"; turn: Turn } | { t: "block"; block: Block };

export interface BlockPage {
	blocks: Block[];
	from: number;
	cursor: number;
	more: boolean;
}

export interface TurnRange {
	turn: Turn;
	start: number;
	end: number;
}

export interface ConversationStore {
	create(meta: ConversationMeta): Promise<ConversationMeta>;
	meta(sessionId: SessionId): Promise<ConversationMeta | undefined>;
	setMeta(
		sessionId: SessionId,
		patch: Partial<Pick<ConversationMeta, "model" | "vendorSessionId">>,
	): Promise<ConversationMeta>;
	appendTurn(turn: Turn): Promise<Turn>;
	appendBlock(sessionId: SessionId, block: Block): Promise<Block>;
	tail(opts: { sessionId: SessionId; cursor?: number; limit?: number }): Promise<BlockPage>;
	readBefore(opts: { sessionId: SessionId; cursor: number; limit?: number }): Promise<{
		blocks: Block[];
		prevCursor: number | null;
	}>;
	turnRange(sessionId: SessionId, turnId: TurnId): Promise<TurnRange | undefined>;
}

const SLICE_BYTES = 256 * 1024;

function conversationsDir(): string {
	return join(paths().root, "conversations");
}

// Exact byte length of one NDJSON line as `appendLine` writes it. The
// parse/stringify round-trip is byte-identical for JSON values, so offsets
// computed this way match the file. Callers only use it on line boundaries.
function lineBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
}

function blocksOnly(lines: ConversationLine[]): Block[] {
	const out: Block[] = [];
	for (const line of lines) {
		if (line.t === "block") {
			out.push(line.block);
		}
	}
	return out;
}

export function openConversationStore(): ConversationStore {
	const mutexes = new Map<SessionId, Mutex>();
	const knownTurns = new Map<SessionId, Set<TurnId>>();

	function mutexFor(sessionId: SessionId): Mutex {
		let mutex = mutexes.get(sessionId);
		if (mutex === undefined) {
			mutex = createMutex();
			mutexes.set(sessionId, mutex);
		}
		return mutex;
	}

	function turnsFor(sessionId: SessionId): Set<TurnId> {
		let set = knownTurns.get(sessionId);
		if (set === undefined) {
			set = new Set();
			knownTurns.set(sessionId, set);
		}
		return set;
	}

	// Forward scan in slices, calling `visit` with each line and its absolute
	// offset. Only one 256 KiB window is live at a time; the scan stays silent
	// because it is an existence probe, not a data read.
	async function scanLines(
		sessionId: SessionId,
		visit: (line: ConversationLine, offset: number) => void,
	): Promise<void> {
		const path = paths().conversation(sessionId);
		const silent = (): void => undefined;
		let from = 0;
		for (;;) {
			const read = await readNdjson<ConversationLine>(path, { from, maxBytes: SLICE_BYTES, onWarn: silent });
			let offset = from;
			for (const line of read.records) {
				visit(line, offset);
				offset += lineBytes(line);
			}
			if (read.records.length === 0) {
				return;
			}
			from = read.bytes;
			if (!read.truncated && from >= (await fileSize(path))) {
				return;
			}
		}
	}

	async function hasTurn(sessionId: SessionId, turnId: TurnId): Promise<boolean> {
		const known = turnsFor(sessionId);
		if (known.has(turnId)) {
			return true;
		}
		let found = false;
		await scanLines(sessionId, (line) => {
			if (line.t === "turn") {
				known.add(line.turn.id);
				if (line.turn.id === turnId) {
					found = true;
				}
			}
		});
		return found;
	}

	// Absolute offsets of block lines, by re-encoding backwards from the clean
	// `stop` boundary (cursors always land on line starts, so this is exact).
	function blockOffsets(lines: ConversationLine[], stop: number): Map<Block, number> {
		const starts = new Map<Block, number>();
		let end = stop;
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			const start = end - lineBytes(line);
			if (line.t === "block") {
				starts.set(line.block, start);
			}
			end = start;
		}
		return starts;
	}

	// The last `capped` blocks before `stop` (default EOF) with the absolute
	// offset of the first one, whether the start of the file was reached, and
	// whether older blocks were cut off by the cap (in which case paging must
	// continue even past `bof`: the cut blocks are still ahead of `from`).
	async function lastBlocksBefore(
		path: string,
		capped: number,
		stop?: number,
	): Promise<{ blocks: Block[]; from: number; bof: boolean; cut: boolean }> {
		const size = await fileSize(path);
		const endAt = stop === undefined ? size : Math.min(stop, size);
		if (endAt <= 0) {
			return { blocks: [], from: 0, bof: true, cut: false };
		}
		let fetch = capped + 1;
		let lines: ConversationLine[] = [];
		let bof = false;
		for (;;) {
			const read = await readNdjsonBackwards<ConversationLine>(path, fetch, { endAt });
			lines = read.records;
			if (blocksOnly(lines).length >= capped || lines.length < fetch) {
				bof = lines.length < fetch;
				break;
			}
			fetch *= 2;
		}
		const all = blocksOnly(lines);
		const blocks = all.slice(-capped);
		if (blocks.length === 0) {
			return { blocks, from: 0, bof, cut: false };
		}
		const starts = blockOffsets(lines, endAt);
		return { blocks, from: starts.get(blocks[0]) ?? 0, bof, cut: all.length > blocks.length };
	}

	return {
		create: async (meta) => {
			await ensureDir(conversationsDir());
			const p = paths();
			const existing = await readJson<ConversationMeta>(p.conversationMeta(meta.sessionId));
			if (existing !== undefined) {
				return existing;
			}
			await writeJsonAtomic(p.conversationMeta(meta.sessionId), meta);
			return meta;
		},

		meta: async (sessionId) => readJson<ConversationMeta>(paths().conversationMeta(sessionId)),

		setMeta: async (sessionId, patch) => {
			const p = paths();
			const current = await readJson<ConversationMeta>(p.conversationMeta(sessionId));
			if (current === undefined) {
				throw new Error(`unknown conversation ${sessionId}`);
			}
			const next = { ...current, ...patch };
			await writeJsonAtomic(p.conversationMeta(sessionId), next);
			return next;
		},

		appendTurn: async (turn) =>
			mutexFor(turn.sessionId)(async () => {
				await ensureDir(conversationsDir());
				await repairTornTail(paths().conversation(turn.sessionId));
				const line: ConversationLine = { t: "turn", turn };
				await appendLine(paths().conversation(turn.sessionId), line);
				turnsFor(turn.sessionId).add(turn.id);
				return turn;
			}),

		appendBlock: async (sessionId, block) =>
			mutexFor(sessionId)(async () => {
				await repairTornTail(paths().conversation(sessionId));
				if (!(await hasTurn(sessionId, block.turnId))) {
					throw new Error(`unknown turn ${block.turnId} in ${sessionId}`);
				}
				await ensureDir(conversationsDir());
				const line: ConversationLine = { t: "block", block };
				await appendLine(paths().conversation(sessionId), line);
				return block;
			}),

		tail: async ({ sessionId, cursor, limit }) =>
			mutexFor(sessionId)(async () => {
				await repairTornTail(paths().conversation(sessionId));
				const capped = Math.min(Math.max(limit ?? 100, 1), 500);
				const path = paths().conversation(sessionId);
				if (cursor !== undefined) {
					const read = await readNdjson<ConversationLine>(path, { from: cursor, maxBytes: SLICE_BYTES });
					const blocks: Block[] = [];
					let offset = cursor;
					let firstStart = read.bytes;
					let lastEnd = read.bytes;
					for (const line of read.records) {
						const start = offset;
						offset += lineBytes(line);
						if (line.t !== "block") {
							continue;
						}
						if (blocks.length === capped) {
							// The window holds more blocks than the page: stop
							// here so the cursor lands past the last returned
							// block instead of skipping the rest.
							break;
						}
						if (blocks.length === 0) {
							firstStart = start;
						}
						blocks.push(line.block);
						lastEnd = offset;
					}
					if (blocks.length === 0) {
						return {
							blocks,
							from: read.bytes,
							cursor: read.bytes,
							more: (await fileSize(path)) > read.bytes,
						};
					}
					return { blocks, from: firstStart, cursor: lastEnd, more: (await fileSize(path)) > lastEnd };
				}
				const found = await lastBlocksBefore(path, capped);
				return { blocks: found.blocks, from: found.from, cursor: await fileSize(path), more: false };
			}),

		readBefore: async ({ sessionId, cursor, limit }) =>
			mutexFor(sessionId)(async () => {
				await repairTornTail(paths().conversation(sessionId));
				const capped = Math.min(Math.max(limit ?? 100, 1), 500);
				const path = paths().conversation(sessionId);
				const found = await lastBlocksBefore(path, capped, cursor);
				if (found.blocks.length === 0) {
					return { blocks: [], prevCursor: found.bof ? null : cursor };
				}
				const done = !found.cut && (found.bof || found.from === 0);
				return { blocks: found.blocks, prevCursor: done ? null : found.from };
			}),

		turnRange: async (sessionId, turnId) =>
			mutexFor(sessionId)(async () => {
				await repairTornTail(paths().conversation(sessionId));
				let turn: Turn | undefined;
				let start = 0;
				let end = 0;
				await scanLines(sessionId, (line, offset) => {
					if (line.t === "turn" && line.turn.id === turnId) {
						turn = line.turn;
						start = offset;
						end = offset + lineBytes(line);
					} else if (line.t === "block" && turn !== undefined && line.block.turnId === turnId) {
						end = offset + lineBytes(line);
					}
				});
				if (turn === undefined) {
					return undefined;
				}
				return { turn, start, end };
			}),
	};
}
