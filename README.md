# Neta

[![ci](https://github.com/sudhanshug16/neta/actions/workflows/ci.yml/badge.svg)](https://github.com/sudhanshug16/neta/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@intervene/neta)](https://www.npmjs.com/package/@intervene/neta)

Neta is a leader agent. You talk to a leader; it delegates work to tiered
worker agents and drives them until the problem is done. The leader never
edits files — that restriction is enforced, not suggested.

Neta is not a TUI. You live in the native UI of the coding agent you already
use and pay for — Claude Code, Codex, or OpenCode:

```
neta
```

That detects the agent CLIs you have, launches one as the leader with Neta's
instructions and worker tools injected, and stays behind it. The leader spawns
workers, collects their results, and reports once.

## What you get

- **A lead, not an implementer.** The leader reads, decides, delegates and
  verifies. Its edit tools are removed by the vendor's own permission system,
  and shell writes (`sed -i`, `echo > file`, `git commit`) are blocked too — a
  leader with a way to edit eventually edits.
- **Workers on your subscription.** Every worker is a real agent CLI driven
  over ACP, so it runs on the login you already have rather than on API credit.
  Tiers are unconfigured by default and spread deterministically across
  installed backends; configure them in settings.
- **Tiers, not model names.** The leader asks for a junior, senior or staff
  worker; you decide which model each tier means, and can mix vendors —
  `"staff": { "backend": "codex" }` puts staff work on `gpt-5.6-sol[xhigh]`
  while the rest stay on Claude. `neta models` lists what each backend offers.
- **One writer at a time.** Reads parallelize; writes serialize. A second
  writer is refused, not raced.
- **Workers you can take over.** A worker is an ordinary Claude Code or Codex
  session — same history, same id — so `neta attach w1` opens it in that CLI's
  own interface, where you can read what it did and keep talking to it
  yourself. Neta drove it; you can finish it.
- **A tab per worker, if you run a multiplexer.** With Zellij or tmux, each
  worker opens its own tab streaming its log, so the leader you are typing into
  keeps its window. Finished tabs stay until the leader starts new workers,
  then close themselves. Without a multiplexer, workers run headless.
- **Visible spend.** `neta workers` shows tokens and cost per worker, as the
  backends report them.

How the leader is held to read-only depends on which CLI leads:

| Leader | Typed edit tools | Its shell |
| --- | --- | --- |
| Claude Code | denied by permission rules | `neta guard` runs as a PreToolUse hook |
| Codex | kernel sandbox | same kernel sandbox (`sandbox_mode = "read-only"`) |
| OpenCode | `permission.edit: deny` | denied bash patterns |

Codex's is the strongest — the kernel refuses the write. The other two rely on
Neta's guard, which is a denylist, and a denylist can be incomplete.

## Install

```
npm install -g @intervene/neta      # or: bun install -g @intervene/neta
```

One bundled file, no runtime dependencies. Neta needs Node 22.19+ and at least
one agent CLI on PATH:

```
npm install -g @anthropic-ai/claude-code   # or
npm install -g @openai/codex               # or
npm install -g opencode-ai
```

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
neta watch w1              # watch one worker, and type to talk to it
neta attach w1             # open that worker in its own CLI and take over
neta log w1                # its new lines since you last looked
neta send w1 <message>     # give a running worker more instructions
neta answer w1 <text>      # unblock a worker that asked you something
neta kill w1               # stop it
neta sessions              # leader sessions running on this machine
neta --backends            # which agent CLIs are installed
```

Those worker commands work from any terminal, not just inside the session:
Neta records each live session in `~/.neta/sessions/`, so a second window can
reach the same leader. Add `--session <id>` when more than one is running.

Inside a session the leader gets MCP tools — `neta_spawn`, `neta_spawn_group`,
`neta_workers`, `neta_log`, `neta_wait`, `neta_send`, `neta_answer`,
`neta_kill`, `neta_room` — and workers get `neta_notify`, `neta_ask`,
`neta_say`, `neta_room`, plus the same commands in their shell.

## Configuring it

- **Settings** live in `~/.neta/settings.json`, overridden per project by
  `.neta/settings.json`: which CLI leads, which model each tier means, how
  workers are launched, whether panes open. See [docs/settings.md](docs/settings.md).
- **CHARTER.md** in your project says which decisions the leader may take on
  your behalf and which ones stop and ask — see
  [CHARTER.example.md](CHARTER.example.md). Neta also loads
  `~/.neta/CHARTER.md`; when both exist, it embeds the project charter first,
  then the user charter, with both source paths labelled. Without either one,
  the leader decides routine technical matters and asks before anything
  expensive, destructive, or outward-facing.
- **Roles** are prompts (`scout`, `worker`, `reviewer`, `debater`); **flavors**
  are playbooks the leader reads when a task fits (`implement`, `decide`,
  `investigate`). Both are markdown you can override per project.

## Documentation

- [How it works](docs/how-it-works.md) — the process tree, the two doors, and
  why the control plane is an MCP server.
- [Settings](docs/settings.md) — tiers, backends, multiplexer, leader options.
- [MANIFESTO.md](MANIFESTO.md) — the design: tiers, roles, single writer, the
  charter.
- [PLAN.md](PLAN.md) — what is built, what was verified how, and what is
  deliberately missing.

## Development

```
bun install
bun test          # 161 tests, incl. real worker processes over a real socket
bun run check     # biome + tsc --noEmit
bun run build     # dist/cli.js — one file, targets Node
```

Tests never call a provider: worker backends are a fixture ACP agent.

To release, bump `version` in `package.json` and push to `main`. CI publishes
that version to npm if the registry does not already have it, and tags the
commit; ordinary pushes just run the checks. The CLI reads its version from
`package.json`, so there is nothing else to bump.

## Status

Working end to end, and young.

Verified: every vendor mechanism was checked against the installed CLI before
being coded, the test suite drives the real control plane, real worker
processes and a real socket, and the published package was installed from its
tarball and driven through a full session.

Not verified, and worth knowing:

- **Only Codex workers are sandboxed.** Every read-only worker has its typed
  edits rejected by Neta, and Codex workers additionally run in its `read-only`
  kernel sandbox, which covers the shell. On Claude Code and OpenCode a
  determined worker could still write through `bash`.
- **No long-running real-model use yet.** The leader's honesty rule (report a
  blocker rather than fake delegation) is enforced by prompt and tools, not by
  a test.

Vendor flags change often; that is where breakage will show up first.
