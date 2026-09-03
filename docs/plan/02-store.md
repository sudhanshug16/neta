# 02 — Store

The durable store: `src/store/`. Files only, no database, everything under
`~/.neta/` (override `NETA_DIR`, resolved per call so a test can point at a
temp directory). It is the only module that knows the layout in
`docs/plan/README.md` "Storage" and the only caller of `core/numbering`.
Read first: `docs/plan/README.md`, `docs/plan/01-domain.md`,
`docs/plan/appendix-v2-engine.md` (Durable state), `MANIFESTO.md` sections
Neta on each machine, Mission lifecycle and closeout, Clients cache and
offline state. Depends on 01; runs in parallel with 03.

## Decisions

- Every write is atomic (temp file in the *same* directory, `fsync`, `rename`,
  `fsync` the directory), directories 0700, files 0600, set explicitly against
  a loose umask; NDJSON is only ever appended. Specified once in T2.2.
- A truncated last line is tolerated: dropped with one warning. A bad line
  anywhere else throws — the file is corrupt.
- Cursors are stable and opaque: missions `<createdAt>|<id>`, exclusive, over
  `(createdAt, id)`; events the last `seq`; conversations a byte offset.
- Compaction writes the snapshot before emptying the log, so replay after a
  crash is idempotent: `create` and `update` both put a full record.
- Sequence numbers are monotonic, not gapless; a crash may skip one.
- Windowing is the store's job; coalescing old events into summaries is the
  client's (`MANIFESTO.md` Clients and cache).

## Tasks

### T2.1 store paths
Goal: one module that knows every path in the layout, and nothing else.
Reads: `docs/plan/README.md` (Storage), this file.
Writes: `src/store/paths.ts`, `test/store-paths.test.ts`.
Contract:
```ts
export interface Paths {
  root: string; nodeJson: string; nodeSock: string; machineJson: string;
  workspacesDir: string; workspace(id: WorkspaceId): string;
  leader(id: WorkspaceId): string;
  missionsDir(id: WorkspaceId): string; counter(id: WorkspaceId): string;
  registryLog(id: WorkspaceId): string; registrySnapshot(id: WorkspaceId): string;
  eventsDir(id: WorkspaceId): string; eventSeq(id: WorkspaceId): string;
  eventMonth(id: WorkspaceId, month: string): string;
  conversation(id: SessionId): string; conversationMeta(id: SessionId): string;
  worktrees(id: WorkspaceId): string; charterHash(id: WorkspaceId): string;
}
export function netaDir(): string;   // NETA_DIR ?? ~/.neta, never cached
export function paths(): Paths;      // fresh from netaDir() on every call
export function encodeWorkspaceId(id: WorkspaceId): string;   // encodeURIComponent
export function decodeWorkspaceId(name: string): WorkspaceId;  // its inverse
export function monthKey(at: IsoTime): string;  // "2026-09", UTC
```
Steps: 1. resolve `netaDir()` from `process.env.NETA_DIR`, else
`os.homedir()/.neta`, and build the rest with `path.join`; 2. `conversation`
is `conversations/<sessionId>.ndjson`, `conversationMeta` the `.meta.json`.
Tests: `test/store-paths.test.ts` — a `NETA_DIR` change between calls is
picked up; encode/decode round-trip `git:github.com/org/repo` with no `/` in
the name; `monthKey` is UTC, padded; every path is under `netaDir()`.
Done when: `bun run check` and `bun test` pass, that test passes, commit made.
Commit: `feat(store): storage paths`

### T2.2 atomic files, NDJSON, mutex
Goal: the durability primitives every other store module uses.
Reads: this file, `src/store/paths.ts`.
Writes: `src/store/files.ts`, `test/store-files.test.ts`.
Contract:
```ts
export interface NdjsonRead<T> { records: T[]; bytes: number; truncated: boolean; }
export interface NdjsonOptions { from?: number; maxBytes?: number; onWarn?: (message: string) => void; }
export type Mutex = <T>(fn: () => Promise<T>) => Promise<T>;
export function ensureDir(dir: string): Promise<void>;                       // recursive, 0700
export function writeFileAtomic(path: string, data: string): Promise<void>;  // 0600
export function writeJsonAtomic(path: string, value: unknown): Promise<void>;
export function readJson<T>(path: string): Promise<T | undefined>;           // undefined on ENOENT
export function readText(path: string): Promise<string | undefined>;
export function appendLine(path: string, value: unknown): Promise<number>;   // EOF offset after the write
export function readNdjson<T>(path: string, opts?: NdjsonOptions): Promise<NdjsonRead<T>>;
export function readNdjsonBackwards<T>(path: string, lines: number): Promise<NdjsonRead<T>>;
export function fileSize(path: string): Promise<number>;                     // 0 on ENOENT
export function createMutex(): Mutex;
```
Steps: 1. `writeFileAtomic`: temp sibling, write, `fchmod` 0600, `fsync`,
close, `rename`, `fsync` the directory; 2. `appendLine`: open `a`, write,
`fsync`, return the new size; 3. `readNdjson`: from `opts.from ?? 0`, at most
`maxBytes`, split on `\n`; a trailing fragment or unparsable final line sets
`truncated` and calls `onWarn` (default `console.warn`) while any other bad
line throws, and `bytes` is the offset past the last good line;
4. `readNdjsonBackwards`: 64 KiB chunks from EOF until `lines` whole lines are
collected, in file order; 5. `createMutex` is a promise chain.
Tests: `test/store-files.test.ts` under a temp `NETA_DIR` — an atomic write
leaves no `.tmp`, is 0600 in a 0700 directory, and never exposes a partial read
to a concurrent reader; a last line cut mid-JSON reads back with every earlier
record, `truncated: true` and one warning, while a cut middle line throws;
`readNdjson({from})` resumes at a returned `bytes`, `readNdjsonBackwards`
returns the last 10 of 1 000 lines; the mutex serialises one counter.
Done when: `bun run check` and `bun test` pass, that test passes, commit made.
Commit: `feat(store): atomic files and ndjson`

### T2.3 single-record stores
Goal: `MachineStore`, `WorkspaceStore`, `LeaderStore` over single JSON files.
Reads: this file, `src/core/types.ts`, `src/store/paths.ts`, `src/store/files.ts`.
Writes: `src/store/records.ts`, `test/store-records.test.ts`.
Contract:
```ts
export interface MachineStore { load(): Promise<Machine>; save(m: Machine): Promise<void>; }  // default {id: ulid(), name: os.hostname(), createdAt: nowIso()}
export interface WorkspaceStore {
  load(id: WorkspaceId, defaults: () => Workspace): Promise<Workspace>;
  save(workspace: Workspace): Promise<void>;
  list(): Promise<Workspace[]>;                    // createdAt ascending
}
export interface LeaderStore { load(id: WorkspaceId, defaults: () => Leader): Promise<Leader>; save(l: Leader): Promise<void>; }
export function openMachineStore(): MachineStore; export function openWorkspaceStore(): WorkspaceStore;
export function openLeaderStore(): LeaderStore;
```
Steps: 1. every `load` reads the JSON and, when absent, builds the default,
saves it and returns it — creation is a write, so two callers cannot disagree
about the machine id; 2. each store owns one `Mutex` guarding load-create and
save; 3. `list` reads `workspaces/` and decodes each name, and an unparsable
file is an error, not a skip.
Tests: `test/store-records.test.ts` — the first `load` creates the file, the
second returns the identical record, two concurrent first loads return one
machine id; a `Leader` round-trips every field including `modeActiveMs` and
`activeMissionId`; `list` is in createdAt order.
Done when: `bun run check` and `bun test` pass, that test passes, commit made.
Commit: `feat(store): machine, workspace and leader records`

### T2.4 mission index
Goal: the in-memory index and windowed query, pure, no I/O.
Reads: this file, `src/core/types.ts`.
Writes: `src/store/mission-index.ts`, `test/store-mission-index.test.ts`.
Contract:
```ts
export interface MissionQuery { from?: IsoTime; to?: IsoTime; states?: MissionState[]; limit?: number; cursor?: string; }
export interface MissionPage { missions: Mission[]; cursor?: string; }
export interface MissionIndex {
  put(mission: Mission): void;                     // insert or replace by id
  get(id: MissionId): Mission | undefined; byNumber(n: number): Mission | undefined;
  list(query: MissionQuery): MissionPage; all(): Mission[];   // all: createdAt ascending
  maxNumber(): number; size(): number;                        // maxNumber 0 when empty
}
export function createMissionIndex(): MissionIndex;
export function missionCursor(mission: Mission): string;   // `${createdAt}|${id}`
```
Steps: 1. keep `Map<MissionId, Mission>`, `Map<number, Mission>` and an array
sorted by `(createdAt, id)`; 2. `put` replaces in place for a known id and
throws on a changed `createdAt`, which is immutable; 3. `list` binary-searches
the lower bound from `cursor` (exclusive) or `from` (inclusive), walks while
`createdAt <= to`, keeps states in `states`, stops at `limit` (default 100, max
1 000), returns a `cursor` only when rows remain.
Tests: `test/store-mission-index.test.ts` over 1 000 synthetic missions — a
window returns exactly the missions inside it; paging by cursor visits each
mission once, in order, no repeat at a page boundary, including ties on
`createdAt`; `states` filters without breaking paging; `put` of an update keeps
its slot and refreshes all three indexes.
Done when: `bun run check` and `bun test` pass, that test passes, commit made.
Commit: `feat(store): mission index and windowed query`

### T2.5 mission registry
Goal: the append-only registry, snapshot compaction, and mission numbering.
Reads: this file, `src/store/paths.ts`, `src/store/files.ts`,
`src/store/mission-index.ts`, `src/core/numbering.ts`.
Writes: `src/store/mission-registry.ts`, `test/store-mission-registry.test.ts`.
Contract:
```ts
export interface RegistryLine { op: "create" | "update"; at: IsoTime; mission: Mission; }
export interface RegistrySnapshot { version: 1; at: IsoTime; missions: Mission[]; }
export interface MissionRegistry {
  load(workspaceId: WorkspaceId): Promise<void>;              // snapshot + tail, idempotent
  allocateNumber(workspaceId: WorkspaceId): Promise<number>;  // only caller of nextNumber()
  create(mission: Mission): Promise<Mission>; update(mission: Mission): Promise<Mission>;
  get(workspaceId: WorkspaceId, id: MissionId): Promise<Mission | undefined>;
  byNumber(workspaceId: WorkspaceId, n: number): Promise<Mission | undefined>;
  list(workspaceId: WorkspaceId, query: MissionQuery): Promise<MissionPage>;
  compact(workspaceId: WorkspaceId): Promise<void>;
  close(): Promise<void>;                                     // compacts every loaded workspace
}
export function openMissionRegistry(): MissionRegistry; export const COMPACT_AFTER_LINES = 10_000;
```
Steps: 1. keep `{index, tailLines, mutex}` per workspace, lazily, and load in
every method so callers never sequence `load` by hand; 2. `load` applies the
snapshot, then replays `registry.ndjson` on top; 3. `create`/`update` hold the
mutex: append a `RegistryLine`, put it in the index, compact past
`COMPACT_AFTER_LINES`; `create` rejects a duplicate id, `update` an unknown one;
4. `allocateNumber`, same mutex, reads `counter` (missing →
`nextNumber(index.maxNumber())`), returns it, writes `nextNumber(value)`
atomically; numbers are never reused or renumbered, closed missions included;
5. `compact` writes the snapshot from `index.all()`, then empties the log.
Tests: `test/store-mission-registry.test.ts` — create then reopen returns the
mission with the same `number`; `allocateNumber` gives 1, 2, 3 across a reopen
and 100 distinct numbers for 100 concurrent calls; an `update` with a closed
record replaces the running one after reload; compaction leaves an empty log, a
snapshot of every mission and unchanged `list` output, and replaying
pre-compaction lines over it yields one copy of each mission.
Done when: `bun run check` and `bun test` pass, that test passes, commit made.
Commit: `feat(store): mission registry`

### T2.6 event log
Goal: the monthly append-only event log with per-workspace sequence numbers.
Reads: this file, `src/core/types.ts`, `src/store/paths.ts`, `src/store/files.ts`.
Writes: `src/store/event-log.ts`, `test/store-event-log.test.ts`.
Contract:
```ts
export interface EventQuery { from?: IsoTime; to?: IsoTime; kinds?: EventKind[]; limit?: number; cursor?: string; }
export interface EventPage { events: Event[]; cursor?: string; }
export interface EventLog {
  append(event: Omit<Event, "seq" | "at">): Promise<Event>;   // workspaceId is on the event
  list(workspaceId: WorkspaceId, query: EventQuery): Promise<EventPage>;
  tail(workspaceId: WorkspaceId, sinceSeq: number, limit?: number): Promise<Event[]>;
  close(): Promise<void>;
}
export function openEventLog(): EventLog;
```
Steps: 1. keep `{nextSeq, mutex}` per workspace, reading `events/<enc>/seq` on
first touch and repairing it upward from the highest `seq` in the newest month
file; 2. `append`, under the mutex, stamps `at = nowIso()` and `seq = nextSeq++`,
writes the seq file atomically, appends to `eventMonth(id, monthKey(at))`,
returns the full `Event`; 3. `list` derives the month keys between `from`
(default: earliest month file) and `to` (default: now), reads them in order from
the cursor's month on, drops events outside the window, at or below the cursor,
or not in `kinds`, stops at `limit` (default 200, max 2 000) and sets `cursor`
to the last returned `seq` when rows remain; 4. `tail` is `list` with
`cursor = String(sinceSeq)` and no time bounds.
Tests: `test/store-event-log.test.ts` — `seq` rises per workspace, two
workspaces number independently, and it survives a reopen and a deleted `seq`
file (repaired from the month file); events across a month boundary come back
in one window in `seq` order; `kinds` filters, paging visits each event once,
`tail(sinceSeq)` returns only newer events and is empty at the head.
Done when: `bun run check` and `bun test` pass, that test passes, commit made.
Commit: `feat(store): event log`

### T2.7 conversation store
Goal: append-only turns and blocks, tailed by byte offset, never loaded whole.
Reads: this file, `src/core/types.ts`, `src/store/paths.ts`, `src/store/files.ts`.
Writes: `src/store/conversations.ts`, `test/store-conversations.test.ts`.
Contract:
```ts
export interface ConversationMeta {
  sessionId: SessionId; provider: string; model: string; vendorSessionId?: string; createdAt: IsoTime;
}
export type ConversationLine = { t: "turn"; turn: Turn } | { t: "block"; block: Block };
export interface BlockPage { blocks: Block[]; from: number; cursor: number; more: boolean; }
export interface TurnRange { turn: Turn; start: number; end: number; }
export interface ConversationStore {
  create(meta: ConversationMeta): Promise<ConversationMeta>;   // idempotent per sessionId
  meta(sessionId: SessionId): Promise<ConversationMeta | undefined>;   // undefined when unknown
  setMeta(sessionId: SessionId, patch: Partial<Pick<ConversationMeta, "model" | "vendorSessionId">>): Promise<ConversationMeta>;
  appendTurn(turn: Turn): Promise<Turn>;                       // sessionId is on the Turn
  appendBlock(sessionId: SessionId, block: Block): Promise<Block>;
  tail(opts: { sessionId: SessionId; cursor?: number; limit?: number }): Promise<BlockPage>;
  readBefore(opts: { sessionId: SessionId; cursor: number; limit?: number }):
    Promise<{ blocks: Block[]; prevCursor: number | null }>;   // backwards from a byte offset
  turnRange(sessionId: SessionId, turnId: TurnId): Promise<TurnRange | undefined>;
}
export function openConversationStore(): ConversationStore;
```
Steps: 1. one `ConversationLine` per NDJSON line, meta in the separate
atomically written JSON file; 2. `tail` with a `cursor` reads forward from it
with `readNdjson({from, maxBytes})` and keeps block lines: result `cursor` is
the offset past the last complete line, `from` the offset of the first block
returned, `more` whether bytes remain; 3. `tail` without a `cursor` returns the
last `limit` blocks via `readNdjsonBackwards` with `cursor` at EOF, so a client
follows a live conversation by passing the previous `cursor` back (`limit`
default 100, max 500); 4. `turnRange` scans forward in 256 KiB slices for the
turn line and the last block with that `turnId`, never accumulating the whole
file; 5. a block for an unknown turn is an error.
Tests: `test/store-conversations.test.ts` over 5 000 blocks in 50 turns — `tail`
with no cursor returns the last 100 in order, and following with the returned
cursor after 10 more blocks returns exactly those 10; a cursor survives a
reopen; `turnRange` on the 25th turn returns offsets whose `tail({cursor:
start})` starts with that turn's first block; `readBefore` from the end returns
the last N blocks in order and stops at offset 0, its `prevCursor` `null` there;
`setMeta` changes the model and keeps `createdAt`.
Done when: `bun run check` and `bun test` pass, that test passes, commit made.
Commit: `feat(store): conversation store`

### T2.8 store facade, crash consistency and restore
Goal: the `openStore()` the Node uses, proven to survive a crash and restore.
Reads: this file, every module in `src/store/`.
Writes: `src/store/index.ts`, `test/store-restore.test.ts`.
Contract:
```ts
export interface Store {
  dir: string; machine: MachineStore; workspaces: WorkspaceStore; leaders: LeaderStore;
  missions: MissionRegistry; events: EventLog; conversations: ConversationStore;
  close(): Promise<void>;    // compacts every loaded registry, then releases
}
export function openStore(): Promise<Store>;
```
It also re-exports the public types and `open*` functions above.
Steps: 1. `openStore` creates `netaDir()` and its subdirectories at 0700,
loads the machine record and wires the six stores; 2. `close` is what the Node
calls on stop — `missions.close()`, the "compact at Node stop" rule, then
`events.close()`; 3. no timers, no background work.
Tests: `test/store-restore.test.ts` under a temp `NETA_DIR`. Crash consistency:
write missions, events and blocks, `close()`, truncate mid-JSON the last line of
`registry.ndjson`, of the current month's events file and of one conversation
file, reopen — every complete record survives, the partial ones are gone, one
warning per file was emitted, and a further `create`/`append` lands cleanly.
Restore: write 5 000 missions across two workspaces, `close()`, reopen, `load`
the larger one; a 24-hour `list` window returns the right missions in under
50 ms and numbering continues where it stopped, with a 0700 tree and 0600 files.
Done when: `bun run check` and `bun test` pass, both tests pass, commit made.
Commit: `feat(store): store facade with crash and restore tests`
