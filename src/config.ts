/**
 * Names and paths every part of Neta shares.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

/** The command workers and the leader invoke to reach Neta. */
export const APP_NAME = "neta";

/** Read from package.json so a release is one edit, not two that can disagree. */
export const VERSION: string = pkg.version;

/** Per-project directory: settings, roles, skills. */
export const CONFIG_DIR_NAME = ".neta";

/** User-level directory. `NETA_DIR` overrides it, which is what tests use. */
export function getAgentDir(): string {
	return process.env.NETA_DIR ?? join(homedir(), CONFIG_DIR_NAME);
}
