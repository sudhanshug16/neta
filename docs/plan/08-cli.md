# 08 — CLI

`src/cli/` is the `neta` command: a thin client of the Node over
`~/.neta/node.sock`. It owns no sessions, no store, no ACP; every command is a
protocol call from `04-node.md` plus formatting. The terminal chat opens the
same exact ACP session the desktop shows (manifesto Principle 6); both may be
attached at once, each seeing the other's turns.

Read first: `docs/plan/README.md` (Architecture, Protocol summary, Task format),
`docs/plan/01-domain.md` (Types), `docs/plan/04-node.md` (requests,
notifications, errors), `MANIFESTO.md` section Lead and Lead++.

## Shape

`src/cli/main.ts` (parsing, dispatch, exit codes, `version`), `client.ts`
(transport, on-demand start), `chat.ts` (the terminal chat), and one module per
command group under `commands/`: `node`, `missions`, `events`, `leader`, `mcp`.

## Command surface

| Command | Effect |
|---|---|
| `neta` | open the workspace for the cwd if needed, attach to its leader's conversation |
| `neta node start [--detach]` | run the Node; `--detach` returns once it is live |
| `neta node stop` | the only thing that stops a Node |
| `neta node status [--json]` | report without starting anything |
| `neta open [path]` | open the workspace, print its record, do not attach |
| `neta missions [--all\|--since <dur>] [--json]` | open missions; `--all` includes closed |
| `neta mission <number> [--json]` | one mission: record, agents, recent events |
| `neta events [--follow] [--since <dur>] [--json]` | workspace event log |
| `neta mode [lead\|lead++] [--mission <n>]` | read or set leader mode |
| `neta models [--json]` | providers and their models from settings |
| `neta model <id>` | set the model of the attached conversation |
| `neta mcp --actor <id> --token <t>` | stdio MCP server for one ACP session |
| `neta version` | the version from `package.json`, the one place |

`<dur>` is `<n>[mhdw]`, e.g. `90m`, `3d`. `--json` is accepted only where the
table lists it and prints one JSON value on stdout, newline-terminated;
`events --follow --json` prints NDJSON. Everything else is plain text, no colors
off a TTY, no header rows, no spinners; errors go to stderr as `neta: <msg>`.

`neta` and `neta open` start the Node on demand when `node.json` is absent or
its pid is dead; the lock in 04 makes the race safe. No other command starts it,
and `neta node status` never does — it exits 0 either way. Exit codes: `0` ok;
`1` usage — unknown command or flag, bad argument, unknown mission number, any
other protocol error; `2` node unreachable — no socket, connect failed, start
timed out; `3` refused — `data.code` is `UNAUTHORIZED` or `CONFIRMATION_REQUIRED`.

## Tasks

### T8.1 entry, parsing, exit codes
Goal: `neta` parses a command line into a dispatch record and exits with the
documented codes.
Reads: this file, `docs/plan/README.md`.
Writes: `src/cli/main.ts`, `test/cli-args.test.ts`, `package.json` (bin `neta`
→ `dist/main.js`, build entry `src/cli/main.ts`).
Contract: `export type Command = { name: "attach" | "node" | "open" |
"missions" | "mission" | "events" | "mode" | "models" | "model" | "mcp" |
"version"; sub?: string; args: string[]; flags: Record<string, string | true> }`;
`export function parse(argv: string[]): Command | { usage: string }`;
`export function readVersion(): string`, which walks up from `import.meta.url`
to the first `package.json` whose `name` is `@intervene/neta`; `export async function
main(argv: string[]): Promise<number>` returns the exit code and never calls
`process.exit` itself.
Steps: 1. parse; an unknown command or flag, a missing argument, and `--json`
where the table forbids it all return `{ usage }`. 2. dispatch through a handler
table; a usage result prints the command table on stderr and returns 1.
Tests: `test/cli-args.test.ts` — every row of the command table parses to the
expected `Command`; `--since 3d` accepted and `--since 3x` rejected; unknown
command and stray flag return usage; `readVersion()` equals the version in
`package.json`; `main(["version"])` returns 0 and prints only the version.
Done when: `bun run check`, `bun test` and the tests above pass; commit made.
Commit: `feat(cli): command parsing and exit codes`

### T8.2 node client
Goal: one connection to the Node, on-demand start, error mapping.
Reads: this file, `docs/plan/04-node.md`.
Writes: `src/cli/client.ts`, `test/cli-client.test.ts`,
`test/helpers/cli-harness.ts`.
Contract: `export class NodeClient` with `static async connect(opts?: {start?:
boolean}): Promise<NodeClient>`, `request<T>(method: string, params?: object):
Promise<T>`, `on(kind: "event" | "state" | "turn" | "node", fn: (p: unknown) =>
void): () => void`, `close(): void`; `export class CliError extends Error {
code: 1 | 2 | 3 }`. It wraps `connectNode` from `src/node/client.ts` (T4.4),
which owns the transport, the `hello` handshake and autostart; this module adds
the CLI's error-to-exit-code mapping and the harness, nothing else. `connect`
reads `$NETA_DIR/node.json` (default `~/.neta`) and checks the pid is alive;
with `start: true` it spawns `node <bundle> node start --detach` and retries
every 100 ms for up to 5 s. A version mismatch is `CliError(2)` "node speaks
protocol N, this CLI speaks M". Errors map per the exit codes above.
`test/helpers/cli-harness.ts` exports `startNode(): Promise<Harness>` =
`{dir, run(args): Promise<{code, stdout, stderr}>, spawn(args), stop()}`; `dir`
is a temp `NETA_DIR` whose `settings.json` has one provider running
`test/fixtures/fake-acp-agent.mjs`, and `run` executes the bundle with `node`,
built once per test file.
Steps: 1. transport, pending-request map, notification fan-out. 2. `connect`,
start-on-demand, error mapping. 3. the harness.
Tests: `test/cli-client.test.ts` — round-trip `hello` against a running Node;
no `node.json` with `start: false` throws `CliError` code 2; `start: true`
starts a reachable Node; an error with `data.code: "UNAUTHORIZED"` maps to code 3;
a malformed NDJSON line is ignored without killing the connection.
Done when: `bun run check`, `bun test` and the tests above pass; commit made.
Commit: `feat(cli): node client transport`

### T8.3 node lifecycle and open
Goal: `neta node start|stop|status` and `neta open`.
Reads: this file, `docs/plan/04-node.md`.
Writes: `src/cli/commands/node.ts`, `test/cli-node.test.ts`.
Contract: `export async function nodeCommand(sub: string, flags):
Promise<number>` and `export async function openCommand(path?: string):
Promise<number>`. `node start` runs the Node in the foreground, log on stderr;
`--detach` spawns it detached with stdio ignored, waits for `node.json` to name
a live pid, and prints `started  pid <pid>  <socket>`. `node stop` sends
`node.stop`, waits up to 10 s for the pid to disappear, prints `stopped`; with
no Node it prints `not running`, exit 0. `node status` prints `not running` or
`running  pid <pid>  socket <path>  protocol <n>  uptime 2h07m`, and with
`--json` `{"running":bool,"pid":number|null,"socket":string|null,
"protocol":number|null,"startedAt":string|null}`. `open` resolves its argument
(default cwd) to an absolute path, sends `workspace.open`, prints
`<workspaceId>  <name>  <root>`, and refuses `~` and `/` with exit 1.
Steps: 1. status and stop from `node.json`. 2. foreground and detached start.
3. `open` with path resolution and the two refusals.
Tests: `test/cli-node.test.ts` — `node status` on an empty `NETA_DIR` prints
`not running`, exit 0; after `node start --detach` it reports the live pid and
`--json` parses to the shape above; `open` prints the same workspace id twice
for one directory; `open ~` exits 1; `node stop` prints `stopped` and a second
`node stop` prints `not running`, both exit 0.
Done when: `bun run check`, `bun test` and the tests above pass; commit made.
Commit: `feat(cli): node lifecycle commands`

### T8.4 terminal chat
Goal: `neta` attaches to the workspace leader's conversation.
Reads: this file, `docs/plan/01-domain.md` (Block, Turn), `docs/plan/04-node.md`
(`conversation.tail`, `conversation.prompt`, `conversation.cancel`, `turn`).
Writes: `src/cli/chat.ts`, `test/cli-chat.test.ts`.
Contract: `export async function attach(client: NodeClient, path: string):
Promise<number>` and `export function renderBlock(b: Block, tty: boolean):
string | null`. Flow: `workspace.open` → `conversation.tail` for the last 20
blocks through the same renderer → read a line from stdin → `conversation.prompt`
→ stream `turn` notifications until the turn ends. Line-based, never a TUI:
- `text`: written verbatim as it arrives, no prefix;
- `thought`: dim, one line truncated to the terminal width, rewritten in place
  with `\r` and cleared when thinking ends; skipped when stdout is not a TTY;
- `tool` and `diff`: one dim line each, `· <text>`, never re-rendered;
- `status`: one dim line, `— <text>`;
- a `user` block from a turn this process did not start: one dim `> <text>`.
The prompt is `<workspace name> <lead|lead++>> `, printed only when stdin is a
TTY, its mode half updated from `state` notifications; a turn ends with one
blank line. The first `SIGINT` during a streaming turn sends
`conversation.cancel` and prints `^C cancelled`; `SIGINT` with no turn streaming
closes the client and returns 0.
Steps: 1. renderer. 2. tail then follow. 3. line reader and prompt. 4. signals.
Tests: `test/cli-chat.test.ts` — `renderBlock` for each `BlockKind` in TTY and
non-TTY mode; a spawned `neta` with piped stdin prompts the fake agent and its
reply appears on stdout; a second client on the same session sees the first
client's user block; `SIGINT` mid-turn prints `^C cancelled` and the process
stays alive, a second `SIGINT` exits 0.
Done when: `bun run check`, `bun test` and the tests above pass; commit made.
Commit: `feat(cli): terminal chat`

### T8.5 missions
Goal: `neta missions` and `neta mission <number>`.
Reads: this file, `docs/plan/01-domain.md` (Mission, Agent),
`docs/plan/04-node.md` (`missions.list`, `missions.get`).
Writes: `src/cli/commands/missions.ts`, `test/cli-missions.test.ts`.
Contract: `export async function missionsCommand(client, flags)` and
`export async function missionCommand(client, number: number, flags)`.
`missions` lists open missions newest first, one line each, columns two spaces
apart: `#<number>` right in 5, state left in 15, name left in 32 (truncated with
`…`), `<n> agents` left in 9, relative age (`3h ago`), then `— <attention>` when
set; the line is cut to the terminal width, 100 off a TTY. `--all` adds closed
missions, `--since <dur>` filters on `createdAt`, an empty result prints
`no missions`, `--json` prints the protocol's `Mission[]` unchanged. `mission
<n>` prints labelled lines: `Mission <n> · <name>`, then `State`, `Access`,
`Lead` (`leader` or `agent <name>`), `Worktree` (`<path>  <branch> off <base>`,
omitted when absent), `Objective`, `Changes`, `Agents` (name in 12, state in 12,
access in 10, `<provider>/<model>`, task) and `Events` (the last 10 in T8.6's
format); `--json` prints `{"mission":Mission,"agents":Agent[],"events":Event[]}`.
An unknown number prints `neta: no mission #<n> in this workspace`, exit 1.
Steps: 1. width-aware column formatter. 2. list. 3. detail. 4. `--json` paths.
Tests: `test/cli-missions.test.ts`, against a Node driven by the fake agent —
`missions --json` parses to an array whose first element has `number`, `state`
and `name`; text output truncates a long name to 32 columns and shows
`attention`; `--all` includes a closed mission plain `missions` omits;
`mission 1` prints the objective and its agents; `mission 99` exits 1.
Done when: `bun run check`, `bun test` and the tests above pass; commit made.
Commit: `feat(cli): missions commands`

### T8.6 events
Goal: `neta events`, including `--follow`.
Reads: this file, `docs/plan/01-domain.md` (Event, EventKind),
`docs/plan/04-node.md` (`events.list`, `event` notification).
Writes: `src/cli/commands/events.ts`, `test/cli-events.test.ts`.
Contract: `export async function eventsCommand(client, flags)` and
`export function formatEvent(e: Event): string` =
`<at>  <seq right 6>  <kind left 20>  <#number or - left 5>  <summary>`, where
`<summary>` is `data.name ?? data.text ?? data.reason ?? ""` and the line is cut
to the terminal width. The default window is the last 24 hours, overridden by
`--since <dur>`. `--follow` prints the window, then every `event` notification
for this workspace as it arrives, flushing each line, until `SIGINT`, which
exits 0. `--json` prints an `Event[]`; `--follow --json` prints one per line.
Steps: 1. formatter. 2. windowed list. 3. follow, with clean shutdown.
Tests: `test/cli-events.test.ts` — `formatEvent` for `mission.created`,
`leader.modeChanged` and an event with empty `data`; `events --json` returns
events in ascending `seq`; a spawned `events --follow` prints a
`mission.created` line within 5 s of a mission being created through the fake
agent and exits 0 on `SIGINT`; `--since 1m` excludes an older event.
Done when: `bun run check`, `bun test` and the tests above pass; commit made.
Commit: `feat(cli): events command`

### T8.7 mode and models
Goal: `neta mode`, `neta models`, `neta model <id>`.
Reads: this file, `docs/plan/07-modes.md`, `docs/plan/04-node.md`
(`leader.setMode`, `models.list`, `conversation.setModel`), `MANIFESTO.md`
section Lead and Lead++.
Writes: `src/cli/commands/leader.ts`, `test/cli-leader.test.ts`.
Contract: `export async function modeCommand(client, arg, flags)`,
`export async function modelsCommand(client, flags)`,
`export async function modelCommand(client, id: string)`. `neta mode` with no
argument prints `lead` or `lead++  12m active`. `neta mode lead` sets the
workspace leader to `lead` and prints `mode lead`. `neta mode lead++` sends
`leader.setMode` with `mode: "leadPlus"` and prints `mode lead++`: it is 07's
manual path, the person's own choice, and takes no decision record — a record
belongs to the leader's own `neta_mode` requests, never to a client.
`--mission <n>` targets that mission's lead instead of the workspace leader.
`neta models` prints one line per model — provider left in 12, model id left in
28, then `default` or `forbidden` or nothing — and with `--json`
`{"provider":string,"model":string,"default":boolean,"forbidden":boolean}[]`.
`neta model <id>` takes `provider/model` or a bare id unique across providers,
sends `conversation.setModel` for the leader's session and prints `model
<provider>/<model>`; an ambiguous or unknown id exits 1, a forbidden one 3.
Steps: 1. mode read, set and refusal. 2. models listing. 3. model id resolution.
Tests: `test/cli-leader.test.ts` — `mode` prints `lead` on a fresh leader;
`mode lead++` exits 0 and a following `mode` prints `lead++` with its active
time; `mode lead` exits 0 and a following `mode` reflects it; `models --json` lists the fake
provider with one `default: true`; `model nope` exits 1; a forbidden model, 3.
Done when: `bun run check`, `bun test` and the tests above pass; commit made.
Commit: `feat(cli): mode and model commands`

### T8.8 mcp route and settings documentation
Goal: `neta mcp` reaches the tool proxy, and `docs/settings.md` describes the v3
settings file.
Reads: this file, `docs/plan/05-tools.md` (stdio proxy), `docs/plan/03-acp.md`
(settings shape), the current `docs/settings.md`, which is replaced wholesale.
Writes: `src/cli/commands/mcp.ts`, `test/cli-mcp.test.ts`, `docs/settings.md`.
Contract: `export async function mcpCommand(flags): Promise<number>` requires
`--actor <id>` and `--token <t>` — missing either is exit 1 — and calls
`runProxy({actorId, token, socketPath})` from `src/tools/proxy.ts`, adding
nothing:
no parsing of MCP traffic, no writing to stdout, which is the proxy's.
`docs/settings.md` is rewritten with exactly these sections: locations
(`$NETA_DIR/settings.json`, default `~/.neta`, then `<root>/.neta/settings.json`
deep-merged with project keys winning; a malformed file is ignored, never
fatal), the example below, one table per key, Environment (`NETA_DIR`, plus
`NETA_SOCKET` on every Neta-launched ACP process, the actor id and token
travelling in `neta mcp`'s argv, never the environment), and a closing note that authority lives in `CHARTER.md`, not here.
```json
{
  "providers": {
    "claude": { "command": "npx",
                "args": ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"],
                "defaultModel": "sonnet", "env": {} }
  },
  "leader": { "provider": "claude", "model": "sonnet" },
  "forbiddenModels": ["claude-fable-5"]
}
```
`providers` maps a name to 03's `ProviderSettings` — `{command, args, env,
readOnlyArgs, readWriteArgs, resume, defaultModel, disabled}`; `leader` names
the provider and model of every workspace leader; each `forbiddenModels` entry
is a model id matched exactly (03), rejected wherever it is requested. Skills
and charters are not configured here: 05 resolves them from `.neta/skills/` and
`CHARTER.md` under the workspace root, then under `~/.neta/`. Nothing about
tiers, backends, roles, flavors or multiplexers survives from v2.
Steps: 1. the route. 2. the rewrite, from scratch.
Tests: `test/cli-mcp.test.ts` — `neta mcp` without `--actor` exits 1 and prints
usage; with both flags and a running Node it answers an MCP `initialize` on
stdin and writes nothing to stdout that is not MCP framing; a bad token exits 3.
Done when: `bun run check`, `bun test` and the tests above pass; commit made.
Commit: `feat(cli): mcp route and v3 settings docs`
