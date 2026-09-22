import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectNode } from "../node/client.ts";

/** Start the client only; the owning Node survives the terminal. */
export async function toadCommand(demo = false): Promise<number> {
	if (!demo) {
		const client = await connectNode({ client: "cli", autostart: true });
		client.close();
	}
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	const runtime = moduleDirectory.endsWith("/dist")
		? join(moduleDirectory, "toad")
		: join(moduleDirectory, "..", "..", "prototypes", "toad-mvp");
	return new Promise((resolve) => {
		const child = spawn(
			"uv",
			[
				"run",
				"--frozen",
				"--project",
				runtime,
				"python",
				join(runtime, "app.py"),
				"--project",
				process.cwd(),
				...(demo ? ["--demo"] : []),
			],
			{ stdio: "inherit" },
		);
		child.once("error", (error) => {
			process.stderr.write(`neta: cannot launch Toad client (uv is required): ${error.message}\n`);
			resolve(1);
		});
		child.once("exit", (code) => resolve(code ?? 1));
	});
}
