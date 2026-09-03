export interface McpEnvVar {
	name: string;
	value: string;
}

// The stdio MCP server descriptor handed to `session/new`: one `neta mcp`
// proxy per ACP session that needs tools. Its shape matches what ACP expects,
// so 05 passes it through untouched.
export interface McpServerSpec {
	name: string;
	command: string;
	args: string[];
	env: McpEnvVar[];
}

export interface NetaBin {
	command: string;
	prefixArgs: string[];
}

export const NETA_MCP_SERVER_NAME = "neta";
export const NETA_SOCKET_ENV = "NETA_SOCKET";

// How to invoke this Neta: an installed `neta` via NETA_BIN when set, else
// the current runtime with the bundle path, so a checkout and an installed
// bundle both work.
export function netaBin(env?: NodeJS.ProcessEnv): NetaBin {
	const fromEnv = env?.NETA_BIN ?? process.env.NETA_BIN;
	if (fromEnv !== undefined && fromEnv !== "") {
		return { command: fromEnv, prefixArgs: [] };
	}
	return { command: process.execPath, prefixArgs: [process.argv[1]] };
}

export function netaMcpServer(o: {
	actorId: string;
	token: string;
	socketPath?: string;
	bin?: NetaBin;
}): McpServerSpec {
	const bin = o.bin ?? netaBin();
	const env: McpEnvVar[] = [];
	if (o.socketPath !== undefined) {
		env.push({ name: NETA_SOCKET_ENV, value: o.socketPath });
	}
	return {
		name: NETA_MCP_SERVER_NAME,
		command: bin.command,
		args: [...bin.prefixArgs, "mcp", "--actor", o.actorId, "--token", o.token],
		env,
	};
}
