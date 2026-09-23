import type { Agent, InboxMessage, Mission } from "../core/types.ts";
import type { ConversationInboxStore } from "../store/conversation-inbox.ts";
import { createMutex, type Mutex } from "../store/files.ts";

/** Save before admission; serialize lifecycle changes while the inbox retains retry identity. */
export function createFollowupSender(ports: {
	inbox: ConversationInboxStore;
	getAgent(id: string): Agent | undefined;
	getMission(id: string): Mission | undefined;
	validateMission?(mission: Mission): void;
	putAgent(agent: Agent): Promise<void>;
	saveMission(mission: Mission): Promise<void>;
	resume(agent: Agent): Promise<Agent>;
	admit(sessionId: string, text: string, sourceId: string): Promise<InboxMessage>;
	receipt(item: InboxMessage): void;
	failed(item: InboxMessage, error: unknown): void;
}) {
	const locks = new Map<string, Mutex>();
	return async (target: Agent, text: string, sourceId: string): Promise<InboxMessage> => {
		let lock = locks.get(target.id);
		if (!lock) {
			lock = createMutex();
			locks.set(target.id, lock);
		}
		return lock(async () => {
			const agent = ports.getAgent(target.id);
			const mission = agent && ports.getMission(agent.missionId);
			if (!agent || !mission || agent.state === "archived" || mission.state === "closed")
				throw new Error("The target mission is archived or unavailable; no follow-up was saved.");
			ports.validateMission?.(mission);
			const receipt = await ports.inbox.enqueue(agent.sessionId, text, [], { readerDirected: false, sourceId });
			ports.receipt(receipt);
			if (receipt.status !== "queued" || agent.state === "queued") return receipt;
			try {
				if (["running", "starting"].includes(agent.state))
					return await ports.admit(agent.sessionId, text, sourceId);
				const live = await ports.resume(agent);
				if (["completed", "failed", "blocked"].includes(agent.state)) {
					await ports.putAgent({
						...live,
						state: "idle",
						outcome: undefined,
						endedAt: undefined,
						pendingQuestion: undefined,
					});
					await ports.saveMission({ ...mission, state: "running", attention: undefined });
				}
				return await ports.admit(live.sessionId, text, sourceId);
			} catch (error) {
				ports.failed(receipt, error);
				return (await ports.inbox.list(agent.sessionId)).find((item) => item.id === receipt.id) ?? receipt;
			}
		});
	};
}
