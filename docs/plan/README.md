# Neta v3 rebuild plan

This directory is the implementation plan for rebuilding Neta from scratch
against [MANIFESTO.md](../../MANIFESTO.md). Every file here is written so a
small agent can execute one task from it without reading anything else except
the files the task names. The manifesto is the product spec; this plan is the
engineering spec. When they disagree, the manifesto wins and the plan is wrong.

The current code (npm `@intervene/neta` 2.2.x, `src/`, `apps/macos/`) is retired. It is
tagged `v2-final` and stays readable in Git history and in the two appendices
in this directory. Nothing from it is imported; ideas are.

## How to read this plan

| File | Workstream | Depends on |
|---|---|---|
| `00-reset.md` | Repo reset, scaffold, CI | nothing |
| `01-domain.md` | Domain types, ids, state machines (the contract every other workstream imports) | 00 |
| `02-store.md` | Durable store: registry, event log, conversations, leader state | 01 |
| `03-acp.md` | ACP runtime: providers, sessions, streams, access enforcement | 01 |
| `04-node.md` | The Neta Node service and its socket protocol | 01, 02, 03 |
| `05-tools.md` | Neta tools served to leaders, mission leads and agents over MCP | 01, 02, 03, 04 |
| `06-worktrees.md` | Worktrunk worktrees, writer leases, merge detection, closeout | 01, 02, 05 |
| `07-modes.md` | Lead and Lead++ | 01, 02, 03, 05 |
| `08-cli.md` | The `neta` command line client | 04 |
| `09-desktop-shell.md` | macOS app: window, Node client, store, glass, navigator, mission bar | 04 |
| `10-desktop-spine.md` | The spine canvas | 09 |
| `11-desktop-chat.md` | Chat: turns, streaming, composer controls, model picker, Details | 09 |
| `12-release.md` | Packaging, versioning, publishing | all |
| `appendix-v2-engine.md` | Map of the retired engine, for reference only | — |
| `appendix-v2-desktop.md` | Map of the retired desktop app, for reference only | — |

Workstreams 02 and 03 can run in parallel once 01 is merged. 05, 06 and 07
can run in parallel once 04 is merged. 09 can start as soon as the protocol
in 04 is merged, against a recorded fixture. 10 and 11 can run in parallel
once 09 is merged.

## Task format

Every task in a workstream file has this shape. Do not start a task that is
missing any of these; ask the leader to complete it first.

```
### T<workstream>.<n> <title>
Goal: one sentence.
Reads: files the agent must read first (paths). Nothing else is assumed.
Writes: files the agent may create or change. Anything else is out of scope.
Contract: the exact exported names, types or protocol messages this task
  produces, so the next task can depend on them without reading the code.
Steps: numbered, concrete.
Tests: the test file to write and what each test proves. Tests use
  test/fixtures/fake-acp-agent.mjs for anything ACP; never a real provider.
Done when: `bun run check` and `bun test` (or `swift build` and `swift test`
  for Swift) pass, the tests listed exist and pass, and the commit is made.
Commit: `<type>: <message>` exactly as given.
```

Tasks within a workstream are ordered; each assumes the previous ones are
merged. A task should be one sitting for a small agent: one module, one test
file, one commit. If a task turns out to be bigger, split it and record the
split in the workstream file before continuing.

## Working rules for agents on this plan

These restate [AGENTS.md](../../AGENTS.md) for the rebuild:

- TypeScript strict, no `any`, top-level imports only, erasable syntax only.
  Bun for install, test, build; `tsc` for typecheck. Direct deps pinned exact.
  No new runtime dependency without a line in the task that names it.
- The published artifact is a Node-runnable bundle. Nothing in `src/` may
  import a Bun-only module (`bun:sqlite`, `bun:ffi`, `Bun.*`). Tests may use
  Bun's test runner.
- Swift: Swift 6 language mode, macOS 26 minimum, Swift Package Manager, no
  Xcode project, no external Swift dependencies without a line in the task.
- Stage explicit paths. One commit per task with the message given. Never
  `git add -A`, never reset or stash.
- A writer commits everything it changed before it finishes.
- Do not expand scope. If the task cannot be done as written, stop and report
  what is wrong with it instead of improvising around it.

## Architecture

### Processes

```
neta-node (TypeScript, one per machine, long-lived)
  owns: workspaces, leaders, missions, agents, ACP sessions, worktrees,
        event log, conversation store, modes, writer leases
  listens: ~/.neta/node.sock (Unix domain socket), NDJSON JSON-RPC 2.0
  serves:  neta MCP tools to leaders/leads/agents via stdio proxies

neta (TypeScript CLI, thin client of the Node)
  starts the Node on demand; attaches to a leader's conversation in the
  terminal; lists missions and events; changes modes; stops the Node.

NetaDesktop (SwiftUI, macOS 26, thin client of the Node)
  connects to the same socket; renders the spine, mission bar, navigator,
  chat; never owns a session.

neta mcp --actor <id> (TypeScript, one per ACP session that needs tools)
  a stdio MCP server the provider launches; every tool call is forwarded to
  the Node over the socket with the actor's token.
```

Closing a client never stops the Node. `neta node stop` stops the Node and
only the processes it owns. On reconnect a client asks for one complete
snapshot and replaces its cache; then it follows notifications on the same
connection. There is no "changes since revision" protocol.

### Source layout

```
src/
  core/        01: types, ids, numbering, state machines, agent name pool
  store/       02: registry, events, conversations, leader state (files)
  acp/         03: providers, session wrapper, streams, access enforcement
  node/        04: server, protocol, auth, snapshot, subscriptions, lifecycle
  tools/       05: MCP tool server and the stdio proxy
  worktrees/   06: Worktrunk driver, writer leases, merge detection
  modes/       07: Lead and Lead++ state, decision records, reminders
  cli/         08: the neta command
apps/macos/    09–11: NetaDesktop Swift package
test/          Bun tests; test/fixtures/fake-acp-agent.mjs is kept verbatim
design/        design working files (kept)
docs/plan/     this plan
```

### Storage

Everything lives under `~/.neta/` (override `NETA_DIR`), files only, 0700
directories and 0600 files, atomic rename on every write. No database until
measurement forces one; the escalation path is `node:sqlite`, and the store
module is the only place that would change.

```
~/.neta/
  settings.json                   providers, leader defaults (03)
  node.json                       socket path, token, pid, protocol version
  node.sock
  node.lock                       exclusive start lock (04)
  machine.json                    {id, name, createdAt}
  workspaces/<workspaceId>.json   Workspace record
  leaders/<workspaceId>.json      Leader record incl. mode state
  missions/<workspaceId>/
    counter                        next mission number, written atomically
    registry.ndjson                append-only MissionRecord deltas
    registry.snapshot.json         periodic compaction of the above
  events/<workspaceId>/<yyyy-mm>.ndjson   append-only Event lines
  events/<workspaceId>/seq                next event sequence number
  conversations/<sessionId>.ndjson        append-only Turn/Block lines
  conversations/<sessionId>.meta.json     provider, model, vendor session id
  worktrees/<workspaceId>.json    lease state and queue
  charters/<workspaceId>.hash     last seen charter hash, for change events
```

The registry is loaded into memory at Node start (snapshot plus tail) and
indexed by number and by time. Conversations are never loaded whole; they are
tailed by cursor.

### Protocol summary

JSON-RPC 2.0 over NDJSON on the Unix socket. The first message from a client
is `hello`. Full message list in `04-node.md`; the shape is fixed here so
09–11 can start against a fixture:

- Requests: `hello`, `snapshot`, `workspace.open`, `workspace.list`,
  `missions.list`, `missions.get`, `events.list`, `conversation.tail`,
  `conversation.prompt`, `conversation.cancel`, `conversation.setModel`,
  `models.list`, `leader.setMode`, `mission.pin`, `agent.archive`,
  `node.stop`.
- Notifications from the Node: `event` (one Event), `state` (a Mission or
  Agent or Leader record after a change), `turn` (a Turn or Block appended to
  a conversation), `node` (lifecycle: restarting, stopping).

### Identity

- `machineId`: ULID generated once, stored in `machine.json`.
- `workspaceId`: for Git, the canonical remote identity (host, owner, repo,
  after normalising SSH and HTTPS forms); for a folder, `folder:` plus the
  absolute path hash. Two clones of one repo on one machine are the same
  workspace with two roots.
- `missionId`: ULID. `mission.number`: integer, monotonic per workspace,
  never reused, never renumbered.
- `agentId`: ULID. Agent display names come from a fixed name pool in
  `core/names.ts`; a name is unique within a workspace's open missions.
- `sessionId`: the ACP conversation id as stored by Neta, distinct from the
  provider's own `vendorSessionId`.
- `turnId`: ULID per prompt/response pair; every Block carries its turnId.

### State machines

Defined exactly in `01-domain.md`. In short:

- Mission: `running | blocked | failed | readyToClose | mergedNotClosed |
  closed`, plus `disposition: merged | abandoned` once closed. Closed
  missions never leave the registry.
- Agent: `starting | running | blocked | failed | completed | interrupted |
  archived`.
- Leader mode: `lead | leadPlus` with active-time accounting.

## Phases

1. **Foundation** (00, 01, 02, 03): the repo is reset, the domain compiles,
   the store persists and restores, ACP sessions run against the fake agent.
2. **Node** (04, 05): a Node serves snapshots and events; a leader launched
   through it can create a mission with one tool call and the mission appears
   in `snapshot`.
3. **Authority and isolation** (06, 07): worktrees per Git mission, writer
   leases, merge detection, closeout; Lead and Lead++ with decision records
   and reminders.
4. **Clients** (08, 09, 10, 11): the CLI attaches to a leader; the desktop
   renders the spine, mission bar, navigator and chat from a live Node.
5. **Release** (12): app bundle, npm 3.0.0, docs rewritten.

Definition of done for the whole plan: the Paper artboards "Neta · Spine",
"Neta · Typical day" and "Neta · Navigator open" can be reproduced on a real
Node with the fake agent driving fourteen missions, and every manifesto MUST
in `design/canvas-directions/BRIEF.md` holds in the running app.

## Things this plan deliberately does not do

- Multi-machine sync. One machine, the machine level exists in the model and
  is hidden in the UI.
- Leader conversation compaction and memory. The conversation store is
  append-only and unbounded; compaction is a later program.
- Mobile clients.
- A migration from v2 checkpoints. v2 sessions are not imported.
