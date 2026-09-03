// Wire types only: any client can import this file alone. Transport is one
// JSON object per line over the Unix socket, JSON-RPC 2.0.
import type {
	Agent,
	AgentId,
	Block,
	Event,
	IsoTime,
	Leader,
	LeaderMode,
	Machine,
	Mission,
	MissionId,
	MissionState,
	SessionId,
	Turn,
	TurnId,
	Workspace,
	WorkspaceId,
} from "../core/types.ts";

export const PROTOCOL_VERSION = 1;

export type ClientKind = "cli" | "desktop" | "tools";

export type RpcId = string | number | null;

export interface RpcRequest {
	jsonrpc: "2.0";
	id: RpcId;
	method: string;
	params?: unknown;
}

export interface RpcResult {
	jsonrpc: "2.0";
	id: RpcId;
	result: unknown;
}

export interface RpcErrorBody {
	code: number;
	message: string;
	data: { code: string };
}

export interface RpcErrorReply {
	jsonrpc: "2.0";
	id: RpcId;
	error: RpcErrorBody;
}

export interface RpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

// Symbolic name -> numeric code. `error.data` always carries `{code}` with
// the symbol, so clients switch on the name, never the number.
export const NODE_ERRORS = {
	PARSE: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL: -32603,
	UNAUTHORIZED: -32000,
	PROTOCOL_MISMATCH: -32001,
	NOT_FOUND: -32002,
	CONFIRMATION_REQUIRED: -32003,
	BUSY: -32004,
	PROVIDER_ERROR: -32005,
	LINE_TOO_LARGE: -32700,
} as const;

export type NodeErrorSymbol = keyof typeof NODE_ERRORS;

export class NodeError extends Error {
	readonly code: number;
	readonly symbol: NodeErrorSymbol;
	readonly data: unknown;

	constructor(symbol: NodeErrorSymbol, message: string, data?: unknown) {
		super(message);
		this.name = "NodeError";
		this.symbol = symbol;
		this.code = NODE_ERRORS[symbol];
		this.data = data;
	}
}

export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export function encodeLine(message: unknown): string {
	return `${JSON.stringify(message)}\n`;
}

// Splits a buffer into complete lines, keeping a partial trailing line in
// `rest`. Bad JSON throws a `PARSE` NodeError whose `data.rest` is the buffer
// past the bad line, so the caller can reply and resync; a line over 8 MB
// throws `LINE_TOO_LARGE`.
export function decodeLines(buffer: string): { messages: unknown[]; rest: string } {
	const messages: unknown[] = [];
	let rest = buffer;
	for (;;) {
		const newline = rest.indexOf("\n");
		if (newline < 0) {
			if (Buffer.byteLength(rest, "utf8") > MAX_LINE_BYTES) {
				throw new NodeError("LINE_TOO_LARGE", "line exceeds 8 MB");
			}
			return { messages, rest };
		}
		const line = rest.slice(0, newline);
		rest = rest.slice(newline + 1);
		if (line === "") {
			continue;
		}
		if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
			throw new NodeError("LINE_TOO_LARGE", "line exceeds 8 MB");
		}
		try {
			messages.push(JSON.parse(line) as unknown);
		} catch {
			throw new NodeError("PARSE", "malformed JSON", { rest });
		}
	}
}

function toNodeError(error: unknown): NodeError {
	if (error instanceof NodeError) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	return new NodeError("INTERNAL", message);
}

// Builds a JSON-RPC 2.0 error reply line for any thrown value. A NodeError
// keeps its own code; anything else is INTERNAL (-32603) with no stack.
export function rpcError(id: RpcId, error: unknown): string {
	const nodeError = toNodeError(error);
	const reply: RpcErrorReply = {
		jsonrpc: "2.0",
		id,
		error: { code: nodeError.code, message: nodeError.message, data: { code: nodeError.symbol } },
	};
	return encodeLine(reply);
}

export interface HelloParams {
	token: string;
	client: ClientKind;
	protocolVersion: number;
}

export interface HelloResult {
	machine: Machine;
	protocolVersion: number;
	nodeVersion: string;
	pid: number;
}

export interface SnapshotParams {
	workspaceId?: WorkspaceId;
	windowDays?: number;
}

// One snapshot replaces a client's whole cache; there is no revision
// protocol. Missions cover every open mission plus closed ones inside the
// window; agents cover all starting|running|blocked|failed|interrupted plus
// up to 8 most recent completed per mission; archived agents never appear.
export interface SnapshotResult {
	machine: Machine;
	workspaces: Workspace[];
	leaders: Leader[];
	missions: Mission[];
	hasOlder: boolean;
	agents: Agent[];
	completedCounts: Record<MissionId, number>;
	events: Event[];
	attention: Mission[];
	windowDays: number;
	protocolVersion: number;
	at: IsoTime;
}

export interface WorkspaceOpenParams {
	path: string;
}

export interface WorkspaceOpenResult {
	workspace: Workspace;
	leader: Leader;
}

// No params; the empty object keeps every method shaped alike.
export type WorkspaceListParams = Record<string, never>;

export interface WorkspaceListResult {
	workspaces: Workspace[];
	leaders: Leader[];
}

export interface MissionsListParams {
	workspaceId: WorkspaceId;
	state?: MissionState;
	from?: IsoTime;
	to?: IsoTime;
	limit?: number;
	cursor?: string;
}

export interface MissionsListResult {
	missions: Mission[];
	nextCursor?: string;
}

export interface MissionsGetParams {
	missionId: MissionId;
}

export interface MissionsGetResult {
	mission: Mission;
	agents: Agent[];
}

export interface EventsListParams {
	workspaceId: WorkspaceId;
	from?: IsoTime;
	to?: IsoTime;
	limit?: number;
	cursor?: string;
}

export interface EventsListResult {
	events: Event[];
	nextCursor?: string;
}

export interface ConversationTailParams {
	sessionId: SessionId;
	limit?: number;
	cursor?: string;
	turnId?: TurnId;
	direction?: "forward" | "backward";
}

export interface ConversationTailResult {
	sessionId: SessionId;
	turns: Turn[];
	blocks: Block[];
	nextCursor?: string;
	prevCursor: string | null;
	provider: string;
	model: string;
}

export interface ConversationUntailParams {
	sessionId: SessionId;
}

export interface ConversationUntailResult {
	sessionId: SessionId;
}

export interface ConversationPromptParams {
	sessionId: SessionId;
	text: string;
}

export interface ConversationPromptResult {
	turnId: TurnId;
}

export interface ConversationCancelParams {
	sessionId: SessionId;
}

export interface ConversationCancelResult {
	sessionId: SessionId;
}

export interface ConversationSetModelParams {
	sessionId: SessionId;
	model: string;
}

export interface ConversationSetModelResult {
	sessionId: SessionId;
	model: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
}

export interface ModelsListParams {
	sessionId?: SessionId;
	provider?: string;
}

export interface ModelsListResult {
	models: ModelInfo[];
}

export interface LeaderSetModeParams {
	workspaceId: WorkspaceId;
	mode: LeaderMode;
	missionId?: MissionId;
}

export interface LeaderSetModeResult {
	leader: Leader;
}

export interface MissionPinParams {
	missionId: MissionId;
	pinned: boolean;
}

export interface MissionPinResult {
	missionId: MissionId;
	pinned: boolean;
}

export interface AgentArchiveParams {
	agentId: AgentId;
	confirm?: boolean;
}

export interface AgentArchiveResult {
	agent: Agent;
}

// No params; the empty object keeps every method shaped alike.
export type NodeStopParams = Record<string, never>;

export interface NodeStopResult {
	stopping: true;
}

export interface ToolDescription {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface ToolsListParams {
	actorId: string;
	token: string;
}

export interface ToolsListResult {
	tools: ToolDescription[];
}

export interface ToolsCallParams {
	actorId: string;
	token: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolsCallResult {
	content: Array<Record<string, unknown>>;
	isError: boolean;
}

export interface EventNotification {
	event: Event;
}

export interface StateNotification {
	kind: "mission" | "agent" | "leader";
	record: Mission | Agent | Leader;
}

export interface TurnNotification {
	sessionId: SessionId;
	turn?: Turn;
	block?: Block;
}

export interface NodeNotification {
	phase: "restarting" | "stopping";
}
