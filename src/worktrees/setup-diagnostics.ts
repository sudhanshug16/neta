// Private, bounded evidence for a Worktrunk setup failure. It is deliberately
// separate from provider failures: a failed setup has no runtime session to resume.
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { WorkspaceId, Worktree } from "../core/types.ts";
import { createMutex, readJson, writeJsonAtomic } from "../store/files.ts";
import { encodeWorkspaceId } from "../store/paths.ts";
import type { WtError } from "./wt.ts";

export const EXCERPT_BYTES = 4096;
const STORED_OUTPUT_BYTES = 64 * 1024;
const MAX_DIAGNOSTICS = 20;
const MAX_DIRECTORY_BYTES = 4 * 1024 * 1024;

export interface WorktreeSetupDiagnostic {
	workspaceId: WorkspaceId;
	number: number;
	name: string;
	objective: string;
	access: string;
	repoRoot: string;
	branch: string;
	base: string;
	at: string;
	exitCode?: number;
	stdout: string;
	stderr: string;
	partialWorktree?: Worktree;
	setupDisposition?: "handled" | "waived";
	recoveredAt?: string;
}

function cleanOutput(text: string): string {
	return stripVTControlCharacters(text)
		.split("")
		.filter((char) => char === "\t" || char === "\n" || (char >= " " && char <= "~"))
		.join("")
		.replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,}]+/gi, "$1[redacted]")
		.replace(/("(?:api[_-]?key|token|password|secret)"\s*:\s*")[^"]+/gi, "$1[redacted]")
		.replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]")
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted]@");
}

export function safeExcerpt(text: string): string {
	const cleaned = cleanOutput(text);
	if (cleaned.length <= EXCERPT_BYTES) return cleaned;
	const errorLines = cleaned
		.split("\n")
		.filter((line) =>
			/rake aborted!|(?:^|\s)[\w:]+(?:Error|Exception|Invalid):|Validation failed:|^error:|^fatal:/i.test(line),
		)
		.slice(-2)
		.join("\n")
		.slice(0, 768);
	const marker = `\n[... middle omitted ...]${errorLines === "" ? "" : `\n[error lines]\n${errorLines}`}\n`;
	const headLength = 512;
	const tailLength = EXCERPT_BYTES - headLength - marker.length;
	return `${cleaned.slice(0, headLength)}${marker}${cleaned.slice(-tailLength)}`;
}

function storedOutput(text: string): string {
	const cleaned = cleanOutput(text);
	if (Buffer.byteLength(cleaned, "utf8") <= STORED_OUTPUT_BYTES) return cleaned;
	const bytes = Buffer.from(cleaned, "utf8");
	const head = bytes.subarray(0, 8 * 1024).toString("utf8");
	const tail = bytes.subarray(-(STORED_OUTPUT_BYTES - 9 * 1024)).toString("utf8");
	return `${head}\n[output truncated before storage]\n${tail}`;
}

const writeMutexes = new Map<string, ReturnType<typeof createMutex>>();

async function retain(path: string, incomingBytes: number): Promise<void> {
	if (incomingBytes > MAX_DIRECTORY_BYTES) throw new Error("setup diagnostic exceeds retention byte limit");
	const dir = join(path, "..");
	const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const entries = await Promise.all(
		files
			.filter((file) => file.isFile() && /^\d+\.json$/.test(file.name))
			.map(async (file) => ({ path: join(dir, file.name), stat: await stat(join(dir, file.name)) })),
	);
	let bytes = entries.reduce((total, entry) => total + entry.stat.size, 0);
	let count = entries.length;
	for (const entry of entries.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)) {
		if (count < MAX_DIAGNOSTICS && bytes + incomingBytes <= MAX_DIRECTORY_BYTES) break;
		await rm(entry.path, { force: true });
		bytes -= entry.stat.size;
		count--;
	}
}

export function setupDiagnosticPath(netaDir: string, workspaceId: WorkspaceId, number: number): string {
	return join(netaDir, "worktree-setup", encodeWorkspaceId(workspaceId), `${number}.json`);
}

export function buildSetupDiagnostic(
	diagnostic: Omit<WorktreeSetupDiagnostic, "stdout" | "stderr" | "exitCode"> & { error: WtError | Error },
): WorktreeSetupDiagnostic {
	const error = diagnostic.error;
	const wt = "stderr" in error ? (error as WtError) : undefined;
	const saved: WorktreeSetupDiagnostic = {
		...diagnostic,
		stdout: storedOutput(wt === undefined ? "" : wt.stdout),
		stderr: storedOutput(wt === undefined ? error.message : wt.stderr),
		exitCode: wt?.code,
	};
	delete (saved as WorktreeSetupDiagnostic & { error?: Error }).error;
	return saved;
}

export async function writeSetupDiagnostic(
	netaDir: string,
	diagnostic: Omit<WorktreeSetupDiagnostic, "stdout" | "stderr" | "exitCode"> & { error: WtError | Error },
): Promise<WorktreeSetupDiagnostic> {
	const saved = buildSetupDiagnostic(diagnostic);
	const path = setupDiagnosticPath(netaDir, saved.workspaceId, saved.number);
	const key = join(path, "..");
	let mutex = writeMutexes.get(key);
	if (mutex === undefined) {
		mutex = createMutex();
		writeMutexes.set(key, mutex);
	}
	await mutex(async () => {
		await retain(path, Buffer.byteLength(`${JSON.stringify(saved)}\n`));
		await writeJsonAtomic(path, saved);
	});
	return saved;
}

export function readSetupDiagnostic(
	netaDir: string,
	workspaceId: WorkspaceId,
	number: number,
): Promise<WorktreeSetupDiagnostic | undefined> {
	return readJson<WorktreeSetupDiagnostic>(setupDiagnosticPath(netaDir, workspaceId, number));
}

export class WorktreeSetupError extends Error {
	readonly diagnostic: WorktreeSetupDiagnostic;
	readonly diagnosticPath?: string;
	readonly persistenceError?: string;

	constructor(diagnostic: WorktreeSetupDiagnostic, netaDir = "$NETA_DIR", persistenceError?: string) {
		super(
			`worktree setup failed before mission registration or agent launch (exit ${diagnostic.exitCode ?? "unknown"}); diagnostic: ${persistenceError === undefined ? setupDiagnosticPath(netaDir, diagnostic.workspaceId, diagnostic.number) : "could not persist"}; stderr: ${safeExcerpt(diagnostic.stderr).split("\n")[0] ?? "(none)"}`,
		);
		this.name = "WorktreeSetupError";
		this.diagnostic = diagnostic;
		this.diagnosticPath =
			persistenceError === undefined
				? setupDiagnosticPath(netaDir, diagnostic.workspaceId, diagnostic.number)
				: undefined;
		this.persistenceError = persistenceError;
	}
}
