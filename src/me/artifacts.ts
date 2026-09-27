import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ulid } from "../core/ids.ts";
import { ensureDir, readJson, writeJsonAtomic } from "../store/files.ts";
import { encodeWorkspaceId, paths } from "../store/paths.ts";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_BYTES = 32 * 1024;
const MAX_OPEN_BYTES = 16 * 1024;
const ALLOWED_MIME = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

export type ArtifactAudience = "parent" | "neta" | "user";
export interface NetaArtifact {
	id: string;
	workspaceId: string;
	machineId: string;
	missionId?: string;
	producerActorId: string;
	producerKind: "leader" | "lead" | "agent";
	title: string;
	mimeType: string;
	audience: ArtifactAudience;
	size: number;
	hash: string;
	preview: string;
	createdAt: string;
	previousId?: string;
}

export interface ArtifactActor {
	workspaceId: string;
	machineId: string;
	missionId?: string;
	actorId: string;
	kind: "leader" | "lead" | "agent" | "neta";
}

function artifactDir(workspaceId: string): string {
	return join(paths().root, "artifacts", encodeWorkspaceId(workspaceId));
}
function metadataPath(workspaceId: string, id: string): string {
	if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error("invalid artifact id");
	return join(artifactDir(workspaceId), `${id}.json`);
}
function dataPath(workspaceId: string, id: string): string {
	return join(artifactDir(workspaceId), `${id}.data`);
}
function within(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function privatePath(path: string): boolean {
	return path
		.split(sep)
		.some(
			(part) =>
				part === ".git" ||
				part === ".neta" ||
				part === ".env" ||
				part.startsWith(".env.") ||
				/^(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/i.test(part),
		);
}
function textBytes(bytes: Buffer, mimeType: string): string {
	if (!ALLOWED_MIME.has(mimeType)) throw new Error("unsupported artifact MIME type");
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (text.includes("\u0000")) throw new Error("artifact contains binary content");
	if (mimeType === "application/json") JSON.parse(text);
	return text;
}
function title(value: string): string {
	if (!value.trim() || value.length > 160) throw new Error("artifact title must be 1 to 160 characters");
	return value.trim();
}

export async function publishArtifact(input: {
	actor: ArtifactActor;
	assignedRoot: string;
	path?: string;
	text?: string;
	title: string;
	mimeType: string;
	audience: ArtifactAudience;
	previousId?: string;
}): Promise<NetaArtifact> {
	if ((input.path === undefined) === (input.text === undefined))
		throw new Error("publish exactly one of path or text");
	if (!["parent", "neta", "user"].includes(input.audience)) throw new Error("invalid artifact audience");
	if (input.actor.kind === "neta") throw new Error("Neta cannot publish execution artifacts");
	const artifactTitle = title(input.title);
	let bytes: Buffer;
	if (input.path !== undefined) {
		const root = await realpath(input.assignedRoot);
		const requested = resolve(input.assignedRoot, input.path);
		const before = await realpath(requested);
		if (!within(root, before) || privatePath(relative(root, before)) || privatePath(relative(root, requested)))
			throw new Error("artifact path is outside the assigned worktree or is private");
		const handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const file = await handle.stat();
			const after = await realpath(requested);
			const current = await stat(after);
			if (
				!file.isFile() ||
				file.size > MAX_FILE_BYTES ||
				!within(root, after) ||
				file.ino !== current.ino ||
				file.dev !== current.dev
			)
				throw new Error("artifact source changed or exceeds the size limit");
			bytes = await handle.readFile();
		} finally {
			await handle.close();
		}
	} else {
		bytes = Buffer.from(input.text ?? "", "utf8");
		if (bytes.length > MAX_INLINE_BYTES) throw new Error("inline artifact exceeds the size limit");
	}
	if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error("artifact is empty or exceeds the size limit");
	const decoded = textBytes(bytes, input.mimeType);
	if (input.previousId) {
		const previous = await readJson<NetaArtifact>(metadataPath(input.actor.workspaceId, input.previousId));
		if (!previous || previous.machineId !== input.actor.machineId || previous.producerActorId !== input.actor.actorId)
			throw new Error("previous artifact is not in this workspace copy");
	}
	const id = ulid();
	const dir = artifactDir(input.actor.workspaceId);
	await ensureDir(dir);
	const target = dataPath(input.actor.workspaceId, id);
	const handle = await open(target, "wx", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.chmod(0o600);
		await handle.sync();
	} finally {
		await handle.close();
	}
	const metadata: NetaArtifact = {
		id,
		workspaceId: input.actor.workspaceId,
		machineId: input.actor.machineId,
		...(input.actor.missionId ? { missionId: input.actor.missionId } : {}),
		producerActorId: input.actor.actorId,
		producerKind: input.actor.kind,
		title: artifactTitle,
		mimeType: input.mimeType,
		audience: input.audience,
		size: bytes.length,
		hash: createHash("sha256").update(bytes).digest("hex"),
		preview: decoded.slice(0, 512),
		createdAt: new Date().toISOString(),
		...(input.previousId ? { previousId: input.previousId } : {}),
	};
	try {
		await writeJsonAtomic(metadataPath(input.actor.workspaceId, id), metadata);
	} catch (error) {
		await rm(target, { force: true });
		throw error;
	}
	return metadata;
}

export async function inspectArtifact(
	actor: ArtifactActor,
	id: string,
	openRange?: { offset: number; limit: number },
): Promise<{
	artifact: NetaArtifact;
	text?: string;
	nextOffset?: number;
}> {
	const artifact = await readJson<NetaArtifact>(metadataPath(actor.workspaceId, id));
	if (!artifact || artifact.machineId !== actor.machineId)
		throw new Error("artifact is unavailable in this workspace copy");
	const sameMission = actor.missionId !== undefined && actor.missionId === artifact.missionId;
	const allowed =
		actor.actorId === artifact.producerActorId ||
		(actor.kind === "lead" && sameMission) ||
		(actor.kind === "leader" && (artifact.producerKind === "lead" || artifact.audience !== "parent")) ||
		(actor.kind === "neta" && (artifact.audience === "neta" || artifact.audience === "user"));
	if (!allowed) throw new Error("artifact audience does not include this actor");
	if (!openRange) return { artifact };
	if (
		!Number.isSafeInteger(openRange.offset) ||
		openRange.offset < 0 ||
		!Number.isSafeInteger(openRange.limit) ||
		openRange.limit < 1 ||
		openRange.limit > MAX_OPEN_BYTES
	)
		throw new Error("invalid artifact range");
	const handle = await open(dataPath(actor.workspaceId, id), constants.O_RDONLY | constants.O_NOFOLLOW);
	let bytes: Buffer;
	try {
		const file = await handle.stat();
		if (!file.isFile() || file.size !== artifact.size || file.size > MAX_FILE_BYTES)
			throw new Error("artifact bytes are missing or changed");
		bytes = await handle.readFile();
	} finally {
		await handle.close();
	}
	if (bytes.length !== artifact.size || createHash("sha256").update(bytes).digest("hex") !== artifact.hash)
		throw new Error("artifact bytes are missing or changed");
	const start = Math.min(bytes.length, openRange.offset);
	const end = Math.min(bytes.length, start + openRange.limit);
	const text = bytes.toString("utf8", start, end);
	return {
		artifact,
		text,
		...(end < bytes.length ? { nextOffset: end } : {}),
	};
}
