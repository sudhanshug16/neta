# Neta

Neta is a leader agent. You talk to a leader; it delegates work to tiered
worker agents and drives them until the problem is done. The leader never
edits files — that restriction is enforced, not suggested.

Neta is not a TUI. You live in the native UI of the coding agent you already
use and pay for — Claude Code, Codex, or OpenCode:

```
neta
```

That detects the agent CLIs you have, launches one as the leader with Neta's
instructions and worker tools injected, and stays behind it. Workers appear as
panes you can read; the leader collects their results and reports once.

## What you get

- **A lead, not an implementer.** The leader reads, decides, delegates and
  verifies. Its edit tools are removed by the vendor's own permission system,
  and shell writes (`sed -i`, `echo > file`, `git commit`) are blocked by a
  hook — a leader with an edit tool eventually edits.
- **Workers on your subscription.** Every worker is a real agent CLI driven
  over ACP, so it runs on the login you already have rather than on API credit.
- **Tiers, not model names.** The leader asks for a junior, senior or staff
  worker; you decide which model each tier means.
- **One writer at a time.** Reads parallelize; writes serialize. A second
  writer is refused, not raced.
- **Panes you can enter.** With Zellij or tmux running, each worker gets a pane
  streaming its log. Watching one costs nothing and closing one breaks nothing.
- **Visible spend.** `neta workers` shows tokens and cost per worker.

## Install

```
npm install -g @intervene/neta
```

Neta needs Node 22.19+ and at least one agent CLI on PATH:

```
npm install -g @anthropic-ai/claude-code   # or
npm install -g @openai/codex               # or
npm install -g opencode-ai
```

Neta itself is a single bundled file with no runtime dependencies, so this
installs one thing, not a tree.

From a checkout instead — the toolchain is [Bun](https://bun.sh):

```
bun install
bun run build
bun link          # puts `neta` on PATH
```

## Using it

```
neta                       # start a leader session here
neta --leader codex        # pick the backend explicitly
neta --mux none            # no panes; workers run headless
neta -- --model opus       # pass arguments through to the agent CLI

neta workers               # what is running, and what it has cost
neta watch w1              # follow one worker's log
neta log w1                # its new lines since you last looked
neta kill w1               # stop it
neta sessions              # leader sessions running on this machine
```

Inside a session, the leader gets MCP tools: `neta_spawn`, `neta_spawn_group`,
`neta_workers`, `neta_log`, `neta_wait`, `neta_send`, `neta_answer`,
`neta_kill`, `neta_room`. Workers get `neta_notify`, `neta_ask`, `neta_say`,
`neta_room`, and the same commands as a CLI.

## Deciding what the leader may decide

Write a `CHARTER.md` in your project (see [CHARTER.example.md](CHARTER.example.md)).
It says which decisions the leader takes on your behalf and which ones stop and
ask. Without one, the leader decides routine technical matters and asks before
anything expensive, destructive, or outward-facing.

## Development

```
bun install
bun test          # 161 tests, including real worker processes over a real socket
bun run check     # biome + tsc --noEmit
bun run build     # dist/cli.js, one file, runs on Node
```

## Documentation

- [How it works](docs/how-it-works.md) — the process tree, the two doors, and
  why the control plane is an MCP server.
- [Settings](docs/settings.md) — tiers, backends, multiplexer, leader options.
- [MANIFESTO.md](MANIFESTO.md) — the design: tiers, roles, single writer, the
  charter.
- [PLAN.md](PLAN.md) — what is built and what is deliberately not.

## Status

Working end to end, and young. Every mechanism it relies on was verified
against the installed CLIs, and the test suite drives real worker processes
over a real socket with a fake agent — but it has not been through months of
daily use. Expect rough edges around vendor flags, which change often.
