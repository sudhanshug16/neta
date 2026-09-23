import { type AdaptedRuntime, adaptRuntime } from "../../src/node/lifecycle.ts";
import { startSession } from "./legacy-acp/session.ts";

// Keep the old wire fixture available to coordination tests while production
// sessions use the direct OpenCode adapter.
export function adaptLegacyAcp(...args: Parameters<typeof adaptRuntime>): AdaptedRuntime {
	return adaptRuntime(
		args[0],
		args[1],
		args[2],
		args[3],
		args[4],
		args[5],
		args[6],
		args[7],
		args[8],
		args[9],
		startSession,
	);
}

export { startSession as startLegacySession };
