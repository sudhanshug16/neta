// How this Neta re-invokes itself. Three hosts ship the same code and each
// needs a different argv: `node dist/main.js` and the installed `neta` bin
// symlink both need the script as the first argument, while the
// `bun build --compile` executable has no script at all — inside it
// `process.argv[1]` is the virtual `/$bunfs/root/main`, which a child would
// parse as a command name and reject with `unknown command`.
//
// Every place that hands this Neta's own argv to something else goes through
// here: the detached `node start` child (`src/cli/commands/node.ts`), the
// on-demand autostart (`src/node/client.ts`) and the `neta mcp` server entry
// an ACP session is launched with (`src/acp/mcp.ts`). `src/cli/main.ts`
// recognises the same shape by the basename of `execPath`.
import { basename } from "node:path";

export interface SelfInvocation {
	command: string;
	// What goes before the command name: the script path, or nothing at all
	// inside the compiled executable.
	prefixArgs: string[];
}

// Undefined when neither form is available: not the compiled exe, and no
// script path either (an embedder that imported the bundle).
export function selfInvocation(execPath: string, script: string | undefined): SelfInvocation | undefined {
	if (basename(execPath) === "neta") {
		return { command: execPath, prefixArgs: [] };
	}
	if (script === undefined || script === "") {
		return undefined;
	}
	return { command: execPath, prefixArgs: [script] };
}
