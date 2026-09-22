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
	/** True only when Neta selected its repository-owned checkout. */
	managed: boolean;
	create: (fork: string) => Promise<void>;
	verify: (fork: string) => Promise<void>;
}

/** Rebuild only the ignored repository runtime when it has drifted from its pin. */
export async function ensureOpenCodeCheckout(setup: CheckoutSetup): Promise<void> {
	const exists = await access(setup.fork).then(() => true).catch(() => false);
	if (!exists) {
		await setup.create(setup.fork);
		await setup.verify(setup.fork);
		return;
	}
	try {
		await setup.verify(setup.fork);
		return;
	} catch (error) {
		if (!setup.managed) throw error;
		const parent = resolve(setup.fork, "..");
		const candidate = await temporaryPath(parent, ".neta-opencode-replacement-");
		try {
			await setup.create(candidate);
			await setup.verify(candidate);
		} catch (createError) {
			await rm(candidate, { recursive: true, force: true });
			throw createError;
		}

		const backup = await temporaryPath(parent, ".neta-opencode-backup-");
		await rename(setup.fork, backup);
		try {
			await rename(candidate, setup.fork);
		} catch (promotionError) {
			await rename(backup, setup.fork);
			throw promotionError;
		}
		console.log(`Preserved stale OpenCode runtime at ${backup}`);
	}
}

async function temporaryPath(parent: string, prefix: string): Promise<string> {
	await mkdir(parent, { recursive: true });
	const path = await mkdtemp(join(parent, prefix));
	await rm(path, { recursive: true, force: true });
	return path;
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
		managed: environment.NETA_OPENCODE_DIR === undefined,
		create: (target) => createCheckout(target, pin),
		verify: (target) => verifyCheckout(target, pin),
	});
	const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
		cwd: fork,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (await install.exited) throw new Error("Pinned OpenCode dependency installation failed");
}

if (import.meta.main) await setupOpenCode();
