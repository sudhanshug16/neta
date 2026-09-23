import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { nowIso } from "../core/time.ts";
import type { ExitInfo } from "../session/runtime.ts";
import { type ProviderSettings, providerPath } from "../session/settings.ts";
import { systemContextPath } from "../session/system-context.ts";
import { openCodeInvocation } from "./runtime.ts";

export interface NativeEvent {
	type: string;
	data: Record<string, unknown>;
	id?: string;
}

export interface NativeServer {
	readonly api: NativeApi;
	readonly exited: Promise<ExitInfo>;
	stderrTail(): string;
	close(): Promise<ExitInfo>;
}

/** A private, stdio leased V2 server. Closing stdin also closes the server after a Node crash. */
export async function startNativeServer(input: {
	provider: ProviderSettings;
	cwd: string;
	access: "readOnly" | "readWrite";
	unsandboxed: boolean;
	sessionId: string;
	actorId: string;
	bindingGeneration: string;
}): Promise<NativeServer> {
	const invocation = openCodeInvocation();
	if (invocation.apiVersion !== 2) throw new Error("Neta requires the pinned OpenCode V2 runtime");
	const password = randomBytes(32).toString("base64url");
	const child = spawn(invocation.command, [...invocation.args, "serve", "--stdio", "--port", "0"], {
		cwd: input.cwd,
		env: {
			...process.env,
			...input.provider.env,
			PATH: providerPath(input.provider),
			NETA_MANAGED_OPENCODE: "1",
			NETA_NATIVE_ACCESS: input.access,
			NETA_NATIVE_LEADER: input.unsandboxed ? "1" : "0",
			NETA_SYSTEM_CONTEXT_FILE: systemContextPath(input.sessionId),
			NETA_SYSTEM_CONTEXT_ACTOR_ID: input.actorId,
			NETA_SYSTEM_CONTEXT_SESSION_ID: input.sessionId,
			NETA_SYSTEM_CONTEXT_GENERATION: input.bindingGeneration,
			OPENCODE_DISABLE_AUTOUPDATE: "true",
			OPENCODE_PASSWORD: password,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	return await nativeServer(child, password);
}

async function nativeServer(child: ChildProcessWithoutNullStreams, password: string): Promise<NativeServer> {
	let stderr = "";
	child.stderr.on("data", (bytes: Buffer) => {
		stderr = (stderr + bytes.toString("utf8")).slice(-8192);
	});
	let exit: ExitInfo | undefined;
	let exitResolve!: (value: ExitInfo) => void;
	const exited = new Promise<ExitInfo>((resolve) => {
		exitResolve = resolve;
	});
	const finish = (code: number | null, signal: string | null): void => {
		if (exit !== undefined) return;
		exit = { code, signal, at: nowIso() };
		exitResolve(exit);
	};
	child.on("exit", finish);
	child.on("error", () => finish(null, null));
	const url = await new Promise<string>((resolve, reject) => {
		let output = "";
		const timeout = setTimeout(() => reject(new Error("OpenCode V2 server did not report readiness")), 30_000);
		const cleanup = (): void => {
			clearTimeout(timeout);
			child.stdout.off("data", onData);
			child.off("error", onError);
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const onData = (bytes: Buffer): void => {
			output += bytes.toString("utf8");
			if (output.length > 8192) {
				cleanup();
				reject(new Error("Invalid OpenCode V2 readiness response"));
				return;
			}
			const end = output.indexOf("\n");
			if (end < 0) return;
			try {
				const ready: unknown = JSON.parse(output.slice(0, end));
				if (!isRecord(ready) || typeof ready.url !== "string") throw new Error("Invalid readiness response");
				const parsed = new URL(ready.url);
				if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password)
					throw new Error("OpenCode V2 server is not on authenticated loopback");
				cleanup();
				resolve(parsed.origin);
			} catch (error) {
				cleanup();
				reject(error);
			}
		};
		child.stdout.on("data", onData);
		child.once("error", onError);
		void exited.then(() => {
			cleanup();
			reject(new Error(`OpenCode V2 server exited before readiness${stderr ? `: ${stderr}` : ""}`));
		});
	}).catch(async (error: unknown) => {
		child.stdin.end();
		child.kill("SIGTERM");
		throw error;
	});
	child.stdout.resume();
	const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
	const api = new NativeApi(url, authorization);
	let stopping: Promise<ExitInfo> | undefined;
	return {
		api,
		exited,
		stderrTail: () => stderr,
		close: () => {
			if (stopping) return stopping;
			stopping = (async () => {
				child.stdin.end();
				const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
				const force = setTimeout(() => child.kill("SIGKILL"), 5000);
				try {
					return await exited;
				} finally {
					clearTimeout(timer);
					clearTimeout(force);
				}
			})();
			return stopping;
		},
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function dataOf(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || !isRecord(value.data)) throw new Error("Invalid OpenCode V2 response");
	return value.data;
}

export class NativeApi {
	readonly url: string;
	readonly authorization: string;
	constructor(url: string, authorization: string) {
		this.url = url;
		this.authorization = authorization;
	}

	async request(
		method: string,
		path: string,
		body?: unknown,
		directory?: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		const url = new URL(path, this.url);
		if (directory !== undefined) url.searchParams.set("location[directory]", directory);
		const response = await fetch(url, {
			method,
			headers: {
				Authorization: this.authorization,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			...(signal === undefined ? {} : { signal }),
		});
		if (!response.ok) {
			const detail = await response.json().catch(() => undefined);
			const message =
				isRecord(detail) && isRecord(detail.data) && typeof detail.data.message === "string"
					? detail.data.message
					: `HTTP ${response.status}`;
			throw new Error(`OpenCode V2 ${method} ${url.pathname}: ${message}`);
		}
		if (response.status === 204) {
			await response.body?.cancel();
			return undefined;
		}
		return await response.json();
	}

	async *events(signal: AbortSignal): AsyncGenerator<NativeEvent> {
		const response = await fetch(new URL("/api/event", this.url), {
			headers: { Authorization: this.authorization },
			signal,
		});
		if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body)
			throw new Error("OpenCode V2 event stream unavailable");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const next = await reader.read();
				buffer += decoder.decode(next.value, { stream: !next.done });
				if (buffer.length > 16 * 1024 * 1024) throw new Error("OpenCode V2 event exceeds 16 MiB");
				buffer = buffer.replaceAll("\r\n", "\n");
				let boundary = buffer.indexOf("\n\n");
				while (boundary >= 0) {
					const block = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const text = block
						.split("\n")
						.flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
						.join("\n");
					if (text) {
						const value: unknown = JSON.parse(text);
						if (isRecord(value) && typeof value.type === "string" && isRecord(value.data))
							yield {
								type: value.type,
								data: value.data,
								...(typeof value.id === "string" ? { id: value.id } : {}),
							};
					}
					boundary = buffer.indexOf("\n\n");
				}
				if (next.done) return;
			}
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	}
}
