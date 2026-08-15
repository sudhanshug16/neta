/**
 * `neta models [backend]` — what a backend can actually run.
 *
 * Tiers are configured by model id, and the ids belong to the backend: Codex
 * folds the reasoning level into them (`gpt-5.6-sol[xhigh]`), Claude Code uses
 * aliases (`haiku`), OpenCode's depend on the provider you logged into. Rather
 * than document a list that will be wrong next month, ask the backend.
 *
 * This opens a session and closes it. No prompt is sent, so nothing is spent.
 */

import { AcpConnection } from "./acp/connection.ts";
import { loadConfig } from "./settings.ts";
import { TIERS } from "./types.ts";

export async function listBackendModels(backendName: string | undefined, cwd: string): Promise<number> {
	const config = loadConfig(cwd);
	const names = backendName ? [backendName] : config.backendNames();

	for (const name of names) {
		const backend = config.launcher(name);
		if (!backend.command) {
			console.log(`${name}: no command configured.`);
			continue;
		}

		const connection = new AcpConnection({
			command: backend.command,
			args: backend.args,
			cwd,
			env: backend.env,
			allowMutations: false,
			onUpdate: () => {},
			onStderr: () => {},
			onDenied: () => {},
		});

		try {
			await connection.start();
			const { models, currentModel, modes, currentMode } = connection.offered;
			console.log(`\n${name}`);
			console.log(`  models: ${models.length === 0 ? "(none advertised)" : ""}`);
			for (const model of models) console.log(`    ${model}${model === currentModel ? "  (default)" : ""}`);
			console.log(`  modes: ${modes.map((mode) => (mode === currentMode ? `${mode} (default)` : mode)).join(", ")}`);
			const mapped = TIERS.filter((tier) => config.resolve(tier).name === name)
				.map((tier) => `${tier}=${config.resolve(tier).model ?? "backend default"}`)
				.join(", ");
			if (mapped) console.log(`  your tiers: ${mapped}`);
		} catch (error) {
			console.log(`\n${name}\n  could not start: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			connection.kill();
		}
	}
	return 0;
}
