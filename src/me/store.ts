import { createHash } from "node:crypto";
import { join } from "node:path";
import { createMutex, readJson, writeJsonAtomic } from "../store/files.ts";
import { paths } from "../store/paths.ts";

export const SOL_ID = "sol";
export const SOL_SESSION_ID = "sol";
export const SOL_ROLE = "orchestrator" as const;

export interface MeSource {
	id: string;
	workspaceId: string;
	workspaceName: string;
	sessionId: string;
	actorKind: "leader" | "missionLead" | "agent";
	kind: "message" | "event" | "permission" | "failure";
	at: string;
	text: string;
	turnId?: string;
	eventId?: string;
	missionId?: string;
	explicit: boolean;
	forceVisible?: boolean;
	transcriptPointer?: { sessionId: string; turnId: string; firstSeq: number; lastSeq: number; sourceHash: string };
	destinationSessionIds: string[];
}

export interface MeDecision {
	action: "surface" | "update" | "suppress";
	concernKey: string;
	headline: string;
	summary: string;
	evidenceSourceIds: string[];
	needsReply: boolean;
	resolved: boolean;
	destinationSessionIds: string[];
}

export interface MeCard extends MeDecision {
	id: string;
	version: number;
	sourceIds: string[];
	workspaceId: string;
	workspaceName: string;
	sessionId: string;
	latestAt: string;
	readAt?: string;
}

export type MeReplyStatus = "queued" | "delivering" | "accepted" | "delivered" | "uncertain" | "rejected";
export interface MeReply {
	id: string;
	idempotencyKey: string;
	cardId: string;
	text: string;
	destinationSessionId: string;
	status: MeReplyStatus;
	queuedAt: string;
	receipt?: string;
}

/** High-water mark for cross-workspace event and turn replay. Stale writes do not rewind it. */
export interface MeTurnCursor {
	sessionId: string;
	turnId: string;
	blockSeq?: number;
}
export interface MeWorkspaceCheckpoint {
	workspaceId: string;
	eventSeq: number;
	turns: MeTurnCursor[];
}
export interface MeCheckpoint {
	workspaces: MeWorkspaceCheckpoint[];
}

/** Sol is the Me orchestrator, never a workspace-leader alias. */
export interface SolIdentity {
	id: typeof SOL_ID;
	role: typeof SOL_ROLE;
	title: "Sol";
	sessionId: typeof SOL_SESSION_ID;
	createdAt: string;
}
export interface SolTurn {
	id: string;
	idempotencyKey: string;
	at: string;
	author: "user" | "sol";
	text: string;
}
export interface SolRouteIntent {
	id: string;
	idempotencyKey: string;
	solTurnId: string;
	instruction: string;
	destinationSessionIds: string[];
	provenanceSourceIds: string[];
	status: MeReplyStatus;
	createdAt: string;
	receipt?: string;
}

export interface MeStore {
	capture(input: MeSource): Promise<MeSource>;
	list(options?: {
		includeSuppressed?: boolean;
		limit?: number;
		after?: string;
	}): Promise<{ cards: MeCard[]; pending: MeSource[]; hasMore: boolean }>;
	decide(sourceId: string, result: MeDecision): Promise<MeCard | undefined>;
	markRead(cardId: string): Promise<void>;
	queueReply(input: {
		idempotencyKey: string;
		cardId: string;
		text: string;
		destinationSessionId: string;
	}): Promise<MeReply>;
	updateReply(id: string, status: MeReplyStatus, receipt?: string): Promise<MeReply>;
	pendingSources(): Promise<MeSource[]>;
	getSource(id: string): Promise<MeSource | undefined>;
	getCard(id: string): Promise<MeCard | undefined>;
	getReply(id: string): Promise<MeReply | undefined>;
	getCheckpoint(): Promise<MeCheckpoint>;
	setCheckpoint(checkpoint: MeCheckpoint): Promise<MeCheckpoint>;
	solIdentity(): Promise<SolIdentity>;
	appendSolTurn(input: {
		idempotencyKey: string;
		author: "user" | "sol";
		text: string;
		at?: string;
	}): Promise<SolTurn>;
	listSolTurns(options?: { limit?: number; after?: string }): Promise<{ turns: SolTurn[]; hasMore: boolean }>;
	queueRoute(input: {
		idempotencyKey: string;
		solTurnId: string;
		instruction: string;
		destinationSessionIds: string[];
		provenanceSourceIds: string[];
	}): Promise<SolRouteIntent>;
	updateRoute(id: string, status: MeReplyStatus, receipt?: string): Promise<SolRouteIntent>;
	getRoute(id: string): Promise<SolRouteIntent | undefined>;
}

interface Document {
	version: 2;
	sources: MeSource[];
	decidedSourceIds: string[];
	cards: MeCard[];
	replies: MeReply[];
	checkpoint: MeCheckpoint;
	sol?: SolIdentity;
	solTurns: SolTurn[];
	routes: SolRouteIntent[];
}

const mutexes = new Map<string, ReturnType<typeof createMutex>>();
const emptyCheckpoint = (): MeCheckpoint => ({ workspaces: [] });
const empty = (): Document => ({
	version: 2,
	sources: [],
	decidedSourceIds: [],
	cards: [],
	replies: [],
	checkpoint: emptyCheckpoint(),
	solTurns: [],
	routes: [],
});
const digest = (parts: unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const replyTransitions: Record<MeReplyStatus, MeReplyStatus[]> = {
	queued: ["delivering", "rejected"],
	delivering: ["accepted", "delivered", "uncertain", "rejected"],
	accepted: [],
	delivered: [],
	uncertain: [],
	rejected: [],
};

export function meSourceId(
	source: Pick<MeSource, "workspaceId" | "sessionId" | "kind" | "turnId" | "eventId">,
): string {
	if (!source.turnId && !source.eventId) throw new Error("Me source requires a turnId or eventId");
	return `src-${digest([source.workspaceId, source.sessionId, source.kind, source.turnId ?? null, source.eventId ?? null])}`;
}

function bounded(value: unknown, name: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`invalid Me ${name}`);
	return value.trim();
}

function exactText(value: unknown, name: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`invalid Me ${name}`);
	return value;
}

function distinctIds(value: unknown, name: string, max = 32): string[] {
	if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== "string" || !v || v.length > 256))
		throw new Error(`invalid Me ${name}`);
	if (new Set(value).size !== value.length) throw new Error(`duplicate Me ${name}`);
	return [...value];
}

function copy<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

function validatedSource(input: MeSource): MeSource {
	const workspaceId = bounded(input.workspaceId, "workspaceId", 256);
	const sessionId = bounded(input.sessionId, "sessionId", 256);
	if (sessionId === SOL_SESSION_ID) throw new Error("Sol is not a workspace session");
	if (
		!["leader", "missionLead", "agent"].includes(input.actorKind) ||
		!["message", "event", "permission", "failure"].includes(input.kind)
	)
		throw new Error("invalid Me source kind");
	if (
		typeof input.explicit !== "boolean" ||
		(input.forceVisible !== undefined && typeof input.forceVisible !== "boolean") ||
		(input.actorKind === "agent" && input.kind === "message" && !input.explicit)
	)
		throw new Error("unrelated agent messages cannot enter Me");
	if (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at)))
		throw new Error("invalid Me source time");
	const destinationSessionIds = distinctIds(input.destinationSessionIds, "destinations");
	if (destinationSessionIds.includes(SOL_SESSION_ID)) throw new Error("Sol is not a reply destination");
	if (!destinationSessionIds.length || !destinationSessionIds.includes(sessionId))
		throw new Error("Me source must include its originating session as a destination");
	const source: MeSource = {
		id: "",
		workspaceId,
		sessionId,
		workspaceName: bounded(input.workspaceName, "workspaceName", 160),
		actorKind: input.actorKind,
		kind: input.kind,
		at: input.at,
		text: bounded(input.text, "source text", 8_000),
		explicit: input.explicit,
		...(input.forceVisible === true ? { forceVisible: true } : {}),
		destinationSessionIds,
		...(input.turnId === undefined ? {} : { turnId: bounded(input.turnId, "turnId", 256) }),
		...(input.eventId === undefined ? {} : { eventId: bounded(input.eventId, "eventId", 256) }),
		...(input.missionId === undefined ? {} : { missionId: bounded(input.missionId, "missionId", 256) }),
		...(input.transcriptPointer === undefined
			? {}
			: (() => {
					const pointer = input.transcriptPointer;
					if (
						pointer.sessionId !== sessionId ||
						pointer.turnId !== input.turnId ||
						!Number.isSafeInteger(pointer.firstSeq) ||
						!Number.isSafeInteger(pointer.lastSeq) ||
						pointer.firstSeq < 1 ||
						pointer.lastSeq < pointer.firstSeq ||
						!/^[a-f0-9]{64}$/.test(pointer.sourceHash)
					)
						throw new Error("invalid transcript pointer");
					return { transcriptPointer: { ...pointer } };
				})()),
	};
	const id = meSourceId(source);
	if (input.id && input.id !== id) throw new Error("Me source id does not match its origin");
	return { ...source, id };
}

function validatedDecision(source: MeSource, doc: Document, result: MeDecision): MeDecision {
	if (!result || !["surface", "update", "suppress"].includes(result.action)) throw new Error("invalid Me action");
	const evidenceSourceIds = distinctIds(result.evidenceSourceIds, "evidence");
	if (
		!evidenceSourceIds.includes(source.id) ||
		evidenceSourceIds.some(
			(id) => !doc.sources.some((item) => item.id === id && item.workspaceId === source.workspaceId),
		)
	)
		throw new Error("Me evidence must include this source and belong to its workspace");
	const destinationSessionIds = distinctIds(result.destinationSessionIds, "destinations");
	const allowed = new Set(
		doc.sources.filter((item) => evidenceSourceIds.includes(item.id)).flatMap((item) => item.destinationSessionIds),
	);
	if (destinationSessionIds.some((id) => !allowed.has(id) || id === SOL_SESSION_ID))
		throw new Error("Me destination is not in source provenance");
	if (typeof result.needsReply !== "boolean" || typeof result.resolved !== "boolean")
		throw new Error("invalid Me decision flags");
	if (result.needsReply && (result.resolved || !destinationSessionIds.length || result.action === "suppress"))
		throw new Error("a pending question requires a visible reply destination");
	if (source.forceVisible && result.action === "suppress")
		throw new Error("an explicit user escalation must remain visible");
	return {
		action: result.action,
		concernKey: bounded(result.concernKey, "concernKey", 160),
		headline: bounded(result.headline, "headline", 160),
		summary: bounded(result.summary, "summary", 1_200),
		evidenceSourceIds,
		needsReply: result.needsReply,
		resolved: result.resolved,
		destinationSessionIds,
	};
}

function normalize(raw: (Omit<Partial<Document>, "version"> & { version?: 1 | 2 }) | undefined): Document {
	if (!raw) return empty();
	if (raw.version !== 1 && raw.version !== 2) throw new Error("unsupported Me store version");
	if (raw.sol && (raw.sol.id !== SOL_ID || raw.sol.role !== SOL_ROLE || raw.sol.sessionId !== SOL_SESSION_ID))
		throw new Error("Sol identity cannot alias a workspace leader");
	return {
		version: 2,
		sources: raw.sources ?? [],
		decidedSourceIds: raw.decidedSourceIds ?? [],
		cards: raw.cards ?? [],
		replies: raw.replies ?? [],
		checkpoint: raw.checkpoint ?? emptyCheckpoint(),
		...(raw.sol ? { sol: raw.sol } : {}),
		solTurns: raw.solTurns ?? [],
		routes: raw.routes ?? [],
	};
}

function mergeCheckpoint(current: MeCheckpoint, incoming: MeCheckpoint): MeCheckpoint {
	if (!incoming || !Array.isArray(incoming.workspaces) || incoming.workspaces.length > 500)
		throw new Error("invalid Me checkpoint");
	const merged = new Map(current.workspaces.map((item) => [item.workspaceId, copy(item)]));
	for (const item of incoming.workspaces) {
		const workspaceId = bounded(item.workspaceId, "checkpoint workspace", 256);
		if (!Number.isSafeInteger(item.eventSeq) || item.eventSeq < 0) throw new Error("invalid Me event cursor");
		if (!Array.isArray(item.turns) || item.turns.length > 200) throw new Error("invalid Me turn cursor");
		const turns = item.turns.map((turn) => ({
			sessionId: bounded(turn.sessionId, "checkpoint session", 256),
			turnId: bounded(turn.turnId, "checkpoint turn", 256),
			...(turn.blockSeq === undefined ? {} : { blockSeq: turn.blockSeq }),
		}));
		if (
			turns.some(
				(turn) =>
					turn.sessionId === SOL_SESSION_ID ||
					(turn.blockSeq !== undefined && (!Number.isSafeInteger(turn.blockSeq) || turn.blockSeq < 0)),
			)
		)
			throw new Error("invalid Me turn checkpoint");
		if (new Set(turns.map((turn) => `${turn.sessionId}\u0000${turn.turnId}`)).size !== turns.length)
			throw new Error("duplicate Me turn cursor");
		const previous = merged.get(workspaceId) ?? { workspaceId, eventSeq: 0, turns: [] };
		for (const turn of turns) {
			const key = `${turn.sessionId}\u0000${turn.turnId}`;
			const existing = previous.turns.find((item) => `${item.sessionId}\u0000${item.turnId}` === key);
			if (!existing) previous.turns.push(turn);
			else if (turn.blockSeq !== undefined) existing.blockSeq = Math.max(existing.blockSeq ?? 0, turn.blockSeq);
		}
		previous.turns = previous.turns.slice(-1_000);
		previous.eventSeq = Math.max(previous.eventSeq, item.eventSeq);
		merged.set(workspaceId, previous);
	}
	return { workspaces: [...merged.values()].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)) };
}

function advanceStatus<T extends { status: MeReplyStatus; receipt?: string }>(
	record: T,
	status: MeReplyStatus,
	receipt: string | undefined,
): T {
	if (!replyTransitions[record.status] || !replyTransitions[status]) throw new Error("invalid Me receipt status");
	if (record.status === status && (receipt === undefined || record.receipt === receipt)) return record;
	if (!replyTransitions[record.status].includes(status))
		throw new Error("invalid Me receipt transition; uncertain attempts cannot be replayed");
	record.status = status;
	if (receipt !== undefined) record.receipt = bounded(receipt, "receipt", 2_000);
	return record;
}

/** The Node is the sole writer process. All handles in that process share one mutex per root. */
export function openMeStore(): MeStore {
	const file = join(paths().root, "me", "state.json");
	let mutex = mutexes.get(file);
	if (!mutex) {
		mutex = createMutex();
		mutexes.set(file, mutex);
	}
	const locked = mutex;
	const load = async (): Promise<Document> =>
		normalize(await readJson<Omit<Partial<Document>, "version"> & { version?: 1 | 2 }>(file));
	const save = (doc: Document): Promise<void> => writeJsonAtomic(file, doc);
	return {
		capture: (input) =>
			locked(async () => {
				const source = validatedSource(input);
				const doc = await load();
				const existing = doc.sources.find((item) => item.id === source.id);
				if (existing) return copy(existing);
				doc.sources.push(source);
				await save(doc);
				return copy(source);
			}),
		list: (options = {}) =>
			locked(async () => {
				const doc = await load();
				const limit = Math.min(100, Math.max(1, options.limit ?? 30));
				const ordered = doc.cards
					.filter((card) => options.includeSuppressed || card.action !== "suppress")
					.sort((a, b) => b.latestAt.localeCompare(a.latestAt) || b.id.localeCompare(a.id));
				const offset = options.after ? ordered.findIndex((card) => card.id === options.after) : -1;
				if (options.after && offset < 0) throw new Error("unknown Me page cursor");
				const cards = ordered.slice(offset + 1, offset + 1 + limit);
				const decided = new Set(doc.decidedSourceIds);
				return {
					cards: copy(cards),
					pending: copy(doc.sources.filter((source) => !decided.has(source.id))),
					hasMore: ordered.length > offset + 1 + cards.length,
				};
			}),
		pendingSources: () =>
			locked(async () => {
				const doc = await load();
				const decided = new Set(doc.decidedSourceIds);
				return copy(doc.sources.filter((source) => !decided.has(source.id)));
			}),
		getSource: (id) =>
			locked(async () => copy(await load().then((doc) => doc.sources.find((item) => item.id === id)))),
		getCard: (id) => locked(async () => copy(await load().then((doc) => doc.cards.find((item) => item.id === id)))),
		getReply: (id) =>
			locked(async () => copy(await load().then((doc) => doc.replies.find((item) => item.id === id)))),
		getCheckpoint: () => locked(async () => copy((await load()).checkpoint)),
		setCheckpoint: (checkpoint) =>
			locked(async () => {
				const doc = await load();
				doc.checkpoint = mergeCheckpoint(doc.checkpoint, checkpoint);
				await save(doc);
				return copy(doc.checkpoint);
			}),
		decide: (sourceId, result) =>
			locked(async () => {
				const doc = await load();
				const source = doc.sources.find((item) => item.id === sourceId);
				if (!source) return undefined;
				if (doc.decidedSourceIds.includes(sourceId))
					return copy(doc.cards.find((card) => card.sourceIds.includes(sourceId)));
				const decision = validatedDecision(source, doc, result);
				const id = `card-${digest([source.workspaceId, decision.concernKey])}`;
				const previous = doc.cards.find((card) => card.id === id);
				if (previous?.needsReply && !previous.resolved && !decision.resolved && !decision.needsReply)
					throw new Error("unanswered Me concern cannot be silently dismissed");
				const sourceIds = [...new Set([...(previous?.sourceIds ?? []), ...decision.evidenceSourceIds])];
				const card: MeCard = {
					...decision,
					id,
					version: (previous?.version ?? 0) + 1,
					sourceIds,
					workspaceId: source.workspaceId,
					workspaceName: source.workspaceName,
					sessionId: source.sessionId,
					latestAt: previous && previous.latestAt > source.at ? previous.latestAt : source.at,
				};
				doc.cards = [...doc.cards.filter((item) => item.id !== id), card];
				doc.decidedSourceIds.push(sourceId);
				await save(doc);
				return copy(card);
			}),
		markRead: (cardId) =>
			locked(async () => {
				const doc = await load();
				const card = doc.cards.find((item) => item.id === cardId);
				if (!card) throw new Error("unknown Me card");
				if (!card.readAt) {
					card.readAt = new Date().toISOString();
					await save(doc);
				}
			}),
		queueReply: (input) =>
			locked(async () => {
				const doc = await load();
				const idempotencyKey = bounded(input.idempotencyKey, "idempotency key", 256);
				const existing = doc.replies.find((item) => item.idempotencyKey === idempotencyKey);
				if (existing) {
					if (
						existing.cardId !== input.cardId ||
						existing.text !== input.text ||
						existing.destinationSessionId !== input.destinationSessionId
					)
						throw new Error("Me reply idempotency key reused for different content");
					return copy(existing);
				}
				const card = doc.cards.find((item) => item.id === input.cardId);
				if (!card || card.action === "suppress" || !card.destinationSessionIds.includes(input.destinationSessionId))
					throw new Error("invalid Me reply destination");
				const reply: MeReply = {
					id: `reply-${digest([idempotencyKey])}`,
					idempotencyKey,
					cardId: card.id,
					text: exactText(input.text, "reply text", 16_000),
					destinationSessionId: input.destinationSessionId,
					status: "queued",
					queuedAt: new Date().toISOString(),
				};
				doc.replies.push(reply);
				await save(doc);
				return copy(reply);
			}),
		updateReply: (id, status, receipt) =>
			locked(async () => {
				const doc = await load();
				const reply = doc.replies.find((item) => item.id === id);
				if (!reply) throw new Error("unknown Me reply");
				advanceStatus(reply, status, receipt);
				await save(doc);
				return copy(reply);
			}),
		solIdentity: () =>
			locked(async () => {
				const doc = await load();
				if (!doc.sol) {
					doc.sol = {
						id: SOL_ID,
						role: SOL_ROLE,
						title: "Sol",
						sessionId: SOL_SESSION_ID,
						createdAt: new Date().toISOString(),
					};
					await save(doc);
				}
				return copy(doc.sol);
			}),
		appendSolTurn: (input) =>
			locked(async () => {
				const doc = await load();
				if (!doc.sol) throw new Error("Sol identity is not open");
				if (input.author !== "user" && input.author !== "sol") throw new Error("invalid Sol author");
				const idempotencyKey = bounded(input.idempotencyKey, "idempotency key", 256);
				const existing = doc.solTurns.find((item) => item.idempotencyKey === idempotencyKey);
				const text = exactText(input.text, "Sol turn", 16_000);
				if (existing) {
					if (existing.author !== input.author || existing.text !== text)
						throw new Error("Sol turn idempotency key reused for different content");
					return copy(existing);
				}
				const at = input.at ?? new Date().toISOString();
				if (!Number.isFinite(Date.parse(at))) throw new Error("invalid Sol turn time");
				const turn: SolTurn = {
					id: `sol-turn-${digest([idempotencyKey])}`,
					idempotencyKey,
					at,
					author: input.author,
					text,
				};
				doc.solTurns.push(turn);
				await save(doc);
				return copy(turn);
			}),
		listSolTurns: (options = {}) =>
			locked(async () => {
				const doc = await load();
				const limit = Math.min(100, Math.max(1, options.limit ?? 30));
				const offset = options.after ? doc.solTurns.findIndex((turn) => turn.id === options.after) : -1;
				if (options.after && offset < 0) throw new Error("unknown Sol turn cursor");
				const turns = doc.solTurns.slice(offset + 1, offset + 1 + limit);
				return { turns: copy(turns), hasMore: doc.solTurns.length > offset + 1 + turns.length };
			}),
		queueRoute: (input) =>
			locked(async () => {
				const doc = await load();
				const idempotencyKey = bounded(input.idempotencyKey, "idempotency key", 256);
				const instruction = exactText(input.instruction, "route instruction", 16_000);
				const destinationSessionIds = distinctIds(input.destinationSessionIds, "route destinations");
				const provenanceSourceIds = distinctIds(input.provenanceSourceIds, "route provenance", 32);
				const existing = doc.routes.find((item) => item.idempotencyKey === idempotencyKey);
				if (existing) {
					if (
						existing.solTurnId !== input.solTurnId ||
						existing.instruction !== instruction ||
						existing.destinationSessionIds.join("\u0000") !== destinationSessionIds.join("\u0000") ||
						existing.provenanceSourceIds.join("\u0000") !== provenanceSourceIds.join("\u0000")
					)
						throw new Error("Sol route idempotency key reused for different content");
					return copy(existing);
				}
				const turn = doc.solTurns.find((item) => item.id === input.solTurnId);
				if (!turn || turn.author !== "user" || turn.text !== instruction)
					throw new Error("Sol route must preserve the exact user instruction");
				if (!destinationSessionIds.length || destinationSessionIds.includes(SOL_SESSION_ID))
					throw new Error("Sol route requires an explicit workspace destination");
				if (
					!provenanceSourceIds.length ||
					provenanceSourceIds.some((id) => !doc.sources.some((source) => source.id === id))
				)
					throw new Error("Sol route provenance is not a captured source");
				const route: SolRouteIntent = {
					id: `route-${digest([idempotencyKey])}`,
					idempotencyKey,
					solTurnId: turn.id,
					instruction,
					destinationSessionIds,
					provenanceSourceIds,
					status: "queued",
					createdAt: new Date().toISOString(),
				};
				doc.routes.push(route);
				await save(doc);
				return copy(route);
			}),
		updateRoute: (id, status, receipt) =>
			locked(async () => {
				const doc = await load();
				const route = doc.routes.find((item) => item.id === id);
				if (!route) throw new Error("unknown Sol route");
				advanceStatus(route, status, receipt);
				await save(doc);
				return copy(route);
			}),
		getRoute: (id) => locked(async () => copy(await load().then((doc) => doc.routes.find((item) => item.id === id)))),
	};
}
