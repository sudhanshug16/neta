import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { managedOpenCodeDir, readPin, sha256, verifyCheckout } from "./opencode-pin.ts";

const root = resolve(import.meta.dir, "..");
const fork = process.env.NETA_OPENCODE_DIR ?? managedOpenCodeDir(root);
const metadata = JSON.parse(await readFile(join(fork, "neta-fork.json"), "utf8"));
if (metadata.integrationVersion !== 2) throw new Error("Incompatible Neta OpenCode checkout");
const pin = await readPin();
if (Bun.version !== pin.bun) throw new Error(`Pinned OpenCode requires Bun ${pin.bun}; found ${Bun.version}`);
if (process.env.NETA_RELEASE_BUILD === "1") await verifyCheckout(fork, pin);
const build = Bun.spawn([process.execPath, "run", "--cwd", "packages/cli", "build", "--single", "--skip-install", "--skip-web-ui"], {
  cwd: fork, stdout: "inherit", stderr: "inherit", env: { ...process.env, OPENCODE_CHANNEL: "neta" },
});
if (await build.exited) throw new Error("Native OpenCode build failed");
const platform = `${process.platform}-${process.arch}`;
const executable = process.platform === "win32" ? "opencode.exe" : "opencode";
const directory = join(root, "dist", "opencode", platform);
await mkdir(directory, { recursive: true });
await copyFile(join(fork, "packages/cli/dist", `cli-${platform}`, "bin", executable), join(directory, executable));
await chmod(join(directory, executable), 0o755);
await copyFile(join(fork, "LICENSE"), join(directory, "LICENSE"));
await copyFile(join(fork, "neta-fork.json"), join(directory, "neta-fork.json"));
await writeFile(join(directory, "build-manifest.json"), `${JSON.stringify({
  format: 1, platform, integrationVersion: metadata.integrationVersion,
  certifiedSource: process.env.NETA_RELEASE_BUILD === "1", upstreamCommit: pin.commit,
  overlaySha256: pin.overlaySha256, lockSha256: sha256(await readFile(join(fork, "bun.lock"))),
  executableSha256: sha256(await readFile(join(directory, executable))),
}, null, 2)}\n`);
console.log(`Staged Neta OpenCode for ${platform}`);
