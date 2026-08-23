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
and removes its live session file. It retains a separate durable checkpoint.
If it dies without cleaning up (a crash,
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

## Roles and tiers

A worker's role and tier are separate parts of a spawn. The role supplies the
prompt — scout, worker, reviewer, or debater — while the tier says how much
ambiguity the worker can handle. They are orthogonal: a debater is not required
to be an architect. For each debate position, the leader selects the lowest tier
that fits. An apprentice may take a bounded, evidence-gathering, or narrowly
specified position. When multiple suitable tiers are available, prefer a mix with
at least one non-apprentice debater for judgment; if only apprentice tiers are
available, use the available apprentices rather than blocking the debate. Room
diversity still spreads debaters across distinct providers when multiple backends
are available. Architect is for ambiguous or open-ended positions, not for the
debate role itself.

## Durable checkpoints

The live registry and the recovery checkpoint have different jobs:

- `~/.neta/sessions/<manager-id>.json` is an ephemeral lease. It contains the
  socket, authorization token, process identity, and crash-cleanup process
  groups. Graceful cleanup and stale-session sweep remove it.
- `~/.neta/checkpoints/<logical-id>.json` is durable, versioned semantic state.
  It contains worker outcomes and logs, notes, rooms, assignment cursors, and
  writer queue history. It never contains tokens, sockets, environment, process
  ids for workers, scratch paths, transports, callbacks, or other live objects.

Checkpoint files are written by rename from a same-directory temporary file,
after syncing the file; the directory is synced after rename. The directory is
mode `0700` and files are `0600`. Corrupt files and unknown schema versions fail
closed and are never overwritten.

A session's checkpoint is created *before* its vendor CLI starts, and a launch
that cannot create it stops there with an error rather than starting a leader.
Nothing would retry that write in time — the control plane that owns later
writes is started by the vendor — so continuing would produce a session that
looks normal and can never be reopened. A session is either durably resumable or
not launched. (Once a session is running, a failed checkpoint write is reported
and never interrupts live orchestration; that trade only applies after the
session exists.)

Durable writes and deferred writes serve different consistency needs.
Structural state — worker outcomes, notes, rooms, writer queue, leader
conversation id, and ownership — is written immediately. Telemetry, logs, progress,
usage, and terminal cursors coalesce with a 100ms trailing debounce and a hard
1-second deadline, so they may lag up to 1 second in exchange for reducing write
overhead when many events fire in quick succession.

Hydration is inert: it creates no worker process, prompt, pane, callback, or
scratch directory. `starting`, `running`, `waiting`, and `queued` workers become
terminal `interrupted` records carrying their previous state. Queued writer
order and history remain visible, but nothing starts automatically. The writer
slot stays held until the recovery boundary proves the old processes dead.
Completed, failed, and killed outcomes remain unchanged.

## Reopening a closed session

`neta resume <id>` reopens one closed session by its exact durable id. The id is
authoritative: it decides the directory, the leader backend and the vendor
conversation, and each is verified rather than inferred. The upgrade flow this
exists for is: quit the leader, install the new Neta, `neta sessions --all`,
`neta resume <id>`.

All three leader backends have the same resume behaviour. What differs is only
how each vendor names a conversation, and each mechanism below was read off the
installed CLI — its help, its embedded documentation, its own SDK types — not
assumed.

Resume reopens the *same vendor conversation*, never a guessed one. Neta uses no
`--continue`, `--last`, `--fork`, or picker selector, and refuses pass-through
arguments that would move the conversation:

| Backend | Fresh session | Resume | Capture mechanism |
| --- | --- | --- | --- |
| Claude Code | `--session-id <uuid>` (Neta assigns and records it before launch) | `--resume <uuid>` | none needed |
| Codex | id assigned by Codex | `codex resume <uuid>` | `SessionStart` hook in `$CODEX_HOME/hooks.json` |
| OpenCode | id assigned by OpenCode (`ses_…`) | `opencode --session <ses_…>` | plugin `event` hook on `session.created` |

- **Claude Code** is the one vendor that lets the caller name a conversation, so
  there is nothing to capture: the id exists before the CLI starts. Rejected
  pass-through: `--continue`, `-c`, `--resume`, `-r`, `--session-id`,
  `--fork-session`.
- **Codex** assigns its own id and reports it to a `SessionStart` hook, whose
  JSON payload carries `session_id`. Neta writes that hook into its overlay
  home, gated on the installed Codex advertising hooks at all. Rejected
  pass-through: `resume`, `fork`, `--last`, `--session`, `--session-id`,
  `--continue`.

  Codex 0.147 and later will not *run* a hook they have not been told to trust:
  a new one waits for review in the TUI, and `--dangerously-bypass-hook-trust`
  un-reviews every enabled hook for that invocation, project-local ones
  included. Neta uses neither. Before the leader starts it asks the installed
  binary — `codex app-server`, `hooks/list`, offline, no session and no model —
  for the key and hash Codex files this hook under, records
  `[hooks.state."<key>"] trusted_hash = "<hash>"` in the config that session will
  read, and asks again to confirm Codex now trusts it. If it does not, the launch
  is refused rather than started unresumable.

  **Where that trust is written.** Not in your `~/.codex/config.toml`. Each
  logical session's overlay home gets its own `config.toml`, generated from
  yours at launch — your settings verbatim, plus this session's one trust entry.
  Neta reads your config and never writes it. Two consequences worth knowing:

  - Two `neta` launches in two directories cannot overwrite each other's trust.
    They used to: each read your one config, each appended its entry, and
    whichever wrote second dropped the other's. The losing session then started
    with an untrusted capture hook, so Codex never ran it and that
    conversation's id was lost with no error anywhere.
  - A setting you change from inside a Neta-led Codex session — a `/model`, a
    "Trust all" in the hooks screen — lands in that session's copy, not in your
    own config. Change anything you want to keep in `~/.codex/config.toml`; the
    next launch copies it forward. The copy is rebuilt from yours on every run,
    including a resume, so your config is always what wins.

  **What Neta vouches for.** Exactly two things: its own generated capture hook,
  and a hook of yours whose identical definition your Codex config already
  trusts (the overlay gives your hooks a new path, which Codex reads as new).
  Anything else — an unreviewed hook of yours, anything a repository ships —
  stays untrusted and Codex asks you, as it would without Neta. Trust entries
  naming overlay homes that no longer exist are dropped when the copy is
  generated, and only for paths genuinely inside Neta's own
  `~/.neta/leader-sessions` directory — a sibling that merely starts with the
  same characters is left alone.

  **The hook command line.** Codex takes a hook as one command *string* and runs
  it through a shell, so Neta quotes each argument rather than joining them with
  spaces: an install path with a space, an apostrophe or a `$(…)` in it is passed
  literally and never executed. Windows Codex gets the same command as
  `commandWindows`, quoted for `cmd.exe`; on Windows a path containing `"`, `%`
  or `!` is refused outright rather than mis-quoted.
- **OpenCode** also assigns its own id (`ses_…`) and offers no way to name one.
  The leader runs in OpenCode's own TUI rather than over ACP, so there is no
  `session/new` response to read the id from; what there is, is the plugin
  `event` hook, which receives every bus event with the whole `Session` object
  attached. Neta registers one generated plugin — `plugin: ["file://…"]` in the
  inline config — that reports the id once, from the session's own creation
  event.

  The point of that design is that it is an exact observation, not a lookup.
  Neta never runs `opencode session list` and takes the newest row: that would
  race every other OpenCode window the user has open. Four rules keep it exact:
  the plugin instance belongs to this leader's own process; the event is the
  creation itself; a session carrying a `parentID` is a subagent's; a session
  whose project directory is unrelated to this launch is not ours; and a
  `session.updated` is accepted only when the session's own recorded creation
  time falls inside this launch, so an older session being touched can never be
  mistaken for the new one.

  Gated on the installed OpenCode advertising plugins; `--pure` disables plugins
  and is reported as such. OpenCode's own global storage is untouched: Neta adds
  inline config plus that one plugin file at its own stable path, and never
  relocates the OpenCode data directory — `opencode session list --format json`
  and `opencode export <id>` keep working against exactly the id Neta recorded.
  Rejected pass-through: `-c`, `--continue`, `-s`, `--session`, `--fork`.

Where capture cannot be arranged — an older build without hooks or plugins,
or `--pure` — the **launch is refused**, in the same way a conflicting
pass-through selector is. A session that starts is a session the user will
expect to reopen, so Neta does not start one it already knows it could not.

Where capture is arranged but never arrives — a hook that silently does not
fire — the control plane says so on the session's own error stream ("this
leader never reported its conversation id … `neta resume` will refuse this
session"), including whatever the capture recorded about why it failed. Worker
history is still saved; only the leader conversation is lost, and
`neta sessions --all` shows that as `conversation-id:no`.
Everything else is identical across the three: `neta sessions --all`, the live
conflict check, the process-death barrier, inert hydration with no rerun, the
recovery briefing, preserved notes and results, and `neta_attach` on a recovered
interrupted worker.

A resumed leader keeps its logical session id and its vendor conversation id,
and gets everything else fresh: a new manager id, socket, authorization token,
temporary bundle and MCP config, CLI shim, and the currently installed Neta's
instructions and restrictions. Its instructions carry a short recovered-state
briefing — prior version, worker outcomes, open notes, and the fact that no
worker was restarted — and point at `neta_status` for the rest.

### Generated vendor state lives at a stable path

Codex records the absolute path of a session's rollout file in its own thread
index. Neta's Codex overlay home therefore lives at
`~/.neta/leader-sessions/<logical-id>/codex-home` (mode `0700`), not under the
per-run temporary directory: an overlay that is deleted at exit leaves Codex
pointing at a path that no longer exists, and `codex resume <id>` then fails
even though the transcript is safe in the real Codex home. Only `AGENTS.md`,
`hooks.json` and `config.toml` are generated there; every other entry stays a
symlink into the real home, so credentials, history and sessions are never
copied. `config.toml` is a copy rather than a link so this session's hook trust
has somewhere private to live — see
[Reopening a closed session](#reopening-a-closed-session) above.

OpenCode's capture plugin lives in the same per-session directory
(`opencode-session-capture.mjs`) and is regenerated on every run, for the same
reason: config that points at a per-run temporary path is config that stops
resolving the moment the run ends. Claude Code needs no such file.

### The process-death barrier

Recovery hydrates only after it can prove that nothing from the previous run is
still running:

- A graceful shutdown records `shutdown.processesStopped` in the checkpoint
  after every worker process group is confirmed gone.
- A crash leaves the lease. Resume then matches the recorded manager identity,
  reaps each recorded worker process group by pgid *and* recorded start time,
  waits for death, kills the recorded multiplexer session, and records the proof.
- The stale-session sweep, which any `neta` command can trigger, leaves a
  stopped marker in `~/.neta/sessions/stopped/` when it reaps a manager, so its
  cleanup is not lost evidence.

Identity mismatch, a still-live manager, a kill that cannot be verified, or
missing evidence after an unclean stop all abort recovery with the writer slot
still held and the checkpoint unchanged. A directory launch lock plus a
checkpoint claim stop two resumes from building two managers over one session.

## The two doors

Two doors reach one manager, but they do not carry the same operations. The
MCP door has ten leader tools. The socket door carries the six
leader commands a person or token-holding process needs from a terminal —
`workers`, `status`, `inspect`, `wait`, `send`, `kill` — plus
the worker commands and the view commands (`watch`, `attach`, `sessions`).
Delegation, unrestricted command execution, and notes are MCP-only surfaces of the leader's judgment loop.

For a delegation batch, Neta validates every request before seeding a room or
allocating a worker. That input boundary is atomic. Process startup is not
rolled back: if a later worker fails to start after earlier workers are live,
the remaining workers are still attempted and `neta_delegate` returns every
allocated worker id with its running, queued, or failed state and explicit
startup error.

| Door | Who uses it | How |
| --- | --- | --- |
| MCP tools | the leader | all 10 `neta_*` tools in the vendor's tool loop |
| Unix socket | workers, and you | 6 leader commands, worker commands, the view commands |

`neta_exec` carries no command grammar. Its argv is handed to the OS process
launch exactly as given: any executable name or path, any arguments —
including shell or interpreter flags and inline shell source such as
`["sh", "-c", "..."]` — and Git or Bun with any options, because a positive
grammar for Git alone cannot hold (Git can reintroduce a shell through pagers,
aliases, diff drivers and remote helpers) and narrowing Bun or Git specifically
while leaving every other executable open only relocates the boundary rather
than enforcing one. There is no replacement allowlist. What remains before
spawn is structural: argv must be a non-empty array of non-empty strings with
no NUL byte (the OS cannot carry one through exec regardless of policy), the
resolved cwd must exist as a directory — any existing directory, not only the
session repository — and, if a timeout is given at all, it must be a positive
number representable as a millisecond integer the runtime's own timer can
hold. Omitting the timeout is not the same as a large one: neta_exec then
imposes none of its own and waits for the command to finish or for the
session to shut down. `userApproved` still
exists on the request for callers built against the old schema, but nothing
reads it: no command, including `git push`, is gated on it, and Neta neither
disables Git hooks nor refuses the command because a writer owns or is queued
for the writer slot. A `git push` issued this way runs the repository's normal
`pre-push` hook with host permissions, exactly as an unauthorized shell would.

Output is the boundary that is left. Every invocation streams combined
stdout/stderr directly to a unique mode-0600 file under the session's
temporary directory (audit directory mode 0700). The command's own output
excerpt inside the tool result — not the tool result as a whole, which also
carries a header, the temp file path and any warnings below — never exceeds
12,000 UTF-8 bytes: under that cap the excerpt carries everything; over it,
the excerpt keeps the head and the tail of the capture — a failing command's
actual error usually lands at the end — and the result states plainly, outside
that excerpt, that the output was too large to return in full, names the exact
temp file path, and tells the leader to delegate reading that file to an
apprentice or scout rather than trying to read around the cut itself. A
command that cannot even be launched (bad executable, a process group that
cannot be proven stopped) does not raise a tool error either: it comes back as
a completed result with a distinct exit code and the launch failure folded
into that same bounded excerpt, so it still carries its call number and
warning like any other accepted call. An explicit timeout firing, or the
session shutting down, sends TERM then KILL to the whole detached process
group and waits until it is gone; with no timeout given, only shutdown can
stop the command early.

Each session counts its own accepted `neta_exec` calls — accepted meaning
argv, cwd and, when supplied, timeout all passed structural validation (the
MCP layer checks `timeoutSeconds` itself — finite, positive, and small enough
to round into a millisecond value the runtime's timer can hold — before it is
rounded, so an invalid value can neither slip through rounding nor count as
accepted), whether or not the command itself then exited nonzero or failed to
launch.
The counter lives only in the running manager, not the checkpoint, so a
resumed process legitimately restarts it at one. The first call in a session
carries no warning; every call from the
second on returns with its exact call number and a line telling the leader
that repeated discovery belongs to a delegated worker, not to another
`neta_exec` call. The warning never rejects or delays the command — it is
carried on the same completed result as the command's own output.

The socket door is authorized per role, by token. Each worker's requests carry
its own per-worker token, and a worker can only report progress, report a blocker,
use its team transcript when it has one, or run `neta status --writers`; it holds no leader token, and the
CLI refuses leader commands inside a worker. The leader token — the one that
authorizes terminal control commands — goes to the leader's process and to the
session file in `~/.neta/sessions/`, which is readable only by you. That file
is how `neta workers` or `neta status` in a second terminal finds the session
you are running.

Leader status keeps the default `neta_status` summary live and useful in large
sessions: it includes the writer slot, every queued or active worker, every
blocked worker requiring leader action, and every open note. Individual task,
progress, diagnostic, linked-worker, goal, and note-text fields are clipped to
fixed bounds, while closed history is represented by terminal counts only;
ordinary done, killed, failed, and interrupted rows stay hidden unless a
later-failure diagnostic makes them actionable. Use `view="workers"` or
`view="notes"` with `limit` (20 by default, 100 max), the returned opaque
`cursor`, and (for workers) `state` to page stable insertion/created order.
`workerId` and `noteId` select one exact record; invalid or stale cursors are
rejected. The no-argument `neta_note` listing and wait results use bounded
previews and point back to the notes view for more. The hidden deprecated
`neta_workers` MCP route keeps its prefix and exact-id behavior while using the
bounded worker page.

## Waking the leader

Workers are quiet. They record progress milestones in a log the leader pulls
when it chooses, and nothing they say interrupts anyone. Two things block instead:

- the leader's `neta_wait` blocks until the workers it named are finished —
  all of them, or the first one with `first: true` — and returns their
  summaries; this is how an idle leader wakes up with results. A watched
  worker reporting `blocked` wakes the wait immediately, and `roomEvents` opts
  a wait into waking on new room posts, so a debate can be refereed live;
- a worker's `neta_blocked` ends that exact turn and stops the worker; the
  leader's `neta_send` resumes the exact ACP conversation with the answer.

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
  replaced by your own text plus Neta's, and `config.toml` copied from yours.
  The linking is best-effort: an entry that cannot be linked is silently
  skipped, and Codex simply does not see it. A `config.toml` that exists but
  cannot be *read* is not: the launch is refused, because a session started
  from an empty copy is a Codex running with none of your model, provider or
  approval settings. Sessions, history and credentials live in your real home
  through the links that succeed. When Codex refreshes credentials it replaces
  the `auth.json` link with a real file; at the end of the session Neta copies
  those bytes back to your real home, verifies them there, and restores the
  link — so Neta's own directory retains no copy of your credentials. The copy
  goes through a temporary file beside the real one, and every way it can fail
  removes that temporary file, because it holds your credentials too. If any
  step fails it says so and leaves your files alone, because the alternative is
  deleting the only good copy.

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

The leader's `neta_attach` tool is stricter: it opens a fresh mux tab only for
a terminal worker with an exact recorded vendor session and configured resume
command. It refuses active or unstarted workers and headless sessions, sends no
prompt, and does not change worker state. Closing that TUI and calling the tool
again opens another tab.

Opening a native TUI transfers ownership of that vendor conversation outside
the control plane. Neta persists that fact and fails closed: a leader restart
will not headlessly resume the worker. Vendor CLIs do not provide proof that a
detached native client has really exited, so closing the TUI cannot clear the
flag safely. The recovery path is to close the native client and delegate a
fresh worker.

## Panes

With Zellij or tmux available, each worker gets a pane running `neta watch
<id>`: the worker's prose rendered as markdown, tool calls as one-liners,
file changes as colored diffs, and an input line at the bottom. Typing there
uses the same manager path as `neta send` and `neta_send`: Neta cancels the
exact active ACP turn, waits until that session-wide cancel is dispatched,
then sends the text as the immediate next prompt in the same worker session.
A delayed cancel is held ahead of its replacement prompt, so it cannot stop
the later turn. Text entered while no turn is active becomes the next turn. A
worker that calls `neta blocked` stops; `neta send` resumes its exact ACP
conversation and delivers the answer. The pane is a window onto the worker,
not the worker itself — the agent process stays under Neta's control. Panes read the log
without consuming it, so nothing a pane shows is stolen from the leader, and
`neta watch <id> --plain` prints the same stream as bare lines for piping.
Worker views abort promptly when closed or when the leader restarts, and
missing Unix sockets fail truthfully without leaving orphaned views.


`neta inspect <id>` and `neta_inspect` provide the repo-owned expansion for a
worker row. They show a 6,000-character hard-capped recent window, including
worker metadata, task, input and output, without moving the leader's log cursor,
and print an explicit truncation marker when
older entries or characters were omitted. This remains available for headless
workers. Any clickable Terminal row in a vendor transcript or terminal host is
host-owned; Neta does not install or modify that external click handler.

An existing worker watch tab advertises its result in the tab bar: `✓` is done,
`✗` is failed, and `⊘` is killed. Status marking only renames the exact watch
tab Neta marked and never opens or retains one; running `neta watch` in an
ordinary user terminal does not rename that terminal's tmux window or Zellij
tab. CLI `neta attach` takes over its caller's terminal; only the leader's
`neta_attach` tool opens a fresh tab.

A room gets one more pane of its own, opened when its first member joins:
`neta watch <room-name>` follows the room's merged transcript, every post
rendered as an attributed markdown block, so a debate reads in one place
instead of across its members' panes. The room view holds after the last
member finishes, like a worker pane, and closes with the batch.

Under the default `auto` mode, a multiplexer session you are already inside
wins; outside one, `auto` prefers Zellij, then tmux. An explicit `--mux
zellij` or `--mux tmux` picks that multiplexer regardless. If you are not
inside a session, Neta starts one around the leader; with no multiplexer
available, workers run headless and nothing else changes.

## Terminal handoffs and worker observability

A terminal worker — one driven with `neta attach` in the vendor's native TUI
— reports back to Neta through a persistent wire, so its final state (whether
it committed, its exit status, whether there are uncommitted changes) is
authoritative. That state lands in the worker row and carries through to
recovery when the session is resumed later: `neta workers` and the leader's
`neta_status` always show the worker's true final state.

Worker panes and `neta_inspect` are designed for observability without
intervention. A pane reading the worker's log does not consume it — the leader
pulls the same log independently, and nothing shown in a pane is taken away
from the leader. `neta_inspect` provides a fixed-size recent window that is
never altered by pane activity, so you can verify a worker's behavior from
another terminal without scrolling an open pane. This makes it safe to run
`neta inspect <id>` at any time to see a worker's last activity, including for
headless workers with no pane.

Worker view continuity is maintained through leader restarts and session
recovery: watch panes continue streaming even when the leader reconnects, and
the pane input line keeps working. If a pane's terminal multiplexer is killed
or the pane itself is closed, `neta watch <id>` reopens it in the same or a
different terminal. This is supported by the worker view layer retrying its
stream connection and reconnecting to the multiplexer when needed.

## Worker cost estimation

Worker usage (tokens and cost) appears in the pane footer, the `neta workers`
listing, and the MCP tools' status lines. Most backends report token counts
but not cost. When cost is missing, Neta estimates it from a bundled snapshot
of [models.dev](https://models.dev) pricing data, labeled `est.` to
distinguish it from backend-reported amounts. The snapshot covers Anthropic
and OpenAI models; estimates for other providers are not available. To refresh
the snapshot, run `bun run refresh-pricing` from the repository root.
