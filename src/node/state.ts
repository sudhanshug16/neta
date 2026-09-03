import { SessionTable } from "../acp/lifecycle.ts";
import type { McpServerSpec } from "../acp/mcp.ts";
import { type AcpSession, startSession } from "../acp/session.ts";
import { loadSettings, type Settings } from "../acp/settings.ts";
import { ulid } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import type { Access, SessionId, WorkspaceId } from "../core/types.ts";
import type { Store } from "../store/index.ts";
import { netaDir } from "../store/paths.ts";

export interface SessionDeps {
	settings: Settings;
	mcpServers: McpServerSpec[];
}

export interface NodeSnapshot {
	version: number;
	sessions: SessionEntry[];
}

export interface SessionEntry {
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	provider: string;
	model: string;
	access: Access;
	vendorSessionId?: string;
	netaSessionId?: SessionId;
}

export interface HydratedSession {
	session: AcpSession;
	entry: SessionEntry;
	needsResume: boolean;
}

export interface NodeState {
	sessions: SessionTable;
	store: Store;
	settings: Settings;
	mcpServers: McpServerSpec[];
	cwd: string;
	defaultAccess: Access;
	defaultModel?: string;
}

// Builds the Node's shared state: store, settings (loaded when absent),
// MCP servers, cwd, table. Nothing starts a provider process or opens a
// socket here; sessions come from `startManagedSession`.
export function nodeState(o: { store: Store; settings?: Settings; mcpServers?: McpServerSpec[] }): NodeState {
	const settings = o.settings ?? loadSettings({ netaDir: netaDir() }).settings;
	const cwd = process.cwd();
	return {
		sessions: new SessionTable({ settings, cwd, access: "readOnly", mcpServers: o.mcpServers }),
		store: o.store,
		settings,
		mcpServers: o.mcpServers ?? [],
		cwd,
		defaultAccess: "readOnly",
		defaultModel: settings.leader.model,
	};
}

export function recordSession(s: NodeState, session: AcpSession, entry: SessionEntry): void {
	s.sessions.set(entry.sessionId, { session, provider: entry.provider });
}

export function getManagedSession(s: NodeState, sessionId: SessionId): AcpSession | undefined {
	return s.sessions.get(sessionId)?.session;
}

// Mint (or reuse) the Neta sessionId, record its conversation meta, start the
// provider session with defaults from state, resume the vendor session when
// the entry carries one, and record the live session in the table.
export async function startManagedSession(
	s: NodeState,
	entry: Omit<SessionEntry, "sessionId"> & { sessionId?: SessionId },
): Promise<AcpSession> {
	const sessionId = entry.sessionId ?? ulid();
	await s.store.conversations.create({
		sessionId,
		provider: entry.provider,
		model: entry.model,
		createdAt: nowIso(),
	});
	const session = await startSession({
		settings: s.settings,
		provider: entry.provider,
		access: entry.access,
		cwd: s.cwd,
		model: entry.model,
		mcpServers: s.mcpServers,
		sessionId,
		resumeVendorSessionId: entry.vendorSessionId,
	});
	recordSession(s, session, {
		sessionId,
		workspaceId: entry.workspaceId,
		provider: entry.provider,
		model: session.model,
		access: entry.access,
		vendorSessionId: session.vendorSessionId,
		netaSessionId: entry.netaSessionId,
	});
	return session;
}
