#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openCodeCommand } from "../opencode/launcher.ts";
import { rmuxCommand } from "../rmux/bridge.ts";
import { toadCommand } from "../toad/launcher.ts";
// The `neta` command entry: argument parsing, dispatch and exit codes (08).
// Every command is a thin client of the Node over its socket; this module owns
// the command line shape only. Later tasks fill in the handlers behind the
// dispatch table. Exit codes: 0 ok, 1 usage, 2 node unreachable, 3 refused.
import { netaVersion } from "../version.ts";
import { attach } from "./chat.ts";
import { CliError, NodeClient } from "./client.ts";
import { eventsCommand } from "./commands/events.ts";
import { modeCommand, modelCommand, modelsCommand } from "./commands/leader.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { missionCommand, missionsCommand } from "./commands/missions.ts";
import { nodeCommand, openCommand } from "./commands/node.ts";

export type Command = {
	name:
		| "attach"
		| "node"
		| "open"
		| "missions"
		| "mission"
		| "events"
		| "mode"
		| "models"
		| "model"
		| "mcp"
		| "rmux"
		| "tui"
		| "version";
	sub?: string;
	args: string[];
	flags: Record<string, string | true>;
};

type Usage = { usage: string };

const DUR_RE = /^[0-9]+[mhdw]$/;
const COUNT_RE = /^[1-9][0-9]*$/;

const COMMAND_TABLE = `usage: neta [command] [options]

  neta                                   attach to the workspace leader's conversation
  neta chat                              use the plain terminal conversation client
  neta node start [--detach]             run the Node
  neta node stop                         stop the Node
  neta node status [--json]              report Node status without starting anything
  neta open [path]                       open the workspace, print its record
  neta missions [--all | --since <dur>] [--json]
  neta mission <number> [--json]         one mission: record, agents, recent events
  neta events [--follow] [--since <dur>] [--json]
  neta mode [lead | lead++] [--mission <n>]
  neta models [--json]                   providers and their models
  neta model <id>                        set the model of the attached conversation
  neta mcp --actor <id> --token <t>      stdio MCP server for one ACP session
  neta tui [path] [--migrate] [--host id]  open native OpenCode chat and the Neta spine
  neta tui --legacy [--demo]              open the retired Toad client
  neta rmux                              open the Neta rmux terminal workspace
  neta version                            print the version from package.json

<dur> is <n>[mhdw], e.g. 90m, 3d. --json is accepted only where listed above.`;

type FlagSpec = {
	booleans: readonly string[];
	values: Readonly<Record<string, (value: string) => boolean>>;
};

function splitFlags(
	tokens: string[],
	spec: FlagSpec,
): { args: string[]; flags: Record<string, string | true> } | Usage {
	const args: string[] = [];
	const flags: Record<string, string | true> = {};
	const rest = [...tokens];
	while (rest.length > 0) {
		const token = rest.shift() as string;
		if (token === "--") {
			args.push(...rest);
			break;
		}
		if (!token.startsWith("-") || token === "-") {
			args.push(token);
			continue;
		}
		const body = token.startsWith("--") ? token.slice(2) : token.slice(1);
		const eq = body.indexOf("=");
		const key = eq < 0 ? body : body.slice(0, eq);
		const inline = eq < 0 ? undefined : body.slice(eq + 1);
		if (spec.booleans.includes(key)) {
			if (inline !== undefined) return { usage: `--${key} takes no value` };
			flags[key] = true;
			continue;
		}
		const validate = spec.values[key];
		if (validate === undefined) return { usage: `unknown flag: --${key}` };
		let value = inline;
		if (value === undefined) {
			const next = rest.shift();
			if (next === undefined || next.startsWith("-") || next.length === 0) {
				return { usage: `--${key} needs a value` };
			}
			value = next;
		}
		if (value.length === 0 || !validate(value)) return { usage: `bad value for --${key}: ${value}` };
		flags[key] = value;
	}
	return { args, flags };
}

function rejectExtra(args: string[]): Usage | null {
	if (args.length > 0) return { usage: `unexpected argument: ${args[0]}` };
	return null;
}

function parseNode(tokens: string[]): Command | Usage {
	const sub = tokens[0];
	if (sub === undefined) return { usage: "neta node needs start, stop or status" };
	if (sub !== "start" && sub !== "stop" && sub !== "status") return { usage: `unknown node command: ${sub}` };
	if (sub === "start") {
		const split = splitFlags(tokens.slice(1), { booleans: ["detach"], values: {} });
		if ("usage" in split) return split;
		const extra = rejectExtra(split.args);
		if (extra !== null) return extra;
		return { name: "node", sub, args: [], flags: split.flags };
	}
	if (sub === "stop") {
		if (tokens.length > 1) return { usage: "neta node stop takes no arguments" };
		return { name: "node", sub, args: [], flags: {} };
	}
	const split = splitFlags(tokens.slice(1), { booleans: ["json"], values: {} });
	if ("usage" in split) return split;
	const extra = rejectExtra(split.args);
	if (extra !== null) return extra;
	return { name: "node", sub, args: [], flags: split.flags };
}

function parseOpen(tokens: string[]): Command | Usage {
	const split = splitFlags(tokens, { booleans: [], values: {} });
	if ("usage" in split) return split;
	if (split.args.length > 1) return { usage: "neta open takes at most one path" };
	return { name: "open", args: split.args, flags: {} };
}

function parseTui(tokens: string[]): Command | Usage {
	const split = splitFlags(tokens, {
		booleans: ["legacy", "demo", "migrate"],
		values: { host: (value) => value.length > 0 },
	});
	if ("usage" in split) return split;
	if (split.args.length > 1) return { usage: "neta tui takes at most one workspace path" };
	if ((split.flags.legacy || split.flags.demo) && (split.flags.migrate || split.flags.host || split.args.length))
		return { usage: "legacy Toad mode does not support native migration or a workspace path" };
	return { name: "tui", ...split };
}

function parseMissions(tokens: string[]): Command | Usage {
	const split = splitFlags(tokens, {
		booleans: ["all", "json"],
		values: { since: (value) => DUR_RE.test(value) },
	});
	if ("usage" in split) return split;
	const extra = rejectExtra(split.args);
	if (extra !== null) return extra;
	if (split.flags.all === true && typeof split.flags.since === "string") {
		return { usage: "neta missions takes --all or --since, not both" };
	}
	return { name: "missions", args: [], flags: split.flags };
}

function parseMission(tokens: string[]): Command | Usage {
	const split = splitFlags(tokens, { booleans: ["json"], values: {} });
	if ("usage" in split) return split;
	if (split.args.length === 0) return { usage: "neta mission needs a number" };
	if (split.args.length > 1 || !COUNT_RE.test(split.args[0] as string)) {
		return { usage: `bad mission number: ${split.args[0] ?? ""}` };
	}
	return { name: "mission", args: [split.args[0] as string], flags: split.flags };
}

function parseEvents(tokens: string[]): Command | Usage {
	const split = splitFlags(tokens, {
		booleans: ["follow", "json"],
		values: { since: (value) => DUR_RE.test(value) },
	});
	if ("usage" in split) return split;
	const extra = rejectExtra(split.args);
	if (extra !== null) return extra;
	return { name: "events", args: [], flags: split.flags };
}

function parseMode(tokens: string[]): Command | Usage {
	const split = splitFlags(tokens, {
		booleans: [],
		values: { mission: (value) => COUNT_RE.test(value) },
	});
	if ("usage" in split) return split;
	if (split.args.length > 1) return { usage: "neta mode takes lead or lead++" };
	if (split.args.length === 1 && split.args[0] !== "lead" && split.args[0] !== "lead++") {
		return { usage: `bad mode: ${split.args[0]}` };
	}
	return { name: "mode", args: split.args, flags: split.flags };
}

function parseModels(tokens: string[]): Command | Usage {
	const split = splitFlags(tokens, { booleans: ["json"], values: {} });
	if ("usage" in split) return split;
	const extra = rejectExtra(split.args);
	if (extra !== null) return extra;
	return { name: "models", args: [], flags: split.flags };
}

function parseModel(tokens: string[]): Command | Usage {
	const split = splitFlags(tokens, { booleans: [], values: {} });
	if ("usage" in split) return split;
	if (split.args.length === 0) return { usage: "neta model needs an id" };
	if (split.args.length > 1 || (split.args[0] as string).length === 0) {
		return { usage: `bad model id: ${split.args[0] ?? ""}` };
	}
	return { name: "model", args: [split.args[0] as string], flags: {} };
}

function parseMcp(tokens: string[]): Command | Usage {
	const notEmpty = (value: string): boolean => value.length > 0;
	const split = splitFlags(tokens, { booleans: [], values: { actor: notEmpty, token: notEmpty } });
	if ("usage" in split) return split;
	const extra = rejectExtra(split.args);
	if (extra !== null) return extra;
	if (typeof split.flags.actor !== "string") return { usage: "neta mcp needs --actor <id>" };
	if (typeof split.flags.token !== "string") return { usage: "neta mcp needs --token <t>" };
	return { name: "mcp", args: [], flags: split.flags };
}

export function parse(argv: string[]): Command | Usage {
	const head = argv[0];
	if (head === undefined) return { name: "attach", args: [], flags: {} };
	const rest = argv.slice(1);
	switch (head) {
		case "node":
			return parseNode(rest);
		case "open":
			return parseOpen(rest);
		case "missions":
			return parseMissions(rest);
		case "mission":
			return parseMission(rest);
		case "events":
			return parseEvents(rest);
		case "mode":
			return parseMode(rest);
		case "models":
			return parseModels(rest);
		case "model":
			return parseModel(rest);
		case "mcp":
			return parseMcp(rest);
		case "tui":
			return parseTui(rest);
		case "chat":
			return rest.length
				? { usage: "neta chat takes no arguments" }
				: { name: "attach", args: [], flags: { legacy: true } };
		case "rmux":
			if (rest.length > 0) return { usage: "neta rmux takes no arguments" };
			return { name: "rmux", args: [], flags: {} };
		case "version":
		case "--version":
			if (rest.length > 0) return { usage: "neta version takes no arguments" };
			return { name: "version", args: [], flags: {} };
		default:
			return { usage: `unknown command: ${head}` };
	}
}

function printVersion(): number {
	process.stdout.write(`${netaVersion()}\n`);
	return 0;
}

async function attachCommand(): Promise<number> {
	let client: NodeClient;
	try {
		client = await NodeClient.connect({ start: true });
	} catch (error) {
		if (error instanceof CliError) {
			process.stderr.write(`neta: ${error.message}\n`);
			return error.code;
		}
		process.stderr.write(`neta: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	return attach(client, process.cwd());
}

async function withClient(fn: (client: NodeClient) => Promise<number>): Promise<number> {
	let client: NodeClient;
	try {
		client = await NodeClient.connect();
	} catch (error) {
		if (error instanceof CliError) {
			process.stderr.write(`neta: ${error.message}\n`);
			return error.code;
		}
		process.stderr.write(`neta: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	try {
		return await fn(client);
	} finally {
		client.close();
	}
}

const handlers: Record<Command["name"], (cmd: Command) => number | Promise<number>> = {
	attach: (cmd) =>
		process.stdin.isTTY && process.stdout.isTTY && cmd.flags.legacy !== true ? openCodeCommand() : attachCommand(),
	node: (cmd) => nodeCommand(cmd.sub ?? "", cmd.flags),
	open: (cmd) => openCommand(cmd.args[0]),
	missions: (cmd) => withClient((client) => missionsCommand(client, cmd.flags)),
	mission: (cmd) => withClient((client) => missionCommand(client, Number(cmd.args[0]), cmd.flags)),
	events: (cmd) => withClient((client) => eventsCommand(client, cmd.flags)),
	mode: (cmd) => withClient((client) => modeCommand(client, cmd.args[0], cmd.flags)),
	models: (cmd) => withClient((client) => modelsCommand(client, cmd.flags)),
	model: (cmd) => withClient((client) => modelCommand(client, cmd.args[0] as string)),
	mcp: (cmd) => mcpCommand(cmd.flags),
	rmux: rmuxCommand,
	tui: (cmd) =>
		cmd.flags.legacy === true || cmd.flags.demo === true
			? toadCommand(cmd.flags.demo === true)
			: openCodeCommand(
					cmd.args[0],
					cmd.flags.migrate === true,
					typeof cmd.flags.host === "string" ? cmd.flags.host : undefined,
				),
	version: printVersion,
};

export async function main(argv: string[]): Promise<number> {
	const parsed = parse(argv);
	if ("usage" in parsed) {
		process.stderr.write(`neta: ${parsed.usage}\n${COMMAND_TABLE}\n`);
		return 1;
	}
	return handlers[parsed.name](parsed);
}

// A Node bundle can have any filename. Compare the actual module with argv[1]
// instead of admitting a basename: an imported bundle must stay inert even if
// its importing runner happens to be named main.js. The compiled executable
// has no useful script path, so it remains identified by its executable name.
function isEntrypoint(): boolean {
	if (process.versions.bun !== undefined && import.meta.main) return true;
	const script = process.argv[1];
	if (script === undefined || script === "") return basename(process.execPath) === "neta";
	const modulePath = fileURLToPath(import.meta.url);
	try {
		return realpathSync(script) === realpathSync(modulePath);
	} catch {
		return resolve(script) === modulePath;
	}
}

if (isEntrypoint()) {
	void main(process.argv.slice(2)).then((code) => process.exit(code));
}
