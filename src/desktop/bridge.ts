import { existsSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { sendChannelRequest } from "../channel/client.ts";
import type { NetaActorSnapshot } from "../channel/protocol.ts";
import { type CheckpointWorker, listCheckpoints, readCheckpoint, readVendorSessionCapture } from "../checkpoint.ts";
import { getAgentDir } from "../config.ts";
import { listSessions, type SessionRecord } from "../session.ts";
import type { WorkerLogPage, WorkerState } from "../types.ts";
import {
	detectWorkspaceBinding,
	readWorkspaceBinding,
	type WorkspaceBinding,
	workspaceAvailability,
	workspaceBindingsMatch,
} from "../workspace.ts";
import { DesktopLeaderSession, type DesktopMessage, type DesktopMessagePage } from "./leader-session.ts";

interface DesktopRequest {
	id: string;
	command: "list" | "archives" | "open" | "resume" | "tail" | "prompt" | "stop" | "close" | "shutdown";
	sessionId?: string;
	actorId?: string;
	cwd?: string;
	backend?: string;
	since?: number;
	text?: string;
}

interface DesktopResponse {
	id: string;
	ok: boolean;
	data?: unknown;
	error?: string;
}

export interface DesktopActorSummary {
	id: string;
	name: string;
	role: string;
	backend: string;
	kind: "leader" | "worker";
	state: string;
	task?: string;
	writer?: boolean;
}

export interface DesktopProjectSummary {
	id: string;
	logicalId: string;
	name: string;
	path: string;
	owned: boolean;
	lifecycle: "active" | "archived";
	updatedAt: number;
	resumable: boolean;
	workspace?: {
		provider: "worktrunk";
		branch?: string;
		availability: "available" | "restorable" | "missing";
	};
	error?: string;
	agents: DesktopActorSummary[];
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseRequest(line: string): DesktopRequest {
	const value = JSON.parse(line) as Partial<DesktopRequest>;
	if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.command !== "string") {
		throw new Error("Desktop bridge requests require string id and command fields.");
	}
	return value as DesktopRequest;
}

function workerState(state: WorkerState): string {
	switch (state) {
		case "starting":
		case "running":
			return "running";
		case "waiting":
			return "thinking";
		case "queued":
		case "blocked":
			return "waiting";
		case "done":
			return "done";
		case "failed":
		case "killed":
		case "interrupted":
			return "failed";
	}
}

function projectSummary(
	record: SessionRecord,
	snapshot: NetaActorSnapshot,
	owned: DesktopLeaderSession | undefined,
): DesktopProjectSummary {
	return {
		id: record.id,
		logicalId: snapshot.session.logicalId,
		name: basename(snapshot.session.cwd),
		path: snapshot.session.cwd,
		owned: owned !== undefined,
		lifecycle: "active",
		updatedAt: snapshot.session.startedAt,
		resumable: false,
		agents: [
			{
				id: "leader",
				name: "Neta",
				role: "Leader",
				backend: snapshot.leader.backend,
				kind: "leader",
				state: owned?.state ?? "running",
			},
			...snapshot.workers.map((worker) => ({
				id: worker.id,
				name: worker.name,
				role: `${worker.role} · ${worker.tier}`,
				backend: worker.backend,
				kind: "worker" as const,
				state: workerState(worker.state),
				task: worker.task,
				writer: worker.writer,
			})),
		],
	};
}

function archivedWorker(worker: CheckpointWorker): DesktopActorSummary {
	return {
		id: worker.id,
		name: worker.name,
		role: `${worker.role} · ${worker.tier}`,
		backend: worker.backend,
		kind: "worker",
		state: workerState(worker.state),
		task: worker.task,
		writer: worker.writer,
	};
}

function archiveId(logicalId: string): string {
	return `archive:${logicalId}`;
}

function logicalArchiveId(sessionId: string): string | undefined {
	return sessionId.startsWith("archive:") ? sessionId.slice("archive:".length) : undefined;
}

function mapWorkerPage(page: WorkerLogPage): DesktopMessagePage {
	return {
		cursor: page.cursor,
		messages: page.entries.map((entry, index) => {
			const delivered = /^(?:Leader queued for next turn|Leader delivering now as next turn): (.*)$/.exec(
				entry.text,
			);
			return {
				id: `worker-${page.cursor - page.entries.length + index + 1}`,
				author: delivered ? "user" : entry.kind === "text" || entry.kind === "say" ? "agent" : "system",
				text: delivered?.[1] ?? entry.text,
				at: entry.at,
			};
		}) satisfies DesktopMessage[],
	};
}

export class DesktopBridge {
	private readonly owned = new Map<string, DesktopLeaderSession>();

	async handle(request: DesktopRequest): Promise<unknown> {
		switch (request.command) {
			case "list":
				return { projects: await this.listProjects() };
			case "archives":
				return { projects: await this.listArchives() };
			case "open": {
				if (!request.cwd) throw new Error("open requires cwd.");
				const session = await DesktopLeaderSession.start({ cwd: request.cwd, backend: request.backend });
				if (!session.sessionId) throw new Error("The desktop leader did not register a session id.");
				this.owned.set(session.sessionId, session);
				return { sessionId: session.sessionId };
			}
			case "resume": {
				if (!request.sessionId) throw new Error("resume requires sessionId.");
				const checkpointId = logicalArchiveId(request.sessionId) ?? request.sessionId;
				const session = await DesktopLeaderSession.resume({ checkpointId });
				if (!session.sessionId) throw new Error("The resumed desktop leader did not register a session id.");
				this.owned.set(session.sessionId, session);
				return { sessionId: session.sessionId };
			}
			case "tail":
				return this.tail(request);
			case "prompt":
				return this.prompt(request);
			case "stop":
				return this.stop(request);
			case "close":
				return this.close(request.sessionId);
			case "shutdown":
				await this.shutdown();
				return { stopped: true };
		}
	}

	async shutdown(): Promise<void> {
		await Promise.all([...this.owned.values()].map((session) => session.close().catch(() => {})));
		this.owned.clear();
	}

	private async listProjects(): Promise<DesktopProjectSummary[]> {
		const records = listSessions(getAgentDir());
		const projects = await Promise.all(
			records.map(async (record) => {
				try {
					const response = await sendChannelRequest(record.socket, {
						type: "actor-snapshot",
						token: record.token,
					});
					if (!response.ok || !response.data) return undefined;
					return projectSummary(record, response.data as NetaActorSnapshot, this.owned.get(record.id));
				} catch {
					return undefined;
				}
			}),
		);
		return projects.filter((project): project is DesktopProjectSummary => project !== undefined);
	}

	private async listArchives(): Promise<DesktopProjectSummary[]> {
		const agentDir = getAgentDir();
		const live = new Set(listSessions(agentDir).map((record) => record.checkpointId ?? record.id));
		const projects = await Promise.all(
			listCheckpoints(agentDir).map(async (entry): Promise<DesktopProjectSummary | undefined> => {
				if (live.has(entry.id)) return undefined;
				if (!entry.checkpoint) {
					return {
						id: archiveId(entry.id),
						logicalId: entry.id,
						name: entry.id,
						path: entry.path,
						owned: false,
						lifecycle: "archived",
						updatedAt: 0,
						resumable: false,
						error: entry.error ?? "This checkpoint cannot be read.",
						agents: [],
					};
				}
				const checkpoint = entry.checkpoint;
				const savedBinding = readWorkspaceBinding(checkpoint.id, agentDir);
				const detectedBinding = await detectWorkspaceBinding(checkpoint.canonicalCwd, checkpoint.id);
				const binding: WorkspaceBinding | undefined = savedBinding ?? detectedBinding;
				const availability =
					savedBinding &&
					existsSync(checkpoint.canonicalCwd) &&
					(!detectedBinding || !workspaceBindingsMatch(savedBinding, detectedBinding))
						? "missing"
						: workspaceAvailability(checkpoint.canonicalCwd, binding);
				const hasConversation = Boolean(
					checkpoint.leader.vendorConversationId ?? readVendorSessionCapture(checkpoint.id, agentDir),
				);
				return {
					id: archiveId(checkpoint.id),
					logicalId: checkpoint.id,
					name: basename(checkpoint.canonicalCwd),
					path: checkpoint.canonicalCwd,
					owned: false,
					lifecycle: "archived",
					updatedAt: checkpoint.updatedAt,
					resumable: hasConversation && availability !== "missing",
					...(binding
						? {
								workspace: {
									provider: "worktrunk" as const,
									...(binding.branch ? { branch: binding.branch } : {}),
									availability,
								},
							}
						: {}),
					...(!hasConversation ? { error: "The exact leader conversation was not captured." } : {}),
					agents: [
						{
							id: "leader",
							name: "Neta",
							role: "Leader",
							backend: checkpoint.leader.backend,
							kind: "leader",
							state: "done",
						},
						...checkpoint.workers.map(archivedWorker),
					],
				};
			}),
		);
		return projects.filter((project): project is DesktopProjectSummary => project !== undefined);
	}

	private async tail(request: DesktopRequest): Promise<DesktopMessagePage> {
		const archivedId = request.sessionId ? logicalArchiveId(request.sessionId) : undefined;
		if (archivedId) return this.tailArchive(archivedId, request.actorId, request.since);
		const { record, actorId } = this.target(request);
		if (actorId === "leader") {
			const owned = this.owned.get(record.id);
			if (!owned) {
				return {
					cursor: 1,
					messages:
						(request.since ?? 0) > 0
							? []
							: [
									{
										id: "leader-native-owner",
										author: "system",
										text: "This leader is open in its native CLI. Start the project from Neta Desktop to chat here through ACP.",
										at: Date.now(),
									},
								],
				};
			}
			return owned.messagePage(request.since);
		}
		const response = await sendChannelRequest(record.socket, {
			type: "tail",
			token: record.token,
			workerId: actorId,
			since: request.since,
		});
		if (!response.ok) throw new Error(response.error);
		return mapWorkerPage(response.data as WorkerLogPage);
	}

	private tailArchive(checkpointId: string, actorId: string | undefined, since = 0): DesktopMessagePage {
		if (!actorId) throw new Error("tail requires actorId.");
		const checkpoint = readCheckpoint(checkpointId, getAgentDir());
		if (actorId === "leader") {
			const messages: DesktopMessage[] = [
				{
					id: `archive-${checkpointId}-leader`,
					author: "system",
					text: "Archived session. Resume it to continue the exact leader conversation through ACP.",
					at: checkpoint.updatedAt,
				},
			];
			return { cursor: messages.length, messages: since > 0 ? [] : messages };
		}
		const worker = checkpoint.workers.find((candidate) => candidate.id === actorId);
		if (!worker) throw new Error(`Archived session ${checkpointId} has no agent ${actorId}.`);
		const cursor = Math.max(0, Math.min(Math.trunc(since), worker.log.length));
		return {
			cursor: worker.log.length,
			messages: worker.log.slice(cursor).map((entry, index) => ({
				id: `archive-${checkpointId}-${actorId}-${cursor + index + 1}`,
				author: entry.kind === "text" || entry.kind === "say" ? "agent" : "system",
				text: entry.text,
				at: entry.at,
			})),
		};
	}

	private async prompt(request: DesktopRequest): Promise<{ accepted: true }> {
		const { record, actorId } = this.target(request);
		const text = request.text?.trim();
		if (!text) throw new Error("prompt requires non-empty text.");
		if (actorId === "leader") {
			const owned = this.owned.get(record.id);
			if (!owned) throw new Error("This leader is owned by its native CLI and cannot accept GUI prompts safely.");
			await owned.prompt(text);
			return { accepted: true };
		}
		const response = await sendChannelRequest(record.socket, {
			type: "pane-input",
			token: record.token,
			workerId: actorId,
			text,
		});
		if (!response.ok) throw new Error(response.error);
		return { accepted: true };
	}

	private async stop(request: DesktopRequest): Promise<{ stopped: true }> {
		const { record, actorId } = this.target(request);
		if (actorId === "leader") {
			const owned = this.owned.get(record.id);
			if (!owned) throw new Error("This leader is owned by its native CLI and cannot be stopped from the GUI.");
			await owned.cancel();
			return { stopped: true };
		}
		const response = await sendChannelRequest(record.socket, {
			type: "kill",
			token: record.token,
			workerId: actorId,
		});
		if (!response.ok) throw new Error(response.error);
		return { stopped: true };
	}

	private async close(sessionId: string | undefined): Promise<{ closed: true }> {
		if (!sessionId) throw new Error("close requires sessionId.");
		const owned = this.owned.get(sessionId);
		if (!owned) throw new Error("Only a GUI-owned leader session can be closed here.");
		await owned.close();
		this.owned.delete(sessionId);
		return { closed: true };
	}

	private target(request: DesktopRequest): { record: SessionRecord; actorId: string } {
		if (!request.sessionId || !request.actorId) throw new Error(`${request.command} requires sessionId and actorId.`);
		const record = listSessions(getAgentDir()).find((session) => session.id === request.sessionId);
		if (!record) throw new Error(`Session ${request.sessionId} is not running.`);
		return { record, actorId: request.actorId };
	}
}

export async function runDesktopBridge(): Promise<void> {
	const bridge = new DesktopBridge();
	const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	let closing = false;
	const write = (response: DesktopResponse) => process.stdout.write(`${JSON.stringify(response)}\n`);
	lines.on("line", (line) => {
		let request: DesktopRequest;
		try {
			request = parseRequest(line);
		} catch (error) {
			write({ id: "invalid", ok: false, error: describe(error) });
			return;
		}
		void bridge.handle(request).then(
			(data) => write({ id: request.id, ok: true, data }),
			(error) => write({ id: request.id, ok: false, error: describe(error) }),
		);
	});
	const close = async () => {
		if (closing) return;
		closing = true;
		await bridge.shutdown();
	};
	lines.once("close", () => void close());
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.once(signal, () => void close().then(() => process.exit(0)));
	}
}
