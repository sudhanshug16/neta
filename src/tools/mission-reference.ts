import type { Mission } from "../core/types.ts";
import type { ToolContext } from "./router.ts";
import type { MissionRef } from "./schemas.ts";

/** Public numbers are always scoped to the authenticated workspace. Storage keeps stable IDs. */
export function resolveMission(ctx: ToolContext, reference?: MissionRef): Mission | undefined {
	const ref =
		reference ??
		(ctx.actor.kind === "lead"
			? ctx.actor.missionId
			: ctx.actor.kind === "leader"
				? ctx.deps.store.getLeader(ctx.actor.workspaceId)?.activeMissionId
				: undefined);
	const mission =
		typeof ref === "number"
			? ctx.deps.store
					.listMissions(ctx.actor.workspaceId)
					.find((m) => m.workspaceId === ctx.actor.workspaceId && m.number === ref)
			: ref === undefined
				? undefined
				: ctx.deps.store.getMission(ref);
	return mission?.workspaceId === ctx.actor.workspaceId ? mission : undefined;
}
