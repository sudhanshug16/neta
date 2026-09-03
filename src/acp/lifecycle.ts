import type { Access, SessionId } from "../core/types.ts";
import type { ConversationStore } from "../store/conversations.ts";
import type { McpServerSpec } from "./mcp.ts";
import { type AcpSession, startSession } from "./session.ts";
import { isForbiddenModel, type Settings } from "./settings.ts";

export interface LifecycleOptions {
	settings: Settings;
	cwd: string;
	access: Access;
	mcpServers?: McpServerSpec[];
	model?: string;
}

export interface SessionRecord {
	session: AcpSession;
	provider: string;
}

// The Node's session registry, keyed by Neta sessionId. It also holds the
// launch defaults `switchProvider` starts new sessions from: the plan gives
// `switchProvider` no settings channel, so the table carries them. The old
// session's access, cwd and model win over these defaults on every switch.
export class SessionTable {
	readonly defaults: LifecycleOptions;
	private records = new Map<SessionId, SessionRecord>();

	constructor(defaults: LifecycleOptions) {
		this.defaults = defaults;
	}

	get(sessionId: SessionId): SessionRecord | undefined {
		return this.records.get(sessionId);
	}

	delete(sessionId: SessionId): void {
		this.records.delete(sessionId);
	}

	set(sessionId: SessionId, record: SessionRecord): void {
		this.records.set(sessionId, record);
	}

	values(): SessionRecord[] {
		return [...this.records.values()];
	}

	clear(): void {
		this.records.clear();
	}
}

// Move one Neta session to another provider: free the old process first, then
// start fresh (never resume across providers) with the same sessionId and the
// old access. The old model carries over only when the new provider offers it
// and policy allows it; the conversation meta follows the resulting model.
export async function switchProvider(
	sessions: SessionTable,
	store: ConversationStore,
	sessionId: SessionId,
	provider: string,
): Promise<AcpSession> {
	const record = sessions.get(sessionId);
	if (record === undefined) {
		throw new Error(`unknown session ${sessionId}`);
	}
	const old = record.session;
	const access = old.access;
	const cwd = old.cwd;
	const oldModel = old.model;
	await old.close();
	let next: AcpSession;
	try {
		next = await startSession({
			settings: sessions.defaults.settings,
			provider,
			access,
			cwd,
			mcpServers: sessions.defaults.mcpServers,
			sessionId,
		});
	} catch (error) {
		sessions.delete(sessionId);
		throw error;
	}
	const settings = sessions.defaults.settings;
	if (!isForbiddenModel(settings, oldModel) && next.listModels().some((option) => option.id === oldModel)) {
		try {
			await next.setModel(oldModel);
		} catch {
			// The session stays on its default model; the effective model is
			// always observable via `session.model`.
		}
	}
	const meta = await store.meta(sessionId);
	if (meta !== undefined) {
		await store.setMeta(sessionId, { model: next.model });
	}
	sessions.set(sessionId, { session: next, provider });
	return next;
}

// Close every session and empty the table. One failing close never blocks the
// rest and never throws.
export async function closeAll(sessions: SessionTable): Promise<void> {
	for (const record of sessions.values()) {
		try {
			await record.session.close();
		} catch {
			// Already gone; keep closing the rest.
		}
	}
	sessions.clear();
}
