// `neta mcp --actor <id> --token <t>` (08, T8.8): the stdio MCP server one
// ACP session holds. A thin route to `runProxy` from `src/tools/proxy.ts`
// (05, T5.4) and nothing else: both flags are required (missing either is
// exit 1), the Node must be reachable first — unreachable is exit 2, a
// refused hello exit 3, the same mapping every other command uses — and then
// stdio belongs to the proxy. This module parses no MCP traffic and writes
// nothing to stdout, which is the proxy's.
import { dirname } from "node:path";
import { runProxy } from "../../tools/proxy.ts";
import { CliError, NodeClient } from "../client.ts";

function fail(error: unknown): number {
	if (error instanceof CliError) {
		process.stderr.write(`neta: ${error.message}\n`);
		return error.code;
	}
	process.stderr.write(`neta: ${error instanceof Error ? error.message : String(error)}\n`);
	return 1;
}

export async function mcpCommand(flags: Record<string, string | true>): Promise<number> {
	const actor = flags.actor;
	const token = flags.token;
	if (typeof actor !== "string" || actor.length === 0) {
		process.stderr.write("neta: neta mcp needs --actor <id>\n");
		return 1;
	}
	if (typeof token !== "string" || token.length === 0) {
		process.stderr.write("neta: neta mcp needs --token <t>\n");
		return 1;
	}
	// `NETA_SOCKET` is the only variable `netaMcpServer` puts in an ACP
	// session's environment, so it has to be enough on its own: the node
	// descriptor is read from beside that socket rather than from
	// `netaDir()`, which an agent's proxy has no `NETA_DIR` to point at.
	const env = process.env.NETA_SOCKET;
	const socketPath = env === undefined || env === "" ? undefined : env;
	try {
		const client = await NodeClient.connect(socketPath === undefined ? {} : { dir: dirname(socketPath) });
		client.close();
	} catch (error) {
		return fail(error);
	}
	return runProxy({ actorId: actor, token, ...(socketPath === undefined ? {} : { socketPath }) });
}
