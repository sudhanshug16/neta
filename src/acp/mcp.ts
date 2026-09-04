import { selfInvocation } from "../core/self.ts";

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
// this process's own argv through `selfInvocation`, so a checkout, an
// installed bundle and the compiled single-file exe inside the app bundle
// all work. Passing `process.argv[1]` on unconditionally used to hand every
// session under the app `<exe> /$bunfs/root/neta mcp ...`, and that child
// exits 1 with `unknown command`, so no actor could reach a Neta tool.
export function netaBin(env?: NodeJS.ProcessEnv, self?: { execPath: string; script?: string }): NetaBin {
	const fromEnv = env?.NETA_BIN ?? process.env.NETA_BIN;
	if (fromEnv !== undefined && fromEnv !== "") {
		return { command: fromEnv, prefixArgs: [] };
	}
	const execPath = self?.execPath ?? process.execPath;
	const script = self === undefined ? process.argv[1] : self.script;
	// Neither form available (an embedder that imported the bundle): the
	// runtime alone is the closest thing to a command there is.
	return selfInvocation(execPath, script) ?? { command: execPath, prefixArgs: [] };
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
