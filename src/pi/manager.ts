import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "../core/ids.ts";
import { recordTerminalTelemetry } from "../diagnostics/telemetry.ts";
export interface TerminalChunk {
	generation: string;
	seq: number;
	dataBase64: string;
}
export interface TerminalAttachment {
	sessionId: string;
	attachmentId: string;
	pid: number;
	generation: string;
	replay: TerminalChunk[];
	replayTruncated: boolean;
}
export interface PiTerminalManager {
	startSession(sessionId: string, cwd: string): Promise<void>;
	attach(
		sessionId: string,
		cwd: string,
		cols: number,
		rows: number,
		connectionId: string,
		emit: (method: string, params: unknown) => void,
	): Promise<TerminalAttachment>;
	input(sessionId: string, attachmentId: string, connectionId: string, dataBase64: string): Promise<void>;
	resize(sessionId: string, attachmentId: string, connectionId: string, cols: number, rows: number): Promise<void>;
	detach(sessionId: string, attachmentId: string, connectionId: string): void;
	closeAll(): void;
	closeSession(sessionId: string): void;
}
interface Live {
	child: ChildProcessWithoutNullStreams;
	next: number;
	pending: Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
	>;
	listeners: Map<string, (method: string, params: unknown) => void>;
	owner?: string;
	ownerConnection?: string;
	buffer: string;
}
export function createPiTerminalManager(o: {
	dataDir: string;
	nodeCommand?: string;
	piCommand?: string;
	piArgs?: string[];
	piCliPath?: string;
	extensionPath?: string;
	extraExtensionPath?: string;
	bridgePath?: string;
	claudeExecutable?: string;
	provider?: string;
	model?: string;
	envForSession?: (id: string) => Record<string, string>;
	hostPath?: string;
	requestTimeoutMs?: number;
}): PiTerminalManager {
	const sessions = new Map<string, Live>();
	const starting = new Map<string, Promise<Live>>();
	const record = (event: string, fields: Record<string, string | number | undefined>) =>
		recordTerminalTelemetry(o.dataDir, event, fields);
	const request = <T>(live: Live, method: string, params: object): Promise<T> =>
		new Promise((resolve, reject) => {
			const id = ++live.next;
			const timer = setTimeout(() => {
				live.pending.delete(id);
				reject(new Error(`Pi terminal ${method} timed out`));
			}, o.requestTimeoutMs ?? 10_000);
			live.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			live.child.stdin.write(`${JSON.stringify({ id, method, ...params })}\n`);
		});
	const start = async (sessionId: string, cwd: string, cols: number, rows: number): Promise<Live> => {
		const sessionDir = join(o.dataDir, "pi", sessionId);
		const configDir = join(o.dataDir, "pi-config");
		mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		if (o.claudeExecutable !== undefined) {
			const path = join(configDir, "claude-bridge.json");
			let existing: Record<string, unknown> = {};
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
					existing = parsed as Record<string, unknown>;
			} catch {}
			const prior =
				typeof existing.provider === "object" && existing.provider !== null && !Array.isArray(existing.provider)
					? (existing.provider as Record<string, unknown>)
					: {};
			if (typeof prior.pathToClaudeCodeExecutable !== "string" || prior.pathToClaudeCodeExecutable === "") {
				writeFileSync(
					path,
					`${JSON.stringify({ ...existing, provider: { ...prior, pathToClaudeCodeExecutable: o.claudeExecutable } }, null, 2)}\n`,
					{ mode: 0o600 },
				);
			}
		}
		const child = spawn(o.nodeCommand ?? "node", [o.hostPath ?? join(process.cwd(), "src/pi/pty-host.mjs")], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const live: Live = { child, next: 0, pending: new Map(), listeners: new Map(), buffer: "" };
		sessions.set(sessionId, live);
		const fail = (error: Error) => {
			record("terminal.error", { sessionId, byteCount: Buffer.byteLength(error.message) });
			if (sessions.get(sessionId) === live) sessions.delete(sessionId);
			for (const pending of live.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(error);
			}
			live.pending.clear();
		};
		child.on("error", fail);
		child.on("exit", (code, signal) => fail(new Error(`Pi terminal host exited (${String(code ?? signal)})`)));
		child.stdin.on("error", fail);
		child.stderr.resume();
		child.stdout.on("data", (data) => {
			live.buffer += data.toString();
			if (live.buffer.length > 4 * 1024 * 1024) {
				child.kill();
				return;
			}
			for (;;) {
				const at = live.buffer.indexOf("\n");
				if (at < 0) return;
				const raw = live.buffer.slice(0, at);
				live.buffer = live.buffer.slice(at + 1);
				let m: {
					id?: number;
					result?: unknown;
					error?: string;
					event?: string;
					chunk?: TerminalChunk;
					phase?: string;
					generation?: string;
					exitCode?: number;
					signal?: number;
				};
				try {
					m = JSON.parse(raw) as typeof m;
				} catch {
					child.kill();
					return fail(new Error("Pi terminal host sent invalid JSON"));
				}
				if (m.id !== undefined) {
					const pending = live.pending.get(m.id);
					if (pending !== undefined) {
						clearTimeout(pending.timer);
						if (m.error !== undefined) pending.reject(new Error(m.error));
						else pending.resolve(m.result);
					}
					live.pending.delete(m.id);
				} else if (m.event === "output") {
					record("terminal.output", {
						sessionId,
						generation: m.chunk?.generation,
						seq: m.chunk?.seq,
						byteCount: m.chunk === undefined ? 0 : Buffer.from(m.chunk.dataBase64, "base64").byteLength,
					});
					for (const emit of live.listeners.values()) emit("terminal.output", { sessionId, ...m.chunk });
				} else if (m.event === "state") {
					record("terminal.exit", { sessionId, generation: m.generation, byteCount: m.exitCode });
					for (const emit of live.listeners.values())
						emit("terminal.state", {
							sessionId,
							generation: m.generation,
							phase: m.phase,
							exitCode: m.exitCode,
							signal: m.signal,
						});
					if (m.phase === "exited") {
						sessions.delete(sessionId);
						child.kill();
					}
				}
			}
		});
		const args = o.piArgs ?? [
			o.piCliPath ?? join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
			"--session-dir",
			sessionDir,
			"--session-id",
			sessionId,
			"--extension",
			o.extensionPath ?? join(process.cwd(), "src/pi/neta-extension.ts"),
			...(o.extraExtensionPath === undefined ? [] : ["--extension", o.extraExtensionPath]),
			"--extension",
			o.bridgePath ?? join(process.cwd(), "node_modules/pi-claude-bridge/src/index.ts"),
			"--approve",
			"--provider",
			o.provider ?? "claude-bridge",
			"--model",
			o.model ?? "claude-fable-5",
		];
		const env = Object.fromEntries(
			Object.entries({ ...process.env, PI_CODING_AGENT_DIR: configDir, ...o.envForSession?.(sessionId) }).filter(
				(e): e is [string, string] => typeof e[1] === "string",
			),
		);
		try {
			record("terminal.start", { sessionId, cols, rows });
			await request(live, "start", {
				command: o.piCommand ?? o.nodeCommand ?? "node",
				args,
				cwd,
				cols,
				rows,
				env,
				generation: ulid(),
			});
		} catch (error) {
			sessions.delete(sessionId);
			child.kill();
			throw error;
		}
		return live;
	};
	const getOrStart = (sid: string, cwd: string, cols: number, rows: number): Promise<Live> => {
		const pending = starting.get(sid);
		if (pending !== undefined) return pending;
		const existing = sessions.get(sid);
		if (existing !== undefined) return Promise.resolve(existing);
		const launched = start(sid, cwd, cols, rows).finally(() => starting.delete(sid));
		starting.set(sid, launched);
		return launched;
	};
	const owned = (sid: string, aid: string, connectionId: string) => {
		const live = sessions.get(sid);
		if (live === undefined || live.owner !== aid || live.ownerConnection !== connectionId)
			throw new Error("stale terminal attachment");
		return live;
	};
	return {
		startSession: async (sid, cwd) => {
			await getOrStart(sid, cwd, 80, 24);
		},
		attach: async (sid, cwd, cols, rows, connectionId, emit) => {
			const live = await getOrStart(sid, cwd, cols, rows);
			const attachmentId = ulid();
			if (live.owner !== undefined) live.listeners.delete(live.owner);
			live.listeners.set(attachmentId, emit);
			live.owner = attachmentId;
			live.ownerConnection = connectionId;
			record("terminal.attach", { sessionId: sid, cols, rows });
			// A Pi lead starts before a desktop view exists, at the bootstrap
			// 80x24 size. Resize the retained PTY to the attaching emulator before
			// taking replay so Pi's fullscreen redraw is ordered into that replay.
			await request(live, "resize", { cols, rows });
			const state = await request<{
				pid: number;
				generation: string;
				replay: TerminalChunk[];
				replayTruncated: boolean;
			}>(live, "snapshot", {});
			return { sessionId: sid, attachmentId, ...state };
		},
		input: async (sid, aid, connectionId, dataBase64) => {
			record("terminal.input", { sessionId: sid, byteCount: Buffer.from(dataBase64, "base64").byteLength });
			await request(owned(sid, aid, connectionId), "input", { dataBase64 });
		},
		resize: async (sid, aid, connectionId, cols, rows) => {
			record("terminal.resize", { sessionId: sid, cols, rows });
			await request(owned(sid, aid, connectionId), "resize", { cols, rows });
		},
		detach: (sid, aid, connectionId) => {
			record("terminal.detach", { sessionId: sid });
			const live = owned(sid, aid, connectionId);
			live.listeners.delete(aid);
			live.owner = undefined;
			live.ownerConnection = undefined;
		},
		closeSession: (sid) => {
			starting.delete(sid);
			const live = sessions.get(sid);
			if (live === undefined) return;
			sessions.delete(sid);
			for (const pending of live.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("Pi terminal session closed"));
			}
			live.pending.clear();
			live.child.stdin.write(`${JSON.stringify({ id: 0, method: "close" })}\n`);
		},
		closeAll: () => {
			for (const sid of [...sessions.keys()]) {
				const live = sessions.get(sid);
				if (live !== undefined) {
					sessions.delete(sid);
					live.child.stdin.write(`${JSON.stringify({ id: 0, method: "close" })}\n`);
				}
			}
			starting.clear();
		},
	};
}
