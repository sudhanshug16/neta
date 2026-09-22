import { spawn } from "node:child_process";
import { existsSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const gate = process.env.NETA_PI_GATE_FILE;
const started = process.env.NETA_PI_GATE_STARTED_FILE;
const realCli = process.env.NETA_REAL_PI_CLI;
if (gate === undefined || started === undefined || realCli === undefined) throw new Error("gated Pi fixture is missing its latch environment");

writeFileSync(started, "started");
if (!existsSync(gate)) {
	await new Promise((resolve) => {
		const watcher = watch(dirname(gate), () => {
			if (existsSync(gate)) {
				watcher.close();
				resolve(undefined);
			}
		});
	});
}
const child = spawn(process.execPath, [realCli, ...process.argv.slice(2)], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => child.kill(signal));
}
const result = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exitCode = result.code ?? 1;
