# 01 — Domain

The contract every other workstream imports. `src/core/` has no I/O, no
process spawning, no timers: pure types and pure functions, fully unit
tested. If a later workstream needs a field that is not here, it adds it
here first, in its own task, with a test.

Read first: `docs/plan/README.md`, `MANIFESTO.md` sections Vocabulary,
Leaders and missions, Mission lifecycle and closeout, Agents, Writers and
worktrees.

## Types

`src/core/types.ts` exports exactly these. Names are final; do not rename.

```ts
export type Ulid = string;                 // 26 chars, Crockford base32
export type MachineId = Ulid;
export type WorkspaceId = string;          // see workspace identity below
export type MissionId = Ulid;
export type AgentId = Ulid;
export type SessionId = Ulid;              // Neta's id for one ACP conversation
export type TurnId = Ulid;
export type IsoTime = string;              // ISO 8601, UTC, milliseconds

export type WorkspaceKind = "git" | "folder";
export interface Workspace {
  id: WorkspaceId;
  kind: WorkspaceKind;
  name: string;                            // repo name or folder basename
  remote?: string;                         // canonical remote, git only
  roots: WorkspaceRoot[];                  // copies on this machine
  createdAt: IsoTime;
}
export interface WorkspaceRoot { machineId: MachineId; path: string; }

export interface Machine { id: MachineId; name: string; createdAt: IsoTime; }

export type LeaderMode = "lead" | "leadPlus";
export interface Leader {
  workspaceId: WorkspaceId;
  machineId: MachineId;
  sessionId: SessionId;                    // the one continuous conversation
  provider: string;                        // provider name from settings
  model: string;                           // concrete model id
  mode: LeaderMode;
  modeSince: IsoTime;
  modeActiveMs: number;                    // active connected time in leadPlus
  activeMissionId?: MissionId;             // mission the leader works in directly
  state: "idle" | "running" | "failed";
}

export type Access = "readOnly" | "readWrite";

export type MissionState =
  | "running" | "blocked" | "failed" | "readyToClose"
  | "mergedNotClosed" | "closed";
export type Disposition = "merged" | "abandoned";

export interface MissionChange {           // append-only accepted scope change
  at: IsoTime; text: string; turnId?: TurnId;
}
export interface Worktree {
  provider: "worktrunk"; path: string; branch: string; base: string;
}
export type MissionLead =
  | { kind: "leader" }
  | { kind: "agent"; agentId: AgentId };

export interface Mission {
  id: MissionId;
  number: number;                          // permanent, per workspace
  workspaceId: WorkspaceId;
  machineId: MachineId;
  name: string;                            // 2–6 words, operational
  objective: string;                       // immutable original objective
  changes: MissionChange[];
  lead: MissionLead;
  agentIds: AgentId[];
  access: Access;                          // what the mission may do at most
  worktree?: Worktree;                     // present for git missions
  state: MissionState;
  attention?: string;                      // one line: the question, the error
  createdAt: IsoTime;
  closedAt?: IsoTime;
  disposition?: Disposition;
  closeReason?: string;
  integration?: { mergedAt: IsoTime; commit: string; base: string };
  continuesMissionId?: MissionId;
}

export type AgentState =
  | "starting" | "running" | "blocked" | "failed"
  | "completed" | "interrupted" | "archived";

export interface Agent {
  id: AgentId;
  missionId: MissionId;
  workspaceId: WorkspaceId;
  name: string;                            // from the name pool
  task: string;                            // full task name, never truncated
  access: Access;
  provider: string;
  model: string;
  skills: string[];                        // skill names attached
  sessionId: SessionId;
  canSpawn: boolean;                       // true only for mission leads
  state: AgentState;
  stateBefore?: AgentState;                // set when interrupted
  activity?: { text: string; at: IsoTime };
  pendingQuestion?: string;
  startedAt: IsoTime;
  endedAt?: IsoTime;
  outcome?: string;                        // final report, one paragraph
}

export interface DecisionRecord {          // Lead++ request, manifesto list
  objective: string;
  whyLeadInsufficient: string;
  missionId: MissionId;
  worktreePath?: string;
  mutationKind: string;
  estimatedFiles: number;
  validation: string;
  estimatedMinutes: number;
  externalEffects: string;                 // "none" is a valid answer
}

export type EventKind =
  | "mission.created" | "mission.changed" | "mission.blocked"
  | "mission.unblocked" | "mission.failed" | "mission.readyToClose"
  | "mission.merged" | "mission.closed"
  | "agent.spawned" | "agent.finished" | "agent.archived"
  | "leader.modeChanged" | "leader.modeReminder"
  | "base.integrated" | "charter.changed" | "node.restarted"
  | "user.pinned";

export interface Event {
  seq: number;                             // monotonic per workspace
  at: IsoTime;
  workspaceId: WorkspaceId;
  kind: EventKind;
  missionId?: MissionId;
  agentId?: AgentId;
  sessionId?: SessionId;
  turnId?: TurnId;                         // the conversation turn that caused it
  data: Record<string, string | number | boolean | null>;
}

export type Role = "user" | "agent" | "system";
export type BlockKind = "text" | "thought" | "tool" | "diff" | "status";
export interface Block {
  turnId: TurnId; seq: number; at: IsoTime; role: Role; kind: BlockKind;
  text: string;                            // rendered text; tool blocks carry the title
  data?: Record<string, string | number | boolean | null>;
}
export interface Turn {
  id: TurnId; sessionId: SessionId; startedAt: IsoTime; endedAt?: IsoTime;
  role: Role;                              // who opened the turn
  cancelled?: boolean;
}
```

## Rules encoded as pure functions

`src/core/state.ts`:

- `deriveMissionState(mission, agents, integration)` returns the state:
  `closed` if `closedAt` set; else `mergedNotClosed` if `integration` set;
  else `failed` if any agent is `failed` and no agent is `running`; else
  `blocked` if any agent is `blocked` or the lead has a pending question;
  else `readyToClose` if the mission was marked ready (a flag set by the
  lead's tool call, stored in `data`) or every agent is `completed` and the
  lead reported done; else `running`.
- `canTransitionAgent(from, to)` per this table, everything else is
  rejected: starting→running|failed|interrupted; running→blocked|failed|
  completed|interrupted; blocked→running|failed|interrupted|archived;
  failed→archived; completed→archived; interrupted→running|archived.
- `needsPerson(mission)` is true for `blocked | failed | readyToClose |
  mergedNotClosed`. The mission bar shows these first.
- `isWaiting(mission)` alias of the above, used by tool responses.

`src/core/ids.ts`: `ulid(now?: number)` monotonic within a process; `isUlid`.

`src/core/workspace-id.ts`: `canonicalRemote(url)` normalises
`git@github.com:org/repo.git`, `ssh://git@github.com/org/repo`,
`https://github.com/org/repo.git`, `https://user@github.com/org/repo/`
to `github.com/org/repo`; `workspaceIdFor({kind, remote?, path})` returns
`git:github.com/org/repo` or `folder:<sha256 of absolute path, 16 hex>`.

`src/core/names.ts`: `NAME_POOL` (the 117 names in
`design/canvas-directions/dataset.json` plus 83 more of the same register,
200 total, no two sharing a prefix of three letters) and
`pickName(taken: Set<string>, seed: string)`.

`src/core/numbering.ts`: `nextNumber(current: number)` is trivially
`current + 1`; it exists so the store owns the only call site.

`src/core/lens.ts`: the time lens used by both the Node (for windowed
queries) and the desktop (for layout), written once in TypeScript here and
ported to Swift in 10 with the same tests: `lens({now, focusStart, focusEnd,
width, minPxPerHour})` returns `x(t)` and `t(x)`, linear inside the focus
window and logarithmically compressed outside it on both sides.

## Tasks

Done when, for every task: `bun run check` and `bun test` pass, the test file
it names exists and passes, and its commit is made.

### T1.1 ids and time
Goal: ULIDs and ISO time helpers.
Reads: this file.
Writes: `src/core/ids.ts`, `src/core/time.ts`, `test/core-ids.test.ts`.
Contract: `ulid()`, `isUlid()`, `nowIso()`, `parseIso()`, `msBetween()`.
Steps: implement ULID per spec with a monotonic tail within the process; no
dependency. Tests: length and alphabet, monotonic under same millisecond,
round-trips of time helpers.
Commit: `feat(core): ulid and time helpers`

### T1.2 domain types
Goal: the types above, verbatim, exported from `src/core/types.ts`, with
`src/core/index.ts` re-exporting the whole core.
Reads: this file. Writes: `src/core/types.ts`, `src/core/index.ts`.
Contract: every name in the Types section.
Steps: transcribe the Types block verbatim; these files hold no logic.
Tests: `test/core-types.test.ts` type-checks a literal of each interface
(compile-time coverage; a runtime assertion that the file imports).
Commit: `feat(core): domain types`

### T1.3 state rules
Goal: `deriveMissionState`, `canTransitionAgent`, `needsPerson`.
Reads: this file, `src/core/types.ts`. Writes: `src/core/state.ts`,
`test/core-state.test.ts`.
Contract: `deriveMissionState`, `canTransitionAgent`, `needsPerson` and
`isWaiting`, exactly as "Rules encoded as pure functions" defines them.
Steps: implement those rules and nothing else; pure functions, no I/O.
Tests: one case per row of the transition table, one case per branch of
`deriveMissionState` including precedence (closed beats merged beats failed
beats blocked beats ready beats running).
Commit: `feat(core): mission and agent state rules`

### T1.4 workspace identity
Goal: canonical remote and workspace ids.
Reads: this file. Writes: `src/core/workspace-id.ts`,
`test/core-workspace-id.test.ts`.
Contract: `canonicalRemote(url)`, `workspaceIdFor({kind, remote?, path})`.
Steps: normalise as described above; no network, no `git` call.
Tests: the four remote forms above map to one id; trailing slash and `.git`
ignored; case of host lowered, path case kept; folder ids stable across
calls and different for different paths.
Commit: `feat(core): workspace identity`

### T1.5 name pool
Goal: agent names.
Reads: this file, `design/canvas-directions/dataset.json` (names only).
Writes: `src/core/names.ts`, `test/core-names.test.ts`.
Contract: `NAME_POOL`, `pickName(taken: Set<string>, seed: string)`.
Steps: take the dataset names, extend to 200 in the same register, then pick
deterministically from `seed`, skipping taken names.
Tests: pool size 200, all unique, no three-letter prefix collision, `pickName`
skips taken names and is deterministic for a seed.
Commit: `feat(core): agent name pool`

### T1.6 time lens
Goal: the lens function with a table-driven test that 10 will port.
Reads: this file, `MANIFESTO.md` Canvas section. Writes: `src/core/lens.ts`,
`test/core-lens.test.ts`, `test/fixtures/lens-cases.json`.
Contract: `lens(opts)` → `{ x(t: number): number; t(x: number): number;
ticks(): {t: number; label: string}[] }`; the JSON fixture lists
`{opts, samples: [{t, x}]}` cases; the Swift port must pass the same fixture.
Steps: write the lens, then generate the fixture from it.
Tests: identity inside the focus window, monotonic everywhere, `t(x(t))`
round-trips within 1 ms, ticks are the manifesto labels (`now, 1h, 3h, 12h,
1d, 3d, 1w, 2w, ...`) and lie inside the width.
Commit: `feat(core): time lens`
