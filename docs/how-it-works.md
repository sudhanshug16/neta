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
and removes its session file.

## The two doors

Every worker operation exists twice, over one manager:

| Door | Who uses it | How |
| --- | --- | --- |
| MCP tools | the leader | `neta_spawn`, `neta_wait`, … in the vendor's tool loop |
| Unix socket | workers, and you | `neta notify`, `neta workers`, `neta watch` |

The socket door is authorized by a token. Workers get their own id and can only
report; the token that authorizes spawning and killing goes to the leader's
process and to the session file in `~/.neta/sessions/`, which is readable only
by you. That file is how `neta workers` in a second terminal finds the session
you are running.

## Waking the leader

Workers are quiet. They narrate into a log the leader pulls when it chooses,
and nothing they say interrupts anyone. Two things block instead:

- the leader's `neta_wait` blocks until the workers it named are finished, and
  returns their summaries — this is how an idle leader wakes up with results;
- a worker's `neta_ask` blocks until the leader answers.

Blocking tool calls are the only cross-agent channel. Neta never types into
another agent's terminal.

## Restrictions

The leader is read-only, enforced with each vendor's own machinery:

| Backend | Typed tools | Shell |
| --- | --- | --- |
| Claude Code | `permissions.deny` on Edit/Write/NotebookEdit | PreToolUse hook running `neta guard` |
| Codex | kernel sandbox | same kernel sandbox (`sandbox_mode = "read-only"`) |
| OpenCode | `permission.edit: deny` | denied bash patterns |

Codex's is the strongest: the kernel refuses the write, so there is no pattern
to outsmart. Claude Code and OpenCode rely on Neta's guard, which denies
redirects into files, in-place editors, `tee`, `patch`, the file-moving
commands, and the git subcommands that change a repository. The guard is a
list, and a list can be incomplete — that is stated here rather than papered
over.

Workers are restricted at the ACP layer: a worker without the writer slot has
its file-editing tool calls rejected by Neta, whatever its prompt says. Its
shell is only sandboxed if you give that backend sandbox flags — see
`readOnlyArgs` in [settings](settings.md).

## Instructions, per vendor

The leader's operating instructions (role, tiers, charter, flavors) reach each
CLI differently, because the CLIs differ:

- **Claude Code**: `--append-system-prompt`.
- **OpenCode**: `instructions` in an inline `OPENCODE_CONFIG_CONTENT` config.
- **Codex**: no append flag exists, so the session runs against an overlay
  `CODEX_HOME` — every entry of your real one symlinked in, with `AGENTS.md`
  replaced by your own text plus Neta's. Sessions, history and credentials
  still live in your real home through those links, and a refreshed
  `auth.json` is copied back when the session ends.

## Panes

With Zellij or tmux available, each worker gets a pane running `neta watch
<id>`, which streams that worker's log. The pane is a window onto the worker,
not the worker itself — the agent process stays under Neta's control. Panes
read the log without consuming it, so nothing a pane shows is stolen from the
leader.

If you are already inside a multiplexer session, Neta uses it. If you are not,
it starts one around the leader. With neither installed, workers run headless
and nothing else changes.
