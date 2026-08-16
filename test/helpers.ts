/**
 * Two small things `bun:test` does not ship, which several suites need.
 */

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
	"ZELLIJ",
	"ZELLIJ_SESSION_NAME",
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
