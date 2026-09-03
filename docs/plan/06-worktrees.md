# 06 — Worktrees, writer leases, merge detection, closeout

`src/worktrees/` owns Git isolation and mission closeout. **Neta never runs `git
worktree` itself.** Worktrunk (`wt`) owns creation, naming and removal; Neta
invokes and verifies it. Plain `git` is used only for read-only merge detection.
Worktrunk **is** installed here (`wt v0.72.0`), so every flag and JSON shape
below came from it; two unprovokable details are marked "verify". CI has none.

Read first: `docs/plan/README.md`, `docs/plan/01-domain.md`, `MANIFESTO.md`
sections "Writers and worktrees" and "Mission lifecycle and closeout".
Depends on 01 (types), 02 (store, event emit), 05 (the tools that call in).

## What Worktrunk gives us, and what we decide

Invoke the binary directly (`command wt`, never the shell function), always
non-interactively: `stdin` ignored, `-y`, `--no-cd`, `NO_COLOR=1`,
`WORKTRUNK_VERBOSE=0`. **stdout is pure JSON; human text goes to stderr.**

| Call | Observed on stdout |
|---|---|
| `switch --create <branch> --base <base> --no-cd -y --format=json` | `{"action":"created","branch":"mission/1-test","path":"/abs/repo.mission-1-test","created_branch":true,"base_branch":"main"}` |
| `list --format=json --config-set list.json-schema=1` | array of `{branch, path, kind, is_main, is_current, commit{sha,short_sha,message,timestamp}, working_tree{staged,modified,untracked,renamed,deleted,diff{added,deleted}}, main_state, worktree{detached}, repo{host,owner,name,remote}}` |
| `remove <branch> --foreground -y --format=json` | array of `{kind, branch, path, branch_outcome, branch_checked_out_at}`, outcome ∈ `deleted, deferred, not_attempted, retained_unmerged, retained_checked_out, retained_raced, retained_failed` |
| dirty worktree, no `--force` | exit 1, stderr `Cannot remove worktree: <branch> has uncommitted changes` |

Paths come from a user-configurable template: **never compute one**, read `path`
out of the JSON. `--config-set list.json-schema=1` pins the list schema, which
otherwise warns and changes later. `--foreground` on remove is mandatory, or it
finishes after closeout reported success. Any `action` other than `"created"` is
unverified: exit 0 with a parseable `path` and `branch` is success; a non-null
`branch_checked_out_at` means a sibling checkout holds the branch (verify). `wt
merge` is **not used**: the leader integrates, Neta only detects.

`src/worktrees/` holds `wt.ts` (the process runner), `naming.ts` (branch names,
pure), `integration.ts` (merge detection over plain git), `driver.ts`
(`WorktrunkDriver`: create, list, verify, defaultBase, remove), `leases.ts`
(`LeaseManager` and its FIFO queue), `closeout.ts` (`closeMission`) and
`index.ts` (the `WorktreeService` facade the Node calls).

- Branches are `mission/<number>-<slug>` from `base`; `base` defaults to the
  workspace default branch, detected once per workspace and cached in memory.
- One active writer per worktree path, or per workspace root in a non-Git
  workspace: read-only missions unlimited, extra writers queue FIFO, persisted.
- The base checkout is a lease of its own named `base`, so two closeouts can
  never merge into it concurrently.
- Merge detection **never runs on a timer**: only on agent finish, `neta_ready`,
  `neta_close` and `workspace.open`.
- There is no retained-but-closed state; a refused removal leaves the mission
  open with `attention` set to the refusal reason.

## Tasks

### T6.1 wt process runner
Goal: one audited way to call `wt` and read JSON off stdout.
Reads: this file, `docs/plan/README.md`.
Writes: `src/worktrees/wt.ts`, `test/fixtures/fake-wt.mjs`,
`test/helpers/git-repo.ts`, `test/worktrees-wt.test.ts`.
Contract:
```ts
export interface WtRun { stdout: string; stderr: string; code: number }
export interface WtOptions { cwd: string; timeoutMs?: number }
export class WtError extends Error { }   // (argv, run); .argv, .code, .stderr
export function wtBinary(): string;      // NETA_WT_BIN, else "wt"
export function runWt(argv: readonly string[], o: WtOptions): Promise<WtRun>;
export function runWtJson(argv: readonly string[], o: WtOptions): Promise<unknown>;
export function wtAvailable(): Promise<{ ok: boolean; version?: string; reason?: string }>;
```
Steps: 1. `node:child_process.execFile`, `stdin: "ignore"`, env `{...process.env,
NO_COLOR: "1", WORKTRUNK_VERBOSE: "0", TERM: "dumb"}`, `timeoutMs` 120000,
always prefixing `["-C", o.cwd]` and appending `"-y"`. 2. `runWtJson` throws
`WtError` on non-zero exit, else parses the first non-empty stdout line when it
starts with `{` and otherwise all of stdout, returning `unknown` so callers
narrow it. 3. `wtAvailable` runs `--version`, returns `{ok:false, reason}` on
ENOENT, never throws. 4. Build the two files under "Test rig".
Tests: `test/worktrees-wt.test.ts` — JSON parses off stdout while stderr prose
is ignored; a non-zero exit throws `WtError` carrying stderr; a missing binary
gives `ok:false` instead of a throw.
Done when: `bun run check` and `bun test` pass.
Commit: `feat(worktrees): wt process runner`

### T6.2 mission branch naming
Goal: deterministic branch names, pure and dependency-free.
Reads: this file, `src/core/types.ts`.
Writes: `src/worktrees/naming.ts`, `test/worktrees-naming.test.ts`.
Contract:
```ts
export function slugify(name: string): string;                   // ascii [a-z0-9-], <= 32
export function missionBranch(n: number, slug: string): string;  // `mission/${n}-${slug}`
export function parseMissionBranch(b: string): { number: number; slug: string } | undefined;
```
Steps: 1. `slugify` lowercases, strips accents to ASCII, replaces each run of
non-alphanumerics with `-`, trims leading and trailing `-`, truncates to 32 on a
`-` boundary, returns `"mission"` if nothing survives. 2. `missionBranch` throws
on a non-positive or non-integer number. 3. `parseMissionBranch` inverts it.
Tests: `test/worktrees-naming.test.ts` — `"Fix the OAuth refresh loop"` at 12 gives
`mission/12-fix-the-oauth-refresh-loop`; unicode and emoji still give a valid ref;
a 200-char name truncates with no trailing `-`; round-trips; `"main"` is undefined.
Done when: `bun run check` and `bun test` pass.
Commit: `feat(worktrees): mission branch naming`

### T6.3 merge detection
Goal: answer "is this branch in the base?" from plain read-only git.
Reads: this file, `src/worktrees/wt.ts`, `src/core/types.ts`.
Writes: `src/worktrees/integration.ts`, `test/worktrees-integration.test.ts`.
Contract:
```ts
export function runGit(argv: readonly string[], cwd: string): Promise<WtRun>;
export interface IntegrationQuery { repoRoot: string; branch: string; base: string }
export interface IntegrationResult { merged: boolean; base: string;
  commit?: string; baseCommit?: string }
export function isIntegrated(q: IntegrationQuery): Promise<IntegrationResult>;
```
Steps: 1. Resolve the tip with `rev-parse --verify <branch>^{commit}`; an
unresolvable branch returns `{merged:false, base}` rather than throwing, since a
deleted branch is not an error at closeout. 2. Resolve the base tip, preferring
`origin/<base>` when it exists and is strictly ahead of local `<base>`, so a
lagging checkout cannot hide a merge. 3. `merge-base --is-ancestor <branchTip>
<baseTip>` exiting 0 means merged: `commit` is the branch tip (the SHA evidence
names), `baseCommit` the base tip. 4. `branch` accepts a raw SHA, so evidence is
confirmed by passing it there. 5. Never write: no fetch, no checkout.
Tests: `test/worktrees-integration.test.ts` on a real temp repo — a fresh branch
with a commit is not integrated; after a real `git merge` into `main` it is and
`commit` equals the branch tip; a squash-merge of the same content is **not**
merged by ancestry (documented limitation); an unknown branch gives
`merged:false`; a raw SHA works as `branch`.
Done when: `bun run check` and `bun test` pass.
Commit: `feat(worktrees): merge detection`

### T6.4 Worktrunk driver
Goal: create, describe, verify and remove mission worktrees through `wt`.
Reads: this file, `src/worktrees/{wt,naming,integration}.ts`, `src/core/types.ts`.
Writes: `src/worktrees/driver.ts`, `test/worktrees-driver.test.ts`.
Contract:
```ts
export interface CreateInput { repoRoot: string; number: number; slug: string; base?: string }
export interface WorktreeEntry { branch?: string; path: string; commit: string;
  isMain: boolean; isCurrent: boolean; dirty: boolean }
export type Refusal = "dirty" | "unmerged" | "checkedOut" | "failed";
export interface RemoveInput { repoRoot: string; path: string; branch: string;
  base: string; force?: boolean; abandon?: boolean }
export type RemoveResult = { ok: true; branchOutcome: string; path: string }
                         | { ok: false; refusal: Refusal; reason: string };
export interface WorktreeDriver {
  create(input: CreateInput): Promise<Worktree>;   // Worktree from src/core/types.ts
  remove(input: RemoveInput): Promise<RemoveResult>;
  list(repoRoot: string): Promise<WorktreeEntry[]>;
  verify(worktree: Worktree): Promise<{ ok: boolean; reason?: string }>;
  defaultBase(repoRoot: string): Promise<string>;
}
export class WorktrunkDriver implements WorktreeDriver {  // + forgetBase(repoRoot): void
  constructor(opts?: { timeoutMs?: number });
}
```
Steps: 1. `create` runs `switch --create <missionBranch(number, slug)> --base
<base ?? await defaultBase(repoRoot)> --no-cd --format=json`, narrows the payload
with a hand-written guard on `{branch: string, path: string}`, and returns
`{provider: "worktrunk", path, branch, base}`; a missing field is an error, not a
silent default. 2. `list` runs `list --format=json --config-set
list.json-schema=1`; `dirty` is true when any of `staged, modified, untracked,
renamed, deleted` is. 3. `defaultBase` is the `branch` of the `is_main: true`
row, else `git symbolic-ref --short HEAD`, memoised per `repoRoot`, cleared by
`forgetBase`. 4. `verify` fails with a reason when the path is missing from disk
or `list`, or under another branch. 5. `remove` pre-checks before shelling out —
dirty per `list`, or `isIntegrated` false, with `abandon !== true` — and returns
refusal `dirty` or `unmerged` without running `wt`, so a check never destroys
anything. 6. Otherwise `remove <branch> --foreground -y --format=json`, adding
`--force -D` when `abandon` and `--force` when `force`; a non-zero exit is
`failed` with the first stderr line, and on exit 0 `deleted`, `deferred` or
`not_attempted` is `ok:true`, `retained_checked_out` is `checkedOut`, any other
`retained_*` is `failed`. 7. Only closeout passes `abandon`; `force` is false.
Tests: `test/worktrees-driver.test.ts` against the shim — mission 7 named "add
retry budget" yields `mission/7-add-retry-budget` and the payload's path, not a
computed one; `defaultBase` returns `main` and shells out once for two calls;
`verify` passes fresh, then fails once the directory is deleted and when the
branch does not match; a clean merged worktree removes with `branchOutcome:
"deleted"`; a dirty worktree is refused `dirty` and still exists, then removes
with `abandon:true`; a clean unmerged branch is refused `unmerged`; a non-zero
exit gives `failed` with the stderr line.
Done when: `bun run check` and `bun test` pass.
Commit: `feat(worktrees): worktrunk driver`

### T6.5 writer leases
Goal: one active writer per worktree, everyone else queued FIFO and durable.
Reads: this file, `docs/plan/README.md` (Storage), `src/core/types.ts`.
Writes: `src/worktrees/leases.ts`, `test/worktrees-leases.test.ts`.
Contract:
```ts
export const BASE_LEASE = "base";
export type LeaseOutcome = "active" | "queued";
export interface LeaseRecord { key: string; holder?: AgentId; since?: IsoTime; queue: AgentId[] }
export interface LeaseState { workspaceId: WorkspaceId; leases: Record<string, LeaseRecord> }
export interface LeaseStore { read(w: WorkspaceId): Promise<LeaseState>; write(s: LeaseState): Promise<void> }
export function createFileLeaseStore(netaDir: string): LeaseStore;  // worktrees/<workspaceId>.json
export function leaseKeyFor(i: { kind: WorkspaceKind; worktreePath?: string; root: string }): string;
export class LeaseManager {   // one internal promise chain serialises all writes
  constructor(store: LeaseStore, onChange?: (w: WorkspaceId, r: LeaseRecord) => void);
  acquire(w: WorkspaceId, a: AgentId, key: string): Promise<LeaseOutcome>;
  release(w: WorkspaceId, a: AgentId): Promise<{ key: string; promoted?: AgentId }[]>;
  queuePosition(w: WorkspaceId, a: AgentId): Promise<number | undefined>;
  holder(w: WorkspaceId, key: string): Promise<AgentId | undefined>;
}
```
Steps: 1. `leaseKeyFor` returns the worktree path for a Git mission and the
workspace root for a `folder` workspace; `BASE_LEASE` is passed explicitly by
closeout and by workspace-leader integration. 2. Every `acquire`/`release` runs
on one internal promise chain so a read-modify-write cannot interleave; the file
is written atomically (temp file plus `rename`, 0600). 3. `acquire` returns
`"active"` when the key has no holder or the caller already holds it, else
appends to `queue` idempotently and returns `"queued"`. 4. `release` frees every
key the agent holds, drops it from every queue, promotes each freed queue's head
and returns what changed; `onChange` fires for the freed key and the promoted
agent, and the Node turns it into a `state` notification so the canvas shows
queued writers. 5. `queuePosition` is 1-based and `undefined` for the holder or
a stranger; read-only missions never `acquire`.
Tests: `test/worktrees-leases.test.ts` — three writers on one key give `active,
queued, queued` with positions 1 and 2; releasing the holder promotes the first
queued agent and moves the other to position 1; releasing a queued agent leaves
the holder alone; two keys grant two active writers at once; a folder workspace
keyed on its root grants one writer while read-only missions take no lease;
state survives a fresh `LeaseManager`; `BASE_LEASE` is an ordinary key.
Done when: `bun run check` and `bun test` pass.
Commit: `feat(worktrees): writer leases`

### T6.6 mission closeout
Goal: the one place a mission may be closed, with evidence or a reason.
Reads: this file, `MANIFESTO.md` "Mission lifecycle and closeout",
`src/worktrees/{driver,integration,leases}.ts`, `src/core/types.ts`.
Writes: `src/worktrees/closeout.ts`, `test/worktrees-closeout.test.ts`.
Contract:
```ts
export interface CloseMissionInput { mission: Mission; disposition: Disposition;
  reason: string; evidence?: string }
export type CloseOutcome = { ok: true; mission: Mission }
  | { ok: false; attention: string; mission: Mission };
export interface CloseoutDeps {
  driver: WorktreeDriver; leases: LeaseManager; isIntegrated: typeof isIntegrated;
  now(): IsoTime;
  emit(kind: EventKind, missionId: MissionId, data: Record<string, string>): void;
  onMissionClosed(mission: Mission): Promise<void>;   // 07's ModeService
}
export function extractCommit(evidence: string): string | undefined;  // first 7-40 hex token
export function closeMission(i: CloseMissionInput, d: CloseoutDeps): Promise<CloseOutcome>;
```
Steps: 1. Take `BASE_LEASE` first; if it is not `"active"`, return `ok:false`
with attention "another closeout is integrating". 2. `merged` requires either
`mission.integration` present or an `evidence` string whose `extractCommit`
result `isIntegrated` confirms against the mission's base; nothing else counts
and the confirmed commit is written into `mission.integration`. 3. `abandoned`
requires a non-empty trimmed `reason`. 4. Both require, for a Git mission, a
successful `driver.remove` — `abandon: true` only for `abandoned`; a refusal
returns `ok:false` with its reason as `attention`, and the mission stays open,
keeps its worktree, gets no closed field. 5. On success set `closedAt = now()`,
`disposition`, `closeReason`, clear `attention`, emit `mission.closed`, release
every lease the mission's agents hold and `BASE_LEASE`, then `await
onMissionClosed(mission)`; `BASE_LEASE` is freed on every exit path.
Tests: `test/worktrees-closeout.test.ts` — merged with `integration` already set
closes and emits `mission.closed`; merged with only a confirmed evidence SHA
closes and records `integration`; merged with a non-ancestor evidence SHA, merged
with neither, and abandoned with an empty reason each refuse and leave the
mission open with `attention`; abandoned with a reason removes the worktree with
`abandon:true` and closes; a driver refusal leaves it intact and `closedAt`
unset; `onMissionClosed` runs once on success, never on refusal.
Done when: `bun run check` and `bun test` pass.
Commit: `feat(worktrees): mission closeout`

### T6.7 worktree service facade
Goal: one object the Node holds, wiring merge detection to four trigger points.
Reads: this file, `docs/plan/README.md` (Protocol summary), all of `src/worktrees/`.
Writes: `src/worktrees/index.ts`, `test/worktrees-service.test.ts`.
Contract:
```ts
export interface WorktreeServiceDeps {
  driver: WorktreeDriver; leases: LeaseManager; netaDir: string; now(): IsoTime;
  emit(kind: EventKind, missionId: MissionId, data: Record<string, string>): void;
  saveMission(mission: Mission): Promise<void>;
  onMissionClosed(mission: Mission): Promise<void>;
}
export interface WorktreeService {
  prepare(mission: Mission, workspace: Workspace): Promise<Mission>;
  acquireWriter(m: Mission, w: Workspace, a: AgentId): Promise<LeaseOutcome>;
  releaseWriter(workspaceId: WorkspaceId, a: AgentId): Promise<void>;
  refreshIntegration(mission: Mission): Promise<Mission>;
  close(input: CloseMissionInput): Promise<CloseOutcome>;
}
export function createWorktreeService(deps: WorktreeServiceDeps): WorktreeService;
// plus `export *` of driver, leases, naming, integration and closeout
```
Steps: 1. `prepare` creates a worktree for every Git mission — investigation
missions included — sets `mission.worktree` and saves; no-op for a `folder`
workspace or a mission whose worktree already verifies. 2. `acquireWriter` is
called only for `access: "readWrite"`; a `"queued"` result is surfaced by the
Node as a `state` notification so the canvas shows the agent queued.
3. `refreshIntegration` runs `isIntegrated` and on a first positive sets
`mission.integration = {mergedAt: now(), commit, base}`, saves and emits
`mission.merged` exactly once; a mission that already has `integration` is
returned untouched. 4. A comment at the top names its only four callers: agent
finish, `neta_ready`, `neta_close`, `workspace.open`. **No timer, interval or
watcher may call it.** 5. `close` delegates to `closeMission`.
Tests: `test/worktrees-service.test.ts` — `prepare` creates a worktree for a
read-only Git mission and none for a folder workspace; `refreshIntegration`
after a real merge sets `integration` and emits `mission.merged` once across two
calls; a second writer gets `"queued"`; a grep of `src/worktrees/` finds no
`setInterval`/`setTimeout` reaching merge detection.
Done when: `bun run check` and `bun test` pass.
Commit: `feat(worktrees): worktree service facade`

## Test rig

Built in T6.1, reused by T6.3, T6.4, T6.6 and T6.7. `test/helpers/git-repo.ts`
exports `makeRepo(): Promise<{root, cleanup}>` — a temp dir with `git init -b
main`, local `user.name`/`user.email` and one commit — and `fakeWtEnv(): {
NETA_WT_BIN: string }`. `test/fixtures/fake-wt.mjs` is a Node shim implementing
`--version`, `switch --create`, `list --format=json` and `remove` over plain
`git`, emitting exactly the payloads tabled above; it places worktrees as
siblings named `<repo>.<branch with / and - flattened>` so tests can prove Neta
reads the path instead of computing it, and exits 1 with the real dirty-worktree
message when `remove` runs without `--force` on a dirty tree. `NETA_WT_BIN`
points at the shim, so no test needs `wt` installed. Merge detection uses
**real** `git`, so the merges are real. No ACP here.
