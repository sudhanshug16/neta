import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = join(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "neta-packed-rmux-"));

afterEach(() => rmSync(work, { recursive: true, force: true }));

test("a packaged rmux launcher uses only its staged runtime assets", () => {
	const dist = join(work, "dist");
	const runtime = join(dist, "tui", `${process.platform}-${process.arch}`);
	mkdirSync(runtime, { recursive: true });
	execFileSync("bun", ["build", "src/cli/main.ts", "--target=node", "--outdir", dist], {
		cwd: root,
		stdio: "pipe",
	});
	const capture = join(work, "capture.txt");
	const client = join(runtime, "neta-rmux");
	writeFileSync(client, "#!/bin/sh\nprintf '%s\\n' \"$NETA_NODE_SCRIPT|$NETA_PI_CLI|$NETA_PI_ACP_EXTENSION|$RMUX_SDK_DAEMON_BINARY\" > \"$NETA_TEST_CAPTURE\"\n");
	chmodSync(client, 0o755);
	const daemonPath = join(runtime, "rmux");
	writeFileSync(daemonPath, "runtime daemon");
	chmodSync(daemonPath, 0o755);
	writeFileSync(join(runtime, "pi-acp-extension.mjs"), "export default {};\n");
	const piPackage = join(work, "node_modules", "@earendil-works", "pi-coding-agent");
	const fakePi = join(piPackage, "dist", "bundle", "cli.js");
	mkdirSync(join(piPackage, "dist", "bundle"), { recursive: true });
	writeFileSync(fakePi, "");
	chmodSync(fakePi, 0o755);
	writeFileSync(
		join(piPackage, "package.json"),
		JSON.stringify({ type: "module", exports: { ".": "./dist/index.js" } }),
	);
	writeFileSync(join(piPackage, "dist", "index.js"), "export {};\n");
	const { NETA_RMUX_BINARY, NETA_PI_CLI, NETA_PI_ACP_EXTENSION, RMUX_SDK_DAEMON_BINARY, ...environment } = process.env;
	execFileSync("node", [join(dist, "main.js"), "rmux"], {
		cwd: work,
		env: { ...environment, NETA_TEST_CAPTURE: capture },
		stdio: "pipe",
	});
	const [nodeScript, piCli, extension, daemon] = readFileSync(capture, "utf8").trim().split("|");
	expect(nodeScript).toBe(realpathSync(join(dist, "main.js")));
	expect(piCli).toBe(realpathSync(fakePi));
	expect(extension).toBe(realpathSync(join(runtime, "pi-acp-extension.mjs")));
	expect(daemon).toBe(realpathSync(join(runtime, "rmux")));
	for (const value of [nodeScript, piCli, extension, daemon]) expect(value.startsWith(root)).toBe(false);
});

test("a packaged rmux launcher reports a missing runtime without invoking Cargo", () => {
	const dist = join(work, "dist");
	execFileSync("bun", ["build", "src/cli/main.ts", "--target=node", "--outdir", dist], {
		cwd: root,
		stdio: "pipe",
	});
	const result = Bun.spawnSync(["node", join(dist, "main.js"), "rmux"], { cwd: work });
	expect(result.exitCode).toBe(1);
	expect(result.stderr.toString()).toContain("unsupported or missing packaged TUI runtime");
	expect(result.stderr.toString()).not.toContain("cargo");
});
