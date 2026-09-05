import { Buffer } from "node:buffer";
import { asNumber, asString, parseParams } from "./handlers-registry.ts";
import { NodeError } from "./protocol.ts";
import type { NodeContext, NodeHandlers } from "./server.ts";

function terminal(ctx: NodeContext) {
	if (ctx.pi === undefined) throw new NodeError("NOT_FOUND", "Pi terminal runtime is disabled");
	return ctx.pi;
}

function cwdFor(ctx: NodeContext, sessionId: string): string {
	const leader = ctx.store.listLeaders().find((item) => item.sessionId === sessionId);
	if (leader?.provider === "pi") {
		const workspace = ctx.store.getWorkspace(leader.workspaceId);
		const path = workspace?.roots.find((root) => root.machineId === ctx.store.machine().id)?.path;
		if (path !== undefined) return path;
	}
	const agent = ctx.store.listAgents().find((item) => item.sessionId === sessionId && item.provider === "pi");
	if (agent !== undefined) {
		if (agent.state === "completed" || agent.state === "archived") {
			throw new NodeError("NOT_FOUND", `Pi agent session is closed: ${sessionId}`);
		}
		const mission = ctx.store.getMission(agent.missionId);
		const workspace = ctx.store.getWorkspace(agent.workspaceId);
		const path =
			mission?.worktree?.path ?? workspace?.roots.find((root) => root.machineId === ctx.store.machine().id)?.path;
		if (path !== undefined) return path;
	}
	throw new NodeError("NOT_FOUND", `no local Pi actor owns session ${sessionId}`);
}

export const terminalHandlers: NodeHandlers = {
	"terminal.attach": (ctx, params, conn) => {
		const p = parseParams({ sessionId: asString, cols: asNumber, rows: asNumber }, params);
		if (p.cols < 1 || p.rows < 1 || p.cols > 1000 || p.rows > 1000)
			throw new NodeError("INVALID_PARAMS", "terminal size is out of range");
		const attached = terminal(ctx).attach(
			p.sessionId,
			cwdFor(ctx, p.sessionId),
			p.cols,
			p.rows,
			conn.id,
			(method, payload) => conn.send(method, payload),
		);
		void attached.then(
			({ attachmentId }) =>
				conn.onClose?.(() => {
					try {
						terminal(ctx).detach(p.sessionId, attachmentId, conn.id);
					} catch {
						/* already replaced or detached */
					}
				}),
			() => undefined,
		);
		return attached;
	},
	"terminal.input": async (ctx, params, conn) => {
		const p = parseParams({ sessionId: asString, attachmentId: asString, dataBase64: asString }, params);
		if (Buffer.from(p.dataBase64, "base64").byteLength > 1024 * 1024)
			throw new NodeError("INVALID_PARAMS", "terminal input exceeds 1 MiB");
		await terminal(ctx).input(p.sessionId, p.attachmentId, conn.id, p.dataBase64);
		return { sessionId: p.sessionId };
	},
	"terminal.resize": async (ctx, params, conn) => {
		const p = parseParams({ sessionId: asString, attachmentId: asString, cols: asNumber, rows: asNumber }, params);
		if (p.cols < 1 || p.rows < 1 || p.cols > 1000 || p.rows > 1000)
			throw new NodeError("INVALID_PARAMS", "terminal size is out of range");
		await terminal(ctx).resize(p.sessionId, p.attachmentId, conn.id, p.cols, p.rows);
		return { sessionId: p.sessionId };
	},
	"terminal.detach": (ctx, params, conn) => {
		const p = parseParams({ sessionId: asString, attachmentId: asString }, params);
		terminal(ctx).detach(p.sessionId, p.attachmentId, conn.id);
		return Promise.resolve({ sessionId: p.sessionId });
	},
};
