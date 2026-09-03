#!/usr/bin/env bun
// Stand-in for `neta mcp --actor <id> --token <t>` until workstream 08 wires
// the real subcommand: runs the stdio MCP proxy over the socket in
// `NETA_SOCKET`. The provider (here the fake ACP agent) spawns one of these
// per session that needs tools.
import { runProxy } from "../../src/tools/proxy.ts";

const rest = process.argv.slice(2).filter((arg) => arg !== "mcp");
const actorId = rest[rest.indexOf("--actor") + 1];
const token = rest[rest.indexOf("--token") + 1];
if (actorId === undefined || token === undefined) {
	console.error("usage: mcp-proxy-runner.mjs mcp --actor <id> --token <t>");
	process.exit(2);
}
process.exit(await runProxy({ actorId, token, socketPath: process.env.NETA_SOCKET }));
