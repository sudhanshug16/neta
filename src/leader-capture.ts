/**
 * `neta capture-leader-session` — the far end of a vendor's session-start hook.
 *
 * Codex assigns its own conversation id, so the only way to reopen exactly that
 * conversation later is to be told what it was. Codex tells its SessionStart
 * hook, as JSON on stdin, and this command writes the id where the control
 * plane and `neta resume` can find it.
 *
 * It is deliberately forgiving about everything except the id: a hook that
 * fails noisily inside someone's editor is worse than a session that turns out
 * not to be resumable, and resume refuses loudly on its own when the id is
 * missing.
 */

import { recordLeaderVendorConversationId, writeVendorSessionCapture } from "./checkpoint.ts";
import { getAgentDir } from "./config.ts";

/**
 * The id shapes vendors actually assign: a UUID from Codex, a prefixed
 * identifier from OpenCode. Matching them exactly is what keeps a selector word
 * like "latest" or an empty string from being stored as a conversation id.
 */
const CONVERSATION_ID = [
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
	/^ses_[A-Za-z0-9]{16,}$/,
];

export interface CaptureOptions {
	checkpointId: string;
	agentDir?: string;
	payload: string;
	write?: (line: string) => void;
}

/** Returns the id it recorded, or undefined when the payload carried none. */
export function captureLeaderSession(options: CaptureOptions): string | undefined {
	const agentDir = options.agentDir ?? getAgentDir();
	const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
	let parsed: unknown;
	try {
		parsed = JSON.parse(options.payload);
	} catch {
		write(`neta: session-start hook payload was not JSON; ${options.checkpointId} has no conversation id yet.`);
		return undefined;
	}
	const payload = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
	const event = payload.hook_event_name;
	if (typeof event === "string" && event !== "SessionStart") return undefined;
	const sessionId = payload.session_id;
	if (typeof sessionId !== "string" || !CONVERSATION_ID.some((shape) => shape.test(sessionId))) {
		write(`neta: session-start hook reported no usable conversation id for ${options.checkpointId}.`);
		return undefined;
	}

	// The sidecar is what the running control plane adopts; the checkpoint write
	// is what makes the id durable even if the control plane never starts.
	try {
		writeVendorSessionCapture(options.checkpointId, agentDir, sessionId);
	} catch (error) {
		write(
			`neta: could not record the leader conversation id: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		recordLeaderVendorConversationId(options.checkpointId, agentDir, sessionId);
	} catch (error) {
		// A differing nonempty id is a visible resume-integrity failure, not a
		// harmless duplicate capture. The checkpoint writer uses the same invariant.
		write(
			`neta: could not persist leader conversation id: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return sessionId;
}

/** Read the hook payload from stdin, bounded so a hook never hangs a session. */
export async function readHookPayload(stream: NodeJS.ReadStream = process.stdin, timeoutMs = 5000): Promise<string> {
	if (stream.isTTY) return "";
	return new Promise<string>((resolve) => {
		let payload = "";
		const done = (value: string) => {
			clearTimeout(timer);
			stream.removeAllListeners("data");
			resolve(value);
		};
		const timer = setTimeout(() => done(payload), timeoutMs);
		timer.unref?.();
		stream.setEncoding("utf-8");
		stream.on("data", (chunk: string) => {
			payload += chunk;
		});
		stream.once("end", () => done(payload));
		stream.once("error", () => done(payload));
	});
}
