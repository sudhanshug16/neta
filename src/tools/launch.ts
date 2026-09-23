// The MCP config Neta hands a session, and the merged tool table the Node
// serves. `mcpServerFor` builds 03's descriptor through `netaMcpServer`:
// `command` is `process.execPath`, `args` the resolved CLI entry then
// `mcp --actor <id> --token <t>`, `env` carries `NETA_SOCKET` only. 03 passes
// the config at `session/new` and again at `session/resume`; the Node mints
// the token immediately before each launch and revokes the previous one.
import { type McpServerSpec, netaMcpServer } from "../session/mcp.ts";
import { coordinationHandlers } from "./handlers/coordination.ts";
import { lifecycleHandlers } from "./handlers/lifecycle.ts";
import { missionHandlers } from "./handlers/mission.ts";
import { modelHandlers } from "./handlers/model.ts";
import type { ToolHandlers } from "./router.ts";

export function mcpServerFor(actorId: string, token: string, socketPath: string): McpServerSpec {
	return netaMcpServer({ actorId, token, socketPath });
}

export function toolHandlers(): ToolHandlers {
	return { ...missionHandlers, ...modelHandlers, ...coordinationHandlers, ...lifecycleHandlers };
}
