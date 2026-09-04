// The single runtime version source (12-release T12.1): everything that
// reports the package version — `neta --version`, the Node's `hello` reply
// and the MCP proxy's `serverInfo` — reads it through `netaVersion()`. The
// one version literal lives in `package.json`; this module only reads it.
// `build-app.sh` bakes it in as `NETA_VERSION` when compiling the
// single-file exe, which ships with no `package.json` beside it. Otherwise,
// from this module's directory it walks up at most four directories and
// returns the `version` of the first `package.json` named `@intervene/neta`,
// so it works both from `src/` and from the bundled `dist/main.js`.
// Anywhere else it reports `"0.0.0-dev"` instead of throwing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const NETA_VERSION: string | undefined;

let cached: string | undefined;

export function netaVersion(): string {
	if (cached !== undefined) {
		return cached;
	}
	if (typeof NETA_VERSION === "string" && NETA_VERSION.length > 0) {
		cached = NETA_VERSION;
		return cached;
	}
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let level = 0; level <= 4; level++) {
		try {
			const data: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (typeof data === "object" && data !== null) {
				const pkg = data as { name?: unknown; version?: unknown };
				if (pkg.name === "@intervene/neta") {
					if (typeof pkg.version === "string" && pkg.version.length > 0) {
						cached = pkg.version;
						return cached;
					}
					break;
				}
			}
		} catch {
			// Missing or unreadable: keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	cached = "0.0.0-dev";
	return cached;
}
