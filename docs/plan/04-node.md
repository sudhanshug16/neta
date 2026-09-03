# 04 — Node

`src/node/` is the Neta Node: one long-lived process per machine owning
workspaces, leaders, missions, agents, ACP sessions, the event log and the
conversation store, serving all of it over one Unix socket. The CLI (08), the
desktop (09–11) and the tools proxy (05) are thin clients with no authority.

Read first: `docs/plan/README.md` (Architecture, Storage, Protocol summary),
`docs/plan/01-domain.md`, `MANIFESTO.md` sections "Neta on each machine",
"Workspaces and machines", "Clients, cache, and offline state", "The mission
inbox".

## Transport and handshake

Unix domain socket `~/.neta/node.sock` (`NETA_DIR` overrides `~/.neta`), mode
0600, no TCP ever. Framing is one JSON object per line, `\n`-terminated, UTF-8,
JSON-RPC 2.0; a line that does not parse gets `-32700` and the connection stays
open, a line over 8 MB closes it. `~/.neta/node.json`, mode 0600, holds
`{socket, token, pid, protocolVersion, startedAt}`, the token 32 random bytes as
hex. The first message must be `hello`: any other method first, a wrong token,
or a `protocolVersion` other than `PROTOCOL_VERSION` gets one error response,
then the connection is destroyed.

## Requests

`src/node/protocol.ts` is wire types only, so any client can import it alone.

```ts
export const PROTOCOL_VERSION = 1;
export type ClientKind = "cli" | "desktop" | "tools";
hello {token, client: ClientKind, protocolVersion}
   -> {machine: Machine, protocolVersion, nodeVersion, pid}
snapshot {workspaceId?: WorkspaceId, windowDays?/*14*/} -> SnapshotResult
workspace.open {path: string} -> {workspace: Workspace, leader: Leader}
workspace.list {} -> {workspaces: Workspace[], leaders: Leader[]}
missions.list {workspaceId, state?: MissionState, from?: IsoTime, to?: IsoTime,
   limit?/*50*/, cursor?} -> {missions: Mission[], nextCursor?: string}
missions.get {missionId} -> {mission: Mission, agents: Agent[]}
events.list {workspaceId, from?: IsoTime, to?: IsoTime, limit?/*200*/, cursor?}
   -> {events: Event[], nextCursor?: string}
conversation.tail {sessionId, limit?/*200*/, cursor?, turnId?,
   direction?: "forward" | "backward" /*forward*/}   // also subscribes
   -> {sessionId, turns: Turn[], blocks: Block[], nextCursor?: string,
       prevCursor: string | null, provider: string, model: string}
conversation.untail {sessionId} -> {sessionId}  // same for .cancel
conversation.prompt {sessionId, text} -> {turnId: TurnId}
conversation.setModel {sessionId, model} -> {sessionId, model}
models.list {sessionId?, provider?} -> {models: {id, name, provider}[]}
leader.setMode {workspaceId, mode: LeaderMode, missionId?} -> {leader: Leader}
mission.pin {missionId, pinned: boolean} -> {missionId, pinned}
agent.archive {agentId, confirm?: boolean} -> {agent: Agent}
node.stop {} -> {stopping: true}
tools.list {actorId, token} -> {tools: {name, description, inputSchema}[]}
tools.call {actorId, token, name, arguments} -> {content: [...], isError}
```

Cursors are opaque store-minted strings passed back verbatim; an absent
`nextCursor` means the end of history. `mission.pin` appends a `user.pinned`
event with `data: {pinned}` and changes no `Mission` field — 01 has none.
`leader.setMode` sets `mode`/`modeSince` and appends `leader.modeChanged`; 07
replaces its body for the Lead++ clock, and its `missionId` targets that
mission's lead instead of the workspace leader. It is 07's manual path and
takes no decision record. `conversation.tail` with a `turnId` returns the page
starting at that turn (02's `turnRange`), and with `direction: "backward"` the
page before `cursor` through 02's `readBefore`; `prevCursor` is the offset
before the first block returned, `null` at the start of history. The two `tools.*` requests are
authorised by the actor token 05 mints, not the client token, and are answered
by 05's router; 04 only routes them. `agent.archive` on a `starting` or
`running` agent needs `confirm: true`, else `CONFIRMATION_REQUIRED`; the ACP
session closes before the agent is archived, and other states archive at once.

Beyond the standard codes (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`) the
Node uses `-32000` `UNAUTHORIZED`, `-32001` `PROTOCOL_MISMATCH`, `-32002`
`NOT_FOUND`, `-32003` `CONFIRMATION_REQUIRED`, `-32004` `BUSY`, `-32005`
`PROVIDER_ERROR`; `error.data` carries `{code}`, so clients switch on the name.

## Notifications

The Node never polls a client; a client never polls the Node.

```ts
event {event: Event}
state {kind: "mission" | "agent" | "leader", record: Mission|Agent|Leader}
turn  {sessionId: SessionId, turn?: Turn, block?: Block}
node  {phase: "restarting" | "stopping"}
```

Every connection past `hello` receives `event`, `state` and `node`; `turn` only
reaches connections that tailed that `sessionId`, until `untail` or close. A
connection 1000 notifications behind is dropped; it must reconnect and snapshot.

## Snapshot

One `snapshot` replaces a client's whole cache; there is no revision protocol.

```ts
export interface SnapshotResult {
  machine: Machine; workspaces: Workspace[]; leaders: Leader[];
  missions: Mission[];   // every open mission + closed within windowDays
  hasOlder: boolean;     // closed missions exist outside the window
  agents: Agent[];       // all starting|running|blocked|failed|interrupted,
                         // plus up to 8 most recent completed per mission
  completedCounts: Record<MissionId, number>;  // completed, unarchived, total
  events: Event[];       // last 200 per workspace, or windowDays if fewer
  attention: Mission[];  // needsPerson(mission), newest first
  windowDays: number; protocolVersion: number; at: IsoTime;
}
```

`attention` is the mission bar's inbox — `blocked | failed | readyToClose |
mergedNotClosed`, per `needsPerson` in 01; a `workspaceId` param narrows every
array, and archived agents never appear at all.

## Ports

04 never imports `src/store` or `src/acp`: `src/node/server.ts` declares these,
and only `src/node/lifecycle.ts` adapts 02 and 03 to them, so handlers stub.

```ts
export interface NodeStore {
  machine(): Machine;  listWorkspaces(): Workspace[];  listLeaders(): Leader[];
  listMissions(workspaceId?: WorkspaceId): Mission[];
  listAgents(missionId?: MissionId): Agent[];
  getWorkspace(id: WorkspaceId): Workspace | undefined;
  getLeader(id: WorkspaceId): Leader | undefined;
  getMission(id: MissionId): Mission | undefined;
  getAgent(id: AgentId): Agent | undefined;
  putWorkspace(w: Workspace): Promise<void>;  putAgent(a: Agent): Promise<void>;
  putLeader(l: Leader): Promise<void>;  compact(): Promise<void>;
  appendEvent(e: Omit<Event, "seq" | "at">): Promise<Event>;
  listEvents(q: EventsListParams): Promise<EventsListResult>;
  tailConversation(id: SessionId, q: {limit: number; cursor?: string}):
    Promise<Omit<ConversationTailResult, "sessionId">>;
}
export interface NodeAcp {
  createSession(o: {workspaceId: WorkspaceId; cwd: string; provider: string;
    model: string; access: Access; mcpServers: McpServerSpec[]}):
    Promise<{sessionId: SessionId; provider: string; model: string}>;
  prompt(id: SessionId, text: string): Promise<TurnId>;
  setModel(id: SessionId, model: string): Promise<void>;
  listModels(o: ModelsListParams): Promise<ModelsListResult["models"]>;
  cancel(id: SessionId): Promise<void>;  close(id: SessionId): Promise<void>;
  closeAll(): Promise<void>;
  onTurn(fn: (n: TurnNotification) => void): void;
}
```

04 writes no `Mission` — 05, 06 and 07 do. `McpServerSpec` is 03's stdio
server descriptor; the Neta tools server (05) is the only entry 04 adds.

## Lifecycle

`startNode()`, in this order: (1) take the exclusive lock `~/.neta/node.lock`,
failing fast if a live pid holds it; (2) load the stores; (3) for every agent in
`starting`, `running` or `blocked`, set `stateBefore` to that state and `state`
to `interrupted`; (4) append one `node.restarted` event per affected workspace
with `data: {agents: <count>}`; (5) write `node.json`; (6) bind and listen — so
no client sees half-restored state. Interrupted work is never replayed or
re-sessioned; the leader is told and decides (`MANIFESTO.md`, "ACP, steering").

`node.stop` broadcasts `node {phase: "stopping"}`, stops listening, closes every
ACP session the Node owns, calls `store.compact()`, unlinks `node.json` and the
socket, releases the lock and exits 0. A client that finds no socket may spawn
`neta node start --detach` once and retry the connect every 100 ms for up to
5 s; the lock makes that race harmless, since the loser throws `ALREADY_RUNNING`
and its retry finds the winner's socket.

Idle means idle: `src/node/` has no timers except the Lead++ clock (owned by
07) and a connect deadline, and no provider polling, because every change
enters from an ACP stream (03) or a tool call (05). On that one ticker the Node
exposes `connectedClients(): number` and calls 07's `tick()`, since
`src/modes/` has no timers of its own.

## Tasks

Every task's *Done when* is the standard from `docs/plan/README.md`: `bun run
check` and `bun test` pass, the listed tests exist and pass, the commit is made.
Every task reads this file first, `Reads:` lists what else, and no task adds a
runtime dependency: `node:net`, `node:fs`, `node:crypto`, `node:child_process`.

### T4.1 protocol types and framing
Goal: the wire contract, importable without the server.
Reads: `src/core/types.ts`. Writes: `src/node/protocol.ts`,
`test/node-protocol.test.ts`.
Contract: `PROTOCOL_VERSION`; `ClientKind`; one params and one result interface
per method above, `HelloParams`/`HelloResult` through `NodeStopResult`;
`SnapshotResult`; `EventNotification`, `StateNotification`, `TurnNotification`,
`NodeNotification`; `NODE_ERRORS` (symbolic name → code); `NodeError extends
Error` with `code`, `symbol`, `data`; `encodeLine(msg: unknown): string`;
`decodeLines(buf: string): {messages: unknown[]; rest: string}`; `rpcError(id:
string | number | null, e: unknown): string`.
Steps: types first; `decodeLines` keeps a partial line, `PARSE` on bad JSON.
Tests: round-trip; a 3-message buffer split at every byte offset yields those 3
messages; an oversize line is rejected; `rpcError` matches JSON-RPC 2.0 and
carries a symbolic `error.data.code`.
Commit: `feat(node): protocol types and NDJSON framing`

### T4.2 node descriptor and lock
Goal: exactly one Node per `NETA_DIR`, discoverable by clients.
Reads: `docs/plan/README.md` Storage section. Writes: `src/node/lockfile.ts`,
`test/node-lockfile.test.ts`.
Contract: `netaDir(): string`; `NodeDescriptor` = `{socket, token, pid,
protocolVersion, startedAt}`; `readDescriptor(): Promise<NodeDescriptor |
undefined>`; `writeDescriptor(d): Promise<void>` (0600, atomic rename);
`clearDescriptor(): Promise<void>`; `newToken(): string`; `acquireLock():
Promise<LockHandle>`, `LockHandle = {pid: number; release(): Promise<void>}`.
Steps: `acquireLock` writes `node.lock` with flag `wx`; on `EEXIST` it reads the
pid and calls `process.kill(pid, 0)` — alive throws `ALREADY_RUNNING`, dead
unlinks and retries once.
Tests, under a temp `NETA_DIR`: the descriptor round-trips at mode 0600; a
second `acquireLock` throws `ALREADY_RUNNING`; a lock held by a dead pid is
taken over; `release` removes the file.
Commit: `feat(node): node descriptor and single-instance lock`

### T4.3 socket server, hello and fan-out
Goal: the listening server with authentication, dispatch and broadcast.
Reads: `src/node/protocol.ts`, `src/node/lockfile.ts`. Writes:
`src/node/server.ts`, `test/node-server.test.ts`.
Contract: `NodeStore` and `NodeAcp` exactly as in "Ports"; `NodeContext =
{store: NodeStore; acp: NodeAcp; hub: Hub; nodeVersion: string; stop():
Promise<void>}`; `Connection = {id: string; client: ClientKind; send(method:
string, params: unknown): void; tailed: Set<SessionId>; close(): void}`; `Hub =
{broadcast(method: string, params: unknown): void; toTail(sessionId: SessionId,
params: unknown): void; connections(): Connection[]}`; `NodeHandler = (ctx:
NodeContext, params: unknown, conn: Connection) => Promise<unknown>`;
`NodeHandlers = Record<string, NodeHandler>`; `createServer(o: {socketPath:
string; token: string; handlers: NodeHandlers; ctx: Omit<NodeContext, "hub">}):
Promise<{hub: Hub; close(): Promise<void>}>`.
Steps: unlink a stale socket path, bind, buffer lines per connection, require
`hello` first, then dispatch by method; an unknown method gives `-32601`, a
thrown `NodeError` its own code, anything else `-32603` with no stack in `data`.
Tests, with a raw `node:net` client: a non-`hello` first message errors and then
closes; a wrong token gives `UNAUTHORIZED`, a wrong version `PROTOCOL_MISMATCH`;
two clients each receive one `hub.broadcast`; `toTail` reaches only the
connection whose `tailed` holds that session.
Commit: `feat(node): socket server with hello auth and fan-out`

### T4.4 node client
Goal: one client for the CLI (08), the tools proxy (05) and the tests.
Reads: `src/node/protocol.ts`, `src/node/lockfile.ts`, `src/node/server.ts`.
Writes: `src/node/client.ts`, `test/node-client.test.ts`.
Contract: `connectNode(o?: {client?: ClientKind; autostart?: boolean;
timeoutMs?: number}): Promise<NodeClient>`; `NodeClient = {request<T>(method:
string, params?: unknown): Promise<T>; on(method: "event" | "state" | "turn" |
"node", fn: (params: unknown) => void): () => void; hello: HelloResult; close():
Promise<void>; closed: Promise<void>}`.
Steps: read the descriptor, connect, send `hello`, resolve on its result; with
`autostart` and no socket or `ECONNREFUSED`, spawn `neta node start --detach`
once (detached, unref'd), retrying every 100 ms up to `timeoutMs` (5000); match
replies by id and reject all pending on close.
Tests, against a real T4.3 server: request/response, a notification callback and
its unsubscribe, pending requests rejecting on close; autostart against a fake
`neta` creating the socket after 300 ms succeeds, and a socket that never
appears rejects inside `timeoutMs`.
Commit: `feat(node): node client with autostart and retry`

### T4.5 snapshot
Goal: the one payload that replaces a client's cache.
Reads: `src/core/state.ts`, `src/node/server.ts`, `src/node/protocol.ts`.
Writes: `src/node/snapshot.ts`, `test/node-snapshot.test.ts`.
Contract: `buildSnapshot(ctx: NodeContext, params: {workspaceId?: WorkspaceId;
windowDays?: number}): SnapshotResult`; `snapshotHandlers: NodeHandlers`.
Steps: pure selection over the ports. Missions: every one not `closed`, plus
`closed` ones inside `windowDays`, `hasOlder` true when one falls outside.
Agents: every non-archived, non-completed agent of those missions plus the 8
most recently ended completed per mission, `completedCounts` counting all
unarchived completed. Events: last 200 per workspace. `attention`: newest first.
Tests, with a stub store of 3 workspaces, 20 missions and 40 agents: the window
boundary includes and excludes the right closed missions and sets `hasOlder`; a
mission with 12 completed agents yields 8 and `completedCounts` 12; archived
agents never appear; `attention` is exact; `workspaceId` narrows every array.
Commit: `feat(node): snapshot builder`

### T4.6 registry handlers
Goal: paging over history and the small mutations.
Reads: `src/node/server.ts`, `src/node/protocol.ts`, `src/core/types.ts`.
Writes: `src/node/handlers-registry.ts`, `test/node-registry-handlers.test.ts`.
Contract: `registryHandlers: NodeHandlers` covering `workspace.list`,
`missions.list`, `missions.get`, `events.list`, `mission.pin`, `agent.archive`,
`leader.setMode`, `node.stop`; `parseParams<T>(shape, params): T`, used by every
04 handler to turn bad params into `-32602`.
Steps: implement each method exactly as "Requests" specifies: list handlers pass
`cursor`/`limit` to the store ports and return `nextCursor` verbatim, an unknown
id gives `NOT_FOUND`, each mutation appends its event (`user.pinned`,
`agent.archived`, `leader.modeChanged`) and broadcasts `state`, and `node.stop`
replies before calling `ctx.stop()`.
Tests: paging returns the store's cursor unchanged; an unknown id gives
`NOT_FOUND`; archiving a running agent needs `confirm` and otherwise touches
nothing, with it closes the session and emits one `event` and one `state`.
Commit: `feat(node): registry and mutation handlers`

### T4.7 conversation handlers
Goal: tail, prompt, cancel, models, and `turn` subscriptions.
Reads: `src/node/server.ts`, `src/node/protocol.ts`. Writes:
`src/node/handlers-conversation.ts`, `test/node-conversation-handlers.test.ts`.
Contract: `conversationHandlers: NodeHandlers` covering `conversation.tail`,
`.untail`, `.prompt`, `.cancel`, `.setModel` and `models.list`; and
`wireTurnStream(ctx: NodeContext): void`, wiring `acp.onTurn` to `hub.toTail`.
Steps: `tail` reads its page, then adds the session to `conn.tailed` — in that
order, so a block appended during the read arrives as a notification instead of
being lost; a closing connection drops the set; `prompt` returns `turnId` at
once, blocks arriving only as `turn` notifications; rejections `PROVIDER_ERROR`.
Tests: two clients tailing two sessions each receive only their own `turn`
notifications, a third tailing neither receives none but still gets `event`, and
`untail` stops delivery; a `direction: "backward"` tail returns older blocks
with a `prevCursor` that is `null` at the start of history; a rejecting ACP stub
yields `PROVIDER_ERROR`.
Commit: `feat(node): conversation tail, prompt and model handlers`

### T4.8 workspace.open
Goal: a path yields a workspace, a root on this machine, and a live leader.
Reads: `src/core/workspace-id.ts`, `src/node/server.ts`, `MANIFESTO.md`
"Workspaces and machines". Writes: `src/node/workspace-open.ts`,
`test/node-workspace-open.test.ts`.
Contract: `workspaceHandlers: NodeHandlers` with `workspace.open`;
`detectWorkspace(path: string): Promise<{kind: WorkspaceKind; remote?: string;
name: string; root: string}>`; `openWorkspace(ctx: NodeContext, path: string):
Promise<{workspace: Workspace; leader: Leader}>`.
Steps: resolve the path to a real directory, `NOT_FOUND` otherwise; run `git
rev-parse --show-toplevel` and `git remote get-url origin` through
`child_process.execFile`, never a shell, no repo or remote meaning `kind:
"folder"`; compute the id with `workspaceIdFor`; create the `Workspace` or add
this machine's root to the existing one, never duplicating a root or making a
second workspace for an equivalent remote; if the id has no `Leader`, create one
from the settings provider and model with an ACP session whose `mcpServers`
includes that leader's Neta tools server, store it and broadcast `state`.
Tests, with a temp git repo: SSH and HTTPS remotes of one repo open to one
workspace with two roots; a plain folder gets `kind: "folder"`; opening twice
returns the same leader and creates one ACP session carrying the tools entry; a
missing path gives `NOT_FOUND`.
Commit: `feat(node): workspace open and leader creation`

### T4.9 lifecycle
Goal: `startNode` and `node.stop`, with honest restart handling.
Reads: every module above, `docs/plan/02-store.md`, `docs/plan/03-acp.md`,
`MANIFESTO.md` "ACP, steering, and recovery". Writes: `src/node/lifecycle.ts`,
`test/node-lifecycle.test.ts`.
Contract: `startNode(o?: {store?: NodeStore; acp?: NodeAcp}): Promise<Node>`,
`Node = {descriptor: NodeDescriptor; hub: Hub; stop(): Promise<void>; stopped:
Promise<void>}`; `markInterrupted(store: NodeStore): Promise<{workspaceId:
WorkspaceId; agents: number}[]>`; `allHandlers: NodeHandlers` merging the three
handler maps and `snapshotHandlers`; `src/node/index.ts` re-exporting
`startNode`, `connectNode` and the protocol.
Steps: the only file that adapts the real 02 and 03 modules to `NodeStore` and
`NodeAcp` — if an export does not line up, adapt it here and leave the ports
alone; follow the six steps in "Lifecycle" exactly; `stop()` is idempotent.
Tests, with store and ACP stubs: `running` and `blocked` agents come back
`interrupted` carrying `stateBefore` while a `completed` one is untouched, with
one `node.restarted` event per affected workspace; connecting in a loop while
`startNode` runs, the first successful `snapshot` already shows `interrupted`;
a second `startNode` on one `NETA_DIR` throws `ALREADY_RUNNING`; `stop` removes
`node.json`, the socket and the lock twice over, and a scan finds no timers.
Commit: `feat(node): node lifecycle, restart marking and stop`

### T4.10 recorded fixtures for the desktop
Goal: 09–11 build against a real snapshot without a running Node.
Reads: `src/node/lifecycle.ts`, `src/node/client.ts`,
`test/fixtures/fake-acp-agent.mjs`. Writes:
`test/fixtures/record-node-fixture.ts`, `test/fixtures/node-snapshot.json`,
`test/fixtures/node-events.ndjson`, `test/node-fixture.test.ts`.
Contract: `bun test/fixtures/record-node-fixture.ts`, named in a header comment,
regenerates both in a temp `NETA_DIR`; `node-snapshot.json` is one verbatim
`snapshot` result, `node-events.ndjson` one `Event` per line, oldest first.
Steps: start a Node with the fake ACP agent as the only provider, open one temp
git workspace, drive fourteen missions covering every `MissionState` — among
them one `running` with two agents, one `blocked` with an `attention` line,
one `readyToClose`, one `mergedNotClosed`, one `failed`, one `closed` and
`merged`, and one with 12 completed agents so `completedCounts` is exercised,
since 09 and 10 test against this fixture; snapshot through
`connectNode`; write both pretty-printed, the clock and ULID seed fixed so a
re-record is a no-op diff.
Tests: `test/node-fixture.test.ts` asserts the snapshot satisfies
`SnapshotResult` field by field, `attention` is non-empty, `completedCounts` has
an entry over 8, and `seq` is monotonic per workspace in the NDJSON.
Commit: `test(node): recorded snapshot and event fixtures`
