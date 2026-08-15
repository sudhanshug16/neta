/**
 * Names and paths every part of Neta shares.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The command workers and the leader invoke to reach Neta. */
export const APP_NAME = "neta";

export const VERSION = "0.1.0";

/** Per-project directory: settings, roles, skills. */
export const CONFIG_DIR_NAME = ".neta";

/** User-level directory. `NETA_DIR` overrides it, which is what tests use. */
export function getAgentDir(): string {
	return process.env.NETA_DIR ?? join(homedir(), CONFIG_DIR_NAME);
}
