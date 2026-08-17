/**
 * Two small things `bun:test` does not ship, which several suites need.
 */

import { fileURLToPath } from "node:url";
import { NetaConfig, type NetaSettings } from "../src/settings.ts";

const FAKE_ACP_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

/**
 * Scrub session environment variables so tests run cleanly even when executed
 * inside a live Neta session. This runs on import, so every test file that uses
 * helpers.ts gets a clean environment.
 */
const SESSION_ENV_VARS = [
	"NETA_SOCKET",
	"NETA_MUX",
	"NETA_PANES",
	"NETA_LEADER_BACKEND",
	"NETA_LEADER_TOKEN",
	"NETA_WORKER_ID",
	"NETA_WORKER_TOKEN",
	"NETA_SCRATCH",
	"NETA_SESSION_ID",
	"NETA_CHECKPOINT_ID",
	"NETA_ZELLIJ_IDENTITY_FILE",
	"ZELLIJ",
	"ZELLIJ_SESSION_NAME",
	"ZELLIJ_PANE_ID",
];

for (const name of SESSION_ENV_VARS) {
	delete process.env[name];
}

/** Poll until the expectation stops throwing, or give up. */
export async function waitFor(check: () => void | Promise<void>, timeoutMs = 2000, stepMs = 10): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await check();
			return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, stepMs));
		}
	}
}

/**
 * Set environment variables for one test and put the previous values back.
 * Deleting a variable and setting it to empty are different things to code that
 * checks truthiness, so an empty string is kept as an empty string.
 */
export class EnvStub {
	private readonly previous = new Map<string, string | undefined>();

	set(name: string, value: string): void {
		if (!this.previous.has(name)) this.previous.set(name, process.env[name]);
		process.env[name] = value;
	}

	restore(): void {
		for (const [name, value] of this.previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		this.previous.clear();
	}
}

/**
 * All vendor-shaped test backends run the fixture through Bun. Keeping their
 * names preserves assignment-policy coverage while making detection independent
 * of whatever vendor CLIs happen to be installed on the host.
 */
export function fixtureBackendConfig(settings: NetaSettings = {}): NetaConfig {
	const fixture = { detect: "bun", command: process.execPath, args: [FAKE_ACP_AGENT] };
	return new NetaConfig({
		...settings,
		backends: {
			...settings.backends,
			claude: { ...fixture, ...settings.backends?.claude },
			codex: { ...fixture, ...settings.backends?.codex },
			opencode: { ...fixture, ...settings.backends?.opencode },
		},
	});
}
