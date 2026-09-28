import { type ArtifactActor, inspectArtifact, publishArtifact } from "../../me/artifacts.ts";
import type { ToolHandlers } from "../router.ts";

export const artifactHandlers: Pick<ToolHandlers, "artifacts"> = {
	artifacts: async (ctx, args) => {
		const workspace = ctx.deps.store.getWorkspace(ctx.actor.workspaceId);
		const machineId = ctx.deps.store.machine().id;
		const root = workspace?.roots.find((item) => item.machineId === machineId)?.path;
		if (!workspace || !root) return { ok: false, code: "notFound", message: "workspace copy is unavailable" };
		const mission = ctx.actor.kind === "leader" ? undefined : ctx.deps.store.getMission(ctx.actor.missionId);
		const actor: ArtifactActor = {
			workspaceId: workspace.id,
			machineId,
			...(mission ? { missionId: mission.id } : {}),
			actorId: ctx.actor.kind === "leader" ? ctx.actor.sessionId : ctx.actor.agentId,
			kind: ctx.actor.kind,
		};
		try {
			if (args.action === "publish") {
				if (!args.title || !args.mimeType)
					return { ok: false, code: "badParams", message: "publish requires title and mimeType" };
				const artifact = await publishArtifact({
					actor,
					assignedRoot: mission?.worktree?.path ?? root,
					...(args.path === undefined ? {} : { path: args.path }),
					...(args.text === undefined ? {} : { text: args.text }),
					title: args.title,
					mimeType: args.mimeType,
					...(args.previousId === undefined ? {} : { previousId: args.previousId }),
				});
				await ctx.deps.store.appendEvent({
					workspaceId: workspace.id,
					kind: "artifact.published",
					...(mission ? { missionId: mission.id } : {}),
					...(ctx.actor.kind === "leader" ? {} : { agentId: ctx.actor.agentId }),
					sessionId: ctx.actor.sessionId,
					data: { artifactId: artifact.id, title: artifact.title },
				});
				return { ok: true, data: { artifact } };
			}
			if (!args.id) return { ok: false, code: "badParams", message: "artifact id is required" };
			const result = await inspectArtifact(
				actor,
				args.id,
				args.action === "open" ? { offset: args.offset ?? 0, limit: args.limit ?? 2048 } : undefined,
			);
			return { ok: true, data: result };
		} catch (error) {
			return { ok: false, code: "refused", message: error instanceof Error ? error.message : String(error) };
		}
	},
};
