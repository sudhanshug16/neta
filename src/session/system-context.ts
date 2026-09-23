import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../store/files.ts";
import { netaDir } from "../store/paths.ts";

export interface SystemContextBundle {
	version: 1;
	actorId: string;
	sessionId: string;
	generation: string;
	role: "leader" | "lead" | "agent" | "orchestrator" | "curator";
	revision: string;
	hash: string;
	text: string;
}

export interface AppliedSystemContext {
	version: 1;
	actorId: string;
	sessionId: string;
	generation: string;
	revision: string;
	hash: string;
	hook: "context" | "compaction" | "generate";
}

export function systemContextPath(sessionId: string): string {
	return join(netaDir(), "system-context", `${encodeURIComponent(sessionId)}.txt`);
}

export async function writeSystemContext(input: {
	sessionId: string;
	actorId: string;
	bindingGeneration: string;
	role: SystemContextBundle["role"];
	text: string;
}): Promise<SystemContextBundle> {
	if (!input.sessionId || !input.actorId || !input.bindingGeneration || !input.text)
		throw new Error("Cannot publish Neta instructions without a current actor, binding, and context");
	const hash = createHash("sha256").update(input.text).digest("hex");
	const bundle: SystemContextBundle = {
		version: 1,
		actorId: input.actorId,
		sessionId: input.sessionId,
		generation: input.bindingGeneration,
		role: input.role,
		revision: hash,
		hash,
		text: input.text,
	};
	await writeJsonAtomic(systemContextPath(input.sessionId), bundle);
	return bundle;
}

/** A matching receipt proves local request construction, never provider admission. */
export async function readAppliedSystemContext(
	sessionId: string,
	bindingGeneration: string,
): Promise<AppliedSystemContext | undefined> {
	const file = systemContextPath(sessionId);
	const [bundle, applied] = await Promise.all([
		readJson<unknown>(file).catch(() => undefined),
		readJson<unknown>(`${file}.applied.json`).catch(() => undefined),
	]);
	if (!bundle || typeof bundle !== "object" || !applied || typeof applied !== "object") return undefined;
	const context = bundle as Record<string, unknown>;
	const receipt = applied as Record<string, unknown>;
	if (
		receipt.version !== 1 ||
		context.version !== 1 ||
		receipt.sessionId !== sessionId ||
		context.sessionId !== sessionId ||
		receipt.generation !== bindingGeneration ||
		context.generation !== bindingGeneration ||
		typeof receipt.actorId !== "string" ||
		!receipt.actorId ||
		receipt.actorId !== context.actorId ||
		typeof receipt.revision !== "string" ||
		!receipt.revision ||
		receipt.revision !== context.revision ||
		typeof receipt.hash !== "string" ||
		!/^[a-f0-9]{64}$/.test(receipt.hash) ||
		receipt.hash !== context.hash ||
		typeof context.text !== "string" ||
		createHash("sha256").update(context.text).digest("hex") !== receipt.hash ||
		(receipt.hook !== "context" && receipt.hook !== "compaction" && receipt.hook !== "generate")
	)
		return undefined;
	return {
		version: 1,
		actorId: receipt.actorId,
		sessionId,
		generation: bindingGeneration,
		revision: receipt.revision,
		hash: receipt.hash,
		hook: receipt.hook,
	};
}
