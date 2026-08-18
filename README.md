# Neta

[![ci](https://github.com/sudhanshug16/neta/actions/workflows/ci.yml/badge.svg)](https://github.com/sudhanshug16/neta/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@intervene/neta)](https://www.npmjs.com/package/@intervene/neta)

Neta (Hindi: leader) is a leader agent behind the coding-agent CLI you already
use. You talk to Claude Code, Codex or OpenCode in its own interface; Neta
launches it as the leader — instructions injected, worker tools registered as
an MCP server, write access removed with that vendor's own permission
machinery — and gives it a team of worker agents, each a real agent CLI driven
over ACP on the login you already use. The leader reads, decides, delegates
and verifies; workers do the work; one writer at a time per session. Neta owns
no session UI — it stays behind the CLI and gets out of the way. Its launcher
draws the two startup selectors, and its one worker surface is the per-worker
`neta watch` pane.

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

## Quickstart

```
cd your-repo
neta
```

On a terminal, that asks two questions with an arrow-key selector: which of
your installed agent CLIs leads (skipped when only one is installed, or when
`--leader codex` picks), and which worker tiers this session may staff — a
checkbox list where space toggles, enter confirms and esc cancels. The first
run offers every tier; later runs start on whatever you confirmed last time,
remembered in `~/.neta/startup.json` and nowhere else. A session cannot spawn
a tier it was not started with: the control plane refuses it, not the prompt.
Piped or non-interactive launches never prompt and get every tier.

Then Neta launches that CLI as the leader and stays behind it. You are in that CLI's ordinary interface. With Zellij or tmux, each worker
gets a tab streaming its log; without one, workers run headless (`--mux none`
forces that). Arguments after `--` pass through to the vendor CLI:
`neta -- --model opus`.

Worker rows are text. If a vendor transcript or terminal host makes a
Terminal row clickable, that click handler belongs to the host; this repository
does not install or change it. Neta's own expansion is `neta inspect <id>` (or
`neta_inspect`): a bounded recent input/output window with an explicit marker
when content was truncated, including for headless workers.

Then delegate:

> Find out why the release workflow is flaky, and fix it.

The leader delegates the workers in one call, receives their actual backend
assignments, blocks on `neta_wait` until they finish or report a blocker, and
reports once. It never edits files itself; that
restriction is a mechanism, not a prompt:

| Leader | Typed edit tools | Its shell |
| --- | --- | --- |
| Claude Code | denied by permission rules | `neta guard` runs as a PreToolUse hook |
| Codex | kernel sandbox | same kernel sandbox (`sandbox_mode = "read-only"`) |
| OpenCode | `permission.edit: deny` | bash denied by default; read-only allowlist |

Codex's is the strongest — the kernel refuses the write. Claude Code relies on
Neta's guard, which denies shell writes by pattern — redirects (fd-prefixed
ones like `2>` included), in-place editors, `tee`, `patch`, the file movers,
mutating git subcommands — and a denylist can be incomplete. OpenCode denies
bash outright and allows only listed read-only inspection commands; an
allowlist fails closed, but both are weaker than a kernel. The honesty rule
gets the same treatment where the vendor allows it: on Claude Code the
backend's own subagent tools (`Agent`, `Task`) are denied, so the leader
cannot pass its internal subagents off as workers; on Codex and OpenCode that
rule lives in the prompt.

## Workers, tiers, backends

Every worker is a real agent CLI driven over ACP (Agent Client Protocol):
Claude Code and Codex through their ACP bridges
(`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`),
OpenCode natively (`opencode acp`). One transport, so every backend behaves
the same — and every worker launches with that CLI's own auth. Whether that
means a subscription login or API credit is that CLI's configuration; Neta
adds no billing of its own.

The leader asks for a tier, never a model. A tier is what you would trust a
worker with:

- **apprentice** — the mechanical floor: a named command, an exactly specified
  small change, or one bounded question about a named file. Fails on any ambiguity.
- **journeyman** — mechanical work with a precise spec; fails on ambiguity.
- **expert** — well-scoped features, bug fixes with tests, code review.
- **architect** — ambiguity: unknown-cause debugging, design work, debates.

Tiers ship unconfigured, and unconfigured tiers follow the spread policy:
deterministic round-robin across installed backends, stable per session, with
two diversity rules — reviewers and debaters prefer a different backend than
the most recent writer, and debaters in one room are spread across vendors.

Settings pin tiers down. `{ "tiers": { "architect": { "backend": "codex" } } }`
puts architect work on `gpt-5.6-sol[max]` while the rest keep the spread, and
`tierModels` on a backend names which of its models each tier means. OpenCode
ships no tier models on purpose — it fronts many providers, and only you know
which one you logged into — so its ids are provider-qualified
(`"expert": "openai/gpt-5.4"`); [docs/settings.md](docs/settings.md) has the
full example. `"disabled": true` removes a backend from assignment and leader
selection. `neta models [backend]` lists the ids, straight from the backend.
Claude listings omit Fable because Neta does not allow selecting it; old Fable
usage remains cost-estimable for historical reports.

## The leader's tools

Inside the session, worker control is MCP tools — they run in the vendor's
host process, outside any sandbox:

| Tool | What it does |
| --- | --- |
| `neta_delegate` | Start one or more independent workers, or a team sharing one transcript; input errors are atomic, while runtime startup failures are returned per worker and later workers are still attempted. |
| `neta_exec` | Run one guarded mechanical repo command from a small Git-inspection/Bun-test grammar; inspection disables repository Git hooks, and Bun requires an explicit confined test file. Never Git grep/push, bare test discovery, source edits, outside test paths, loaders, or ambiguous implementation. |
| `neta_workers` | List workers with state, token usage and results. |
| `neta_status` | One snapshot: writer slot, queue, workers by state, open notes. |
| `neta_attach` | Reopen a terminal worker's exact native backend session in a new tab. |
| `neta_wait` | Block until watched workers finish, report a blocker, or a team posts. |
| `neta_send` | Steer a live worker or resume a done, failed, or blocked worker in its exact ACP conversation. |
| `neta_inspect` | Expand one worker's recent input and output, bounded, without consuming lines. |
| `neta_kill` | Terminate a worker, releasing the writer slot. |
| `neta_note` | Open-notes ledger: parked work, pending decisions, follow-ups. |

## The worker channel

Workers report back through their own MCP tools — `neta_progress`,
`neta_blocked`, and `neta_status` — or the same commands in
their shell; both doors reach the same socket, and every request carries that
worker's own token. Team workers additionally receive `neta_room` and
`neta_room_post`; independent workers do not see either. Workers hold no leader token and cannot run leader
commands:

```
neta progress <message>    record a progress milestone; the leader pulls it
neta blocked <question>    stop this turn with a blocker; the leader resumes it with send
neta room-post <message>   post to your team transcript
neta room [--tail N]       read your room's transcript
neta status --writers      show active, queued and finished writers
```

Writes serialize. There is one writer slot per session: a worker spawned with
the writer flag holds it, a second writer queues (FIFO) and starts when the
slot frees, and ids show access at a glance — writers are `rw<N>`, read-only
workers `ro<N>`, one counter for the session. A read-only worker has its
file-editing tool calls rejected at the ACP layer on every backend; only
Codex's kernel sandbox covers the worker's shell as well. Read-only workers
are kept aware of the writer: spawned alongside one, they are told who holds
the slot and what it is doing; when a writer starts or finishes, they get a
notice — the finish notice says whether it committed and whether uncommitted
changes remain; `neta status --writers` answers on demand. Writers are told to
commit everything before finishing — the role prompt says so, and a writer
that hands off with a dirty tree gets "uncommitted changes: N files" appended
loudly to its result — so the next writer is briefed from `git log`. That is a
warning, not a hard gate: Neta reports the dirty handoff rather than blocking
it.

Because bare `neta` allows one live session per directory, the common case is
one writer slot per directory. Different subdirectories of one repository can
still host separate sessions and therefore separate writer slots.

## Sessions

There is at most one live `neta` session per directory. Running bare `neta`
again in that directory reattaches its Zellij or tmux session instead of
creating another one. A headless session refuses the second launch and names
the commands to reach or stop it. Different directories — including different
Git worktrees — run their own sessions. Neta records each session in
`~/.neta/sessions/`, so any terminal reaches it; add `--session <id>` when
more than one directory has a live session.

```
neta sessions              leader sessions running on this machine
neta sessions --all        live and closed sessions, with the ids resume takes
neta resume <session-id>   reopen a closed session by its exact id
neta status                writer slot, worker states, queue and open notes
neta workers               what is running, and what it has cost
neta wait ro1 ro2          block until those workers finish
neta watch ro1             watch one worker live; typed text uses the same
                           cancel-and-reprompt steering as neta send
neta watch auth-debate     follow a room's merged transcript live
neta attach ro1            take over this terminal with that worker's own CLI
neta inspect ro1           its recent input and output, bounded, without
                           consuming lines — works with no tab at all
neta send rw2 <message>    give a worker more instructions
neta kill rw2              stop it
neta --backends            which agent CLIs are installed
```

### Reopening a session after quitting or upgrading

A closed session is not lost. Neta keeps a durable checkpoint per session —
worker outcomes, logs, notes, rooms, the writer queue, and the leader's exact
vendor conversation id — so you can pick it up later, including after installing
a newer Neta:

```
# quit the leader, then:
npm install -g @intervene/neta      # or however you installed it
neta sessions --all                 # copy the id of the session you want
neta resume 4f1c8a...               # reopens that exact conversation
```

All three leader backends resume the same way. Neta reopens the same leader
conversation — `claude --resume <uuid>`, `codex resume <uuid>`,
`opencode --session <ses_…>` — with fresh Neta instructions, MCP registration
and restrictions from the version you just installed. It never uses a vendor
"latest", "continue" or "fork" selector: Claude Code is told which conversation
id to use before it starts, while Codex and OpenCode report the id they assigned
through their own hook and plugin mechanisms. A launch that could not arrange that capture at
all — an older CLI without hooks or plugins, or OpenCode's `--pure` — is refused
outright rather than started as a session you could never reopen. If capture was
arranged and still never arrived, the session says so while it runs, lists as
`conversation-id:no`, and is refused by `neta resume` rather than guessed at.

Workers that were running when the leader session
stopped come back as `interrupted` — their history, results and vendor session
ids are intact, and `neta attach <id>` still opens one in its own CLI — but
nothing re-runs automatically. Separately, `neta_send` revives terminal `done`,
`failed`, and `blocked` workers headlessly with ACP `session/resume`; it never
falls back to a new session. Revived writers reacquire or queue for the writer slot. Resume
refuses outright if the old session is still live (reattach instead), if its
directory is gone, or if it cannot prove the previous run's worker processes
are dead.

`neta attach` works because a worker is an ordinary session of the CLI that
ran it: Neta hands the session id the worker's ACP handshake returned to that
backend's own resume command — `claude --resume <id>`, `codex resume <id>`,
`opencode --session <id>` — so it opens in the interface you already know,
where you can read what it did and keep talking to it yourself. Neta drove it;
you can finish it. An existing worker watch tab is renamed in place with `✓`
for success, `✗` for failure, or `⊘` when killed; status marking never opens or
retains a tab. CLI `neta attach` takes over its caller's terminal. The leader's
`neta_attach` tool is the only attach action that opens a fresh tab; it refuses
active workers so two clients cannot drive one conversation.
Once a native TUI has been opened, Neta records that ownership durably and will
not later resume the same worker headlessly, including after a leader restart.
Closing or detaching a vendor TUI cannot be proven from Neta's control plane;
close it and delegate a fresh worker when automated continuation is needed.

## Configuring it

- **Settings** live in `~/.neta/settings.json`, with the project's
  `.neta/settings.json` merged on top: which CLI leads, tiers, backends,
  multiplexer. Each tier and each backend entry deep-merges — project fields
  win, user fields survive. See [docs/settings.md](docs/settings.md).
- **CHARTER.md** in your project says which decisions the leader may take on
  your behalf and which stop and ask — see
  [CHARTER.example.md](CHARTER.example.md). `~/.neta/CHARTER.md` is also
  loaded; when both exist, the project charter comes first. Without either,
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

## Development

The toolchain is [Bun](https://bun.sh):

```
bun install
bun test          # integration tests drive real worker processes over a real socket
bun run check     # biome + tsc --noEmit
bun run build     # dist/cli.js — one file, targets Node
```

Tests never call a provider: worker backends are a fixture ACP agent. From a
checkout, `bun run build && bun link` puts `neta` on PATH.

To release, bump `version` in `package.json` and push to `main`. CI publishes
that version to npm if the registry does not already have it, and tags the
commit. The CLI reads its version from `package.json`, so there is nothing
else to bump.
