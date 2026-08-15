/**
 * Two small things `bun:test` does not ship, which several suites need.
 */

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
