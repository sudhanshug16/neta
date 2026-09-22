import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;

export function recordTerminalTelemetry(
	root: string,
	event: string,
	fields: Record<string, string | number | undefined>,
): void {
	try {
		const dir = join(root, "runtime");
		const path = join(dir, "terminal.ndjson");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		let rotate = false;
		try {
			rotate = statSync(path).size >= MAX_BYTES;
		} catch {
			/* first record */
		}
		if (rotate) {
			rmSync(`${path}.2`, { force: true });
			try {
				renameSync(`${path}.1`, `${path}.2`);
			} catch {
				/* no prior archive */
			}
			renameSync(path, `${path}.1`);
		}
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
	} catch {
		/* diagnostics never break the terminal */
	}
}
