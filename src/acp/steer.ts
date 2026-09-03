import type { AgentId, MissionId } from "../core/types.ts";
import type { AcpSession } from "./session.ts";

export type SteerTarget = { kind: "leader" } | { kind: "mission"; missionId: MissionId; agentId: AgentId };

export interface SteerHandle {
	settled: Promise<void>;
	cancel(): Promise<void>;
}

// Steer the open conversation: one enveloped prompt, resolved when its turn
// ends. The envelope is control-plane — only turn/block events reach the
// transcript, so the "role steer" line is never stored, and this function
// performs no appends itself (there is no first user text block to skip).
// It never touches the session's event iterator: `settled` watches the turn
// boundary, leaving the single consumer to the Node.
export function steerProvider(s: AcpSession, target: SteerTarget, text: string): SteerHandle {
	const where = target.kind === "leader" ? "leader" : `agent ${target.agentId}`;
	const turnId = s.prompt(`<role>steer</role>\n<target>${where}</target>\n<body>${text}</body>`);
	const settled = (async (): Promise<void> => {
		while (s.openTurnId === turnId) {
			await new Promise((done) => setTimeout(done, 10));
		}
	})();
	return {
		settled,
		cancel: async (): Promise<void> => {
			await s.cancel();
			await settled;
		},
	};
}
