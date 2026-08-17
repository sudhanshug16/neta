#!/usr/bin/env node

/**
 * The `neta` command.
 *
 * One binary, four callers:
 *
 * - a person runs `neta` to start a leader session, or `neta workers` to look
 *   in on one from another terminal;
 * - the leader's vendor CLI runs `neta mcp`, the control plane that owns the
 *   workers;
 * - a worker's backend runs `neta mcp --worker`, and the worker itself runs
 *   `neta progress|ask|say|room|status --writers` from its shell;
 * - Claude Code runs `neta guard` as a hook before every bash command.
 *
 * Worker and leader subcommands are dispatched first and gated on being in a
 * real session, so those words stay ordinary arguments everywhere else.
 */

import { attachWorker } from "./attach.ts";
import { handleWorkerChannelCommand } from "./channel/client.ts";
import { handleLeaderChannelCommand, LEADER_COMMANDS } from "./channel/leader-cli.ts";
import { NETA_WORKER_ENV } from "./channel/protocol.ts";
import { APP_NAME, VERSION } from "./config.ts";
import { detectLeaderBackends } from "./detect.ts";
import { runGuard } from "./guard.ts";
import { LaunchError, launchLeader } from "./launch.ts";
import { runControlPlane, runWorkerBridge } from "./mcp/run.ts";
import { listBackendModels } from "./models.ts";
import { listSessions } from "./session.ts";
import { isWorkerId, watchRoom, watchWorker } from "./watch.ts";
import { watchRoomTui, watchWorkerTui } from "./watch-tui.ts";

const HELP = `${APP_NAME} ${VERSION} — a leader agent that delegates to worker agents.

  ${APP_NAME} [--leader <claude|codex|opencode>] [--mux <zellij|tmux|none>] [-- <args>]
      Start a leader session in that agent's own UI. Arguments after -- are
      passed through to it.

  ${APP_NAME} spawn --role <role> --tier <tier> [flags] <task>
                                        Start a worker (spawn --help for the flags).
  ${APP_NAME} workers                   List this session's workers and what they cost.
  ${APP_NAME} status                    Show the writer slot, worker states and open notes.
  ${APP_NAME} wait <id> [<id>...]       Block until the listed workers finish.
  ${APP_NAME} send <id> <message>       Send a follow-up instruction to a running worker.
  ${APP_NAME} answer <id> <text>        Answer a worker's pending question.
  ${APP_NAME} watch <id|room>           Watch a worker and type to it, or follow a
                                        room's merged transcript (--plain for bare log lines).
  ${APP_NAME} log <id>                  Drain a worker's new log lines. This moves the
                                        leader's read cursor; to look in on a worker
                                        without stealing lines, use watch.
  ${APP_NAME} attach <id>               Open a worker in its own CLI (Claude Code,
                                        Codex) to read it there and take over.
  ${APP_NAME} kill <id>                 Stop a worker.
  ${APP_NAME} sessions                  List running leader sessions.
  ${APP_NAME} models [backend]          Show the models a worker backend offers,
                                        for setting tiers in settings.json.
  ${APP_NAME} --backends                Show the agent CLIs found on PATH.

Worker commands (inside a worker): progress, ask, say, room, status --writers.
Plumbing: ${APP_NAME} mcp [--worker], ${APP_NAME} guard.
`;

function listBackends(): void {
	const detected = detectLeaderBackends();
	if (detected.length === 0) {
		console.log("No agent CLIs found on PATH. Install one of: claude, codex, opencode.");
		return;
	}
	for (const backend of detected) console.log(`${backend.id}\t${backend.name}\t${backend.path}`);
}

function printSessions(): void {
	const sessions = listSessions();
	if (sessions.length === 0) {
		console.log("No leader sessions are running.");
		return;
	}
	for (const session of sessions) {
		console.log(`${session.id}\t${session.leader}\tpid ${session.pid}\t${session.cwd}`);
	}
}

function flagValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

async function main(argv: string[]): Promise<void> {
	// Everything after `--` belongs to the vendor CLI, not to us.
	const separator = argv.indexOf("--");
	const args = separator === -1 ? argv : argv.slice(0, separator);
	const passthrough = separator === -1 ? [] : argv.slice(separator + 1);
	const command = args[0];

	if (await handleWorkerChannelCommand(args)) return;
	if (command && LEADER_COMMANDS.has(command) && process.env[NETA_WORKER_ENV]) {
		console.error(
			`Workers cannot run leader command \`${command}\`. Use worker channel commands: progress, ask, say, room, status --writers.`,
		);
		process.exitCode = 1;
		return;
	}
	if (await handleLeaderChannelCommand(args)) return;

	switch (command) {
		case "mcp":
			if (args.includes("--worker")) await runWorkerBridge();
			else await runControlPlane();
			return;
		case "guard":
			await runGuard();
			return;
		case "watch": {
			const targetId = args[1];
			if (!targetId) {
				console.error(`Usage: ${APP_NAME} watch <worker-id|room> [--session <id>] [--dir <neta-dir>] [--plain]`);
				process.exitCode = 1;
				return;
			}
			const sessionId = flagValue(args, "--session");
			// Worker tabs are started by the multiplexer's own server process,
			// which does not have our environment, so they say where to look.
			const agentDir = flagValue(args, "--dir");
			// The interactive view needs a real terminal on both ends; piped
			// output gets the plain line renderer, as does --plain by request.
			const interactive = !args.includes("--plain") && process.stdin.isTTY === true && process.stdout.isTTY === true;
			if (isWorkerId(targetId)) {
				process.exitCode = interactive
					? await watchWorkerTui({ workerId: targetId, sessionId, agentDir })
					: await watchWorker({ workerId: targetId, sessionId, agentDir });
			} else {
				process.exitCode = interactive
					? await watchRoomTui({ room: targetId, sessionId, agentDir })
					: await watchRoom({ room: targetId, sessionId, agentDir });
			}
			return;
		}
		case "attach": {
			const workerId = args[1];
			if (!workerId) {
				console.error(`Usage: ${APP_NAME} attach <worker-id> [--session <id>] [--dir <neta-dir>] [--print]`);
				process.exitCode = 1;
				return;
			}
			process.exitCode = await attachWorker({
				workerId,
				sessionId: flagValue(args, "--session"),
				agentDir: flagValue(args, "--dir"),
				dryRun: args.includes("--print"),
			});
			return;
		}
		case "sessions":
			printSessions();
			return;
		case "models":
			process.exitCode = await listBackendModels(args[1], process.cwd());
			return;
		case "--backends":
			listBackends();
			return;
		case "--version":
		case "-v":
			console.log(VERSION);
			return;
		case "--help":
		case "-h":
			console.log(HELP);
			return;
	}

	if (command && LEADER_COMMANDS.has(command)) {
		// The word was a leader command, but nothing is running to receive it.
		console.error(`No Neta session found here. Start one with \`${APP_NAME}\`, or name one with --session <id>.`);
		process.exitCode = 1;
		return;
	}

	if (command?.startsWith("-") && command !== "--leader" && command !== "--mux") {
		console.error(`Unknown option "${command}".\n\n${HELP}`);
		process.exitCode = 1;
		return;
	}
	if (command && !command.startsWith("-")) {
		console.error(`Unknown command "${command}".\n\n${HELP}`);
		process.exitCode = 1;
		return;
	}

	try {
		process.exitCode = await launchLeader({
			cwd: process.cwd(),
			leader: flagValue(args, "--leader"),
			mux: flagValue(args, "--mux"),
			extraArgs: passthrough,
		});
	} catch (error) {
		if (!(error instanceof LaunchError)) throw error;
		console.error(error.message);
		process.exitCode = 1;
	}
}

await main(process.argv.slice(2));
