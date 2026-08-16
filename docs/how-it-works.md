# How Neta works

## The process tree

```
neta                       ← the launcher: picks a leader, generates config, waits
└── claude / codex / opencode   ← the leader: the UI you talk to
    └── neta mcp               ← the control plane: owns every worker
        ├── worker 1 (ACP)     ← an agent CLI driven over stdio
        └── worker 2 (ACP)
```

The shape is the design. The control plane is a child of the vendor CLI, not of
the launcher, because MCP servers are started by the agent host **outside**
whatever sandbox the agent's own shell commands run in. A Codex leader in
`sandbox_mode = "read-only"` cannot open a Unix socket from bash — the kernel
denies `connect()` — but it can always call a tool. That is the whole reason
worker control is MCP and not a CLI.

The control plane has no daemon and no lifetime of its own: when the leader
exits, its stdio closes, and the control plane kills every worker it started
and removes its session file. If it dies without cleaning up (a crash,
`kill -9`), the next `neta` invocation sweeps the residue: the stale session
file, its socket, and any recorded worker process groups — each checked
against its recorded start time first, so a recycled pid is never killed.
That sweep also ends the recorded Zellij or tmux session, so a crashed manager
cannot leave a detached pane full of orphaned worker views. A session whose
directory was deleted is shut down and removed too, even if its manager pid
still exists.

There is at most one live Neta session per real directory. Before a bare
`neta` launch checks the registry, it sweeps dead sessions, resolves symlinks
on both directory paths, and takes a directory-specific launch lock through
registration. A second launch reattaches the recorded Zellij or tmux session;
for a headless session it refuses and prints the session id, pid, start time,
and the `workers`, `watch`, `kill`, and OS `kill` routes. Different directories
and Git worktrees have different real paths, so each can run its own session.
That normally means one writer slot per directory; separate subdirectories of
one repository still have separate sessions and writer slots.

## The two doors

Two doors reach one manager, but they do not carry the same operations. The
MCP door has all thirteen leader tools. The socket door carries the eight
leader commands a person or token-holding process needs from a terminal —
`spawn`, `workers`, `status`, `log`, `wait`, `send`, `answer`, `kill` — plus
the worker commands and the view commands (`watch`, `attach`, `sessions`).
The five tools without socket twins (`neta_plan`, `neta_spawn_group`,
`neta_room`, `neta_note`, `neta_remember`) are staffing and bookkeeping
surfaces of the leader's own judgment loop, which lives in the MCP door.

| Door | Who uses it | How |
| --- | --- | --- |
| MCP tools | the leader | all 13 `neta_*` tools in the vendor's tool loop |
| Unix socket | workers, and you | 8 leader commands, 5 worker commands, the view commands |

The socket door is authorized per role, by token. Each worker's requests carry
its own per-worker token, and a worker can only report progress, ask, post to
its room, or run `neta status --writers`; it holds no leader token, and the
CLI refuses leader commands inside a worker. The leader token — the one that
authorizes spawning and killing — goes to the leader's process and to the
session file in `~/.neta/sessions/`, which is readable only by you. That file
is how `neta workers` or `neta status` in a second terminal finds the session
you are running.

## Waking the leader

Workers are quiet. They record progress milestones in a log the leader pulls
when it chooses, and nothing they say interrupts anyone. Two things block instead:

- the leader's `neta_wait` blocks until the workers it named are finished —
  all of them, or the first one with `first: true` — and returns their
  summaries; this is how an idle leader wakes up with results. A watched
  worker blocking on `ask` wakes the wait immediately, and `roomEvents` opts
  a wait into waking on new room posts, so a debate can be refereed live;
- a worker's `neta_ask` blocks until the leader answers.

Blocking tool calls are the only cross-agent channel. Neta never types into
another agent's terminal.

## Restrictions

The leader is read-only, enforced with each vendor's own machinery:

| Backend | Typed tools | Shell |
| --- | --- | --- |
| Claude Code | `permissions.deny` on Edit/Write/NotebookEdit | PreToolUse hook running `neta guard` |
| Codex | kernel sandbox | same kernel sandbox (`sandbox_mode = "read-only"`) |
| OpenCode | `permission.edit: deny` | bash denied by default; explicit read-only command allowlist |

Codex's is the strongest: the kernel refuses the write, so there is no pattern
to outsmart. Claude Code relies on Neta's guard, which denies redirects into
files (fd-prefixed forms like `2> file` and `&> file` included), in-place
editors, `tee`, `patch`, the file-moving commands, and git subcommands that
change a repository. OpenCode instead denies bash by default and allows only
listed read-only inspection commands; both approaches are weaker than a
kernel sandbox.

The honesty rule — never substitute the backend's internal subagents for Neta
workers — is mechanized where the vendor allows it: Claude Code's `Agent` and
`Task` tools are in the deny rules, so the leader cannot use them. Codex and
OpenCode expose no equivalent tool to deny, so there the rule is prompt-level.

All Neta processes run as the same OS user; tokens separate sessions and roles,
not a malicious process running as that same user.

Workers are restricted at the ACP layer: a worker without the writer slot has
its file-editing tool calls rejected by Neta, whatever its prompt says. Neta
also asks each worker session for the strictest mode it advertises — where a
backend offers a read-only mode, it is requested automatically; on Codex that
mode is a kernel sandbox, which covers the worker's shell too. Elsewhere the
shell is only sandboxed if you add that backend's own sandbox flags as an
extra layer — see `readOnlyArgs` in [settings](settings.md).

## Instructions, per vendor

The leader's operating instructions (role, tiers, charter, flavors) reach each
CLI differently, because the CLIs differ:

- **Claude Code**: `--append-system-prompt`.
- **OpenCode**: `instructions` in an inline `OPENCODE_CONFIG_CONTENT` config.
- **Codex**: no append flag exists, so the session runs against an overlay
  `CODEX_HOME` — each entry of your real one symlinked in, with `AGENTS.md`
  replaced by your own text plus Neta's. The copy is best-effort: an entry
  that cannot be linked is silently skipped, and Codex simply does not see
  it. Sessions, history and credentials live in your real home through the
  links that succeed, and a refreshed `auth.json` is copied back when the
  session ends — also best-effort.

## Taking a worker over

A worker driven over ACP is not a special kind of session — it is an ordinary
session of its backend CLI, and the ACP handshake hands back that backend's
own session id.

Worker ids show access at a glance: writers use `rw<N>`, read-only workers use
`ro<N>`, and both use one serial counter for the session. `neta attach ro1`
passes the worker's session id to the backend's resume command —
`claude --resume <id>`, `codex resume <id>`, `opencode --session <id>`,
configurable per backend via `backends.<name>.resume` — and you are inside
the worker's conversation in the interface you already know, able to read it
properly and keep talking to it.

There is no second mode to opt into and nothing is given up to get this: Neta
still drove the worker, still gated its edits, still counted its tokens. If you
attach while a worker is still running, you and Neta are both prompting one
conversation, so `neta attach` says so before it opens.

## Panes

With Zellij or tmux available, each worker gets a pane running `neta watch
<id>`: the worker's prose rendered as markdown, tool calls as one-liners,
file changes as colored diffs, and an input line at the bottom. Typing there
talks to the worker — a message queues as its next turn, and when the worker
is blocked on a question, the same input answers it. The pane is a window onto
the worker, not the worker itself — the agent process stays under Neta's
control. Panes read the log without consuming it, so nothing a pane shows is
stolen from the leader, and `neta watch <id> --plain` prints the same stream
as bare lines for piping.

Under the default `auto` mode, a multiplexer session you are already inside
wins; outside one, `auto` prefers Zellij, then tmux. An explicit `--mux
zellij` or `--mux tmux` picks that multiplexer regardless. If you are not
inside a session, Neta starts one around the leader; with no multiplexer
available, workers run headless and nothing else changes.

## Worker cost estimation

Worker usage (tokens and cost) appears in the pane footer, the `neta workers`
listing, and the MCP tools' status lines. Most backends report token counts
but not cost. When cost is missing, Neta estimates it from a bundled snapshot
of [models.dev](https://models.dev) pricing data, labeled `est.` to
distinguish it from backend-reported amounts. The snapshot covers Anthropic
and OpenAI models; estimates for other providers are not available. To refresh
the snapshot, run `bun run refresh-pricing` from the repository root.
