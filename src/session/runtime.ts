import type { Access, Block, PromptAttachment, SessionId, Turn, TurnId } from "../core/types.ts";
import type { OpenCodeAttachment } from "../opencode/attachment.ts";
import { startOpenCodeSession } from "../opencode/direct-session.ts";
import type { McpServerSpec } from "./mcp.ts";
import type { ModelOption } from "./models.ts";
import type { Settings } from "./settings.ts";

export interface StartOptions {
	settings: Settings;
	provider: string;
	access: Access;
	unsandboxed?: boolean;
	cwd: string;
	model?: string;
	mcpServers?: McpServerSpec[];
	resumeVendorSessionId?: string;
	sessionId?: SessionId;
	steeringSafe?: boolean;
	actorId?: string;
	bindingGeneration?: string;
	fallbackModels?: readonly string[];
	onPermissionRequest?: (
		request: { id: string; action: string; resources: string[]; message?: string },
		decision: "once" | "reject",
	) => Promise<void>;
}

export type SessionEvent = (
	| { type: "turn"; turn: Turn }
	| { type: "block"; block: Block }
	| { type: "turnEnd"; turnId: TurnId; stopReason: string; cancelled: boolean }
	| { type: "model"; model: string }
	| { type: "mode"; modeId: string }
	| { type: "interrupted"; turnId?: TurnId; exit: { code: number | null; signal: string | null; at: string } }
) & { bindingGeneration?: string };

export interface ExitInfo {
	code: number | null;
	signal: string | null;
	at: string;
}

export interface RuntimeSession {
	readonly nativeAttachment?: OpenCodeAttachment;
	readonly sessionId: SessionId;
	readonly bindingGeneration: string;
	readonly vendorSessionId: string;
	readonly provider: string;
	readonly cwd: string;
	readonly access: Access;
	readonly unsandboxed: boolean;
	readonly model: string;
	readonly fallbackModels?: readonly string[];
	readonly openTurnId?: TurnId;
	readonly configOptions: readonly { id: string; currentValue: string | boolean }[];
	readonly promptCapabilities: { image: boolean; embeddedContext: boolean };
	readonly steeringSupported: boolean;
	prompt(text: string, attachments?: PromptAttachment[]): TurnId;
	steer(
		messageId: string,
		text: string,
		attachments?: PromptAttachment[],
	): Promise<"injected" | "promptRequired" | "failed">;
	cancel(): Promise<void>;
	listModels(): ModelOption[];
	setModel(model: string): Promise<void>;
	setConfigOption(configId: string, value: string | boolean): Promise<void>;
	relaunch(access: Access): Promise<void>;
	close(): Promise<void>;
	events(): AsyncIterableIterator<SessionEvent>;
}

export function startSession(options: StartOptions): Promise<RuntimeSession> {
	if (options.provider !== "opencode") throw new Error(`Provider ${options.provider} is retired; use OpenCode`);
	return startOpenCodeSession(options);
}

export class TurnInProgressError extends Error {
	readonly turnId: TurnId;
	constructor(turnId: TurnId) {
		super(`a turn is already in progress: ${turnId}`);
		this.name = "TurnInProgressError";
		this.turnId = turnId;
	}
}

export class ResumeFailedError extends Error {
	readonly vendorSessionId: string;
	constructor(vendorSessionId: string, cause?: unknown) {
		super(
			`resume failed for vendor session: ${vendorSessionId}${cause instanceof Error ? `: ${cause.message}` : ""}`,
			{ cause },
		);
		this.name = "ResumeFailedError";
		this.vendorSessionId = vendorSessionId;
	}
}

export class SessionClosedError extends Error {
	constructor() {
		super("session is closed");
		this.name = "SessionClosedError";
	}
}
