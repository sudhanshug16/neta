import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { ulid } from "../core/ids.ts";
import { recordTerminalTelemetry } from "../diagnostics/telemetry.ts";
import { openCodeExecutionContract } from "../opencode/contract.ts";
import { readAppliedSystemContext } from "../session/system-context.ts";
import {
	asNumber,
	asOptionalBoolean,
	asOptionalNumber,
	asOptionalString,
	asString,
	parseParams,
} from "./handlers-registry.ts";
import { netaDir } from "./lockfile.ts";
import { NodeError } from "./protocol.ts";
import type { NodeHandlers } from "./server.ts";

const DIAGNOSTICS_CHUNK_BYTES = 256 * 1024;
const DIAGNOSTICS_FILES_PAGE_SIZE = 100;
const exports = new Map<
	string,
	{
		token: string;
		path: string;
		files: Map<string, { path: string; bytes: number }>;
		dataFiles: ExportFile[];
	}
>();
const TELEMETRY_EVENTS = new Set([
	"terminal.attach",
	"terminal.detach",
	"terminal.resize",
	"terminal.input",
	"terminal.output",
	"terminal.start",
	"terminal.exit",
	"terminal.error",
	"renderer.feed",
	"renderer.resize",
	"renderer.error",
]);
const TELEMETRY_KEYS = new Set(["event", "sessionId", "missionId", "generation", "seq", "cols", "rows", "byteCount"]);

interface ExportFile {
	fileId: string;
	path: string;
	bytes: number;
	sha256: string;
}
interface ExportError {
	path: string;
	error: string;
}

interface ManifestFile {
	fileId: string;
	bytes: number;
	sha256: string;
}

function inside(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

async function copyCut(source: string, destination: string): Promise<Omit<ExportFile, "fileId">> {
	const before = await stat(source);
	const input = await open(source, "r");
	try {
		await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
		const output = await open(destination, "w", 0o600);
		const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, before.size)));
		const hash = createHash("sha256");
		let offset = 0;
		try {
			while (offset < before.size) {
				const wanted = Math.min(buffer.length, before.size - offset);
				const read = await input.read(buffer, 0, wanted, offset);
				if (read.bytesRead === 0) break;
				const chunk = buffer.subarray(0, read.bytesRead);
				await output.write(chunk, 0, chunk.length, offset);
				hash.update(chunk);
				offset += read.bytesRead;
			}
		} finally {
			await output.close();
		}
		return {
			path: destination,
			bytes: offset,
			sha256: hash.digest("hex"),
		};
	} finally {
		await input.close();
	}
}

async function filesBelow(root: string): Promise<string[]> {
	const found: string[] = [];
	async function visit(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			const info = await lstat(path);
			if (info.isSymbolicLink()) continue;
			if (info.isDirectory()) await visit(path);
			else if (info.isFile()) found.push(path);
		}
	}
	try {
		if ((await lstat(root)).isSymbolicLink()) return found;
		await visit(root);
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") throw error;
	}
	return found;
}

const roots = [
	"machine.json",
	"workspaces",
	"leaders",
	"agents.json",
	"missions",
	"events",
	"conversations",
	"glance",
	"worktrees",
	"charters",
	"pi",
	"runtime",
];

function checkedExport(exportId: string, cleanupToken: string) {
	const prepared = exports.get(exportId);
	if (prepared === undefined) throw new NodeError("NOT_FOUND", "diagnostic export is unavailable");
	const expected = Buffer.from(prepared.token);
	const actual = Buffer.from(cleanupToken);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
		throw new NodeError("UNAUTHORIZED", "wrong cleanup token");
	return prepared;
}

export async function prepareDiagnosticsFromDisk(input: {
	root: string;
	localMachineId?: string;
	registeredMachineIds?: string[];
	liveSnapshot: boolean;
}): Promise<{
	exportId: string;
	cleanupToken: string;
	path: string;
	manifest: Record<string, unknown>;
	manifestFile: ManifestFile;
	fileCount: number;
}> {
	const { root } = input;
	const exportId = ulid();
	const token = randomBytes(32).toString("hex");
	const staging = join(root, "diagnostics", exportId);
	await mkdir(join(root, "diagnostics"), { recursive: true, mode: 0o700 });
	await mkdir(staging, { recursive: false, mode: 0o700 });
	const copiedFiles: Array<Omit<ExportFile, "fileId">> = [];
	const errors: ExportError[] = [];
	for (const named of roots) {
		const source = join(root, named);
		const candidates = (await lstat(source).catch(() => undefined))?.isFile() ? [source] : await filesBelow(source);
		for (const candidate of candidates) {
			if (!inside(root, candidate)) continue;
			const rel = relative(root, candidate);
			if (
				rel.startsWith(`diagnostics${sep}`) ||
				basename(candidate) === "node.json" ||
				basename(candidate) === "node.lock"
			)
				continue;
			try {
				const copied = await copyCut(candidate, join(staging, "data", rel));
				copiedFiles.push({ ...copied, path: join("data", rel) });
			} catch (error) {
				errors.push({ path: rel, error: String(error) });
			}
		}
	}
	const files = copiedFiles
		.sort((a, b) => a.path.localeCompare(b.path))
		.map((file, index) => ({ ...file, fileId: `file-${index + 1}` }));
	const ids = new Set(input.registeredMachineIds ?? []);
	if (input.localMachineId !== undefined) ids.add(input.localMachineId);
	const manifest = {
		schemaVersion: 1,
		capturedAt: new Date().toISOString(),
		sensitivity: "fullConversation",
		liveSnapshot: input.liveSnapshot,
		disclosure:
			"Contains complete conversation and tool output, including private text and file paths. External attachment targets are not followed.",
		machines: [...ids].sort().map((id) =>
			id === input.localMachineId && input.liveSnapshot
				? { id, availability: "available" }
				: {
						id,
						availability: "unavailable",
						reason: input.liveSnapshot
							? "no local node or heartbeat registered"
							: "offline export has no live availability data",
					},
		),
		files,
		errors,
		exclusions: [
			"node.json and node.lock",
			"node.sock",
			"settings.json provider launch configuration",
			"pi-config credential and settings store",
			"provider credential stores",
			"process environment and argv",
			"external attachment targets",
		],
		redactions: [
			"No transcript prose was altered; credential stores and runtime authentication material were excluded.",
		],
	};
	const manifestPath = join(staging, "manifest.json");
	const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
	const manifestFile = {
		fileId: "manifest",
		bytes: manifestBytes.byteLength,
		sha256: createHash("sha256").update(manifestBytes).digest("hex"),
	};
	await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
	exports.set(exportId, {
		token,
		path: staging,
		files: new Map([
			...files.map((file) => [file.fileId, { path: join(staging, file.path), bytes: file.bytes }] as const),
			[manifestFile.fileId, { path: manifestPath, bytes: manifestFile.bytes }] as const,
		]),
		dataFiles: files,
	});
	return { exportId, cleanupToken: token, path: staging, manifest, manifestFile, fileCount: files.length };
}

export const diagnosticsHandlers: NodeHandlers = {
	"diagnostics.runtime": async (ctx, params) => {
		const { sessionId } = parseParams({ sessionId: asString }, params);
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))
			throw new NodeError("INVALID_PARAMS", "diagnostics.runtime requires a valid sessionId");
		const agent = ctx.store.listAgents().find((item) => item.sessionId === sessionId);
		const leader =
			agent === undefined ? ctx.store.listLeaders().find((item) => item.sessionId === sessionId) : undefined;
		if (!agent && !leader) throw new NodeError("NOT_FOUND", "This session has no current actor");
		const [runtime, inbox] = await Promise.all([
			ctx.runtime.runtimeDiagnostics?.(sessionId).catch(() => undefined),
			ctx.runtime.listInbox?.(sessionId).catch(() => undefined),
		]);
		const generation = runtime?.bindingGeneration ?? agent?.bindingGeneration;
		const applied = generation === undefined ? undefined : await readAppliedSystemContext(sessionId, generation);
		const counts = inbox?.reduce(
			(count, item) => {
				if (item.status === "queued" || item.status === "delivering" || item.status === "uncertain")
					count[item.status]++;
				return count;
			},
			{ queued: 0, delivering: 0, uncertain: 0 },
		);
		let contract: ReturnType<typeof openCodeExecutionContract>;
		try {
			contract = openCodeExecutionContract(runtime?.contract);
		} catch {
			/* Unverified declarations are unknown. */
		}
		// This surface returns identifiers only, never free-form tasks, failures, endpoints or environment.
		const identifier = (value: string | undefined, limit = 256): string | null =>
			value &&
			value.length <= limit &&
			/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value) &&
			!/^(?:sk[-_]|ghp_|github_pat_|xox[baprs]-|AIza)/.test(value)
				? value
				: null;
		const alternatives = agent?.fallbackModels;
		const fallbackModels = alternatives
			?.slice(0, 16)
			.map((model) => identifier(model))
			.filter((model): model is string => model !== null);
		return {
			version: 1,
			runtimeInstance: identifier(ctx.runtimeAdmission?.instanceId, 128),
			actorId: identifier(agent?.id ?? leader?.sessionId, 128),
			sessionId,
			missionId: identifier(agent?.missionId, 128),
			role: agent ? (agent.canSpawn ? "missionLeader" : "worker") : "workspaceLeader",
			state: agent?.state ?? leader?.state,
			runtimeState:
				runtime?.attached === false
					? "unattached"
					: runtime?.attached === true
						? ctx.runtime.isTurnActive?.(sessionId)
							? "running"
							: "idle"
						: "unknown",
			turnId: identifier(runtime?.turnId ?? agent?.currentTurnId, 128),
			bindingGeneration: identifier(generation, 128),
			provider: identifier(runtime?.provider ?? agent?.provider ?? leader?.provider),
			requestedModel: identifier(agent?.requestedModel),
			actualModel: identifier(runtime?.model ?? agent?.model ?? leader?.model),
			fallbackModels: fallbackModels ?? null,
			fallbackModelsOmitted: alternatives === undefined ? false : alternatives.length !== fallbackModels?.length,
			deliveryHealth: {
				inbox: counts ?? null,
				parentReport: agent?.deliveryStatus ?? "unknown",
			},
			instructions: applied
				? { revision: identifier(applied.revision, 128), hash: applied.hash, hook: applied.hook }
				: null,
			instructionStatus: applied ? "locally-applied" : "unverified",
			contract: contract ?? null,
		};
	},
	"diagnostics.record": async (_ctx, params) => {
		if (
			typeof params !== "object" ||
			params === null ||
			Array.isArray(params) ||
			Object.keys(params).some((key) => !TELEMETRY_KEYS.has(key))
		)
			throw new NodeError("INVALID_PARAMS", "diagnostic record has unknown fields");
		const p = parseParams(
			{
				event: asString,
				sessionId: asOptionalString,
				missionId: asOptionalString,
				generation: asOptionalString,
				seq: asOptionalNumber,
				cols: asOptionalNumber,
				rows: asOptionalNumber,
				byteCount: asOptionalNumber,
			},
			params,
		);
		if (!TELEMETRY_EVENTS.has(p.event)) throw new NodeError("INVALID_PARAMS", "invalid diagnostic event");
		for (const value of [p.sessionId, p.missionId, p.generation])
			if (value !== undefined && (value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)))
				throw new NodeError("INVALID_PARAMS", "diagnostic identifiers are invalid");
		for (const value of [p.seq, p.cols, p.rows, p.byteCount])
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
				throw new NodeError("INVALID_PARAMS", "diagnostic numbers are non-negative integers");
		const root = netaDir();
		recordTerminalTelemetry(root, p.event, p);
		return { recorded: true };
	},
	"diagnostics.prepare": async (ctx, params) => {
		const p = parseParams({ compact: asOptionalBoolean }, params);
		await ctx.store.compact();
		const local = ctx.store.machine();
		const machineIds = new Set<string>([local.id]);
		for (const workspace of ctx.store.listWorkspaces())
			for (const rootEntry of workspace.roots) machineIds.add(rootEntry.machineId);
		const prepared = await prepareDiagnosticsFromDisk({
			root: netaDir(),
			localMachineId: local.id,
			registeredMachineIds: [...machineIds],
			liveSnapshot: true,
		});
		if (p.compact) {
			return {
				exportId: prepared.exportId,
				cleanupToken: prepared.cleanupToken,
				manifestFile: prepared.manifestFile,
				fileCount: prepared.fileCount,
			};
		}
		return {
			exportId: prepared.exportId,
			cleanupToken: prepared.cleanupToken,
			path: prepared.path,
			manifest: prepared.manifest,
		};
	},
	"diagnostics.read": async (_ctx, params) => {
		const p = parseParams({ exportId: asString, cleanupToken: asString, fileId: asString, offset: asNumber }, params);
		const offset = p.offset;
		if (!Number.isSafeInteger(offset) || offset < 0)
			throw new NodeError("INVALID_PARAMS", "offset is a non-negative safe integer");
		const prepared = checkedExport(p.exportId, p.cleanupToken);
		const file = prepared.files.get(p.fileId);
		if (file === undefined) throw new NodeError("NOT_FOUND", "diagnostic export file is unavailable");
		if (offset > file.bytes) throw new NodeError("INVALID_PARAMS", "offset exceeds diagnostic export file size");
		let input: FileHandle | undefined;
		try {
			input = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
			const info = await input.stat();
			if (!info.isFile() || info.size !== file.bytes)
				throw new NodeError("INTERNAL", "diagnostic export file changed after preparation");
			const size = Math.min(DIAGNOSTICS_CHUNK_BYTES, file.bytes - offset);
			const buffer = Buffer.alloc(size);
			let bytesRead = 0;
			while (bytesRead < size) {
				const read = await input.read(buffer, bytesRead, size - bytesRead, offset + bytesRead);
				if (read.bytesRead === 0) throw new NodeError("INTERNAL", "diagnostic export file changed while reading");
				bytesRead += read.bytesRead;
			}
			const nextOffset = offset + bytesRead;
			return { dataBase64: buffer.toString("base64"), nextOffset, eof: nextOffset === file.bytes };
		} catch (error) {
			if (error instanceof NodeError) throw error;
			throw new NodeError("INTERNAL", "diagnostic export file is unavailable");
		} finally {
			await input?.close();
		}
	},
	"diagnostics.files": async (_ctx, params) => {
		const p = parseParams({ exportId: asString, cleanupToken: asString, offset: asNumber }, params);
		if (!Number.isSafeInteger(p.offset) || p.offset < 0)
			throw new NodeError("INVALID_PARAMS", "offset is a non-negative safe integer");
		const prepared = checkedExport(p.exportId, p.cleanupToken);
		if (p.offset > prepared.dataFiles.length)
			throw new NodeError("INVALID_PARAMS", "offset exceeds diagnostic export file count");
		const nextOffset = Math.min(p.offset + DIAGNOSTICS_FILES_PAGE_SIZE, prepared.dataFiles.length);
		return {
			files: prepared.dataFiles.slice(p.offset, nextOffset),
			nextOffset,
			eof: nextOffset === prepared.dataFiles.length,
		};
	},
	"diagnostics.cleanup": async (_ctx, params) => {
		const p = parseParams({ exportId: asString, cleanupToken: asString }, params);
		const prepared = checkedExport(p.exportId, p.cleanupToken);
		if (!inside(join(netaDir(), "diagnostics"), prepared.path))
			throw new NodeError("INTERNAL", "invalid diagnostic export path");
		await rm(prepared.path, { recursive: true, force: true });
		exports.delete(p.exportId);
		return { cleaned: true };
	},
};
