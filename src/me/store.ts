import { createHash } from "node:crypto";
import { join } from "node:path";
import { ulid } from "../core/ids.ts";
import type { SessionId } from "../core/types.ts";
import { createMutex, readJson, writeJsonAtomic } from "../store/files.ts";
import { paths } from "../store/paths.ts";

export const SOL_ID = "sol";
export const SOL_SESSION_ID = "sol";
export const SOL_ROLE = "orchestrator" as const;

export interface MeSource {
	id: string;
	workspaceId: string;
	machineId?: string;
	workspaceName: string;
	sessionId: string;
	actorKind: "leader" | "missionLead" | "agent";
	kind: "message" | "event" | "permission" | "failure";
	at: string;
	text: string;
	turnId?: string;
	eventId?: string;
	missionId?: string;
	questionId?: string;
	artifactIds?: string[];
	explicit: boolean;
	forceVisible?: boolean;
	transcriptPointer?: { sessionId: string; turnId: string; firstSeq: number; lastSeq: number; sourceHash: string };
	destinationSessionIds: string[];
}

export interface MeDecision {
	action: "surface" | "update" | "suppress" | "resolve";
	concernKey: string;
	headline: string;
	summary: string;
	evidenceSourceIds: string[];
	needsReply: boolean;
	resolved: boolean;
	destinationSessionIds: string[];
}

export interface MeDeferral {
	sourceId: string;
	until: string;
	reason: string;
	concernKey: string;
}

export interface MeCard extends MeDecision {
	id: string;
	version: number;
	sourceIds: string[];
	workspaceId: string;
	machineId?: string;
	workspaceName: string;
	sessionId: string;
	latestAt: string;
	readAt?: string;
}

export type MeNoticeStatus = "queued" | "sending" | "accepted" | "delivered" | "uncertain" | "committed";
export interface MeNotice {
	id: string;
	workspaceId: string;
	machineId?: string;
	cardId: string;
	cardVersion: number;
	sourceIds: string[];
	headline: string;
	summary: string;
	needsReply: boolean;
	resolved: boolean;
	status: MeNoticeStatus;
	createdAt: string;
	deliveryId?: string;
	nativeTurnId?: string;
	declaredSourceIds?: string[];
	messageHash?: string;
	presentationDigest?: string;
	presentedAt?: string;
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

/** Sol is a workspace-scoped attention assistant, never a workspace-leader alias. */
export interface SolIdentity {
	id: typeof SOL_ID;
	role: typeof SOL_ROLE;
	title: "Neta" | "Sol";
	sessionId: SessionId;
	createdAt: string;
	workspaceId?: string;
	machineId?: string;
	provider?: string;
	model?: string;
	runtimeInitialized?: boolean;
	contextResetAt?: string;
}
export interface SolTurn {
	id: string;
	idempotencyKey: string;
	at: string;
	author: "user" | "sol";
	text: string;
	workspaceId?: string;
	machineId?: string;
	nativeTurnId?: string;
}
export interface SolRouteIntent {
	id: string;
	idempotencyKey: string;
	solTurnId: string;
	instruction: string;
	derivedInstruction?: string;
	derivation?: string;
	destinationSessionIds: string[];
	provenanceSourceIds: string[];
	questionId?: string;
	status: MeReplyStatus;
	createdAt: string;
	receipt?: string;
	leaderReply?: string;
	leaderReplyAt?: string;
	leaderTurnId?: string;
	leaderSourceId?: string;
	leaderProcessedAt?: string;
	workspaceId?: string;
	machineId?: string;
}

export interface SolInquiry {
	id: string;
	idempotencyKey: string;
	workspaceId: string;
	leaderSessionId: string;
	question: string;
	status: MeReplyStatus | "replied" | "answered";
	createdAt: string;
	receipt?: string;
	leaderReply?: string;
	leaderReplyAt?: string;
	answer?: string;
	answeredAt?: string;
}

export interface LunaIdentity {
	id: "luna";
	role: "curator";
	title: "Luna" | "Neta attention filter";
	sessionId: SessionId;
	createdAt: string;
	workspaceId?: string;
	machineId?: string;
	provider?: string;
	model?: string;
	runtimeInitialized?: boolean;
}

export interface MeStore {
	capture(input: MeSource): Promise<MeSource>;
	list(options?: {
		workspaceId?: string;
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
	nextDeferredAt(): Promise<number | undefined>;
	defer(sourceId: string, until: string, reason: string, concernKey: string): Promise<MeDeferral>;
	recordClassifierFailure(sourceId: string): Promise<number>;
	attentionEvents(workspaceId: string, limit?: number): Promise<MeSource[]>;
	getSource(id: string): Promise<MeSource | undefined>;
	hasEscalatedQuestion(workspaceId: string, questionId: string): Promise<boolean>;
	hasVisibleQuestion(workspaceId: string, questionId: string): Promise<boolean>;
	getCard(id: string): Promise<MeCard | undefined>;
	pendingNotices(workspaceId?: string): Promise<MeNotice[]>;
	getNotice(id: string): Promise<MeNotice | undefined>;
	claimNotice(id: string): Promise<MeNotice>;
	recordNoticeDelivery(
		id: string,
		status: "accepted" | "delivered" | "uncertain",
		deliveryId?: string,
		nativeTurnId?: string,
	): Promise<MeNotice>;
	declareNotice(id: string, sourceIds: string[]): Promise<MeNotice>;
	commitNotice(id: string, turnId: string, text: string): Promise<MeNotice>;
	listPresentations(workspaceId: string, limit?: number): Promise<MeNotice[]>;
	getReply(id: string): Promise<MeReply | undefined>;
	getCheckpoint(): Promise<MeCheckpoint>;
	setCheckpoint(checkpoint: MeCheckpoint): Promise<MeCheckpoint>;
	solIdentity(workspaceId?: string): Promise<SolIdentity>;
	solBySession(sessionId: string): Promise<SolIdentity | undefined>;
	listSolIdentities(): Promise<SolIdentity[]>;
	bindSolRuntime(input: {
		workspaceId: string;
		machineId?: string;
		provider: string;
		model: string;
	}): Promise<SolIdentity>;
	markSolRuntimeInitialized(workspaceId?: string): Promise<SolIdentity>;
	resetSolSession(workspaceId: string, currentSessionId: string, nextSessionId: string): Promise<SolIdentity>;
	appendSolTurn(input: {
		workspaceId?: string;
		idempotencyKey: string;
		author: "user" | "sol";
		text: string;
		at?: string;
	}): Promise<SolTurn>;
	getSolTurn(id: string): Promise<SolTurn | undefined>;
	bindSolNativeTurn(id: string, nativeTurnId: string): Promise<SolTurn>;
	listSolTurns(options?: {
		workspaceId?: string;
		limit?: number;
		after?: string;
	}): Promise<{ turns: SolTurn[]; hasMore: boolean }>;
	listRecentSolTurns(limit?: number, workspaceId?: string): Promise<SolTurn[]>;
	queueRoute(input: {
		idempotencyKey: string;
		solTurnId: string;
		instruction: string;
		derivedInstruction?: string;
		derivation?: string;
		destinationSessionIds: string[];
		provenanceSourceIds: string[];
		questionId?: string;
	}): Promise<SolRouteIntent>;
	updateRoute(id: string, status: MeReplyStatus, receipt?: string): Promise<SolRouteIntent>;
	recordRouteReply(
		id: string,
		reply: string,
		provenance?: { turnId: string; sourceId: string },
	): Promise<SolRouteIntent>;
	getRoute(id: string): Promise<SolRouteIntent | undefined>;
	listRoutes(limit?: number, workspaceId?: string): Promise<SolRouteIntent[]>;
	unprocessedRoutes(): Promise<SolRouteIntent[]>;
	queueInquiry(input: {
		idempotencyKey: string;
		workspaceId: string;
		leaderSessionId: string;
		question: string;
	}): Promise<SolInquiry>;
	updateInquiry(id: string, status: MeReplyStatus, receipt?: string): Promise<SolInquiry>;
	recordInquiryReply(id: string, reply: string): Promise<SolInquiry>;
	answerInquiry(id: string, answer: string): Promise<SolInquiry>;
	getInquiry(id: string): Promise<SolInquiry | undefined>;
	listInquiries(workspaceId: string, limit?: number, after?: string): Promise<SolInquiry[]>;
	lunaIdentity(workspaceId: string): Promise<LunaIdentity>;
	listLunaIdentities(): Promise<LunaIdentity[]>;
	bindLunaRuntime(input: {
		workspaceId: string;
		machineId?: string;
		provider: string;
		model: string;
	}): Promise<LunaIdentity>;
	markLunaRuntimeInitialized(workspaceId: string): Promise<LunaIdentity>;
}

interface Document {
	version: 5;
	sources: MeSource[];
	decidedSourceIds: string[];
	deferrals: MeDeferral[];
	classifierFailures: Record<string, number>;
	cards: MeCard[];
	notices: MeNotice[];
	replies: MeReply[];
	checkpoint: MeCheckpoint;
	sol?: SolIdentity;
	sols: Record<string, SolIdentity>;
	luna?: LunaIdentity;
	lunas: Record<string, LunaIdentity>;
	solTurns: SolTurn[];
	routes: SolRouteIntent[];
	inquiries: SolInquiry[];
}

const mutexes = new Map<string, ReturnType<typeof createMutex>>();
const emptyCheckpoint = (): MeCheckpoint => ({ workspaces: [] });
const empty = (): Document => ({
	version: 5,
	sources: [],
	decidedSourceIds: [],
	deferrals: [],
	classifierFailures: {},
	cards: [],
	notices: [],
	replies: [],
	checkpoint: emptyCheckpoint(),
	sols: {},
	lunas: {},
	solTurns: [],
	routes: [],
	inquiries: [],
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
	if (sessionId === SOL_SESSION_ID) throw new Error("Neta is not a workspace session");
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
	if (destinationSessionIds.includes(SOL_SESSION_ID)) throw new Error("Neta is not a reply destination");
	if (!destinationSessionIds.length || !destinationSessionIds.includes(sessionId))
		throw new Error("Me source must include its originating session as a destination");
	const source: MeSource = {
		id: "",
		workspaceId,
		...(input.machineId === undefined ? {} : { machineId: bounded(input.machineId, "machineId", 256) }),
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
		...(input.questionId === undefined ? {} : { questionId: bounded(input.questionId, "questionId", 256) }),
		...(input.artifactIds === undefined ? {} : { artifactIds: distinctIds(input.artifactIds, "artifact IDs", 16) }),
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
	if (!result || !["surface", "update", "suppress", "resolve"].includes(result.action))
		throw new Error("invalid Me action");
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
	if (
		!result.resolved &&
		!result.needsReply &&
		doc.sources.some((item) => evidenceSourceIds.includes(item.id) && item.questionId)
	)
		throw new Error("pending question cannot lose its reply requirement");
	if (
		result.needsReply &&
		(result.resolved || !destinationSessionIds.length || result.action === "suppress" || result.action === "resolve")
	)
		throw new Error("a pending question requires a visible reply destination");
	if (result.action === "resolve" && (!result.resolved || result.needsReply))
		throw new Error("resolution must clear its pending question or blocker");
	if (result.resolved && result.action !== "resolve")
		throw new Error("resolved concern requires a cited resolution action");
	if (
		result.action === "suppress" &&
		doc.sources.some((item) => evidenceSourceIds.includes(item.id) && item.forceVisible)
	)
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

function normalize(raw: (Omit<Partial<Document>, "version"> & { version?: 1 | 2 | 3 | 4 | 5 }) | undefined): Document {
	if (!raw) return empty();
	if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3 && raw.version !== 4 && raw.version !== 5)
		throw new Error("unsupported Me store version");
	if (raw.sol && (raw.sol.id !== SOL_ID || raw.sol.role !== SOL_ROLE || typeof raw.sol.sessionId !== "string"))
		throw new Error("Neta identity cannot alias a workspace leader");
	if (raw.luna && (raw.luna.id !== "luna" || raw.luna.role !== "curator" || typeof raw.luna.sessionId !== "string"))
		throw new Error("Luna identity is invalid");
	const lunas = { ...(raw.lunas ?? {}) };
	if (raw.luna?.workspaceId && !lunas[raw.luna.workspaceId]) lunas[raw.luna.workspaceId] = raw.luna;
	for (const [workspaceId, identity] of Object.entries(lunas)) {
		if (identity.workspaceId !== workspaceId || identity.id !== "luna" || identity.role !== "curator")
			throw new Error("workspace filter identity is invalid");
	}
	const sol = raw.sol?.sessionId === SOL_SESSION_ID ? undefined : raw.sol;
	const sols = { ...(raw.sols ?? {}) };
	if (sol?.workspaceId && !sols[sol.workspaceId]) sols[sol.workspaceId] = sol;
	for (const [workspaceId, identity] of Object.entries(sols)) {
		if (
			identity.id !== SOL_ID ||
			identity.role !== SOL_ROLE ||
			identity.workspaceId !== workspaceId ||
			typeof identity.sessionId !== "string"
		)
			throw new Error("workspace Neta identity is invalid");
		identity.title = "Neta";
	}
	return {
		version: 5,
		sources: raw.sources ?? [],
		decidedSourceIds: raw.decidedSourceIds ?? [],
		deferrals: raw.deferrals ?? [],
		classifierFailures: raw.classifierFailures ?? {},
		cards: raw.cards ?? [],
		notices: raw.notices ?? [],
		replies: raw.replies ?? [],
		checkpoint: raw.checkpoint ?? emptyCheckpoint(),
		...(sol && !sol.workspaceId ? { sol } : {}),
		sols,
		lunas,
		solTurns: (raw.solTurns ?? []).map((turn) =>
			turn.workspaceId || !sol?.workspaceId ? turn : { ...turn, workspaceId: sol.workspaceId },
		),
		routes: (raw.routes ?? []).map((route) =>
			route.workspaceId || !sol?.workspaceId ? route : { ...route, workspaceId: sol.workspaceId },
		),
		inquiries: raw.inquiries ?? [],
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
		normalize(await readJson<Omit<Partial<Document>, "version"> & { version?: 1 | 2 | 3 | 4 | 5 }>(file));
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
					.filter(
						(card) =>
							(!options.workspaceId || card.workspaceId === options.workspaceId) &&
							(options.includeSuppressed || card.action !== "suppress"),
					)
					.sort((a, b) => b.latestAt.localeCompare(a.latestAt) || b.id.localeCompare(a.id));
				const offset = options.after ? ordered.findIndex((card) => card.id === options.after) : -1;
				if (options.after && offset < 0) throw new Error("unknown Me page cursor");
				const cards = ordered.slice(offset + 1, offset + 1 + limit);
				const decided = new Set(doc.decidedSourceIds);
				return {
					cards: copy(cards),
					pending: copy(
						doc.sources.filter(
							(source) =>
								!decided.has(source.id) && (!options.workspaceId || source.workspaceId === options.workspaceId),
						),
					),
					hasMore: ordered.length > offset + 1 + cards.length,
				};
			}),
		pendingSources: () =>
			locked(async () => {
				const doc = await load();
				const decided = new Set(doc.decidedSourceIds);
				const now = Date.now();
				return copy(
					doc.sources.filter(
						(source) =>
							!decided.has(source.id) &&
							!doc.deferrals.some((item) => item.sourceId === source.id && Date.parse(item.until) > now),
					),
				);
			}),
		nextDeferredAt: () =>
			locked(async () => {
				const doc = await load();
				const decided = new Set(doc.decidedSourceIds);
				const times = doc.deferrals
					.filter((item) => !decided.has(item.sourceId))
					.map((item) => Date.parse(item.until))
					.filter((value) => value > Date.now());
				return times.length ? Math.min(...times) : undefined;
			}),
		defer: (sourceId, until, reason, concernKey) =>
			locked(async () => {
				const doc = await load();
				const source = doc.sources.find((item) => item.id === sourceId);
				if (!source || doc.decidedSourceIds.includes(sourceId)) throw new Error("unknown or decided Me source");
				if (source.forceVisible) throw new Error("urgent attention cannot be deferred");
				const deadline = Date.parse(until);
				if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 24 * 60 * 60 * 1000)
					throw new Error("deferral needs a future deadline within 24 hours");
				const value: MeDeferral = {
					sourceId,
					until: new Date(deadline).toISOString(),
					reason: bounded(reason, "deferral reason", 600),
					concernKey: bounded(concernKey, "deferral concern", 160),
				};
				doc.deferrals = [...doc.deferrals.filter((item) => item.sourceId !== sourceId), value];
				await save(doc);
				return copy(value);
			}),
		recordClassifierFailure: (sourceId) =>
			locked(async () => {
				const doc = await load();
				if (!doc.sources.some((item) => item.id === sourceId)) throw new Error("unknown Me source");
				const failures = (doc.classifierFailures[sourceId] ?? 0) + 1;
				doc.classifierFailures[sourceId] = failures;
				await save(doc);
				return failures;
			}),
		attentionEvents: (workspaceId, limit = 30) =>
			locked(async () => {
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
					throw new Error("invalid attention event limit");
				return copy(
					(await load()).sources
						.filter(
							(source) =>
								source.workspaceId === workspaceId &&
								(source.text.startsWith("mission.blocked") ||
									source.text.startsWith("mission.failed") ||
									source.text.startsWith("mission.readyToClose") ||
									source.text.startsWith("routing.failed")),
						)
						.slice(-limit)
						.reverse(),
				);
			}),
		getSource: (id) =>
			locked(async () => copy(await load().then((doc) => doc.sources.find((item) => item.id === id)))),
		hasEscalatedQuestion: (workspaceId, questionId) =>
			locked(async () =>
				(await load()).sources.some(
					(item) =>
						item.workspaceId === workspaceId &&
						item.questionId === questionId &&
						item.actorKind === "leader" &&
						item.text.startsWith("mission.blocked") &&
						item.forceVisible === true,
				),
			),
		hasVisibleQuestion: (workspaceId, questionId) =>
			locked(async () =>
				(await load()).sources.some(
					(item) =>
						item.workspaceId === workspaceId && item.questionId === questionId && item.forceVisible === true,
				),
			),
		getCard: (id) => locked(async () => copy(await load().then((doc) => doc.cards.find((item) => item.id === id)))),
		pendingNotices: (workspaceId) =>
			locked(async () =>
				copy(
					(await load()).notices.filter(
						(notice) => notice.status !== "committed" && (!workspaceId || notice.workspaceId === workspaceId),
					),
				),
			),
		getNotice: (id) => locked(async () => copy((await load()).notices.find((notice) => notice.id === id))),
		claimNotice: (id) =>
			locked(async () => {
				const doc = await load();
				const notice = doc.notices.find((item) => item.id === id);
				if (!notice) throw new Error("unknown Neta notice");
				if (notice.status === "queued") {
					notice.status = "sending";
					await save(doc);
				}
				return copy(notice);
			}),
		recordNoticeDelivery: (id, status, deliveryId, nativeTurnId) =>
			locked(async () => {
				const doc = await load();
				const notice = doc.notices.find((item) => item.id === id);
				if (!notice) throw new Error("unknown Neta notice");
				if (notice.status === "committed") return copy(notice);
				if (notice.status === "queued") throw new Error("Neta notice was not claimed for delivery");
				notice.status = status;
				if (deliveryId) notice.deliveryId = bounded(deliveryId, "notice delivery", 256);
				if (nativeTurnId) notice.nativeTurnId = bounded(nativeTurnId, "notice native turn", 256);
				await save(doc);
				return copy(notice);
			}),
		declareNotice: (id, sourceIds) =>
			locked(async () => {
				const doc = await load();
				const notice = doc.notices.find((item) => item.id === id);
				if (!notice) throw new Error("unknown Neta notice");
				if (notice.status === "committed") return copy(notice);
				const selected = distinctIds(sourceIds, "presented sources", 32);
				if (!selected.length || selected.some((sourceId) => !notice.sourceIds.includes(sourceId)))
					throw new Error("presentation must cite this notice's captured sources");
				if (notice.declaredSourceIds && notice.declaredSourceIds.join("\u0000") !== selected.join("\u0000"))
					throw new Error("Neta notice was already declared with different sources");
				notice.declaredSourceIds = selected;
				await save(doc);
				return copy(notice);
			}),
		commitNotice: (id, turnId, text) =>
			locked(async () => {
				const doc = await load();
				const notice = doc.notices.find((item) => item.id === id);
				if (!notice) throw new Error("unknown Neta notice");
				const boundTurnId = bounded(turnId, "notice turn", 256);
				if (notice.status === "committed") {
					if (notice.nativeTurnId !== boundTurnId) throw new Error("Neta notice committed in another turn");
					return copy(notice);
				}
				if (!notice.declaredSourceIds?.length || notice.nativeTurnId !== boundTurnId)
					throw new Error("Neta notice has no declaration bound to the delivered turn");
				const finalText = exactText(text, "presented message", 32_000);
				notice.messageHash = createHash("sha256").update(finalText).digest("hex");
				notice.presentationDigest = finalText.slice(0, 1_200);
				notice.presentedAt = new Date().toISOString();
				notice.status = "committed";
				await save(doc);
				return copy(notice);
			}),
		listPresentations: (workspaceId, limit = 20) =>
			locked(async () => {
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid presentation limit");
				return copy(
					(await load()).notices
						.filter((notice) => notice.workspaceId === workspaceId && notice.status === "committed")
						.slice(-limit),
				);
			}),
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
				if (
					decision.action === "resolve" &&
					(!previous ||
						previous.resolved ||
						!previous.sourceIds.some((id) => decision.evidenceSourceIds.includes(id)) ||
						!decision.evidenceSourceIds.some((id) => id !== sourceId && previous.sourceIds.includes(id)))
				)
					throw new Error("resolution must cite the earlier unresolved concern and its new evidence");
				if (previous?.needsReply && !previous.resolved && !decision.resolved && !decision.needsReply)
					throw new Error("unanswered Me concern cannot be silently dismissed");
				const sourceIds = [...new Set([...(previous?.sourceIds ?? []), ...decision.evidenceSourceIds])];
				const card: MeCard = {
					...decision,
					id,
					version: (previous?.version ?? 0) + 1,
					sourceIds,
					workspaceId: source.workspaceId,
					...(source.machineId ? { machineId: source.machineId } : {}),
					workspaceName: source.workspaceName,
					sessionId: source.sessionId,
					latestAt: previous && previous.latestAt > source.at ? previous.latestAt : source.at,
				};
				doc.cards = [...doc.cards.filter((item) => item.id !== id), card];
				if (decision.action !== "suppress") {
					const queued = doc.notices.find((notice) => notice.cardId === id && notice.status === "queued");
					if (queued) {
						queued.cardVersion = card.version;
						queued.sourceIds = sourceIds;
						queued.headline = card.headline;
						queued.summary = card.summary;
						queued.needsReply = card.needsReply;
						queued.resolved = card.resolved;
					} else {
						doc.notices.push({
							id: `notice-${digest([card.id, card.version])}`,
							workspaceId: card.workspaceId,
							...(source.machineId ? { machineId: source.machineId } : {}),
							cardId: card.id,
							cardVersion: card.version,
							sourceIds,
							headline: card.headline,
							summary: card.summary,
							needsReply: card.needsReply,
							resolved: card.resolved,
							status: "queued",
							createdAt: new Date().toISOString(),
						});
					}
				}
				for (const id of decision.evidenceSourceIds) {
					if (!doc.decidedSourceIds.includes(id)) doc.decidedSourceIds.push(id);
					delete doc.classifierFailures[id];
				}
				doc.deferrals = doc.deferrals.filter((item) => !decision.evidenceSourceIds.includes(item.sourceId));
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
		solIdentity: (workspaceId) =>
			locked(async () => {
				const doc = await load();
				if (workspaceId !== undefined) {
					const id = bounded(workspaceId, "Neta workspaceId", 256);
					if (!doc.sols[id]) {
						doc.sols[id] = {
							id: SOL_ID,
							role: SOL_ROLE,
							title: "Neta",
							sessionId: ulid() as SessionId,
							createdAt: new Date().toISOString(),
							workspaceId: id,
						};
						await save(doc);
					}
					return copy(doc.sols[id]);
				}
				const first = Object.values(doc.sols)[0];
				if (first) return copy(first);
				if (!doc.sol) {
					doc.sol = {
						id: SOL_ID,
						role: SOL_ROLE,
						title: "Neta",
						sessionId: ulid() as SessionId,
						createdAt: new Date().toISOString(),
					};
					await save(doc);
				}
				return copy(doc.sol);
			}),
		solBySession: (sessionId) =>
			locked(async () => {
				const doc = await load();
				return copy(
					Object.values(doc.sols).find((sol) => sol.sessionId === sessionId) ??
						(doc.sol?.sessionId === sessionId ? doc.sol : undefined),
				);
			}),
		listSolIdentities: () => locked(async () => copy(Object.values((await load()).sols))),
		lunaIdentity: (workspaceId) =>
			locked(async () => {
				const doc = await load();
				const id = bounded(workspaceId, "filter workspaceId", 256);
				if (!doc.lunas[id]) {
					doc.lunas[id] = {
						id: "luna",
						role: "curator",
						title: "Neta attention filter",
						sessionId: ulid() as SessionId,
						createdAt: new Date().toISOString(),
						workspaceId: id,
					};
					await save(doc);
				}
				return copy(doc.lunas[id]);
			}),
		listLunaIdentities: () => locked(async () => copy(Object.values((await load()).lunas))),
		bindLunaRuntime: (input) =>
			locked(async () => {
				const doc = await load();
				const workspaceId = bounded(input.workspaceId, "filter workspaceId", 256);
				if (!doc.lunas[workspaceId]) {
					doc.lunas[workspaceId] = {
						id: "luna",
						role: "curator",
						title: "Neta attention filter",
						sessionId: ulid() as SessionId,
						createdAt: new Date().toISOString(),
						workspaceId,
					};
				}
				const luna = doc.lunas[workspaceId];
				let machineBound = false;
				if (input.machineId) {
					const machineId = bounded(input.machineId, "filter machineId", 256);
					if (luna.machineId && luna.machineId !== machineId)
						throw new Error("filter belongs to another machine copy");
					machineBound = !luna.machineId;
					luna.machineId = machineId;
				}
				if (luna.provider) {
					if (luna.provider !== input.provider || luna.model !== input.model)
						throw new Error("filter native session is already bound to another runtime target");
					if (machineBound) await save(doc);
					return copy(luna);
				}
				luna.provider = bounded(input.provider, "filter provider", 256);
				luna.model = bounded(input.model, "filter model", 256);
				luna.runtimeInitialized = false;
				await save(doc);
				return copy(luna);
			}),
		markLunaRuntimeInitialized: (workspaceId) =>
			locked(async () => {
				const doc = await load();
				const luna = doc.lunas[bounded(workspaceId, "filter workspaceId", 256)];
				if (!luna?.workspaceId) throw new Error("filter runtime target is not reserved");
				luna.runtimeInitialized = true;
				await save(doc);
				return copy(luna);
			}),
		bindSolRuntime: (input) =>
			locked(async () => {
				const doc = await load();
				const workspaceId = bounded(input.workspaceId, "Neta workspaceId", 256);
				let sol = doc.sols[workspaceId];
				if (!sol) {
					sol = {
						id: SOL_ID,
						role: SOL_ROLE,
						title: "Neta",
						sessionId: ulid() as SessionId,
						createdAt: new Date().toISOString(),
						workspaceId,
					};
					doc.sols[workspaceId] = sol;
				}
				let machineBound = false;
				if (input.machineId) {
					const machineId = bounded(input.machineId, "Neta machineId", 256);
					if (sol.machineId && sol.machineId !== machineId)
						throw new Error("Neta chat belongs to another machine copy");
					machineBound = !sol.machineId;
					sol.machineId = machineId;
				}
				if (sol.provider) {
					if (sol.provider !== input.provider || sol.model !== input.model)
						throw new Error("Neta native session is already bound to another runtime target");
					if (machineBound) await save(doc);
					return copy(sol);
				}
				sol.provider = bounded(input.provider, "Neta provider", 256);
				sol.model = bounded(input.model, "Neta model", 256);
				sol.runtimeInitialized = false;
				await save(doc);
				return copy(sol);
			}),
		markSolRuntimeInitialized: (workspaceId) =>
			locked(async () => {
				const doc = await load();
				const sol = workspaceId ? doc.sols[workspaceId] : (Object.values(doc.sols)[0] ?? doc.sol);
				if (!sol?.workspaceId) throw new Error("Neta runtime target is not reserved");
				sol.runtimeInitialized = true;
				await save(doc);
				return copy(sol);
			}),
		resetSolSession: (workspaceId, currentSessionId, nextSessionId) =>
			locked(async () => {
				const doc = await load();
				const sol = doc.sols[bounded(workspaceId, "Neta workspaceId", 256)];
				if (!sol || sol.sessionId !== currentSessionId) throw new Error("Neta session changed during chat reset");
				const next = bounded(nextSessionId, "Neta next sessionId", 256);
				if (Object.values(doc.sols).some((item) => item !== sol && item.sessionId === next))
					throw new Error("Neta reset session aliases another workspace");
				sol.sessionId = next;
				sol.runtimeInitialized = true;
				sol.contextResetAt = new Date().toISOString();
				await save(doc);
				return copy(sol);
			}),
		appendSolTurn: (input) =>
			locked(async () => {
				const doc = await load();
				const workspaceId = input.workspaceId ?? Object.values(doc.sols)[0]?.workspaceId;
				if (!workspaceId && !doc.sol) throw new Error("Neta identity is not open");
				if (workspaceId && !doc.sols[workspaceId]) throw new Error("Neta workspace identity is not open");
				if (input.author !== "user" && input.author !== "sol") throw new Error("invalid Neta author");
				const idempotencyKey = bounded(input.idempotencyKey, "idempotency key", 256);
				const existing = doc.solTurns.find((item) => item.idempotencyKey === idempotencyKey);
				const text = exactText(input.text, "Neta turn", 16_000);
				if (existing) {
					if (existing.author !== input.author || existing.text !== text || existing.workspaceId !== workspaceId)
						throw new Error("Neta turn idempotency key reused for different content");
					return copy(existing);
				}
				const at = input.at ?? new Date().toISOString();
				if (!Number.isFinite(Date.parse(at))) throw new Error("invalid Neta turn time");
				const turn: SolTurn = {
					id: `sol-turn-${digest([idempotencyKey])}`,
					idempotencyKey,
					at,
					author: input.author,
					text,
					...(workspaceId ? { workspaceId } : {}),
					...(workspaceId && doc.sols[workspaceId]?.machineId
						? { machineId: doc.sols[workspaceId].machineId }
						: {}),
				};
				doc.solTurns.push(turn);
				await save(doc);
				return copy(turn);
			}),
		listSolTurns: (options = {}) =>
			locked(async () => {
				const doc = await load();
				const scoped = options.workspaceId
					? doc.solTurns.filter((turn) => turn.workspaceId === options.workspaceId)
					: doc.solTurns;
				const limit = Math.min(100, Math.max(1, options.limit ?? 30));
				const offset = options.after ? scoped.findIndex((turn) => turn.id === options.after) : -1;
				if (options.after && offset < 0) throw new Error("unknown Neta turn cursor");
				const turns = scoped.slice(offset + 1, offset + 1 + limit);
				return { turns: copy(turns), hasMore: scoped.length > offset + 1 + turns.length };
			}),
		listRecentSolTurns: (limit = 12, workspaceId) =>
			locked(async () => {
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
					throw new Error("invalid Neta recent-turn limit");
				const turns = (await load()).solTurns;
				return copy((workspaceId ? turns.filter((turn) => turn.workspaceId === workspaceId) : turns).slice(-limit));
			}),
		getSolTurn: (id) => locked(async () => copy((await load()).solTurns.find((turn) => turn.id === id))),
		bindSolNativeTurn: (id, nativeTurnId) =>
			locked(async () => {
				const doc = await load();
				const turn = doc.solTurns.find((item) => item.id === id);
				if (!turn) throw new Error("unknown Neta turn");
				const bound = bounded(nativeTurnId, "native turn id", 256);
				if (turn.nativeTurnId && turn.nativeTurnId !== bound)
					throw new Error("Neta turn is already correlated to another native turn");
				turn.nativeTurnId = bound;
				await save(doc);
				return copy(turn);
			}),
		queueRoute: (input) =>
			locked(async () => {
				const doc = await load();
				const idempotencyKey = bounded(input.idempotencyKey, "idempotency key", 256);
				const instruction = exactText(input.instruction, "route instruction", 16_000);
				const derivedInstruction =
					input.derivedInstruction === undefined
						? undefined
						: exactText(input.derivedInstruction, "derived route instruction", 16_000);
				const derivation =
					input.derivation === undefined ? undefined : bounded(input.derivation, "route derivation", 2_000);
				const destinationSessionIds = distinctIds(input.destinationSessionIds, "route destinations");
				const provenanceSourceIds = distinctIds(input.provenanceSourceIds, "route provenance", 32);
				const questionId =
					input.questionId === undefined ? undefined : bounded(input.questionId, "route questionId", 256);
				const existing = doc.routes.find((item) => item.idempotencyKey === idempotencyKey);
				if (existing) {
					if (
						existing.solTurnId !== input.solTurnId ||
						existing.instruction !== instruction ||
						existing.derivedInstruction !== derivedInstruction ||
						existing.derivation !== derivation ||
						existing.destinationSessionIds.join("\u0000") !== destinationSessionIds.join("\u0000") ||
						existing.provenanceSourceIds.join("\u0000") !== provenanceSourceIds.join("\u0000") ||
						existing.questionId !== questionId
					)
						throw new Error("Neta route idempotency key reused for different content");
					return copy(existing);
				}
				const turn = doc.solTurns.find((item) => item.id === input.solTurnId);
				if (!turn || turn.author !== "user" || turn.text !== instruction)
					throw new Error("Neta route must preserve the exact user instruction");
				if (
					turn.workspaceId &&
					provenanceSourceIds.some(
						(id) => !doc.sources.some((source) => source.id === id && source.workspaceId === turn.workspaceId),
					)
				)
					throw new Error("Neta route provenance must belong to its workspace");
				if (!destinationSessionIds.length || destinationSessionIds.includes(SOL_SESSION_ID))
					throw new Error("Neta route requires an explicit workspace destination");
				if (provenanceSourceIds.some((id) => !doc.sources.some((source) => source.id === id)))
					throw new Error("Neta route provenance is not a captured source");
				if (
					questionId &&
					!provenanceSourceIds.some((id) =>
						doc.sources.some(
							(source) =>
								source.id === id &&
								source.workspaceId === turn.workspaceId &&
								source.questionId === questionId &&
								source.forceVisible,
						),
					)
				)
					throw new Error("route question must cite its captured pending question");
				const route: SolRouteIntent = {
					id: `route-${digest([idempotencyKey])}`,
					idempotencyKey,
					solTurnId: turn.id,
					instruction,
					...(derivedInstruction === undefined ? {} : { derivedInstruction }),
					...(derivation === undefined ? {} : { derivation }),
					destinationSessionIds,
					provenanceSourceIds,
					...(questionId ? { questionId } : {}),
					status: "queued",
					createdAt: new Date().toISOString(),
					...(turn.workspaceId ? { workspaceId: turn.workspaceId } : {}),
					...(turn.machineId ? { machineId: turn.machineId } : {}),
				};
				doc.routes.push(route);
				await save(doc);
				return copy(route);
			}),
		updateRoute: (id, status, receipt) =>
			locked(async () => {
				const doc = await load();
				const route = doc.routes.find((item) => item.id === id);
				if (!route) throw new Error("unknown Neta route");
				advanceStatus(route, status, receipt);
				await save(doc);
				return copy(route);
			}),
		recordRouteReply: (id, reply, provenance) =>
			locked(async () => {
				const doc = await load();
				const route = doc.routes.find((item) => item.id === id);
				if (!route) throw new Error("unknown Neta route");
				if (route.leaderReply !== undefined) return copy(route);
				if (route.status !== "delivered" && route.status !== "accepted" && route.status !== "uncertain")
					throw new Error("route delivery was not confirmed");
				if (provenance) {
					const source = doc.sources.find((item) => item.id === provenance.sourceId);
					if (
						!source ||
						source.turnId !== provenance.turnId ||
						source.sessionId !== route.destinationSessionIds[0] ||
						source.workspaceId !== route.workspaceId
					)
						throw new Error("route leader reply source does not match delivery");
					route.leaderTurnId = provenance.turnId;
					route.leaderSourceId = provenance.sourceId;
					route.leaderProcessedAt = new Date().toISOString();
				}
				route.leaderReply = exactText(reply, "route leader reply", 16_000);
				route.leaderReplyAt = new Date().toISOString();
				route.status = "delivered";
				await save(doc);
				return copy(route);
			}),
		getRoute: (id) => locked(async () => copy(await load().then((doc) => doc.routes.find((item) => item.id === id)))),
		listRoutes: (limit = 20, workspaceId) =>
			locked(async () => {
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid Neta route limit");
				const routes = (await load()).routes;
				return copy(
					(workspaceId ? routes.filter((route) => route.workspaceId === workspaceId) : routes)
						.slice(-limit)
						.reverse(),
				);
			}),
		unprocessedRoutes: () =>
			locked(async () => copy((await load()).routes.filter((route) => route.leaderReply === undefined))),
		queueInquiry: (input) =>
			locked(async () => {
				const doc = await load();
				const idempotencyKey = bounded(input.idempotencyKey, "inquiry idempotency key", 256);
				const workspaceId = bounded(input.workspaceId, "inquiry workspace", 256);
				const leaderSessionId = bounded(input.leaderSessionId, "inquiry leader", 256);
				const question = exactText(input.question, "inquiry question", 16_000);
				if (!doc.sols[workspaceId]) throw new Error("inquiry workspace has no Neta conversation");
				const existing = doc.inquiries.find((item) => item.idempotencyKey === idempotencyKey);
				if (existing) {
					if (
						existing.workspaceId !== workspaceId ||
						existing.leaderSessionId !== leaderSessionId ||
						existing.question !== question
					)
						throw new Error("inquiry idempotency key reused for different content");
					return copy(existing);
				}
				const inquiry: SolInquiry = {
					id: `inquiry-${digest([idempotencyKey])}`,
					idempotencyKey,
					workspaceId,
					leaderSessionId,
					question,
					status: "queued",
					createdAt: new Date().toISOString(),
				};
				doc.inquiries.push(inquiry);
				await save(doc);
				return copy(inquiry);
			}),
		updateInquiry: (id, status, receipt) =>
			locked(async () => {
				const doc = await load();
				const inquiry = doc.inquiries.find((item) => item.id === id);
				if (!inquiry) throw new Error("unknown Neta inquiry");
				if (inquiry.status === "answered" || inquiry.status === "replied") return copy(inquiry);
				advanceStatus(inquiry as SolInquiry & { status: MeReplyStatus }, status, receipt);
				await save(doc);
				return copy(inquiry);
			}),
		recordInquiryReply: (id, reply) =>
			locked(async () => {
				const doc = await load();
				const inquiry = doc.inquiries.find((item) => item.id === id);
				if (!inquiry) throw new Error("unknown Neta inquiry");
				if (inquiry.status === "answered" || inquiry.leaderReply !== undefined) return copy(inquiry);
				inquiry.leaderReply = exactText(reply, "inquiry leader reply", 16_000);
				inquiry.leaderReplyAt = new Date().toISOString();
				inquiry.status = "replied";
				await save(doc);
				return copy(inquiry);
			}),
		answerInquiry: (id, answer) =>
			locked(async () => {
				const doc = await load();
				const inquiry = doc.inquiries.find((item) => item.id === id);
				if (!inquiry) throw new Error("unknown Neta inquiry");
				if (inquiry.status === "answered") {
					if (inquiry.answer !== answer) throw new Error("Neta inquiry was already answered differently");
					return copy(inquiry);
				}
				if (inquiry.status === "rejected") throw new Error("inquiry delivery was rejected");
				inquiry.answer = exactText(answer, "inquiry answer", 16_000);
				inquiry.answeredAt = new Date().toISOString();
				inquiry.status = "answered";
				await save(doc);
				return copy(inquiry);
			}),
		getInquiry: (id) => locked(async () => copy((await load()).inquiries.find((item) => item.id === id))),
		listInquiries: (workspaceId, limit = 30, after) =>
			locked(async () => {
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid inquiry limit");
				const all = (await load()).inquiries.filter((item) => item.workspaceId === workspaceId);
				const ordered = [
					...all.filter((item) => item.status !== "answered").reverse(),
					...all.filter((item) => item.status === "answered").reverse(),
				];
				const offset = after ? ordered.findIndex((item) => item.id === after) + 1 : 0;
				if (after && offset === 0) throw new Error("unknown inquiry cursor");
				return copy(ordered.slice(offset, offset + limit));
			}),
	};
}
