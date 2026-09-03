import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
	type ClientConnection,
	client,
	type InitializeResponse,
	ndJsonStream,
	PROTOCOL_VERSION,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { nowIso } from "../core/time.ts";
import type { Access, IsoTime } from "../core/types.ts";
import { launchArgs, type ProviderSettings } from "./settings.ts";

export interface ExitInfo {
	code: number | null;
	signal: string | null;
	at: IsoTime;
}

export interface ClientHandlers {
	onSessionUpdate(p: SessionNotification): void;
	requestPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

export interface SpawnOptions {
	provider: ProviderSettings;
	access: Access;
	cwd: string;
	handlers: ClientHandlers;
	env?: Record<string, string>;
}

export interface ProviderProcess {
	readonly pid: number;
	readonly connection: ClientConnection;
	readonly initialize: InitializeResponse;
	readonly exited: Promise<ExitInfo>;
	stderrTail(): string;
	kill(): Promise<ExitInfo>;
}

export const KILL_GRACE_MS = 2000;
const STDERR_KEEP = 8 * 1024;

export function spawnProvider(o: SpawnOptions): Promise<ProviderProcess> {
	return new Promise<ProviderProcess>((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(o.provider.command, launchArgs(o.provider, o.access), {
				cwd: o.cwd,
				env: { ...process.env, ...o.provider.env, ...o.env },
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			reject(new Error(`failed to spawn ${o.provider.command}: ${(error as Error).message}`));
			return;
		}

		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (stderr.length > STDERR_KEEP) {
				stderr = stderr.slice(-STDERR_KEEP);
			}
		});

		let exitInfo: ExitInfo | undefined;
		let notifyExit: ((info: ExitInfo) => void) | undefined;
		const exited = new Promise<ExitInfo>((done) => {
			notifyExit = done;
		});
		const finish = (code: number | null, signal: string | null): void => {
			if (exitInfo === undefined) {
				exitInfo = { code, signal, at: nowIso() };
				notifyExit?.(exitInfo);
			}
		};
		child.on("exit", (code, signal) => finish(code, signal));
		child.on("error", (error) => {
			if (exitInfo === undefined && settled === false) {
				settled = true;
				try {
					child.kill("SIGKILL");
				} catch {
					// Already gone; the error below carries the cause.
				}
				const tail = stderr === "" ? "" : `: ${stderr}`;
				reject(new Error(`failed to spawn ${o.provider.command}: ${error.message}${tail}`));
				finish(null, null);
				return;
			}
			finish(null, null);
		});

		let settled = false;
		const stdin = child.stdin;
		const stdout = child.stdout;
		if (stdin === null || stdout === null) {
			settled = true;
			reject(new Error(`failed to spawn ${o.provider.command}: stdio unavailable`));
			return;
		}
		const pid = child.pid;
		if (pid === undefined) {
			settled = true;
			reject(new Error(`failed to spawn ${o.provider.command}: no pid`));
			return;
		}

		const stream = ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout));
		const app = client()
			.onNotification("session/update", (ctx) => {
				o.handlers.onSessionUpdate(ctx.params);
			})
			.onRequest("session/request_permission", (ctx) => o.handlers.requestPermission(ctx.params));
		const connection = app.connect(stream);

		connection.agent
			.request("initialize", {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			})
			.then(
				(initialize) => {
					if (settled) {
						return;
					}
					settled = true;
					let killPromise: Promise<ExitInfo> | undefined;
					resolve({
						pid,
						connection,
						initialize,
						exited,
						stderrTail: () => stderr,
						kill: () => {
							if (exitInfo !== undefined) {
								return Promise.resolve(exitInfo);
							}
							if (killPromise === undefined) {
								killPromise = (async (): Promise<ExitInfo> => {
									try {
										child.kill("SIGTERM");
									} catch {
										// Already gone; `exited` still resolves.
									}
									const done = await Promise.race([
										exited,
										new Promise<"wait">((done) => setTimeout(() => done("wait"), KILL_GRACE_MS)),
									]);
									if (done === "wait" && exitInfo === undefined) {
										try {
											child.kill("SIGKILL");
										} catch {
											// Already gone.
										}
									}
									const info = await exited;
									connection.close();
									return info;
								})();
							}
							return killPromise;
						},
					});
				},
				(error) => {
					if (settled) {
						return;
					}
					settled = true;
					try {
						child.kill("SIGKILL");
					} catch {
						// Already gone.
					}
					const tail = stderr === "" ? "" : `: ${stderr}`;
					reject(new Error(`initialize failed for ${o.provider.command}: ${String(error)}${tail}`));
				},
			);
	});
}
