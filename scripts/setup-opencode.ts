import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { git, overlayPath, readPin, verifyCheckout } from "./opencode-pin.ts";

const fork = process.env.NETA_OPENCODE_DIR ?? resolve(import.meta.dir, "../../neta-opencode-v2");
const pin = await readPin();
if (Bun.version !== pin.bun) throw new Error(`Pinned OpenCode requires Bun ${pin.bun}; found ${Bun.version}`);
if (!(await access(fork).then(() => true).catch(() => false))) {
  const parent = resolve(fork, "..");
  await mkdir(parent, { recursive: true });
  const candidate = await mkdtemp(join(parent, ".neta-opencode-"));
  try {
    await git(candidate, ["init", "--quiet"]);
    await git(candidate, ["fetch", "--depth", "1", pin.repository, pin.commit]);
    await git(candidate, ["checkout", "--detach", "FETCH_HEAD"]);
    await git(candidate, ["apply", "--check", overlayPath]);
    await git(candidate, ["apply", overlayPath]);
    await verifyCheckout(candidate, pin);
    await rename(candidate, fork);
  } finally { await rm(candidate, { recursive: true, force: true }); }
} else {
  // A developer checkout is never reset or overwritten by setup.
  await verifyCheckout(fork, pin);
}
const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], { cwd: fork, stdout: "inherit", stderr: "inherit" });
process.exitCode = await install.exited;
