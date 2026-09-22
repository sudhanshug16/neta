import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, InboxMessage, Workspace } from "../src/core/types.ts";
import { systemContextPath, writeSystemContext } from "../src/acp/system-context.ts";
import { RuntimeAdmission } from "../src/node/runtime-admission.ts";
import { diagnosticsHandlers, prepareDiagnosticsFromDisk } from "../src/node/handlers-diagnostics.ts";
import type { NodeContext } from "../src/node/server.ts";

const dirs: string[] = [];
const priorNetaDir = process.env.NETA_DIR;
afterEach(async () => {
	if (priorNetaDir === undefined) delete process.env.NETA_DIR;
	else process.env.NETA_DIR = priorNetaDir;
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function context(workspaces: Workspace[]): NodeContext {
	return {
		store: {
			machine: () => ({ id: "local", name: "Local" }),
			listWorkspaces: () => workspaces,
			listLeaders: () => [],
			listMissions: () => [],
			listAgents: () => [],
			compact: () => Promise.resolve(),
		} as unknown as NodeContext["store"],
	} as NodeContext;
}

test("export captures local state and full transcripts but excludes auth and symlinks", async () => {
	const root = mkdtempSync(join(tmpdir(), "neta-diagnostics-"));
	dirs.push(root);
	process.env.NETA_DIR = root;
	await Promise.all([
		mkdir(join(root, "workspaces")),
		mkdir(join(root, "conversations")),
		mkdir(join(root, "pi", "pi-session"), { recursive: true }),
		mkdir(join(root, "pi-config")),
	]);
	await writeFile(join(root, "machine.json"), JSON.stringify({ id: "local", name: "Local" }));
	await writeFile(join(root, "workspaces", "one.json"), "workspace-one");
	await writeFile(join(root, "workspaces", "two.json"), "workspace-two");
	await writeFile(join(root, "conversations", "acp.ndjson"), "FULL ACP CONVERSATION\n");
	await writeFile(join(root, "pi", "pi-session", "session.jsonl"), "FULL PI CONVERSATION\n");
	await writeFile(join(root, "pi-config", "auth.json"), "SECRET");
	await writeFile(join(root, "outside"), "OUTSIDE");
	await symlink(join(root, "outside"), join(root, "conversations", "linked"));
	const workspaces = [
		{ id: "w1", name: "One", kind: "folder", roots: [{ machineId: "local", path: "/one" }] },
		{ id: "w2", name: "Two", kind: "folder", roots: [{ machineId: "remote", path: "/two" }] },
	] as Workspace[];
	const prepared = (await diagnosticsHandlers["diagnostics.prepare"](context(workspaces), {}, {} as never)) as {
		exportId: string;
		cleanupToken: string;
		path: string;
		manifest: {
			machines: Array<{ id: string; availability: string; reason?: string }>;
			files: Array<{ path: string }>;
		};
	};
	expect(prepared.manifest.machines).toContainEqual({
		id: "remote",
		availability: "unavailable",
		reason: "no local node or heartbeat registered",
	});
	expect(await readFile(join(prepared.path, "data", "conversations", "acp.ndjson"), "utf8")).toContain("FULL ACP");
	expect(await readFile(join(prepared.path, "data", "pi", "pi-session", "session.jsonl"), "utf8")).toContain(
		"FULL PI",
	);
	expect(prepared.manifest.files.some((file) => file.path.includes("auth.json") || file.path.endsWith("linked"))).toBe(
		false,
	);
	await diagnosticsHandlers["diagnostics.cleanup"](
		context(workspaces),
		{ exportId: prepared.exportId, cleanupToken: prepared.cleanupToken },
		{} as never,
	);
	await expect(readFile(join(prepared.path, "manifest.json"))).rejects.toThrow();
});

test("terminal telemetry rotates and rejects payload fields", async () => {
	const root = mkdtempSync(join(tmpdir(), "neta-diagnostics-"));
	dirs.push(root);
	process.env.NETA_DIR = root;
	await mkdir(join(root, "runtime"));
	await writeFile(join(root, "runtime", "terminal.ndjson"), Buffer.alloc(2 * 1024 * 1024));
	const handler = diagnosticsHandlers["diagnostics.record"];
	await handler(context([]), { event: "terminal.input", sessionId: "s", byteCount: 4 }, {} as never);
	expect((await readFile(join(root, "runtime", "terminal.ndjson.1"))).byteLength).toBe(2 * 1024 * 1024);
	await expect(handler(context([]), { event: "terminal.input", payload: "secret" }, {} as never)).rejects.toThrow(
		"unknown fields",
	);
	await expect(
		handler(context([]), { event: "terminal.input", sessionId: "x".repeat(129) }, {} as never),
	).rejects.toThrow("identifiers are invalid");
});

test("offline collector works without a running Node and reports availability unknown", async () => {
	const root = mkdtempSync(join(tmpdir(), "neta-diagnostics-"));
	dirs.push(root);
	await mkdir(join(root, "conversations"));
	await writeFile(join(root, "conversations", "crash.ndjson"), "LAST TURN BEFORE CRASH\n");
	const prepared = await prepareDiagnosticsFromDisk({
		root,
		localMachineId: "local",
		registeredMachineIds: ["local", "remote"],
		liveSnapshot: false,
	});
	expect(await readFile(join(prepared.path, "data", "conversations", "crash.ndjson"), "utf8")).toContain("LAST TURN");
	const manifest = prepared.manifest as { liveSnapshot: boolean; machines: Array<{ availability: string }> };
	expect(manifest.liveSnapshot).toBe(false);
	expect(manifest.machines.every((machine) => machine.availability === "unavailable")).toBe(true);
});

test("an allowlisted root symlink is never traversed", async () => {
	const root = mkdtempSync(join(tmpdir(), "neta-diagnostics-"));
	dirs.push(root);
	const outside = mkdtempSync(join(tmpdir(), "neta-diagnostics-outside-"));
	dirs.push(outside);
	await writeFile(join(outside, "secret.ndjson"), "SECRET OUTSIDE ROOT");
	await symlink(outside, join(root, "conversations"));
	const prepared = await prepareDiagnosticsFromDisk({ root, liveSnapshot: false });
	const manifest = prepared.manifest as { files: Array<{ path: string }> };
	expect(manifest.files.some((file) => file.path.includes("secret.ndjson"))).toBe(false);
});

test("prepared diagnostics stream only immutable allowlisted chunks", async () => {
	const root = mkdtempSync(join(tmpdir(), "neta-diagnostics-"));
	dirs.push(root);
	process.env.NETA_DIR = root;
	const source = join(root, "conversations", "full.ndjson");
	const original = Buffer.concat([Buffer.alloc(256 * 1024, 0x61), Buffer.from("\ncomplete transcript\n")]);
	await mkdir(join(root, "conversations"));
	await writeFile(source, original);
	const prepared = await prepareDiagnosticsFromDisk({ root, liveSnapshot: false });
	const preparedFiles = (
		prepared.manifest as unknown as { files: Array<{ fileId: string; path: string; bytes: number; sha256: string }> }
	).files;
	const file = preparedFiles.find((entry) => entry.path === "data/conversations/full.ndjson");
	expect(file).toBeDefined();
	await writeFile(source, "changed after prepare");
	let offset = 0;
	const chunks: Buffer[] = [];
	for (;;) {
		const page = (await diagnosticsHandlers["diagnostics.read"](
			context([]),
			{ exportId: prepared.exportId, cleanupToken: prepared.cleanupToken, fileId: file!.fileId, offset },
			{} as never,
		)) as { dataBase64: string; nextOffset: number; eof: boolean };
		chunks.push(Buffer.from(page.dataBase64, "base64"));
		expect(page.nextOffset).toBeGreaterThanOrEqual(offset);
		offset = page.nextOffset;
		if (page.eof) break;
	}
	const received = Buffer.concat(chunks);
	expect(received).toEqual(original);
	expect(createHash("sha256").update(received).digest("hex")).toBe(file!.sha256);

	const empty = join(root, "conversations", "empty.ndjson");
	await writeFile(empty, "");
	const emptyPrepared = await prepareDiagnosticsFromDisk({ root, liveSnapshot: false });
	const emptyFiles = (emptyPrepared.manifest as unknown as { files: typeof preparedFiles }).files;
	const emptyFile = emptyFiles.find((entry) => entry.path === "data/conversations/empty.ndjson");
	const eof = (await diagnosticsHandlers["diagnostics.read"](
		context([]),
		{
			exportId: emptyPrepared.exportId,
			cleanupToken: emptyPrepared.cleanupToken,
			fileId: emptyFile!.fileId,
			offset: 0,
		},
		{} as never,
	)) as { dataBase64: string; nextOffset: number; eof: boolean };
	expect(eof).toEqual({ dataBase64: "", nextOffset: 0, eof: true });

	await expect(
		diagnosticsHandlers["diagnostics.read"](
			context([]),
			{ exportId: prepared.exportId, cleanupToken: "wrong", fileId: file!.fileId, offset: 0 },
			{} as never,
		),
	).rejects.toThrow("wrong cleanup token");
	await expect(
		diagnosticsHandlers["diagnostics.read"](
			context([]),
			{ exportId: prepared.exportId, cleanupToken: prepared.cleanupToken, fileId: "../settings.json", offset: 0 },
			{} as never,
		),
	).rejects.toThrow("file is unavailable");
	await expect(
		diagnosticsHandlers["diagnostics.read"](
			context([]),
			{ exportId: prepared.exportId, cleanupToken: prepared.cleanupToken, fileId: file!.fileId, offset: -1 },
			{} as never,
		),
	).rejects.toThrow("offset");
	await expect(
		diagnosticsHandlers["diagnostics.read"](
			context([]),
			{ exportId: prepared.exportId, cleanupToken: prepared.cleanupToken, fileId: file!.fileId, offset: "0" },
			{} as never,
		),
	).rejects.toThrow("offset");
	await expect(
		diagnosticsHandlers["diagnostics.read"](
			context([]),
			{ exportId: prepared.exportId, cleanupToken: prepared.cleanupToken, fileId: file!.fileId },
			{} as never,
		),
	).rejects.toThrow("offset");
	await diagnosticsHandlers["diagnostics.cleanup"](
		context([]),
		{ exportId: prepared.exportId, cleanupToken: prepared.cleanupToken },
		{} as never,
	);
	await expect(
		diagnosticsHandlers["diagnostics.read"](
			context([]),
			{ exportId: prepared.exportId, cleanupToken: prepared.cleanupToken, fileId: file!.fileId, offset: 0 },
			{} as never,
		),
	).rejects.toThrow("export is unavailable");

	const replacement = join(root, "replacement");
	await writeFile(replacement, "not a prepared file");
	await rm(join(emptyPrepared.path, "data", "conversations", "empty.ndjson"));
	await symlink(replacement, join(emptyPrepared.path, "data", "conversations", "empty.ndjson"));
	await expect(
		diagnosticsHandlers["diagnostics.read"](
			context([]),
			{
				exportId: emptyPrepared.exportId,
				cleanupToken: emptyPrepared.cleanupToken,
				fileId: emptyFile!.fileId,
				offset: 0,
			},
			{} as never,
		),
	).rejects.toThrow("file is unavailable");
	await diagnosticsHandlers["diagnostics.cleanup"](
		context([]),
		{ exportId: emptyPrepared.exportId, cleanupToken: emptyPrepared.cleanupToken },
		{} as never,
	);
});

test("compact preparation pages file metadata and streams its manifest", async () => {
	const root = mkdtempSync(join(tmpdir(), "neta-diagnostics-"));
	dirs.push(root);
	process.env.NETA_DIR = root;
	await mkdir(join(root, "conversations"));
	for (let index = 0; index < 101; index += 1) {
		await writeFile(join(root, "conversations", `entry-${String(index).padStart(3, "0")}.ndjson`), `turn ${index}\n`);
	}
	const compact = (await diagnosticsHandlers["diagnostics.prepare"](context([]), { compact: true }, {} as never)) as {
		exportId: string;
		cleanupToken: string;
		manifestFile: { fileId: string; bytes: number; sha256: string };
		fileCount: number;
	};
	expect(compact.fileCount).toBe(101);
	expect("manifest" in compact).toBe(false);
	expect("path" in compact).toBe(false);
	let offset = 0;
	const files: Array<{ fileId: string; path: string; bytes: number; sha256: string }> = [];
	for (;;) {
		const page = (await diagnosticsHandlers["diagnostics.files"](
			context([]),
			{ exportId: compact.exportId, cleanupToken: compact.cleanupToken, offset },
			{} as never,
		)) as { files: typeof files; nextOffset: number; eof: boolean };
		files.push(...page.files);
		if (page.eof) break;
		offset = page.nextOffset;
	}
	expect(files).toHaveLength(101);
	expect(files[0]?.path).toBe("data/conversations/entry-000.ndjson");
	expect(files[100]?.path).toBe("data/conversations/entry-100.ndjson");
	let manifestOffset = 0;
	const manifestChunks: Buffer[] = [];
	for (;;) {
		const page = (await diagnosticsHandlers["diagnostics.read"](
			context([]),
			{
				exportId: compact.exportId,
				cleanupToken: compact.cleanupToken,
				fileId: compact.manifestFile.fileId,
				offset: manifestOffset,
			},
			{} as never,
		)) as { dataBase64: string; nextOffset: number; eof: boolean };
		manifestChunks.push(Buffer.from(page.dataBase64, "base64"));
		if (page.eof) break;
		manifestOffset = page.nextOffset;
	}
	const manifestBytes = Buffer.concat(manifestChunks);
	expect(manifestBytes.byteLength).toBe(compact.manifestFile.bytes);
	expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(compact.manifestFile.sha256);
	expect((JSON.parse(manifestBytes.toString("utf8")) as { files: typeof files }).files).toEqual(files);
	await expect(
		diagnosticsHandlers["diagnostics.files"](
			context([]),
			{ exportId: compact.exportId, cleanupToken: compact.cleanupToken, offset: 102 },
			{} as never,
		),
	).rejects.toThrow("offset exceeds");
	await expect(
		diagnosticsHandlers["diagnostics.files"](
			context([]),
			{ exportId: compact.exportId, cleanupToken: "wrong", offset: 0 },
			{} as never,
		),
	).rejects.toThrow("wrong cleanup token");
	await diagnosticsHandlers["diagnostics.cleanup"](
		context([]),
		{ exportId: compact.exportId, cleanupToken: compact.cleanupToken },
		{} as never,
	);
	await expect(
		diagnosticsHandlers["diagnostics.files"](
			context([]),
			{ exportId: compact.exportId, cleanupToken: compact.cleanupToken, offset: 0 },
			{} as never,
		),
	).rejects.toThrow("export is unavailable");
});

test("runtime diagnostics expose bounded verified facts without instruction text, credentials or errors", async () => {
	const root = mkdtempSync(join(tmpdir(), "neta-runtime-diagnostics-"));
	dirs.push(root);
	process.env.NETA_DIR = root;
	const agent: Agent = {
		id: "agent",
		missionId: "mission",
		workspaceId: "workspace",
		name: "Worker",
		task: "PRIVATE TASK CONTENT",
		access: "readOnly",
		provider: "opencode",
		model: "provider/actual",
		requestedModel: "provider/requested",
		fallbackModels: Array.from({ length: 30 }, (_, index) => `provider/choice-${index}`),
		skills: [],
		sessionId: "session",
		canSpawn: false,
		state: "running",
		startedAt: "2026-09-14T00:00:00.000Z",
		currentTurnId: "turn",
		bindingGeneration: "generation",
		deliveryStatus: "failed",
		deliveryError: "Bearer PRIVATE-CREDENTIAL",
		outcome: "PRIVATE REPORT CONTENT",
	};
	const ctx = context([]);
	ctx.store.listAgents = () => [agent];
	ctx.runtimeAdmission = new RuntimeAdmission("runtime-instance");
	ctx.acp = {
		runtimeDiagnostics: async () => ({
			attached: true,
			bindingGeneration: "generation",
			turnId: "turn",
			model: "provider/actual",
			authorization: "Basic PRIVATE-CREDENTIAL",
		}),
		listInbox: async () =>
			["queued", "uncertain", "delivering", "delivered"].map(
				(status) => ({ status, text: "PRIVATE INBOX CONTENT" }) as InboxMessage,
			),
		isTurnActive: () => true,
	} as unknown as NodeContext["acp"];
	const bundle = await writeSystemContext({
		sessionId: "session",
		actorId: "agent",
		bindingGeneration: "generation",
		role: "agent",
		text: "PRIVATE SYSTEM INSTRUCTIONS",
	});
	const { text: _text, role: _role, ...receipt } = bundle;
	await writeFile(
		`${systemContextPath("session")}.applied.json`,
		JSON.stringify({ ...receipt, hook: "context", credentials: "PRIVATE CREDENTIALS" }),
	);
	const result = (await diagnosticsHandlers["diagnostics.runtime"](
		ctx,
		{ sessionId: "session" },
		{} as never,
	)) as Record<string, unknown>;
	expect(result).toMatchObject({
		runtimeInstance: "runtime-instance",
		actorId: "agent",
		sessionId: "session",
		turnId: "turn",
		bindingGeneration: "generation",
		requestedModel: "provider/requested",
		actualModel: "provider/actual",
		runtimeState: "running",
		deliveryHealth: { inbox: { queued: 1, delivering: 1, uncertain: 1 }, parentReport: "failed" },
		instructions: { revision: bundle.revision, hash: bundle.hash, hook: "context" },
		instructionStatus: "locally-applied",
		fallbackModelsOmitted: true,
		contract: null,
	});
	expect(result.fallbackModels).toHaveLength(16);
	const serialized = JSON.stringify(result);
	expect(serialized).not.toContain("PRIVATE");
	expect(serialized).not.toContain("Bearer");
	expect(Buffer.byteLength(serialized)).toBeLessThan(8192);
	const longRevision = "r".repeat(9000);
	await writeFile(systemContextPath("session"), JSON.stringify({ ...bundle, revision: longRevision }));
	await writeFile(
		`${systemContextPath("session")}.applied.json`,
		JSON.stringify({ ...receipt, revision: longRevision, hook: "context" }),
	);
	const bounded = (await diagnosticsHandlers["diagnostics.runtime"](
		ctx,
		{ sessionId: "session" },
		{} as never,
	)) as Record<string, unknown>;
	expect(bounded.instructions).toMatchObject({ revision: null, hash: bundle.hash });
	expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(8192);

	ctx.acp.runtimeDiagnostics = async () => ({ attached: false, bindingGeneration: "replacement" });
	const replacement = (await diagnosticsHandlers["diagnostics.runtime"](
		ctx,
		{ sessionId: "session" },
		{} as never,
	)) as Record<string, unknown>;
	expect(replacement.instructions).toBeNull();
	expect(replacement.instructionStatus).toBe("unverified");
	expect(replacement.runtimeState).toBe("unattached");
	ctx.acp.runtimeDiagnostics = async () => {
		throw new Error("Bearer PRIVATE-CREDENTIAL");
	};
	ctx.acp.listInbox = async () => {
		throw new Error("PRIVATE INBOX FAILURE");
	};
	agent.requestedModel = "sk-private-key";
	agent.fallbackModels = ["sk-private-key", "provider/valid"];
	const failed = (await diagnosticsHandlers["diagnostics.runtime"](
		ctx,
		{ sessionId: "session" },
		{} as never,
	)) as Record<string, unknown>;
	expect(failed.runtimeState).toBe("unknown");
	expect(failed.deliveryHealth).toEqual({ inbox: null, parentReport: "failed" });
	expect(failed.requestedModel).toBeNull();
	expect(failed.fallbackModels).toEqual(["provider/valid"]);
	expect(JSON.stringify(failed)).not.toContain("PRIVATE");
	expect(JSON.stringify(failed)).not.toContain("sk-private-key");
});

test("runtime diagnostics require one owned session and refuse invalid identifiers", async () => {
	const ctx = context([]);
	await expect(diagnosticsHandlers["diagnostics.runtime"](ctx, {}, {} as never)).rejects.toThrow("sessionId");
	await expect(
		diagnosticsHandlers["diagnostics.runtime"](ctx, { sessionId: "../settings.json" }, {} as never),
	).rejects.toThrow("sessionId");
	await expect(diagnosticsHandlers["diagnostics.runtime"](ctx, { sessionId: "missing" }, {} as never)).rejects.toThrow(
		"no current actor",
	);
});
