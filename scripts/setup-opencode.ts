import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
	git,
	managedOpenCodeDir,
	overlayPath,
	readPin,
	type OpenCodePin,
	verifyCheckout,
} from "./opencode-pin.ts";

export interface CheckoutSetup {
	fork: string;
	managedFork: string;
	create: () => Promise<void>;
	verify: () => Promise<void>;
}

/** Rebuild only the ignored repository runtime when it has drifted from its pin. */
export async function ensureOpenCodeCheckout(setup: CheckoutSetup): Promise<void> {
	const exists = await access(setup.fork).then(() => true).catch(() => false);
	if (!exists) return setup.create();
	try {
		await setup.verify();
		return;
	} catch (error) {
		if (resolve(setup.fork) !== resolve(setup.managedFork)) throw error;
		await rm(setup.fork, { recursive: true, force: true });
		await setup.create();
		await setup.verify();
	}
}

async function createCheckout(fork: string, pin: OpenCodePin): Promise<void> {
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
	} finally {
		await rm(candidate, { recursive: true, force: true });
	}
}

export async function setupOpenCode(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	const managedFork = managedOpenCodeDir();
	const fork = environment.NETA_OPENCODE_DIR ?? managedFork;
	const pin = await readPin();
	if (Bun.version !== pin.bun) throw new Error(`Pinned OpenCode requires Bun ${pin.bun}; found ${Bun.version}`);
	await ensureOpenCodeCheckout({
		fork,
		managedFork,
		create: () => createCheckout(fork, pin),
		verify: () => verifyCheckout(fork, pin),
	});
	const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
		cwd: fork,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (await install.exited) throw new Error("Pinned OpenCode dependency installation failed");
}

if (import.meta.main) await setupOpenCode();
