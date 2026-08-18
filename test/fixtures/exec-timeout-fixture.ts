import { test } from "bun:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const childFixture = fileURLToPath(new URL("./sigterm-ignoring-child.mjs", import.meta.url));

test("holds a descendant open until neta_exec kills the process group", async () => {
	const child = spawn(process.execPath, [childFixture], { stdio: "ignore" });
	writeFileSync("exec-descendant.pid", String(child.pid));
	await new Promise(() => {});
});
