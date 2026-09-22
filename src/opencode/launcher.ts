import { netaBuildId } from "../version.ts";
import { spawn } from "node:child_process";
import { openCodeInvocation } from "./runtime.ts";

/** OpenTUI is a client of the Node-owned OpenCode session, never its owner. */
export async function openCodeCommand(path?: string, migrate = false, host?: string): Promise<number> {
	try {
		const invocation = openCodeInvocation();
		return await new Promise<number>((resolve) => {
			const child = spawn(
				invocation.command,
				[
					...invocation.args,
					"neta",
					...(path ? [path] : []),
					...(migrate ? ["--migrate"] : []),
					...(host ? ["--host", host] : []),
				],
				{
					stdio: "inherit",
					env: {
						...process.env,
						NETA_LAUNCH_CWD: process.cwd(),
						NETA_ENGINE_BUILD: netaBuildId(),
						...(process.argv[1] ? { NETA_ENGINE_ENTRY: process.argv[1] } : {}),
					},
				},
			);
			child.once("error", (error) => {
				process.stderr.write(`neta: ${error.message}\n`);
				resolve(1);
			});
			child.once("exit", (code) => resolve(code ?? 1));
		});
	} catch (error) {
		process.stderr.write(`neta: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
