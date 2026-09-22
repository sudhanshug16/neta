import { dirname } from "node:path";
import type { Block, PromptAttachment, Turn } from "../core/types.ts";
import { connectNode, type NodeClient } from "../node/client.ts";
import type { ConversationTailResult, ModelInfo, ProviderInfo, TurnNotification } from "../node/protocol.ts";

export interface AcpController {
	request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
	tail(sessionId: string, cursor?: string): Promise<ConversationTailResult>;
	untail(sessionId: string): Promise<void>;
	prompt(sessionId: string, text: string, attachments: PromptAttachment[]): Promise<unknown>;
	cancel(sessionId: string): Promise<void>;
	models(sessionId: string): Promise<ModelInfo[]>;
	providers(sessionId: string): Promise<ProviderInfo[]>;
	onTurn(listener: (notification: TurnNotification) => void): () => void;
	close(): void;
}

export async function connectAcpController(descriptorPath: string): Promise<AcpController> {
	const client = await connectNode({
		dir: dirname(descriptorPath),
		client: "desktop",
		autostart: false,
		timeoutMs: 5000,
	});
	return controllerForClient(client);
}

export function controllerForClient(client: NodeClient): AcpController {
	return {
		request: (method, params) => client.request(method, params),
		tail: (sessionId, cursor) =>
			client.request("conversation.tail", {
				sessionId,
				limit: 200,
				direction: "backward",
				...(cursor === undefined ? {} : { cursor }),
			}),
		untail: async (sessionId) => {
			await client.request("conversation.untail", { sessionId });
		},
		prompt: (sessionId, text, attachments) => client.request("conversation.prompt", { sessionId, text, attachments }),
		cancel: (sessionId) => client.request("conversation.cancel", { sessionId }),
		models: async (sessionId) => (await client.request<{ models: ModelInfo[] }>("models.list", { sessionId })).models,
		providers: async (sessionId) =>
			(await client.request<{ providers: ProviderInfo[] }>("providers.list", { sessionId })).providers,
		onTurn: (listener) => client.on("turn", (params) => listener(params as TurnNotification)),
		close: () => void client.close(),
	};
}

export interface RenderedTurnState {
	open: boolean;
	blocks: Map<string, Block>;
	turns: Map<string, Turn>;
}

export function mergeTurnNotification(state: RenderedTurnState, notification: TurnNotification): Block | undefined {
	if (notification.turn !== undefined) {
		state.turns.set(notification.turn.id, notification.turn);
		state.open = [...state.turns.values()].some((turn) => turn.endedAt === undefined);
	}
	if (notification.block === undefined) return undefined;
	state.blocks.set(`${notification.block.turnId}:${notification.block.seq}`, notification.block);
	return notification.block;
}
