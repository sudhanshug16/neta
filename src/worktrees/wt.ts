// The one audited way to call Worktrunk (`wt`). Neta never runs
// `git worktree` itself; plain `git` is only for read-only merge detection
// (integration.ts). The binary is invoked directly, always non-interactively:
// stdin ignored, `-y`, `NO_COLOR=1`, `WORKTRUNK_VERBOSE=0`.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface WtRun {
	stdout: string;
	stderr: string;
	code: number;
}

export interface WtOptions {
	cwd: string;
	timeoutMs?: number;
}

export class WtError extends Error {
	readonly argv: readonly string[];
	readonly code: number | undefined;
	readonly stdout: string;
	readonly stderr: string;

	constructor(argv: readonly string[], run: { stdout: string; stderr: string; code: number | undefined }) {
		super(
			`wt ${argv.join(" ")} failed${run.code === undefined ? "" : ` with exit ${run.code}`}: ${firstLine(run.stderr)}`,
		);
		this.name = "WtError";
		this.argv = argv;
		this.code = run.code;
		this.stdout = run.stdout;
		this.stderr = run.stderr;
	}
}

function firstLine(text: string): string {
	const line = text.split("\n")[0]?.trim() ?? "";
	return line === "" ? "(no stderr)" : line;
}

// NETA_WT_BIN points at the fake-wt shim in tests, so no test needs the real
// binary installed.
export function wtBinary(): string {
	return process.env.NETA_WT_BIN ?? "wt";
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 64 * 1024;

function appendCaptured(current: string, chunk: string, limit = MAX_CAPTURE_BYTES): string {
	const combined = current + chunk;
	if (Buffer.byteLength(combined) <= limit) return combined;
	const marker = "\n[output truncated]\n";
	const headBytes = Math.floor((limit - marker.length) / 2);
	const tailBytes = limit - marker.length - headBytes;
	const bytes = Buffer.from(combined, "utf8");
	return `${bytes.subarray(0, headBytes).toString("utf8")}${marker}${bytes.subarray(-tailBytes).toString("utf8")}`;
}

function baseEnv(): Record<string, string> {
	return {
		...process.env,
		PATH: wtSearchPath(),
		NO_COLOR: "1",
		WORKTRUNK_VERBOSE: "0",
		TERM: "dumb",
	} as Record<string, string>;
}

export function wtSearchPath(inheritedPath = process.env.PATH ?? "", home = homedir()): string {
	const inherited = inheritedPath.split(delimiter).filter((entry) => entry !== "");
	return [
		...new Set([
			...inherited,
			join(home, ".local", "bin"),
			join(home, ".cargo", "bin"),
			"/opt/homebrew/bin",
			"/usr/local/bin",
			"/usr/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
		]),
	].join(delimiter);
}

export function runWt(argv: readonly string[], o: WtOptions): Promise<WtRun> {
	const full = ["-C", o.cwd, ...argv, "-y"];
	return new Promise<WtRun>((resolve, reject) => {
		const child = spawn(wtBinary(), full, {
			stdio: ["ignore", "pipe", "pipe"],
			env: baseEnv(),
			timeout: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			// Lists may describe hundreds of worktrees; do not apply the small
			// hook-output budget to their structured JSON response.
			stdout = appendCaptured(
				stdout,
				chunk.toString("utf8"),
				argv[0] === "list" ? 8 * 1024 * 1024 : MAX_CAPTURE_BYTES,
			);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendCaptured(stderr, chunk.toString("utf8"));
		});
		child.on("error", (error) => {
			const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
			const detail = missing
				? "Worktrunk executable not found in the app service search path; install Worktrunk, then retry mission creation"
				: error.message;
			reject(new WtError(full, { stdout, stderr: stderr === "" ? detail : stderr, code: undefined }));
		});
		child.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr, code: 0 });
				return;
			}
			reject(new WtError(full, { stdout, stderr, code: code ?? undefined }));
		});
	});
}

// stdout is pure JSON; human text goes to stderr and is ignored here. A
// single-object payload arrives on the first non-empty line, a list spans
// all of stdout.
export async function runWtJson(argv: readonly string[], o: WtOptions): Promise<unknown> {
	// A non-zero exit rejects in runWt with a WtError.
	const run = await runWt(argv, o);
	const lines = run.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const first = lines[0];
	const payload = first?.startsWith("{") ? first : run.stdout;
	return JSON.parse(payload) as unknown;
}

export async function wtAvailable(): Promise<{ ok: boolean; version?: string; reason?: string }> {
	try {
		const run = await runWt(["--version"], { cwd: process.cwd() });
		const version = run.stdout
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line !== "");
		return { ok: true, version };
	} catch (error) {
		if (error instanceof WtError) {
			return { ok: false, reason: firstLine(error.stderr) };
		}
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
