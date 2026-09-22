import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import type { Block, PromptAttachment } from "../core/types.ts";
import type { ModelInfo, TurnNotification } from "../node/protocol.ts";
import { connectAcpController, mergeTurnNotification, type RenderedTurnState } from "./pi-acp-controller.ts";
import { copyToClipboard } from "./pi-clipboard.ts";
import { writeFileSync } from "node:fs";

const CUSTOM_TYPE = "neta.acp.turn";
const PROXY_PROVIDER = "neta-acp";
const HISTORY_SNAPSHOT_TYPE = "neta.acp.history-snapshot";
function signalEditorReady(sessionId: string): void {
	// The marker is private to this rmux driver and confirms that Pi installed
	// its editor and input handlers for this ACP session.
	const marker = process.env.NETA_PI_EDITOR_READY_PATH;
	if (marker !== undefined) writeFileSync(marker, sessionId, { mode: 0o600 });
}

function attachmentOf(image: { data: string; mimeType: string }, index: number): PromptAttachment {
	return {
		id: `pi-${Date.now()}-${index}`,
		kind: "image",
		name: `image-${index + 1}`,
		mimeType: image.mimeType,
		dataBase64: image.data,
	};
}

export function latestRemoteResponse(state: RenderedTurnState, sessionId?: string): string | undefined {
	const latest = [...state.turns.values()]
		.filter((turn) => sessionId === undefined || turn.sessionId === sessionId)
		.sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
	if (latest === undefined) return undefined;
	const text = visibleBlocks(state, latest.id)
		.filter((block) => block.role === "agent" && block.kind === "text")
		.map((block) => block.text)
		.filter((block) => block.length > 0)
		.join("");
	return text === "" ? undefined : text;
}

function visibleBlocks(state: RenderedTurnState, turnId: string): Block[] {
	const blocks = [...state.blocks.values()].filter((block) => block.turnId === turnId).sort((a, b) => a.seq - b.seq);
	const lastTool = new Map<string, Block>();
	for (const block of blocks) {
		const toolCallId =
			block.kind === "tool" && typeof block.data?.toolCallId === "string" ? block.data.toolCallId : undefined;
		if (toolCallId !== undefined) lastTool.set(toolCallId, block);
	}
	return blocks.filter((block) => {
		const toolCallId =
			block.kind === "tool" && typeof block.data?.toolCallId === "string" ? block.data.toolCallId : undefined;
		return toolCallId === undefined || lastTool.get(toolCallId) === block;
	});
}

function turnComponent(
	state: RenderedTurnState,
	turnId: string,
	outputPad: number,
	theme: Parameters<Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>[2],
): Component {
	const markdownTheme: MarkdownTheme = {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
	return {
		invalidate() {},
		render(width) {
			const box = new Box(outputPad, 0);
			for (const block of visibleBlocks(state, turnId)) {
				if (block.role === "user") {
					box.addChild(new Text(theme.fg("dim", `> ${block.text}`), 0, 0));
				} else if (block.kind === "text" || block.kind === "plan") {
					box.addChild(new Markdown(block.text, 0, 0, markdownTheme));
				} else {
					box.addChild(new Text(theme.fg("dim", `${block.kind}: ${block.text}`), 0, 0));
				}
			}
			return box.render(width);
		},
	};
}

function proxyModel(model: ModelInfo) {
	return {
		id: model.id,
		name: model.name,
		reasoning: false,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
	};
}

export default function acpExtension(pi: ExtensionAPI) {
	const initialSessionId = process.env.NETA_TARGET_SESSION_ID;
	const configuredProvider = process.env.NETA_TARGET_PROVIDER;
	let provider = configuredProvider;
	const descriptor = process.env.NETA_DESCRIPTOR;
	if (initialSessionId === undefined || configuredProvider === undefined || descriptor === undefined) {
		throw new Error("Neta ACP pane environment is incomplete");
	}
	pi.on("session_start", () => signalEditorReady(initialSessionId));
	if (provider === "pi" && process.env.NETA_FORCE_ACP !== "1") return;
	const clientReady = connectAcpController(descriptor);
	let sessionId = initialSessionId;
	let ui: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]["ui"] | undefined;

	let fallbackModel: ModelInfo = {
		id: process.env.NETA_TARGET_MODEL ?? "current",
		name: process.env.NETA_TARGET_MODEL ?? "Current ACP model",
		provider: configuredProvider,
	};
	let proxyModels = [fallbackModel];
	const registerModels = (): void => {
		pi.registerProvider(PROXY_PROVIDER, {
			name: "Neta ACP",
			baseUrl: "http://127.0.0.1.invalid",
			apiKey: "neta-acp-disabled",
			api: "openai-responses",
			streamSimple: () => {
				throw new Error("native Pi model loop is disabled for Neta ACP panes");
			},
			models: proxyModels.map(proxyModel),
		});
	};
	registerModels();
	pi.on("session_before_compact", () => ({ cancel: true }));
	pi.on("session_before_switch", () => (switchingLocalSession ? undefined : { cancel: true }));
	pi.on("session_before_fork", () => ({ cancel: true }));
	pi.on("session_before_tree", () => ({ cancel: true }));

	const state: RenderedTurnState = { open: false, blocks: new Map(), turns: new Map() };
	let restoringModel = false;
	const displayedTurns = new Set<string>();
	let earlierCursor: string | null = null;
	let switchingLocalSession = false;
	let hydrationSnapshotLoaded = false;
	const ensureTurn = (turnId: string): void => {
		if (displayedTurns.has(turnId)) return;
		displayedTurns.add(turnId);
		pi.sendMessage({ customType: CUSTOM_TYPE, content: "", display: true, details: { turnId } });
	};
	pi.registerMessageRenderer<{ turnId: string }>(CUSTOM_TYPE, (message, { outputPad }, theme) =>
		turnComponent(state, message.details?.turnId ?? "", outputPad, theme),
	);
	const receive = (notification: TurnNotification): void => {
		if (notification.sessionId !== sessionId) return;
		const block = mergeTurnNotification(state, notification);
		if (notification.turn !== undefined) ensureTurn(notification.turn.id);
		if (block !== undefined) ensureTurn(block.turnId);
		if (block?.kind === "usage") ui?.setStatus("neta-acp-context", block.text);
		ui?.setStatus("neta-acp-activity", state.open ? "Remote ACP working" : undefined);
	};
	const loadTail = async (client: Awaited<typeof clientReady>): Promise<void> => {
		if (hydrationSnapshotLoaded) return;
		const tail = await client.tail(sessionId);
		earlierCursor = tail.prevCursor;
		for (const turn of tail.turns) state.turns.set(turn.id, turn);
		state.open = [...state.turns.values()].some((turn) => turn.endedAt === undefined);
		for (const block of tail.blocks) state.blocks.set(`${block.turnId}:${block.seq}`, block);
		for (const turnId of new Set(tail.blocks.map((block) => block.turnId))) ensureTurn(turnId);
		ui?.setStatus(
			"neta-acp-history",
			earlierCursor === null ? undefined : "Earlier history available: /neta-history",
		);
	};
	const rebind = async (nextSessionId: string): Promise<void> => {
		const client = await clientReady;
		const priorSessionId = sessionId;
		const tail = await client.tail(nextSessionId);
		await client.untail(priorSessionId);
		sessionId = nextSessionId;
		process.env.NETA_TARGET_SESSION_ID = nextSessionId;
		state.open = false;
		state.turns.clear();
		state.blocks.clear();
		displayedTurns.clear();
		hydrationSnapshotLoaded = false;
		earlierCursor = null;
		for (const turn of tail.turns) state.turns.set(turn.id, turn);
		state.open = tail.turns.some((turn) => turn.endedAt === undefined);
		for (const block of tail.blocks) state.blocks.set(`${block.turnId}:${block.seq}`, block);
		for (const turnId of new Set(tail.blocks.map((block) => block.turnId))) ensureTurn(turnId);
		earlierCursor = tail.prevCursor;
	};
	pi.registerCommand("neta-providers", {
		description: "List or switch the Neta session provider",
		handler: async (args, ctx) => {
			const client = await clientReady;
			const providers = await client.providers(sessionId);
			const requested = args.trim();
			if (requested === "") {
				ctx.ui.notify(providers.map((item) => `${item.id}${item.available ? "" : " (unavailable)"}`).join(" · "));
				return;
			}
		const selectedProvider = providers.find((item) => item.id === requested && item.available);
		if (selectedProvider === undefined) throw new Error(`provider is unavailable: ${requested}`);
		const selected = await client.request<{ provider: string; model: string }>("conversation.setProvider", {
				sessionId,
				provider: requested,
			});
		provider = selected.provider;
		fallbackModel = { ...fallbackModel, id: selected.model, name: selected.model, provider: selected.provider };
		const refreshed = await client.models(sessionId);
		proxyModels = refreshed.some((model) => model.id === fallbackModel.id) ? refreshed : [fallbackModel, ...refreshed];
		registerModels();
		const active = ctx.modelRegistry.find(PROXY_PROVIDER, fallbackModel.id);
		if (active !== undefined) {
			restoringModel = true;
			try {
				await pi.setModel(active);
			} finally {
				restoringModel = false;
			}
		}
		ctx.ui.setStatus("neta-acp", `${provider} · ${fallbackModel.id}`);
			ctx.ui.notify(`Provider changed to ${requested}.`);
		},
	});
	pi.registerCommand("neta-reset", {
		description: "Reset this Node-owned conversation and attach the replacement session",
		 handler: async (_args, ctx) => {
			const reset = await (await clientReady).request<{ sessionId: string }>("conversation.reset", { sessionId });
			await rebind(reset.sessionId);
			switchingLocalSession = true;
			try {
				const replacement = await ctx.newSession({
					withSession: async (nextCtx) => {
						nextCtx.ui.notify("Conversation reset; attached the replacement session.");
					},
				});
				if (replacement.cancelled) {
					ctx.ui.notify("Remote conversation reset; local Pi session was not replaced.");
					return;
				}
			} finally {
				switchingLocalSession = false;
			}
		},
	});
	pi.on("session_shutdown", () => {
		if (!switchingLocalSession) void clientReady.then((client) => client.close()).catch(() => undefined);
	});

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		pi.setActiveTools([]);
		const snapshotEntry = [...ctx.sessionManager.getEntries()].reverse().find((entry) => entry.type === "custom" && entry.customType === HISTORY_SNAPSHOT_TYPE);
		const snapshot = (snapshotEntry?.type === "custom" ? snapshotEntry.data : undefined) as { sessionId?: unknown; turns?: unknown; blocks?: unknown; cursor?: unknown } | undefined;
		if (snapshot?.sessionId === sessionId && Array.isArray(snapshot.turns) && Array.isArray(snapshot.blocks)) {
			hydrationSnapshotLoaded = true;
			for (const turn of snapshot.turns) if (typeof turn === "object" && turn !== null && typeof (turn as { id?: unknown }).id === "string") state.turns.set((turn as { id: string }).id, turn as never);
			for (const block of snapshot.blocks) if (typeof block === "object" && block !== null && typeof (block as { turnId?: unknown; seq?: unknown }).turnId === "string" && typeof (block as { seq?: unknown }).seq === "number") { const item = block as Block; state.blocks.set(`${item.turnId}:${item.seq}`, item); }
			earlierCursor = typeof snapshot.cursor === "string" ? snapshot.cursor : null;
			for (const turn of [...state.turns.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) ensureTurn(turn.id);
		}
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom_message" || entry.customType !== CUSTOM_TYPE) continue;
			const details = entry.details as { turnId?: unknown } | undefined;
			if (typeof details?.turnId === "string") displayedTurns.add(details.turnId);
		}
		ctx.ui.setStatus("neta-acp", `${provider} · ${fallbackModel.id}`);
		ctx.ui.onTerminalInput((data) => {
			if (!state.open || (data !== "\x1b" && data !== "\x03")) return undefined;
			void clientReady.then((client) => client.cancel(sessionId));
			return { consume: true };
		});
	});
	pi.on("input", async (event) => {
		try {
			const client = await clientReady;
			await client.prompt(sessionId, event.text, (event.images ?? []).map(attachmentOf));
		} catch (error) {
			ui?.notify(`ACP prompt failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { action: "handled" };
	});
	pi.on("user_bash", async (event) => {
		try {
			const client = await clientReady;
			await client.prompt(sessionId, `${event.excludeFromContext ? "!!" : "!"}${event.command}`, []);
		} catch (error) {
			const message = `ACP command failed: ${error instanceof Error ? error.message : String(error)}`;
			ui?.notify(message);
			return { result: { output: message, exitCode: 1, cancelled: false, truncated: false } };
		}
		return {
			result: { output: "sent to remote ACP session", exitCode: 0, cancelled: false, truncated: false },
		};
	});
	pi.on("model_select", async (event, ctx) => {
		if (restoringModel) return;
		if (event.model.provider === PROXY_PROVIDER) {
			await (await clientReady).request("conversation.setModel", { sessionId, model: event.model.id });
			return;
		}
		const fallback = ctx.modelRegistry.find(PROXY_PROVIDER, fallbackModel.id);
		if (fallback === undefined) throw new Error("Neta ACP model is unavailable");
		restoringModel = true;
		try {
			await pi.setModel(fallback);
		} finally {
			restoringModel = false;
		}
	});
	pi.registerCommand("neta-model", {
		description: "List or select a remote ACP model",
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (requested === "") {
				ctx.ui.notify(proxyModels.map((model) => model.id).join(" · "));
				return;
			}
			const model = ctx.modelRegistry.find(PROXY_PROVIDER, requested);
			if (model === undefined) throw new Error(`unknown model: ${requested}`);
			await pi.setModel(model);
		},
	});
	pi.registerCommand("neta-copy", {
		description: "Copy the latest remote agent response to the clipboard",
		handler: async (_args, ctx) => {
			const text = latestRemoteResponse(state, sessionId);
			if (text === undefined) {
				ctx.ui.notify("No remote agent response to copy.");
				return;
			}
			try {
				await copyToClipboard(text);
				ctx.ui.notify("Copied latest remote agent response.");
			} catch (error) {
				ctx.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});
	pi.registerCommand("neta-history", {
		description: "Load the previous bounded page of remote conversation history",
		handler: async (_args, ctx) => {
			if (earlierCursor === null) {
				ctx.ui.notify("No earlier remote history.");
				return;
			}
			const page = await (await clientReady).tail(sessionId, earlierCursor);
			earlierCursor = page.prevCursor;
			for (const turn of page.turns) state.turns.set(turn.id, turn);
			for (const block of page.blocks) state.blocks.set(`${block.turnId}:${block.seq}`, block);
			const turns = [...state.turns.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
			const order = new Map(turns.map((turn, index) => [turn.id, index]));
			const blocks = [...state.blocks.values()].sort((a, b) => (order.get(a.turnId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.turnId) ?? Number.MAX_SAFE_INTEGER) || a.seq - b.seq);
			const snapshot = { sessionId, turns, blocks, cursor: earlierCursor };
			switchingLocalSession = true;
			try {
				const replacement = await ctx.newSession({
					setup: async (manager) => { manager.appendCustomEntry(HISTORY_SNAPSHOT_TYPE, snapshot); },
					withSession: async (nextCtx) => {
						nextCtx.ui.setStatus(
							"neta-acp-history",
							earlierCursor === null ? undefined : "Earlier history available: /neta-history",
						);
					},
				});
				if (replacement.cancelled) { ctx.ui.notify("Earlier history loaded but local view was not rebuilt."); return; }
			} finally { switchingLocalSession = false; }
		},
	});

	void (async () => {
		try {
			const client = await clientReady;
			const buffered: TurnNotification[] = [];
			let historyLoaded = false;
			client.onTurn((notification) => (historyLoaded ? receive(notification) : buffered.push(notification)));
			await loadTail(client);
			historyLoaded = true;
			for (const notification of buffered) receive(notification);
			const listed = await client.models(sessionId);
			if (listed.length > 0) {
				proxyModels = listed;
				registerModels();
			}
		} catch (error) {
			ui?.setStatus("neta-acp", `ACP unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	})();
}
