# How Neta works

One long-lived process, the Node, owns every workspace, leader, mission,
agent, ACP session, worktree record, event, and stored conversation on a
machine. The terminal client and the per-session tool
proxy all speak to that Node and own nothing themselves. Direction lives
in [MANIFESTO.md](../MANIFESTO.md); install and build in [README.md](../README.md).

## Native terminal client

The development terminal client is the Neta OpenCode V2 fork (2.0.3). Its OpenTUI/SolidJS
shell adds machine/workspace navigation and agent tabs around native OpenCode
chat. The Node starts one OpenCode process per actor and controls its native
session through ACP. An authenticated, per-view HTTP gateway lets the renderer
read that same session while routing sends and cancellation through the Node.
Closing the gateway leaves the runtime alive. This is native OpenCode execution,
not a Codex CLI renderer. See [the integration contract](opencode.md) for setup,
reset, compatibility and validation boundaries. Toad remains an explicit rollback
client; the Claude SDK migration is deferred.

Startup restores the last workspace and selected actor. The client starts a missing
Node and compares the running Node's build identity with its own; an idle service
updates automatically, while live turns defer the update. Opening an actor restores
its saved provider session without sending its assignment again. If the saved tab
is queued or cannot resume (including a removed mission worktree), startup opens
the workspace leader with a visible explanation and retains the tab and history.
Explicit navigation to that unavailable tab reports the error without changing views.

## Delegation model routing

OpenCode children use task difficulty (`effort: 1–5`) and the selected routing
policy rather than inheriting the workspace leader's model. `routing.json`
chooses either five fixed connected models or required Jev classification with
PublicAI and models.dev metadata. Explicit model choices bypass classification.
The whole staffing plan resolves before a mission or worktree is created, and
queued agents retain that resolved model and decision. On a user request,
`neta_model` reroutes a mission lead or worker at a higher or lower task effort
without replacing its session or transcript. See
[model routing](model-routing.md) for configuration, failure behavior and tests.

## The process tree

```text
neta-node                           one per machine, long-lived
  owns: workspaces, leaders, missions, agents, ACP sessions,
        event log, conversation store, access state, writer leases
  listens: ~/.neta/node.sock        Unix socket, JSON-RPC 2.0 NDJSON
    |
    +-- neta                       terminal client (src/cli/main.ts)
    |     starts the Node on demand, attaches to a leader,
    |     lists missions and events, sets access state, stops the Node
    |
    +-- neta mcp --actor <id>      stdio proxy (src/tools/proxy.ts),
          one per ACP session that needs tools; the provider launches
          it, and every tool call travels to the Node over the socket
```

The tree starts in `src/node/lifecycle.ts`, which adapts `src/store/` and
`src/acp/` to the ports in `src/node/server.ts`. No client imports those
stores: the terminal renders only and the proxy forwards
only. Authority sits in exactly one place, so two clients attached at once
always read the same state.

## Why the Node is long-lived, and what happens when a client dies

The Node holds the ACP sessions, and ACP sessions outlive any single
view of them. A leader conversation continues while nobody looks at it,
an agent keeps running while the person who launched it closes the
laptop lid, and a mission stays open across restarts of every client.
That is why the Node runs as its own process with its own lock file
(`src/node/lockfile.ts`) rather than as a child of a terminal or a
window: closing a client must never stop work, and only an explicit
`neta node stop` stops the Node (`src/node/handlers-registry.ts`).

When the terminal client exits, its socket connection closes and its
pending requests reject on close (`src/node/client.ts`), but nothing on
the Node changes. Conversations keep their sessions, missions keep
their states, and the event log keeps appending. A fresh `neta`
invocation reconnects and asks for one current snapshot, so it resumes
exactly where the previous view left off.

When the desktop closes or loses its connection, the same rule applies
with one addition: the server drops that connection's set of tailed
conversations (`src/node/handlers-conversation.ts`). A `turn`
notification reaches only connections that currently tail its session,
so a dead window silently unsubscribes and a reopened window
resubscribes by tailing again. No presence record survives a disconnect;
the Node never treats a silent client as work to finish.

The Node also broadcasts `conversation.ended` metadata to connected clients,
including those viewing another conversation. The Neta TUI uses this signal
for workspace-leader and mission-leader terminal notifications, deduplicated by
session and turn. It does not include transcript text in the notification.
Notifications respect OpenCode's attention settings and require an attached TUI;
terminal and operating-system notification permissions still apply.

When a tool proxy ends, the proxy process exits and leaves no residue. It
keeps no state of its own (`src/tools/proxy.ts`): it authenticates each
call with the actor token from its command line and forwards the call to
the Node. Session, turns, and agent record all remain, so a resumed session
is served by a fresh proxy with no recovery step.

When the Node itself dies, the lock tells the story. `node.lock` names
the pid that holds it; a client that finds a lock naming a dead pid
takes the lock over, and one that finds a live pid backs off with
`ALREADY_RUNNING` (`src/node/lockfile.ts`). On start the Node loads the
stores, marks every agent still recorded as `starting`, `running`, or
`blocked` as `interrupted` while preserving the prior state in
`stateBefore`, appends one `node.restarted` event per affected
workspace, and only then binds the socket (`src/node/lifecycle.ts`).
Interrupted work never replays and never gains a replacement session;
the leader sees the interruption event and decides how to continue.
On stop the Node broadcasts its `node` lifecycle notification, closes
every ACP session it owns, compacts the registries, removes `node.json`
and the socket, releases the lock, and exits (`src/node/lifecycle.ts`).

## The socket protocol

Clients reach the Node over `~/.neta/node.sock`, a Unix socket with
mode `0600`; the protocol never listens on TCP. Framing is one JSON
object per line, newline-terminated UTF-8, in JSON-RPC 2.0
(`src/node/protocol.ts`, `src/node/server.ts`). A line that fails to
parse earns a `-32700` reply while the connection stays open, and a
line past 8 MB closes the connection. `~/.neta/node.json`, also mode
`0600`, carries the socket path, the client token, the pid, the
protocol version, and the start time (`src/node/lockfile.ts`).

The first message on a new connection must be `hello`, carrying the
token, the client kind (`cli`, `desktop`, or `tools`), and the protocol
version (`src/node/protocol.ts`). Any other method first, a wrong
token, or a version other than `PROTOCOL_VERSION` earns one error
reply and a closed connection (`src/node/server.ts`). A successful
`hello` answers with the machine record, the protocol version, the
Node version, and the pid, and from that point the connection receives
broadcasts until it closes.

Requests cover the whole surface: `snapshot`, `workspace.open`,
`workspace.list`, `missions.list`, `missions.get`, `events.list`,
`conversation.tail`, `conversation.untail`, `conversation.prompt`,
`conversation.cancel`, `conversation.capabilities`,
`conversation.prepareHandoff`, `conversation.setProvider`,
`conversation.reset`,
`conversation.setModel`, `providers.list`, `models.list`,
`leader.setMode`, `mission.pin`, `agent.archive`, `node.stop`, and the
two actor-authenticated tool routes `tools.list` and `tools.call`
(`src/node/protocol.ts`). Cursors are opaque strings minted by the
store and passed back verbatim; an absent `nextCursor` marks the end
of history. Beyond the standard JSON-RPC codes the Node reports
`UNAUTHORIZED`, `PROTOCOL_MISMATCH`, `NOT_FOUND`,
`CONFIRMATION_REQUIRED`, `BUSY`, and `PROVIDER_ERROR`, with the
symbolic name in `error.data` so clients switch on the name
(`src/node/protocol.ts`).

Protocol version 2 adds structured `plan` and `usage` conversation blocks
and attachments. `conversation.capabilities` reports whether the active ACP
session accepts images or embedded files. `conversation.prompt` accepts text
plus up to ten attachments, capped at 4 MiB each and 5 MiB total. Images map
to ACP image content and files to embedded resources only when the provider
advertises the matching capability. Conversation history stores attachment
id, kind, name, MIME type, and size, never the base64 payload. Tool updates
reuse their tool-call identity, and usage updates merge into one compact block
at the turn boundary. A newly installed CLI may greet an older Node with the
version in its authenticated descriptor solely to request `node.stop`; normal
clients still require an exact protocol match.

Notifications flow one way, from the Node to every connection past
`hello`; a client never polls (`src/node/server.ts`). There are four
kinds (`src/node/protocol.ts`):

- `event` carries one event from the log;
- `state` carries a mission, agent, or leader record after a change;
- `turn` carries a turn or block appended to a conversation, and
  reaches only connections that tailed that session;
- `node` announces lifecycle phases such as stopping.

A connection that falls 1000 notifications behind is dropped; it
reconnects and snapshots (`src/node/server.ts`).

There is no "changes since revision" exchange, by design. One
`snapshot` call returns a complete `SnapshotResult` — machine,
workspaces, leaders, open missions plus closed ones inside the window or
among the newest eight per workspace,
the visible agents, per-mission completed counts, the recent events,
and the attention set — and the client atomically replaces its whole
cache with it (`src/node/snapshot.ts`, `src/node/protocol.ts`). Live
notifications then keep that cache current on the same connection.
Revisions never skew, because no client ever merges a delta into a
stale base: it either holds the latest snapshot plus the stream, or it
holds nothing and snapshots again.

## The store layout under `~/.neta/`

Everything the Node owns lives in files under `~/.neta/`, or under the
directory named by `NETA_DIR` when that variable is set
(`src/store/paths.ts`). The layout is fixed:

```text
~/.neta/
  settings.json                     providers and leader defaults
  node.json                         socket path, token, pid, version
  node.sock                         the Unix socket
  node.lock                         the single-instance lock
  machine.json                      the machine identity
  workspaces/<id>.json              one record per workspace
  leaders/<id>.json                 leader record incl. access state
  missions/<id>/
    counter                         next mission number
    registry.ndjson                 append-only mission deltas
    registry.snapshot.json          periodic compaction of the log
  events/<id>/<yyyy-mm>.ndjson      append-only event lines
  events/<id>/seq                   next event sequence number
  conversations/<session>.ndjson    append-only turn and block lines
  conversations/<session>.meta.json provider, model, vendor session id
  worktrees/<id>.json               lease state and queue
  charters/<id>.hash                last seen charter hash
```

The module in `src/store/paths.ts` is the one place that knows these
paths, and it resolves `NETA_DIR` afresh on every call, so a test
points the whole tree at a temp directory by setting one variable.
Every write is atomic — temp file in the same directory, `fsync`,
rename, `fsync` the directory — directories carry mode `0700`, files
carry mode `0600`, and NDJSON files grow by append only
(`src/store/files.ts`). A truncated final line reads back as a warning
with the earlier records intact; a corrupt line anywhere else is an
error, never a silent skip (`src/store/files.ts`).

Single-record stores hold the machine identity, the workspace records,
and the leader records; the first load creates the file, so two
callers can never disagree about the machine id
(`src/store/records.ts`). The mission registry loads its snapshot and
replays the delta log on top at Node start, indexes every mission by
id, number, and time (`src/store/mission-index.ts`), and compacts the
log into a fresh snapshot before emptying it, so a crash between the
two steps replays idempotently (`src/store/mission-registry.ts`). The
event log stamps each event with wall time and a per-workspace
monotonic sequence number, files lines by UTC month, and repairs a
missing sequence file upward from the newest month file
(`src/store/event-log.ts`). Conversations append one line per turn or
block and serve reads by byte-offset cursor, so a client tails a live
conversation by passing the previous cursor back and the Node never
loads a whole history into memory (`src/store/conversations.ts`).

## Missions

A mission is one bounded objective in one workspace, and it carries a
permanent number. The registry hands out numbers from the per-workspace
counter — 1, 2, 3, across restarts — and a number is never reused and
never reassigned, including after close
(`src/store/mission-registry.ts`, `src/core/numbering.ts`). People
address missions by number (`neta mission 7`); the ULID underneath is
an implementation detail (`src/core/ids.ts`).

A mission is always in exactly one state (`src/core/types.ts`):

```text
running | blocked | failed | readyToClose | mergedNotClosed | closed
```

`blocked` means the mission waits on a person, `failed` marks work
that ends in error, `readyToClose` marks work awaiting leader review,
and `mergedNotClosed` marks work integrated into the base checkout but
still awaiting formal closeout. The attention set in a snapshot —
the inbox behind the mission bar — holds exactly the missions that
need a person: blocked, failed, ready to close, and merged but not
closed, newest first (`src/core/state.ts`, `src/node/snapshot.ts`).

Closing is a deliberate act with evidence. Closeout demands a
disposition, `completed`, `merged`, or `abandoned` (`src/core/types.ts`); a merge
closeout demands integration evidence confirmed against the base, and
completed checks need no merge evidence but retain clean/unmerged-worktree
checks, and an abandon closeout demands a non-empty reason
(`src/worktrees/closeout.ts`). Pinning a mission (`mission.pin`)
appends a `user.pinned` event and changes no mission field
(`src/node/handlers-registry.ts`).

A closed mission never leaves the registry. Compaction rewrites the
snapshot from every mission including closed ones and only then
empties the delta log, so close is a state change, not a deletion
(`src/store/mission-registry.ts`). Snapshots include closed missions
inside the window and always retain the newest eight missions per workspace,
even after a long idle period. They report `hasOlder` when other closed
missions are omitted. The TUI shows those eight in start-time order alongside
all active missions; closing one marks it archived without hiding it. The
Archive control reveals older history without duplicating the recent rows.
On the canvas a closed mission stays anchored at its start
position, marked archived, opening read-only
(`src/node/snapshot.ts`, [MANIFESTO.md](../MANIFESTO.md)).

## Agents and the name pool

Agents do the work inside a mission. An agent record carries its
mission, its ACP conversation id, its provider and model, its access
(read-only or read-write), its task, and its state
(`src/core/types.ts`). The states are `starting`, `running`,
`idle`, `blocked`, `failed`, `completed`, `interrupted`, and `archived`
(`src/core/types.ts`). A mission lead creates agents beneath itself;
an ordinary agent creates nothing further, so the tree stays three
levels deep and cannot grow without bound
([MANIFESTO.md](../MANIFESTO.md), `src/tools/handlers/`).

Display names come from a fixed pool. `src/core/names.ts` holds
`NAME_POOL` plus `pickName`, which selects a name unused among the
open missions of the workspace, so every name on screen is unique
where it matters. The name is presentation; identity is the ULID.

Visibility follows the archive rule. A snapshot carries every
non-archived, non-completed agent of the missions in scope, plus the
eight most recently ended completed agents per mission, with
`completedCounts` counting all unarchived completed agents; archived
agents never appear (`src/node/snapshot.ts`). Archiving a `starting`
or `running` agent requires explicit confirmation, closes its ACP
session first, and only then archives it; every other state archives
at once (`src/node/handlers-registry.ts`). When the Node restarts,
agents left in `starting`, `running`, or `blocked` return as
`interrupted` with the prior state preserved, and the leader decides
what resumes (`src/node/lifecycle.ts`).

## Worktrees and the single writer lease

Every Git mission receives its own worktree by default, including
missions that only investigate. Neta never runs `git worktree`
itself: Worktrunk owns creation, naming, integration, and removal,
and Neta invokes the `wt` binary and verifies the result
(`src/worktrees/wt.ts`, `src/worktrees/driver.ts`).

The Worktrunk runner augments the service's inherited `PATH` with standard
per-user, Homebrew, and system binary locations on every launch. This makes a
`wt` installed at `~/.local/bin`, `/opt/homebrew/bin`, or `/usr/local/bin`
available when Finder starts the app with a minimal environment. An explicit
`NETA_WT_BIN` remains authoritative. If no executable is available, mission
creation returns a direct Worktrunk installation error rather than stalling.
Branches read `mission/<number>-<slug>`, with the slug derived from the mission name
(`src/worktrees/naming.ts`); the base defaults to the workspace
default branch, detected once per workspace and cached in memory
(`src/worktrees/driver.ts`). The base checkout itself is an
integration surface: closeouts that merge into it serialize, so two
missions never integrate concurrently (`src/worktrees/leases.ts`).

Each worktree admits at most one active writer. A mission whose access
is read-write acquires the lease for its worktree path; further
writers queue first-in first-out, and the queue persists in
`worktrees/<workspace>.json` (`src/worktrees/leases.ts`). Read-only
missions take no lease and run without limit. Folders outside Git
have no worktree isolation, so the lease key is the workspace root:
any number of read-only missions run together while writing missions
take the single lease in turn (`src/worktrees/leases.ts`). The base
checkout carries its own lease under the name `base`, taken by every
closeout (`src/worktrees/leases.ts`).

Merge detection stays read-only and runs only at four trigger points:
agent finish, the ready call, the close call, and workspace open. No
timer and no watcher ever calls it (`src/worktrees/index.ts`). The
check resolves the branch tip and the base tip through plain Git and
tests ancestry with `merge-base --is-ancestor`; on the first positive
result the mission records its integration evidence and emits
`mission.merged` exactly once (`src/worktrees/integration.ts`,
`src/worktrees/index.ts`). Closeout also accepts a squash commit on the base
when its full change matches the mission branch's change exactly, including
file contents and modes. The driver rechecks this evidence against the current
branch before removal; a stored merge result cannot discard later branch work.
These checks do not fetch or change the base checkout. A refused removal — dirty tree, unmerged
branch without an explicit abandon — leaves the mission open with its
worktree intact and its attention set to the refusal reason
(`src/worktrees/closeout.ts`).

## Lead and Lead++

Only leaders use access modes: the workspace leader and each mission
lead. Ordinary agents receive fixed read-only or read-write access
from their lead and never change it. The two modes are `lead` —
coordination without a Neta writer lease — and `lead++`, which adds build and
write authority ([MANIFESTO.md](../MANIFESTO.md), `src/modes/switch.ts`).
Both workspace and mission leaders select the provider's advertised
unrestricted ACP mode in either leadership mode. Ordinary agents keep the
provider sandbox implied by their assigned access.

OpenCode read-only agents may read, search, fetch, and run shell commands,
including reading downloaded evidence outside the worktree. Neta still denies
edit requests and unknown permission kinds for these agents. Permission denials
are reported as policy-neutral denials rather than attributed to the user.
Delegated skills resolve from project and user `.neta`, `.agents`, `.claude`, and
`.opencode` skill directories, plus user `.config/opencode/skills`; project
definitions take precedence. Both flat Markdown and `name/SKILL.md` work.

When a Neta Code Mode batch fails, already admitted calls settle before its error
is returned, and the response includes each call's result. A successful agent
launch remains visible even when another launch fails validation. Explicit
cancellation and timeouts still interrupt; interrupted outcomes must be checked
in current state before retrying. Agents are instructed to use `Promise.allSettled`
and inspect each independent launch result.

The workspace leader's mode lives on its leader record as `mode`,
`modeSince`, and `modeActiveMs`; each mission lead's mode lives as a
`LeadMode` entry keyed by agent id in the same leader file under the
`leadModes` field (`src/modes/records.ts`, `src/store/records.ts`).
Every leader starts in `lead`. The mode persists across client and
Node restarts.

Two paths change a mode, under one grant rule. `leader.setMode` is
the manual path: a person sets one selected leader from a client, with
no decision record (`src/node/handlers-registry.ts`,
`src/modes/service.ts`). `neta_mode` is the tool path: the leader
itself requests `lead++` with a decision record stating its objective,
why `lead` falls short, the target mission and worktree, the kind of
mutation, the files affected, the validation plan, the expected
duration, and the destructive or external effects
(`src/modes/approval.ts`). The request is approved only when the
record is complete, the named mission exists and is open, the caller
leads that mission or the workspace, and the charter reserves neither
the mutation kind nor the external effects; anything else is denied
with a reason, never put to the user as a question
(`src/modes/approval.ts`). Only the `## Reserved for the user` section
of `CHARTER.md` is parsed — its bullet lines, matched
case-insensitively with collapsed whitespace — and the rest of the
charter stays prose for the model (`src/modes/approval.ts`).

Every change travels one switch path: cancel the active turn at the
steering boundary, switch Neta session access (`lead++` maps to
read-write, `lead` to read-only), preserve the leader's unrestricted provider
mode, then re-prompt the same session
with a short access-change message (`src/modes/switch.ts`,
`src/acp/steer.ts`, `src/acp/access.ts`). With no active turn the
cancel is a no-op and the re-prompt still lands. `lead++` grants no
writer lease by itself — a `lead++` leader that writes acquires one
from the lease manager like any other writer (`src/worktrees/leases.ts`).

The clock counts active connected time only. `modeActiveMs` accrues
while at least one client connects to the Node, persists every 30
seconds in `lead++` and on every change, and resumes from the stored
value after a restart; the modes module holds no timers, and the Node
drives `tick` (`src/modes/clock.ts`, `src/node/lifecycle.ts`). At ten
active minutes the Node emits `leader.modeReminder` once for the
canvas warning strip; after that a reminder falls due every two
further active minutes and arrives at the next safe tool or turn
boundary, with concurrent reminders coalescing into one
(`src/modes/reminders.ts`). Every tool response to a subject in
`lead++` carries one banner line, `Lead++ active <n> min · #<number>
<name>`, plus a due reminder as a second line; `lead` responses carry
nothing (`src/modes/service.ts`). Nothing expires on its own: the
leader returns to `lead` when mutation work ends, and closing or
abandoning a mission returns its lead to `lead` automatically
(`src/modes/service.ts`, `src/worktrees/closeout.ts`).

## The clients and what each can and cannot do

The `neta` CLI is a thin client over the socket
(`src/cli/main.ts`, `src/cli/client.ts`). It opens the workspace for
the current directory and attaches to its leader conversation, starts
the Node on demand when no live Node answers, lists missions and
events, reads and sets access state, and stops the Node. Only `neta`
with no command and `neta open` start a Node; `neta node status`
reports without starting anything, and `neta node stop` is the single
operation that stops one (`src/cli/commands/node.ts`). The terminal
chat opens the same exact ACP session as other attached clients, so all
views see each other's turns (`src/cli/chat.ts`). The CLI owns no
sessions, no store, and no ACP runtime — every command is a protocol
call plus formatting. Setting `lead++` from the CLI is always the
manual path, a person's own choice with no decision record; records
belong to the leader's own tool requests, never to a client
(`src/cli/commands/leader.ts`).

The OpenCode/OpenTUI shell is the supported interactive client; the Node protocol
remains shared with command-line controls. Its left spine is the navigation
surface, with workspace, machine, archive, delivery, and reset actions under
**Help · actions**.

The `neta mcp --actor <id>` proxy is a stdio MCP server the provider
launches inside the agent session (`src/tools/proxy.ts`,
`src/cli/commands/mcp.ts`). It requires the actor id and token on its
command line, authenticates each tool call with them, and forwards the
call to the Node over the socket. It parses no MCP traffic and adds
no behavior of its own; its stdout carries MCP framing only. Provider
settings, leader defaults, and forbidden models live in
`$NETA_DIR/settings.json` with per-project overrides, described in
[settings](settings.md) (`src/acp/settings.ts`).

Workspace overrides are loaded for the actual session working directory, so
provider launch, availability, and model selection use the same effective
settings. Live model options come from ACP session configuration and are
replaced when `config_option_update` arrives; before launch, only a configured
non-empty default can be shown.

`conversation.reset` replaces the selected owner session atomically with a
fresh provider and vendor conversation. It keeps provider, model, access,
leader sandbox policy, MCP actor authority, and current role/mission brief. The
brief is supplied as refreshed system context for native OpenCode, and attached
once to the first new user prompt for other providers; no old transcript or
provider handoff is included. The owner record is durably rebound before the
old session is retired, and a candidate launch or rebind failure leaves the old
chat usable. Old conversation files remain stored. Queued and archived agents
cannot be reset.

When an ACP actor ends a turn, the runtime sends an automatic report to its parent: workers to their mission lead, mission leads to the workspace leader (self-led mission workers go directly to the workspace leader). The report includes the actual model and final transcript excerpt. It uses the durable inbox to wake an idle parent or queue behind active work. Unacknowledged deliveries persist on the actor and retry; duplicate turn reports are suppressed. A normal turn ending without explicit completion marks the actor idle and resumable; cancellation marks it interrupted. Neither marks the mission complete. A mission lead calls `neta_ready` without an ID to record its own completed handoff; the workspace leader uses the public mission number to close it. Successful checks close as `completed`, merges require commit evidence, and abandonment is reserved for intentionally discarded work. Repeating the same close is idempotent. Closed missions and archived actors do not wake parents. Model fallback updates the stored actor model and conversation metadata.

Workspace leader activity follows runtime turns too: running from turn start,
including thinking before the first response, idle after completion or cancellation,
and failed after a provider error. State changes reach every attached client.
Late events from previous turns or bindings cannot stop a newer execution. A Node
restart clears stale running indicators before serving its first snapshot.

Automatic reports include a runtime snapshot of the other agents in that mission,
separate from the agent's own summary. An idle lead with no executing or queued
agents is explicitly reported as unfinished idle work. The parent must continue
that work or state a real blocker; an agent's claim that a worker is running is
not execution evidence. `neta_status` identifies the caller and each agent's role,
and reports executing/queued counts separately from the mission lifecycle state.
`neta_send` refuses a self-target before touching any session.


Provider errors mark an actor failed, separately from user cancellation. The
snapshot and `neta_status` derive mission attention from actor failures and
pending questions. A workspace leader can use `neta_ask` with the public mission
number even when the work is delegated rather than its own active mission.

`neta_send` persists a follow-up before admission and returns its message ID and
inbox status. Busy actors receive it at a turn boundary without cancellation.
Identical retries within the sender's turn reuse the same receipt. Queued writers
retain messages without bypassing the lease. Completed or failed actors resume
their exact conversation after writer admission; failed admission leaves the
message queued and emits a recovery error. Closed missions require explicit
continuation. Restart recovery resumes saved queued follow-ups.

Interrupted or failed ordinary writers release ownership only after their session
has closed. The next queued writer then starts. Restart recovery respects lease
queue order. Parent reports distinguish pending inbox delivery from provider
acceptance; uncertain receipts remain visible in `/delivery` and are not blindly
replayed. A provider transport failure does not justify automatic replay after
output or possible tool side effects.

Delegation supports task instructions up to 16,000 characters and shared mission
objectives up to 32,000. `/routing` includes sanitized routing failures; classifier
validation identifies the failed constraint without logging raw responses.
