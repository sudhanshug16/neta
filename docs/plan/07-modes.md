# 07 — Lead and Lead++

`src/modes/` owns leadership modes for workspace leaders and mission leads:
where a mode lives, how it is granted, how a switch reaches a live ACP
session, how active time counts. Nothing else may write a mode. Depends on 01,
02, 03, 05.

Read first: `docs/plan/README.md`, `docs/plan/01-domain.md`, `MANIFESTO.md`
sections Lead and Lead++, ACP steering and recovery, CHARTER.md, Canvas.

## Decisions

**Where the mode lives.** The workspace leader's mode is the `mode`,
`modeSince` and `modeActiveMs` fields already on the `Leader` record (01). A
mission lead's mode is a `LeadMode` record keyed by `agentId` in the same
file, `leaders/<workspaceId>.json`, under one new optional top-level field
named **`leadModes`**; 02 owns the file and must round-trip that field, 07
owns its meaning and touches it only through the `LeadModeStore` port (T7.1).
Leaders and mission leads begin in `lead`.

**Two entry points, one grant rule.** `leader.setMode` (04 request, from a
client) is manual: the user's choice, no record, affecting only the selected
leader. `neta_mode` (05 tool, from the leader itself) carries a
`DecisionRecord` (01), approved automatically only when all four hold: the
record is complete (every string field non-empty after trimming,
`worktreePath` exempt; `estimatedFiles` and `estimatedMinutes` positive finite
integers); the named mission exists and is not `closed`; the caller is that
mission's lead or the workspace leader of its workspace; and the charter
reserves neither the named `mutationKind` nor `externalEffects`. Anything else
is denied with a reason — not an error, and never a question put to the user
on the leader's behalf. The record is a decision record, not chain-of-thought:
written flat onto the `leader.modeChanged` event `data` and nowhere else.

**Charter parsing is minimal and explicit.** Only a `## Reserved for the user`
section is parsed: its bullet lines (`-` or `*`, until the next heading or end
of file) are the reservations, and one matches a field when either string
contains the other, lowercased with whitespace collapsed. The rest of
`CHARTER.md` is prose for the model, never parsed.

**Switching.** Every mode change — manual or granted — takes one path: cancel
the active turn at the 03 `steer` boundary, call 03 `switchAccess` (`leadPlus`
→ `readWrite`, `lead` → `readOnly`), then re-prompt that session with a short
mode-change event text; with no active turn the cancel is a no-op and the
re-prompt still happens. Mechanical boundaries still apply: **Lead++ does not
grant a writer lease** — a Lead++ leader that writes takes one from 06 like
any writer, and 07 never calls 06.

**Clock, reminders, banner.** `modeActiveMs` counts only wall time while at
least one client is connected to the Node (which exposes `connectedClients`);
it is persisted every 30 s in `leadPlus` and on every change. `src/modes/` has
no timers — the Node drives `tick(nowMs)`, so tests use a fake clock. At 10
active minutes `leader.modeReminder` is emitted once (the canvas warning
strip); after that a reminder falls due every 2 further active minutes and is
delivered at the next safe boundary (end of a tool call or turn), appended to
that tool response — however many came due, the response carries one. Nothing
expires automatically. Closing or abandoning a mission returns its lead to
`lead`, emitting `leader.modeChanged` with cause
`missionClosed`/`missionAbandoned`. Every tool response to a subject in
`leadPlus` also carries exactly one line, `Lead++ active <n> min · #<number>
<name>`, `<n>` in whole active minutes, with a due reminder as the second
line. 04 owns `leader.setMode`, feeds `connectedClients`, drives `tick`; 05
owns the `neta_mode` schema and calls `decorate` on every tool response.

## Tasks

### T7.1 mode records and the store field
Goal: the mission-lead mode record, its leader-file field, and the port.
Reads: this file, `docs/plan/01-domain.md`, `docs/plan/02-store.md`.
Writes: `src/modes/records.ts`, the persisted leader document type in
`src/store/records.ts` (one optional field), `test/modes-records.test.ts`.
Contract:
```ts
export interface LeadMode { agentId: AgentId; missionId: MissionId;
  mode: LeaderMode; modeSince: IsoTime; modeActiveMs: number; }
export type ModeSubject = { kind: "leader"; workspaceId: WorkspaceId }
  | { kind: "lead"; workspaceId: WorkspaceId; agentId: AgentId };
export interface ModeSnapshot { subject: ModeSubject; mode: LeaderMode;
  modeSince: IsoTime; modeActiveMs: number; missionId?: MissionId; }
export type ModeCause = "user" | "tool" | "missionClosed" | "missionAbandoned";
export interface LeaderFile { leader: Leader;
  leadModes: Record<AgentId, LeadMode>; }
export interface LeadModeStore {
  read(workspaceId: WorkspaceId): Promise<LeaderFile>;
  writeLeader(workspaceId: WorkspaceId, leader: Leader): Promise<void>;
  writeLeadMode(workspaceId: WorkspaceId, agentId: AgentId,
    mode: LeadMode | undefined): Promise<void>;   // undefined deletes
}
export function subjectKey(subject: ModeSubject): string;
export function snapshotOf(leader: Leader,
  leadModes: Record<AgentId, LeadMode>, subject: ModeSubject): ModeSnapshot;
export function modeEventData(input: { from: LeaderMode; to: LeaderMode;
  cause: ModeCause; missionId?: MissionId; record?: DecisionRecord }):
  Record<string, string | number | boolean | null>;
```
Steps: 1. add `leadModes?: Record<AgentId, LeadMode>` to the type 02 persists
in `leaders/<workspaceId>.json`; 01's `Leader` is untouched and the store
round-trips the field, omitting it when empty. 2. `snapshotOf` gives a `lead`
snapshot for an unknown agentId. 3. `modeEventData` flattens the record's nine
fields plus `from`, `to`, `cause`; no record, no record keys.
Tests: `test/modes-records.test.ts` — a file without `leadModes` reads back as
an empty map and a `lead` snapshot; two lead modes round-trip through the real
02 store; deleting one leaves the leader untouched; event data is flat.
Done when: `bun run check`, `bun test` and the listed tests pass; commit made.
Commit: `feat(modes): lead mode records and store field`

### T7.2 charter reservations and the grant rule
Goal: parse `## Reserved for the user`, and decide a `neta_mode` request.
Reads: this file, `docs/plan/01-domain.md`, `MANIFESTO.md` section CHARTER.md,
`CHARTER.example.md`, `src/modes/records.ts`.
Writes: `src/modes/approval.ts`, `test/modes-approval.test.ts`.
Contract:
```ts
export function parseReservations(charter: string): string[];
export function isReserved(reservations: string[], value: string): boolean;
export function reservationFor(reservations: string[],
  record: DecisionRecord): string | undefined;   // the matching bullet text
export function missingFields(record: DecisionRecord): string[];
export type DenialReason = "incompleteRecord" | "missionMissing"
  | "missionClosed" | "notAuthorised" | "reservedByCharter";
export type Approval = { approved: true }
  | { approved: false; reason: DenialReason; detail: string };
export function evaluateRequest(input: { record: DecisionRecord;
  mission: Mission | undefined; caller: ModeSubject;
  reservations: string[] }): Approval;
```
Steps: 1. `parseReservations` finds the heading case-insensitively and takes
bullet lines until the next line starting with `#`, stripping the marker,
surrounding `**` and trailing punctuation. 2. `isReserved` lowercases and
collapses whitespace on both sides, true when either string contains the
other; `reservationFor` checks `mutationKind`, then `externalEffects`. 3.
`missingFields` lists every empty string field and each of
`estimatedFiles`/`estimatedMinutes` that is not a positive finite integer
(`worktreePath` is exempt). 4. `evaluateRequest` checks in the `DenialReason`
order, stopping at the first failure; `detail` is one sentence naming what
failed; the caller passes as the workspace leader of `mission.workspaceId`, or
as `mission.lead`.
Tests: `test/modes-approval.test.ts` — parsing: an empty charter and one
without the section yield nothing, bullets under other headings are ignored,
the section ends at the next heading, `Force-push` reserves `force-push to
main` and the reverse, case and spacing do not matter. The matrix: a complete
record on an open mission led by the caller approves; each missing field and
each non-positive estimate denies `incompleteRecord`, named in `detail`; an
unknown missionId denies `missionMissing`, a closed one `missionClosed`;
another agent's mission denies `notAuthorised` while the workspace leader is
approved for it; a bullet matching `mutationKind` and one matching
`externalEffects` each deny `reservedByCharter`, quoting the bullet.
Done when: `bun run check`, `bun test` and the listed tests pass; commit made.
Commit: `feat(modes): charter reservations and the lead++ grant rule`

### T7.3 active-time clock
Goal: count `modeActiveMs` only while a client is connected, and persist it.
Reads: this file, `src/modes/records.ts`.
Writes: `src/modes/clock.ts`, `test/modes-clock.test.ts`.
Contract:
```ts
export const PERSIST_INTERVAL_MS = 30_000;
export interface ActiveClockOptions { connectedClients: () => number;
  persist: (k: string, activeMs: number) => void; persistIntervalMs?: number; }
export class ActiveClock {
  constructor(options: ActiveClockOptions);
  resume(key: string, activeMs: number, nowMs: number): void;
  suspend(key: string, nowMs: number): number;    // final total
  activeMs(key: string): number; keys(): string[];
  setConnectedClients(count: number, nowMs: number): void;
  tick(nowMs: number): void;                      // accrue, maybe persist
}
```
Steps: 1. no timers and no `Date.now()` in the module — every method takes the
current time. 2. accrue on `tick`, `suspend` and `setConnectedClients`,
counting only spans with the client count above zero. 3. `persist` a key when
`persistIntervalMs` has passed since its last persist, and on `suspend`;
`resume` seeds a key from the stored value, so a restart continues it.
Tests: `test/modes-clock.test.ts` with a fake clock — 60 s connected, 60 s
disconnected, 60 s connected counts 120 s; a key resumed at 300 s continues
from there; `persist` fires at 30 s boundaries, not between, and never for a
key with no connected client; `suspend` returns the final total.
Done when: `bun run check`, `bun test` and the listed tests pass; commit made.
Commit: `feat(modes): active-time clock`

### T7.4 banner and reminders
Goal: the one-line banner, the 10-minute event, and coalescing reminders.
Reads: this file, `MANIFESTO.md` Lead and Lead++, `src/modes/records.ts`.
Writes: `src/modes/reminders.ts`, `test/modes-reminders.test.ts`.
Contract:
```ts
export const FIRST_REMINDER_MS = 600_000;
export const REMINDER_INTERVAL_MS = 120_000;
export function bannerLine(input: { activeMs: number; missionNumber: number;
  missionName: string }): string;      // "Lead++ active 12 min · #7 sales tax"
export function reminderLine(i: { activeMs: number; record?: DecisionRecord }):
  string;
export type ReminderTick = "none" | "firstEvent" | "eligible";
export class ReminderTracker {
  observe(key: string, activeMs: number): ReminderTick;
  take(key: string): boolean;   // true once if a reminder is pending; clears it
  clear(key: string): void;     // on any return to lead
}
```
Steps: 1. `observe` returns `firstEvent` exactly once, when `activeMs` first
reaches `FIRST_REMINDER_MS`, and marks a reminder pending. 2. after that it
returns `eligible` each time `activeMs` passes another `REMINDER_INTERVAL_MS`;
pending is a boolean, so eligible ticks before a `take` collapse into one. 3.
`reminderLine` says why Lead++ is active from the record's `objective` and
`validation`, or "set by the user" without a record; one line under 160
characters. 4. `clear` forgets the key, so a later Lead++ starts over.
Tests: `test/modes-reminders.test.ts` — nothing before 10 min; `firstEvent`
once at 10 min and never again; eligibility at 12, 14, 16 min; three eligible
ticks with no `take` yield one `take` true then false; `clear` then a new run
reproduces `firstEvent`; the banner renders whole minutes and the exact
separator; a record-less reminder says set by the user.
Done when: `bun run check`, `bun test` and the listed tests pass; commit made.
Commit: `feat(modes): lead++ banner and reminders`

### T7.5 the switch path
Goal: cancel, switch access, re-prompt — a mode's only route to a session.
Reads: this file, `docs/plan/03-acp.md`, `MANIFESTO.md` section ACP,
steering, and recovery.
Writes: `src/modes/switch.ts`, `test/modes-switch.test.ts`.
Contract:
```ts
export interface SwitchDeps {
  isTurnActive(sessionId: SessionId): boolean;
  steer(sessionId: SessionId, prompt: string): Promise<void>;  // 03 boundary
  switchAccess(sessionId: SessionId, access: Access): Promise<void>;
}
export function accessFor(mode: LeaderMode): Access;
export function modeChangeText(input: { from: LeaderMode; to: LeaderMode;
  cause: ModeCause; mission?: { number: number; name: string };
  record?: DecisionRecord }): string;
export function applyModeSwitch(deps: SwitchDeps, input: {
  sessionId: SessionId; from: LeaderMode; to: LeaderMode; cause: ModeCause;
  mission?: { number: number; name: string }; record?: DecisionRecord;
}): Promise<{ cancelledTurn: boolean }>;
```
Steps: 1. `accessFor`: `leadPlus` → `readWrite`, `lead` → `readOnly`. 2.
`applyModeSwitch` records whether a turn was active, calls `switchAccess`,
then `steer` exactly once with `modeChangeText`; a switch to the same mode
does neither. 3. never call 06 or mention a writer lease; the text is two or
three sentences naming the new mode, the mission and, for `to: "lead"`, that
Lead++ ended.
Tests: `test/modes-switch.test.ts` against `test/fixtures/fake-acp-agent.mjs`
— a switch during a live turn (agent prompted `HOLD_FOREVER`) cancels it and
re-prompts the same, unchanged sessionId exactly once; with no active turn it
re-prompts without a cancel; `MODE_UPDATE` and `CONFIG_UPDATE` from the agent
mid-turn do not change the Neta mode; `switchAccess` runs first; a same-mode
switch performs no calls.
Done when: `bun run check`, `bun test` and the listed tests pass; commit made.
Commit: `feat(modes): mode switch through the steering boundary`

### T7.6 the mode service
Goal: one object the Node and the tool server call, wiring T7.1–T7.5 together.
Reads: this file, `docs/plan/04-node.md`, `docs/plan/05-tools.md`, T7.1–T7.5.
Writes: `src/modes/service.ts`, `src/modes/index.ts`,
`test/modes-service.test.ts`.
Contract:
```ts
export interface ModeServiceDeps {
  store: LeadModeStore; clock: ActiveClock; reminders: ReminderTracker;
  switchDeps: SwitchDeps; mission(id: MissionId): Mission | undefined;
  sessionFor(subject: ModeSubject): SessionId | undefined;
  charter(workspaceId: WorkspaceId): string;
  lastModeChange(subject: ModeSubject): Event | undefined;
  emit(event: Omit<Event, "seq">): void; now(): number; nowIso(): IsoTime;
}
export class ModeService {
  constructor(deps: ModeServiceDeps);
  snapshot(subject: ModeSubject): Promise<ModeSnapshot>;
  setMode(subject: ModeSubject, mode: LeaderMode): Promise<ModeSnapshot>;
  requestLeadPlus(subject: ModeSubject, record: DecisionRecord):
    Promise<{ result: Approval; snapshot: ModeSnapshot }>;
  onMissionClosed(mission: Mission): Promise<void>;
  onClientsChanged(count: number): void; tick(): void;
  decorate(subject: ModeSubject, response: string): Promise<string>;
}   // src/modes/index.ts re-exports every name from T7.1–T7.5 and this task.
```
Steps: 1. `setMode` is the manual path: no record, cause `user`, one subject.
2. `requestLeadPlus` parses the charter, calls `evaluateRequest`, and on
approval switches with cause `tool` and the record; on denial nothing changes
and the `Approval` is returned for the tool to render. 3. every change writes
through `store`, calls `applyModeSwitch`, resumes or suspends the clock under
`subjectKey`, clears reminders on return to `lead`, and emits
`leader.modeChanged` from `modeEventData`; the clock's `persist` writes back.
4. `tick` feeds the clock then `observe`; a `firstEvent` emits
`leader.modeReminder` once. 5. `decorate` prepends `bannerLine` in `leadPlus`
and appends `reminderLine` when `take` is true; a `lead` response is
unchanged. 6. `onMissionClosed` returns that mission's lead to `lead` with the
cause its disposition implies. 7. on construction restore the reminder record
from `lastModeChange`, so Lead++ survives a restart.
Tests: `test/modes-service.test.ts` with a fake clock, a fake store and
`test/fixtures/fake-acp-agent.mjs` — an approved `neta_mode` request switches
access, re-prompts once, and emits one `leader.modeChanged` carrying the
record fields; a denied one emits nothing and stays in `lead`; a manual
`setMode` during a live turn cancels and re-prompts once; the clock counts
only connected time across a disconnect; at 10 active minutes one
`leader.modeReminder` is emitted and the next `decorate` carries the banner
plus one coalesced reminder; closing a mission returns its lead to `lead`.
Done when: `bun run check`, `bun test` and the listed tests pass; commit made.
Commit: `feat(modes): mode service`
