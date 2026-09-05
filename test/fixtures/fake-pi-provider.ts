import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function stream(model: Model<Api>, context: Context, _options?: SimpleStreamOptions) {
	const result = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const afterTool = context.messages.some(
			(message) => message.role === "toolResult" && message.toolName === "neta_mission",
		);
		const isMissionLead = JSON.stringify(context.messages).includes("Verify the Pi mission bridge");
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...zeroUsage, cost: { ...zeroUsage.cost } },
			stopReason: "pending",
			timestamp: Date.now(),
		};
		result.push({ type: "start", partial: output });
		if (!afterTool && !isMissionLead) {
			const call: ToolCall = {
				type: "toolCall",
				id: "fixture-mission",
				name: "neta_mission",
				arguments: {
					name: "Pi fixture mission",
					objective: "Verify the Pi mission bridge",
					access: "readOnly",
					lead: "self",
				},
			};
			output.content.push(call);
			result.push({ type: "toolcall_start", contentIndex: 0, partial: output });
			result.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
			output.stopReason = "toolUse";
			result.push({ type: "done", reason: "toolUse", message: output });
		} else {
			const block = {
				type: "text" as const,
				text: afterTool ? "PI_FIXTURE_DONE" : "PI_MISSION_LEAD_READY",
			};
			output.content.push(block);
			result.push({ type: "text_start", contentIndex: 0, partial: output });
			result.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: output });
			result.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
			output.stopReason = "stop";
			result.push({ type: "done", reason: "stop", message: output });
		}
		result.end();
	});
	return result;
}

export default function fixture(pi: ExtensionAPI) {
	pi.registerProvider("neta-fixture", {
		baseUrl: "http://127.0.0.1",
		apiKey: "fixture",
		api: "neta-fixture-api",
		models: [
			{
				id: "fixture",
				name: "Fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			},
		],
		streamSimple: stream,
	});
}
