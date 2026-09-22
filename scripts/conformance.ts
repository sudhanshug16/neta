import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readPin, repositoryRoot, verifyCheckout } from "./opencode-pin.ts";
import { assertRequiredReport } from "./conformance-report.ts";

const root = repositoryRoot;
const fork = process.env.NETA_OPENCODE_DIR ?? resolve(root, "../neta-opencode-v2");
const pin = await readPin();
await verifyCheckout(fork, pin);
// Nested fixture directories must leave room for the macOS 103-byte socket limit.
// mkdtemp creates this private directory with mode 0700 on supported POSIX hosts.
const temp = await mkdtemp("/tmp/nc-");
const env: Record<string, string> = {
	PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(temp, "home"),
	TMPDIR: temp, TERM: "xterm-256color", SHELL: "/bin/bash",
	NETA_REQUIRED_CONFORMANCE: "1", NETA_OPENCODE_DIR: fork,
	OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
	OPENCODE_DISABLE_AUTOUPDATE: "true",
};
let reportNumber = 0;
async function run(args: string[], extra: Record<string, string> = {}, cwd = root): Promise<void> {
	const report = args[1] === "test" ? join(temp, `required-${++reportNumber}.xml`) : undefined;
	const invocation = report ? [args[0]!, "test", "--reporter=junit", `--reporter-outfile=${report}`, ...args.slice(2)] : args;
	const command = invocation[0] === process.execPath ? [process.execPath, "--no-env-file", ...invocation.slice(1)] : invocation;
	const proc = Bun.spawn(command, { cwd, env: { ...env, ...extra }, stdout: "inherit", stderr: "inherit" });
	if (await proc.exited) throw new Error(`Required conformance failed: ${args.join(" ")}`);
	if (report) assertRequiredReport(await readFile(report, "utf8"));
}
try {
	await mkdir(env.HOME!, { recursive: true });
	for (const name of ["tmux", "node", "tar"]) if (!Bun.which(name)) throw new Error(`Required conformance prerequisite missing: ${name}`);
	console.log("Conformance: pinned bridge, fallback, instruction and startup contracts");
	await run([process.execPath, "test", "test/acp"], {}, join(fork, "packages/cli"));
	await run([process.execPath, "test", "test/plugin/neta-context.test.ts", "test/plugin/optimize.test.ts"], {}, join(fork, "packages/core"));
	await run([process.execPath, "test", "test", "src/index.test.ts"], {}, join(fork, "packages/neta-client"));
	await run([process.execPath, "test", "test/neta-recovery.test.ts", "test/neta-presentation.test.ts", "test/neta-theme.test.ts", "test/neta-viewport.test.tsx", "test/neta-archive.test.tsx", "test/terminal-dimensions.test.ts"], {}, join(fork, "packages/tui"));
	console.log("Conformance: source Node and native OpenCode (fake provider only)");
	await run([process.execPath, "test", "test/agent-runtime.test.ts", "test/parent-reports.test.ts", "test/parent-dispatcher.test.ts", "test/conversation-inbox.test.ts",
		"test/parent-continuation.test.ts", "test/system-context.test.ts", "test/opencode-contract.test.ts",
		"test/node-diagnostics.test.ts", "test/node-lifecycle.test.ts", "test/node-lockfile.test.ts", "test/node-runtime.test.ts",
		"test/node-snapshot.test.ts", "test/assignment-policy.test.ts", "test/result-recovery.test.ts",
		"test/runtime-admission.test.ts", "test/session-lifecycle.test.ts",
		"test/node-conversation-handlers.test.ts", "test/worker-model.test.ts", "test/workspace-reset.test.ts",
		"test/opencode-gateway.test.ts", "test/opencode-v2-native.test.ts"], { NETA_TUI_SMOKE: "1", NETA_TUI_CAPTURE_DIR: process.env.NETA_TUI_CAPTURE_DIR ?? join(temp, "visual") });
	await run([process.execPath, "scripts/verify-opencode.ts"]);
	const native = join(root, "dist/opencode", `${process.platform}-${process.arch}`, "opencode");
	console.log("Conformance: staged native OpenCode (fake provider only)");
	await run([process.execPath, "test", "test/opencode-v2-native.test.ts"], { NETA_OPENCODE_BIN: native, NETA_TUI_SMOKE: "1", NETA_TUI_CAPTURE_DIR: process.env.NETA_TUI_CAPTURE_DIR ?? join(temp, "visual") });
	console.log("Conformance: packed installation without sibling checkout or Bun on PATH");
	await run([process.execPath, "pm", "pack", "--destination", temp, "--ignore-scripts", "--quiet"]);
	const archive = (await readdir(temp)).find((name) => name.endsWith(".tgz"));
	if (!archive) throw new Error("Package archive missing");
	await run(["tar", "-xzf", join(temp, archive), "-C", temp]);
	const bin = join(temp, "bin");
	await mkdir(bin);
	// Version-manager shims depend on the caller's home/config. Resolve Node
	// before placing it in the deliberately empty installation environment.
	const nodeProbe = Bun.spawn(["node", "-p", "process.execPath"], { stdout: "pipe", stderr: "pipe" });
	const nodeExecutable = (await new Response(nodeProbe.stdout).text()).trim();
	if ((await nodeProbe.exited) !== 0 || !nodeExecutable.startsWith("/"))
		throw new Error(`Could not resolve installed Node executable: ${await new Response(nodeProbe.stderr).text()}`);
	await symlink(nodeExecutable, join(bin, "node"));
	await symlink(Bun.which("tmux")!, join(bin, "tmux"));
	const installed = join(temp, "package/dist/main.js");
	await chmod(installed, 0o755);
	await run([process.execPath, "test", "test/opencode-cold-start.test.ts"], {
		NETA_TEST_EXECUTABLE: installed, NETA_TEST_PATH: `${bin}:/usr/bin:/bin`,
		NETA_OPENCODE_DIR: join(temp, "no-sibling-checkout"),
	});
} finally { await rm(temp, { recursive: true, force: true }); }
