import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = dirname(import.meta.dir);
const launcherSource = join(root, "packages/termux/neta-rmux/neta-rmux");
const temporary: string[] = [];

function runLauncher(prefix: string, args: string[], env: NodeJS.ProcessEnv) {
	return spawnSync("/bin/bash", [join(prefix, "bin/neta-rmux"), ...args], { env, encoding: "utf8" });
}

function stagedRuntime() {

	const prefix = mkdtempSync(join(tmpdir(), "neta termux launcher "));
	temporary.push(prefix);
	const runtime = join(prefix, "lib/neta-rmux");
	mkdirSync(join(prefix, "bin"), { recursive: true });
	mkdirSync(join(prefix, "tmp"), { recursive: true });
	mkdirSync(join(runtime, "pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle"), { recursive: true });
	cpSync(launcherSource, join(prefix, "bin/neta-rmux"));
	chmodSync(join(prefix, "bin/neta-rmux"), 0o755);
	for (const name of ["neta-rmux", "rmux"]) {
		writeFileSync(join(runtime, name), "#!/bin/sh\nprintf '%s\\n' \"$0|$NETA_PI_EXECUTABLE|$NETA_PI_CLI|$NETA_PI_ACP_EXTENSION|$RMUX_SDK_DAEMON_BINARY|$NETA_REMOTE_SSH_EXECUTABLE|$TMPDIR|$RMUX_TMPDIR|${NETA_NODE_EXECUTABLE-unset}\"\nfor argument in \"$@\"; do printf 'argument=%s\\n' \"$argument\"; done\n");
		chmodSync(join(runtime, name), 0o755);
	}
	writeFileSync(join(runtime, "pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), "export {};\n");
	writeFileSync(join(runtime, "pi-runtime/neta-acp-extension.mjs"), "export {};\n");
	const fakeNode = join(prefix, "node with spaces");
	const fakeSsh = join(prefix, "ssh with spaces");
	for (const executable of [fakeNode, fakeSsh]) {
		writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'v22.19.0\\n'; fi\nexit 0\n");
		chmodSync(executable, 0o755);
	}
	return { prefix, fakeNode, fakeSsh };
}

afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Termux rmux launcher", () => {
	test("uses relocatable paths, forwards arguments, and never needs Bun or Cargo", () => {
		const { prefix, fakeNode, fakeSsh } = stagedRuntime();
		const physicalPrefix = realpathSync(prefix);
		const result = runLauncher(prefix, ["two words", "--flag"], {
			PATH: "/usr/bin:/bin",
			TERMUX_PREFIX: prefix,
			NETA_TERMUX_NODE: fakeNode,
			NETA_REMOTE_SSH_EXECUTABLE: fakeSsh,
			NETA_REMOTE_SSH_DESTINATION: "person@example.test",
			NETA_REMOTE_NETA_DIR: "/remote/neta",
			NETA_REMOTE_WORKSPACE_ROOT: "/remote/workspace",
			NETA_NODE_EXECUTABLE: "bun-should-not-survive",
		});
		expect(result.status, result.stderr).toBe(0);
		const [header, ...arguments_] = result.stdout.trim().split("\n");
		const fields = header.split("|");
		expect(fields[0]).toBe(join(physicalPrefix, "lib/neta-rmux/neta-rmux"));
		expect(arguments_).toEqual(["argument=two words", "argument=--flag"]);
		expect(fields.slice(1, 8)).toEqual([
			fakeNode,
			join(physicalPrefix, "lib/neta-rmux/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
			join(physicalPrefix, "lib/neta-rmux/pi-runtime/neta-acp-extension.mjs"),
			join(physicalPrefix, "lib/neta-rmux/rmux"),
			fakeSsh,
			join(prefix, "tmp"),
			join(prefix, "tmp"),
		]);
		expect(fields[8]).toBe("unset");
	});

	test("reports missing remote and packaged dependencies before launching", () => {
		const { prefix, fakeNode, fakeSsh } = stagedRuntime();
		const missingRemote = runLauncher(prefix, [], { TERMUX_PREFIX: prefix, NETA_TERMUX_NODE: fakeNode, NETA_REMOTE_SSH_EXECUTABLE: fakeSsh });
		expect(missingRemote.status).toBe(2);
		expect(missingRemote.stderr).toContain("NETA_REMOTE_SSH_DESTINATION is required");

		rmSync(join(prefix, "lib/neta-rmux/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"));
		const missingPi = runLauncher(prefix, [], {
				TERMUX_PREFIX: prefix,
				NETA_TERMUX_NODE: fakeNode,
				NETA_REMOTE_SSH_EXECUTABLE: fakeSsh,
				NETA_REMOTE_SSH_DESTINATION: "person@example.test",
				NETA_REMOTE_NETA_DIR: "/remote/neta",
				NETA_REMOTE_WORKSPACE_ROOT: "/remote/workspace",
		});
		expect(missingPi.status).toBe(127);
		expect(missingPi.stderr).toContain("npm install --omit=dev --package-lock=false");
		expect(missingPi.stderr).toContain("neta\\ termux\\ launcher");

		rmSync(join(prefix, "lib/neta-rmux/rmux"));
		const missingDaemon = runLauncher(prefix, [], {
				TERMUX_PREFIX: prefix,
				NETA_TERMUX_NODE: fakeNode,
				NETA_REMOTE_SSH_EXECUTABLE: fakeSsh,
				NETA_REMOTE_SSH_DESTINATION: "person@example.test",
				NETA_REMOTE_NETA_DIR: "/remote/neta",
				NETA_REMOTE_WORKSPACE_ROOT: "/remote/workspace",
		});
		expect(missingDaemon.status).toBe(127);
		expect(missingDaemon.stderr).toContain("Android rmux daemon is missing");
		expect(existsSync(join(prefix, "lib/neta-rmux/neta-rmux"))).toBe(true);
	});

	test("the staged ACP extension is a Node-loadable bundle with Pi dependencies external", () => {
		const stage = mkdtempSync(join(tmpdir(), "neta termux extension "));
		temporary.push(stage);
		symlinkSync(join(root, "node_modules"), join(stage, "node_modules"), "dir");
		const extension = join(stage, "pi-acp-extension.mjs");
		execFileSync("bun", ["build", join(root, "src/rmux/pi-acp-extension.ts"), "--target=node", "--format=esm", "--external", "@earendil-works/*", "--outfile", extension], { stdio: "pipe" });
		const loaded = execFileSync("node", ["--input-type=module", "--eval", `import(${JSON.stringify(extension)}).then((module) => process.stdout.write(typeof module.default))`], { encoding: "utf8" });
		expect(loaded).toBe("function");
	});

	test("the staging script preserves the Pi CLI location and stages no backend runtime modules", () => {
		const work = mkdtempSync(join(tmpdir(), "neta termux stage "));
		temporary.push(work);
		const client = join(work, "neta-rmux android");
		const daemon = join(work, "rmux android");
		for (const executable of [client, daemon]) {
			writeFileSync(executable, "#!/bin/sh\nexit 0\n");
			chmodSync(executable, 0o755);
		}
		const destination = join(work, "stage with spaces");
		const staged = spawnSync(join(root, "scripts/prepare-termux-rmux.sh"), [destination], {
			env: {
				...process.env,
				TMPDIR: tmpdir(),
				NETA_RMUX_ANDROID_BINARY: client,
				RMUX_ANDROID_DAEMON: daemon,
			},
			encoding: "utf8",
		});
		expect(staged.status).toBe(0);
		expect(existsSync(join(destination, "lib/neta-rmux/pi-runtime/package.json"))).toBe(true);
		expect(existsSync(join(destination, "lib/neta-rmux/pi-runtime/node_modules"))).toBe(false);
		const stagedRuntime = join(destination, "lib/neta-rmux/pi-runtime/node_modules");
		mkdirSync(dirname(join(stagedRuntime, "@earendil-works/pi-tui")), { recursive: true });
		cpSync(join(root, "node_modules/@earendil-works/pi-tui"), join(stagedRuntime, "@earendil-works/pi-tui"), { recursive: true });
		for (const dependency of ["get-east-asian-width", "marked"]) {
			cpSync(join(root, "node_modules", dependency), join(stagedRuntime, dependency), { recursive: true });
		}
		const loaded = execFileSync("node", ["--input-type=module", "--eval", `import(${JSON.stringify(join(destination, "lib/neta-rmux/pi-runtime/neta-acp-extension.mjs"))}).then((module) => process.stdout.write(typeof module.default))`], { encoding: "utf8" });
		expect(loaded).toBe("function");
	});
});
