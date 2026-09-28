import { createHash } from "node:crypto";
import { join } from "node:path";
import { ulid } from "../core/ids.ts";
import { createMutex, readJson, writeJsonAtomic } from "../store/files.ts";
import { paths } from "../store/paths.ts";

export const NETA_ID = "neta";
export const NETA_SESSION_ID = "neta";
export const NETA_ROLE = "neta" as const;

/** References are transport metadata owned by Node, never model arguments. */
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
	artifactIds?: string[];
	transcriptPointer?: { sessionId: string; turnId: string; firstSeq: number; lastSeq: number; sourceHash: string };
}
export type MeDecision =
	| { action: "send"; reason: string; text: string }
	| { action: "suppress"; reason: string }
	| { action: "defer"; reason: string; until: string };
export type DeliveryState = "awaiting filter" | "suppressed" | "deferred" | "delivery pending" | "delivered" | "failed";
export interface MeNotice {
	id: string;
	workspaceId: string;
	machineId?: string;
	sourceIds: string[];
	createdAt: string;
	state: DeliveryState;
	decision?: MeDecision;
	attempts: number;
	retryGeneration?: number;
	text?: string;
	error?: string;
	uncertain?: boolean;
	deliveryId?: string;
	nativeTurnId?: string;
	presentedAt?: string;
	presentation?: string;
}
export interface MeTurnCursor {
	sessionId: string;
	turnId: string;
	blockSeq?: number;
	fileCursor?: number;
}
export interface MeCheckpoint {
	workspaces: { workspaceId: string; eventSeq: number; turns: MeTurnCursor[] }[];
}
export interface WorkspaceLeaderIdentity {
	id: "neta";
	role: "neta";
	title: "Workspace leader";
	sessionId: string;
	createdAt: string;
	workspaceId: string;
	machineId?: string;
	provider?: string;
	model?: string;
	runtimeInitialized?: boolean;
	contextResetAt?: string;
}
export interface FilterIdentity {
	id: "filter";
	role: "curator";
	title: "Filter";
	sessionId: string;
	createdAt: string;
	workspaceId: string;
	machineId?: string;
	provider?: string;
	model?: string;
	runtimeInitialized?: boolean;
	toolsEnabled?: boolean;
}
interface Document {
	version: 1;
	cutoverAt: string;
	sources: MeSource[];
	notices: MeNotice[];
	checkpoint: MeCheckpoint;
	// Preserve saved identities under their existing disk key across role renames.
	netas: Record<string, WorkspaceLeaderIdentity>;
	filters: Record<string, FilterIdentity>;
	contextCursors?: Record<string, Record<string, string>>;
}
const locks = new Map<string, ReturnType<typeof createMutex>>();
export function meSourceId(
	source: Pick<MeSource, "workspaceId" | "sessionId" | "kind" | "turnId" | "eventId">,
): string {
	return createHash("sha256")
		.update(JSON.stringify([source.workspaceId, source.sessionId, source.turnId ?? source.eventId, source.kind]))
		.digest("hex");
}
/** A fresh filename is the cutover. Old attention data stays archived and is never replayed. */
export function openMeStore(file = join(paths().root, "filter", "state.json")) {
	const mutex = locks.get(file) ?? createMutex();
	locks.set(file, mutex);
	async function use<T>(fn: (doc: Document) => T | Promise<T>): Promise<T> {
		return mutex(async () => {
			const doc = (await readJson<Document>(file)) ?? {
				version: 1,
				cutoverAt: new Date().toISOString(),
				sources: [],
				notices: [],
				checkpoint: { workspaces: [] },
				netas: {},
				filters: {},
			};
			const result = await fn(doc);
			await writeJsonAtomic(file, doc);
			return result;
		});
	}
	function neta(doc: Document, workspaceId: string): WorkspaceLeaderIdentity {
		doc.netas[workspaceId] ??= {
			id: "neta",
			role: "neta",
			title: "Workspace leader",
			sessionId: ulid(),
			createdAt: new Date().toISOString(),
			workspaceId,
		};
		doc.netas[workspaceId].title = "Workspace leader";
		return doc.netas[workspaceId];
	}
	function filter(doc: Document, workspaceId: string): FilterIdentity {
		doc.filters[workspaceId] ??= {
			id: "filter",
			role: "curator",
			title: "Filter",
			sessionId: ulid(),
			createdAt: new Date().toISOString(),
			workspaceId,
		};
		return doc.filters[workspaceId];
	}
	function notice(doc: Document, id: string) {
		const found = doc.notices.find((n) => n.id === id);
		if (!found) throw new Error("Unknown filter delivery");
		return found;
	}
	return {
		cutoverAt: () => use((d) => d.cutoverAt),
		capture: (input: MeSource) =>
			use((d) => {
				if (input.at < (d.netas[input.workspaceId]?.contextResetAt ?? d.cutoverAt)) return { ...input, id: "" };
				const id = meSourceId(input);
				const old = d.sources.find((s) => s.id === id);
				if (old) return old;
				const source = { ...input, id };
				d.sources.push(source);
				d.notices.push({
					id,
					workspaceId: source.workspaceId,
					machineId: source.machineId,
					sourceIds: [id],
					createdAt: source.at,
					state: "awaiting filter",
					attempts: 0,
				});
				return source;
			}),
		getSource: (id: string) => use((d) => d.sources.find((s) => s.id === id)),
		pendingSources: () =>
			use((d) =>
				d.sources.filter((s) => {
					const n = notice(d, s.id);
					return (
						n.state === "awaiting filter" ||
						(n.state === "deferred" &&
							n.decision?.action === "defer" &&
							Date.parse(n.decision.until) <= Date.now())
					);
				}),
			),
		nextDeferredAt: () =>
			use((d) => {
				const dates = d.notices.flatMap((n) =>
					n.state === "deferred" && n.decision?.action === "defer" ? [Date.parse(n.decision.until)] : [],
				);
				return dates.length ? Math.min(...dates) : undefined;
			}),
		decide: (sourceIds: string[], decision: MeDecision) =>
			use((d) => {
				const notices = sourceIds.map((id) => notice(d, id));
				const first = notices[0];
				if (!first) throw new Error("No reply to classify");
				if (notices.some((n) => n.state !== "awaiting filter" && n.state !== "deferred")) return first;
				for (const n of notices) {
					n.decision = decision;
					n.error = undefined;
					n.state =
						decision.action === "send"
							? "delivery pending"
							: decision.action === "suppress"
								? "suppressed"
								: "deferred";
				}
				if (decision.action === "send") {
					first.sourceIds = sourceIds;
					first.text = decision.text;
					for (const n of notices.slice(1)) {
						n.state = "suppressed";
						n.decision = { action: "suppress", reason: `Combined with delivery ${first.id}` };
					}
				}
				return first;
			}),
		recordClassifierFailure: (id: string, error: string) =>
			use((d) => {
				const n = notice(d, id);
				if (n.state !== "awaiting filter" && n.state !== "deferred") return n.attempts;
				n.attempts++;
				n.error = error;
				n.state = n.attempts >= 3 ? "failed" : "awaiting filter";
				return n.attempts;
			}),
		advanceFilterRetry: (id: string) =>
			use((d) => {
				const n = notice(d, id);
				if (n.state !== "awaiting filter" || n.decision?.action === "send")
					throw new Error("Only an undecided Filter notice can start another turn");
				n.retryGeneration = (n.retryGeneration ?? 0) + 1;
				return n.retryGeneration;
			}),
		retryFilterDecision: (id: string) =>
			use((d) => {
				const n = notice(d, id);
				if (
					(n.state !== "suppressed" && n.state !== "failed") ||
					n.decision?.action === "send" ||
					(n.state === "suppressed" && n.decision?.reason !== "Filter chose not to send an update")
				)
					throw new Error("Only an undelivered Filter decision can be retried");
				n.state = "awaiting filter";
				n.decision = undefined;
				n.error = undefined;
				n.attempts = 0;
				n.retryGeneration = (n.retryGeneration ?? 0) + 1;
				return n;
			}),
		diagnostics: (workspaceId?: string) =>
			use((d) => d.notices.filter((n) => !workspaceId || n.workspaceId === workspaceId)),
		getNotice: (id: string) => use((d) => d.notices.find((n) => n.id === id)),
		pendingNotices: (workspaceId?: string) =>
			use((d) =>
				d.notices.filter((n) => n.state === "delivery pending" && (!workspaceId || n.workspaceId === workspaceId)),
			),
		recordNoticeDelivery: (id: string, receipt: { status: string; id?: string; turnId?: string; error?: string }) =>
			use((d) => {
				const n = notice(d, id);
				if (n.state !== "delivery pending" && n.state !== "delivered") return n;
				n.deliveryId = receipt.id ?? n.deliveryId;
				n.nativeTurnId = receipt.turnId ?? n.nativeTurnId;
				n.error = receipt.error;
				n.uncertain = receipt.status === "uncertain";
				n.state =
					receipt.status === "delivered"
						? "delivered"
						: receipt.status === "discarded"
							? "failed"
							: "delivery pending";
				return n;
			}),
		commitNotice: (id: string, turnId: string, text: string) =>
			use((d) => {
				const n = notice(d, id);
				n.nativeTurnId = turnId;
				n.presentedAt = new Date().toISOString();
				n.presentation = text;
				return n;
			}),
		listPresentations: (workspaceId: string, limit = 8) =>
			use((d) => d.notices.filter((n) => n.workspaceId === workspaceId && n.presentedAt).slice(-limit)),
		contextCursors: (workspaceId: string) => use((d) => ({ ...(d.contextCursors?.[workspaceId] ?? {}) })),
		advanceContextCursors: (workspaceId: string, cursors: Record<string, string>) =>
			use((d) => {
				d.contextCursors ??= {};
				d.contextCursors[workspaceId] = { ...d.contextCursors[workspaceId], ...cursors };
			}),
		getCheckpoint: () => use((d) => d.checkpoint),
		setCheckpoint: (input: MeCheckpoint) =>
			use((d) => {
				for (const item of input.workspaces) {
					const old = d.checkpoint.workspaces.find((w) => w.workspaceId === item.workspaceId);
					if (!old) {
						d.checkpoint.workspaces.push(item);
						continue;
					}
					old.eventSeq = Math.max(old.eventSeq, item.eventSeq);
					for (const turn of item.turns) {
						const previous = old.turns.find((t) => t.sessionId === turn.sessionId);
						if (!previous) old.turns.push(turn);
						else if ((turn.fileCursor ?? 0) >= (previous.fileCursor ?? 0)) Object.assign(previous, turn);
					}
				}
				return d.checkpoint;
			}),
		workspaceLeaderIdentity: (workspaceId: string) => use((d) => neta(d, workspaceId)),
		workspaceLeaderBySession: (sessionId: string) =>
			use((d) => Object.values(d.netas).find((n) => n.sessionId === sessionId)),
		listWorkspaceLeaderIdentities: () => use((d) => Object.values(d.netas)),
		bindWorkspaceLeaderRuntime: (input: {
			workspaceId: string;
			machineId?: string;
			provider: string;
			model: string;
		}) => use((d) => Object.assign(neta(d, input.workspaceId), input)),
		markWorkspaceLeaderRuntimeInitialized: (workspaceId: string) =>
			use((d) => Object.assign(neta(d, workspaceId), { runtimeInitialized: true })),
		resetWorkspaceLeaderSession: (workspaceId: string, currentSessionId: string, nextSessionId: string) =>
			use((d) => {
				const n = neta(d, workspaceId);
				if (n.sessionId !== currentSessionId) throw new Error("Workspace leader conversation changed");
				Object.assign(n, {
					sessionId: nextSessionId,
					runtimeInitialized: true,
					contextResetAt: new Date().toISOString(),
				});
				for (const entry of d.notices.filter((v) => v.workspaceId === workspaceId && v.state !== "delivered")) {
					entry.state = "suppressed";
					entry.decision = { action: "suppress", reason: "Chat reset" };
				}
				delete d.filters[workspaceId];
				delete d.contextCursors?.[workspaceId];
				return n;
			}),
		filterIdentity: (workspaceId: string) => use((d) => filter(d, workspaceId)),
		filterBySession: (sessionId: string) =>
			use((d) => Object.values(d.filters).find((f) => f.sessionId === sessionId)),
		resetFilterSession: (workspaceId: string, currentSessionId: string, nextSessionId: string) =>
			use((d) => {
				const saved = filter(d, workspaceId);
				if (saved.sessionId !== currentSessionId) throw new Error("Filter conversation changed");
				delete d.contextCursors?.[workspaceId];
				return Object.assign(saved, { sessionId: nextSessionId, runtimeInitialized: true });
			}),
		listFilterIdentities: () => use((d) => Object.values(d.filters)),
		bindFilterRuntime: (input: { workspaceId: string; machineId?: string; provider: string; model: string }) =>
			use((d) => Object.assign(filter(d, input.workspaceId), input)),
		markFilterRuntimeInitialized: (workspaceId: string) =>
			use((d) => Object.assign(filter(d, workspaceId), { runtimeInitialized: true })),
		markFilterToolsEnabled: (workspaceId: string) =>
			use((d) => Object.assign(filter(d, workspaceId), { toolsEnabled: true })),
	};
}
export type MeStore = ReturnType<typeof openMeStore>;
