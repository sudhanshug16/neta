/**
 * `neta attach <worker>` — open a worker in its own CLI.
 *
 * A worker driven over ACP is not a special kind of session. Claude Code files
 * it in `~/.claude/projects`, Codex in `~/.codex/sessions` and OpenCode in its
 * own session store, under the very id the ACP handshake hands back. So the
 * whole conversation a worker had is sitting in that CLI's own history, and the
 * backend's own resume command — `claude --resume <id>`, `codex resume <id>`,
 * `opencode --session <id>` — opens it in the interface you already know, where
 * you can read it properly and keep talking to it yourself.
 *
 * Neta keeps driving the worker while it runs, so attaching to one that is
 * still working means two clients on one conversation. That is the user's call
 * to make, with a warning, rather than ours to forbid.
 */

import { spawn } from "node:child_process";
import { sendChannelRequest } from "./channel/client.ts";
import { APP_NAME } from "./config.ts";
import type { ProcessSpec } from "./mux/types.ts";
import { loadConfig, type NetaConfig } from "./settings.ts";
import { isTerminalState, type WorkerLogPage, type WorkerSummary } from "./types.ts";
import { resolveTarget } from "./watch.ts";

/** The one exact-session resume resolver shared by CLI attach and pane reopen. */
export function workerResumeCommand(config: NetaConfig, worker: WorkerSummary): ProcessSpec {
	if (!worker.vendorSessionId) {
		throw new Error(`${worker.id} has not opened a backend session yet; it cannot be attached.`);
	}
	const resume = config.resumeCommand(worker.backend, worker.vendorSessionId);
	if (!resume) {
		throw new Error(
			`Backend "${worker.backend}" has no resume command configured. ` +
				`Its session id is ${worker.vendorSessionId}; set backends.${worker.backend}.resume in settings.`,
		);
	}
	return resume;
}

export interface AttachOptions {
	workerId: string;
	sessionId?: string;
	cwd?: string;
	agentDir?: string;
	/** Print the command instead of running it. */
	dryRun?: boolean;
	write?: (line: string) => void;
}

export async function attachWorker(options: AttachOptions): Promise<number> {
	const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const cwd = options.cwd ?? process.cwd();
	const target = resolveTarget(options.sessionId, cwd, options.agentDir);
	if (!target) {
		write("No Neta session found. Start one with `neta`, or pass --session <id>.");
		return 1;
	}

	const response = await sendChannelRequest(target.address, {
		type: "tail",
		token: target.token,
		workerId: options.workerId,
		since: Number.MAX_SAFE_INTEGER,
	});
	if (!response.ok) {
		write(response.error);
		return 1;
	}
	const worker = (response.data as WorkerLogPage | undefined)?.worker;
	if (!worker) {
		write(`No worker ${options.workerId} in this session.`);
		return 1;
	}
	let resume: ProcessSpec;
	try {
		resume = workerResumeCommand(loadConfig(cwd, options.agentDir), worker);
	} catch (error) {
		write(error instanceof Error ? error.message : String(error));
		return 1;
	}

	if (!isTerminalState(worker.state)) {
		write(`${worker.id} is still ${worker.state}; Neta is driving it, so your turns and its turns will interleave.`);
	}
	if (options.dryRun) {
		write([resume.command, ...resume.args].join(" "));
		return 0;
	}

	write(`${APP_NAME}: opening ${worker.id} "${worker.name}" in ${worker.backend}…`);
	return new Promise<number>((resolve) => {
		const child = spawn(resume.command, resume.args, { cwd, stdio: "inherit" });
		child.on("error", (error) => {
			write(`Could not start ${resume.command}: ${error.message}`);
			resolve(1);
		});
		child.on("close", (status, signal) => resolve(signal ? 1 : (status ?? 0)));
	});
}
