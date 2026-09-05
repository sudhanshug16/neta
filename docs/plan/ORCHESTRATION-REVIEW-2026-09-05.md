# Orchestration review — 2026-09-05

Status: review recorded; O1–O3 are implemented and covered by regression tests. This document does
not commit Neta to the product recommendations in the final section and does
not authorize a broad orchestration redesign.

The evidence sections describe the defects as observed at review time. The
resolution sections record the bounded implementation that replaced them.

Final validation: `bun run check` passes; the full backend suite passes 517
tests across 67 files. The macOS suite passes 475 tests. These counts include
real fake-ACP coverage for the runtime boundaries described below.

## Correctness work

### O1 — Concurrent workspace opens can create two leaders

**Status:** fixed and verified.

Resolution: `workspace.open` now serializes its stateful work by canonical
workspace id and rechecks state inside the critical section. Ten concurrent
opens converge on one persisted leader, ACP session, token, and broadcast in
`test/node-workspace-open.test.ts`.

`openWorkspace` checks the in-memory leader map and then creates an ACP session
before saving the leader. Two requests for the same new workspace can both see
no leader and create different sessions. The last saved record wins, leaving
one live session and actor token orphaned while callers receive different
leaders. `test/cli-chat.test.ts` currently avoids the race by opening the
workspace before starting the second client.

Evidence:

- `src/node/workspace-open.ts:181-203` — unguarded check then create.
- `src/node/workspace-open.ts:114-145` — session starts before leader save.
- `test/cli-chat.test.ts:215-217` — test comment documents the race.

Smallest fix: serialize the stateful portion of `workspace.open` with a keyed
mutex or singleflight keyed by the canonical workspace id. Perform detection
outside it, re-read workspace and leader state inside it, and remove the key
after either success or failure. If session creation succeeds but leader
persistence fails, close the new session before returning the error.

Regression tests:

- Run ten concurrent opens for one new workspace and assert one session is
  created, every response has the same session id, one leader is persisted,
  and no session or token is orphaned.
- Fail the first creation and verify a later open succeeds, proving cleanup of
  both the singleflight entry and partial session.
- Where the Git fixture permits it, open equivalent canonical repository paths
  concurrently and verify they converge on the same leader.

### O2 — Writer leases do not gate execution or hand work off

**Status:** fixed and verified. This includes ordinary agents, delegated mission
leads, self-led missions, and both manual and tool-driven Lead++ transitions.

Resolution: read-write agents reserve an id and acquire the durable lease
before ACP launch. Queued agents have no provider process or brief. Completion,
archive, launch failure, interrupted recovery, and mode changes close or revoke
the predecessor before FIFO promotion. Delegated leads start read-only. A
self-led Lead++ grant uses the mission as its holder and applies only at a safe
turn boundary; cancellation invalidates a pending grant. Startup clears dead
holders without auto-launching interrupted work. The desktop decodes and
renders queued agents and disables their composer until launch.

Real fake-ACP runtime tests in `test/node-runtime.test.ts` cover two-writer
serialization, exact-one promotion, failed launch cleanup, FIFO restart,
explicit queued continuation, concurrent agent additions, active-turn release,
normal-turn mode application, cancelled mode invalidation, active Lead++
closeout before cross-mission promotion, and workspace-open reacquisition after
restart. Lease unit tests cover durable FIFO, restart interruption, and shared
in-process serialization. Swift decoding and presentation tests cover the
queued state.

Agent sessions currently launch with their requested access and receive their
first prompt before lease acquisition. Initial mission agents all launch first;
only folder missions attempt a lease afterward. Git mission agents and agents
added later do not acquire a lease on this path. A queued folder writer has
therefore already started with read-write access. Completion marks an agent
finished without releasing its lease, and FIFO promotion in `LeaseManager`
changes the durable holder without starting the promoted work.

Lead++ has the same boundary problem. The mounted mode service currently uses
no-op session switch dependencies, so recorded mode can differ from effective
provider access until another `workspace.open`. Granting Lead++ must not bypass
the mission worktree or folder lease. A mode must never be presented as active
read-write access when the provider has not received that access.

Evidence:

- `src/tools/handlers/mission.ts:114-147` — launch and brief precede leasing.
- `src/tools/handlers/mission.ts:219-269` — all agents launch; only a folder
  mission then acquires one lease.
- `src/tools/handlers/mission.ts:281-334` — added agents launch without lease.
- `src/tools/handlers/coordination.ts:151-173` — completion does not release.
- `src/worktrees/leases.ts:120-151` — release promotes a record only.
- `src/worktrees/closeout.ts:79-87` — release is deferred to mission closeout.
- `src/node/handlers-tools.ts:178-195` — effective mode switching is stubbed.
- `MANIFESTO.md:214-234` and `docs/how-it-works.md:263-286` — one active writer
  per worktree or folder, with durable FIFO queuing.

Implementation direction: introduce one Node-owned writer scheduler around the
existing durable `LeaseManager`, ACP lifecycle, agent store, and mission lookup.
Reserve and persist an agent before launch. Read-only work may launch directly.
Read-write work must acquire the correct worktree or folder key before any ACP
process receives read-write access or its work prompt. Queued work remains
durable and does not have a writable live process. Terminal completion,
archive, failed launch, leaving Lead++, and mission close release through the
same scheduler; promotion starts exactly the FIFO successor.

The scheduler must cover direct leadership as well. A workspace leader entering
Lead++ for a self-led mission acquires that mission's key; a delegated mission
lead uses its agent identity and the same key. Manual `leader.setMode` and
`neta_mode` share the path. If there is no valid mission/worktree target or the
lease is unavailable, fail explicitly or report a queued request without
claiming effective Lead++.

Restart reconciliation must be honest. A persisted lease holder whose agent is
now interrupted, terminal, or missing is not a live writer. Reconcile dead
holders without blindly starting interrupted work. Preserve queue order and
require the leader's explicit continuation before an interrupted session gains
write access again.

If implementation adds `queued` to `AgentState`, update and validate the Swift
decoder and rendering, protocol fixtures, snapshot filtering, CLI rendering,
and exhaustive TypeScript state handling in the same change.

Regression tests:

- Two read-write agents in one Git mission: only the holder launches writable;
  completion starts the second, and their writable lifetimes do not overlap.
- Two read-write folder missions: the second stays queued without a writable
  process; completion or archive of the first promotes it.
- Three writers preserve FIFO order across a Node restart.
- A launch or brief failure marks the agent failed, closes and revokes its
  session, releases its lease, and promotes exactly one successor.
- Archiving live, queued, interrupted, and completed agents leaves no stale
  holder or queue entry.
- Self-led Git and folder missions, delegated leads, and ordinary agents contend
  on the same key.
- Manual and tool mode transitions acquire before effective Lead++, release on
  Lead, and never expose a recorded/effective mismatch.
- Restart never auto-launches interrupted work and never leaves a dead holder
  blocking explicit recovery.

### O3 — Interrupted agents cannot be resumed

**Status:** fixed and verified.

Resolution: interrupted continuation reacquires writer admission when needed,
then resumes the exact Neta and provider session with its persisted provider,
model, access, and mission cwd. Resume explicitly forbids a fresh fallback.
Failure leaves the original agent and conversation identifiable and reports an
error. Real fake-session-store tests verify history-preserving continuation,
resume rejection without replacement, and queued writer recovery after restart.

Node startup marks starting, running, and blocked agents interrupted and starts
no replacement process. `neta_send` accepts an interrupted agent but immediately
cancels and prompts its old session id. The new Node's in-memory session table
does not contain that session, so recovery fails with `NOT_FOUND`. Only workspace
leaders currently use `ensureSession` on open.

Evidence:

- `src/node/lifecycle.ts:729-744` — agents become interrupted on restart.
- `src/tools/handlers/coordination.ts:96-101` — interrupted send targets the
  absent live session.
- `src/node/workspace-open.ts:148-178` — leader-only session revival.
- `MANIFESTO.md:310-325` — persisted history, honest interruption, and a leader
  decision about continuation.

Smallest fix: add an explicit agent-resume session port. It uses the persisted
agent provider, model, requested access, mission working directory, Neta session
id, and stored vendor session id. A read-write resume must first pass through
the writer scheduler. Resume rejection or missing provider leaves the agent
interrupted and returns a clear recovery error; it must not silently invent a
replacement conversation. On success, update state to running and then deliver
the leader's prompt.

Regression tests:

- With the fake ACP session store, run an agent, restart the Node, continue it,
  and verify the same conversation history and vendor session receive the new
  prompt and persist its response.
- Configure rejected resume and verify no fresh session, token, or conversation
  appears and the agent remains interrupted with an actionable error.
- Attempt to resume a read-write agent behind another holder and verify it
  remains queued/interrupted without gaining writable access.

## Existing choices to preserve

- Node startup takes the exclusive lock, restores and marks state, records
  restart events, and only then binds the socket.
- ACP actor tokens live in memory and are revoked on failed launch and close, so
  stale proxies fail closed after restart.
- Conversation block numbering resumes from the durable tail and avoids sequence
  collisions in resumed sessions.
- `LeaseManager` serializes read-modify-write operations and atomically persists
  holder and FIFO queue state.
- The Node is the sole owner of orchestration state; clients render or forward
  and do not create a second scheduling authority.

## Product recommendations, not committed implementation

These are directions for a later product design pass. They are not required to
close O1–O3 and should not expand the current correctness fix.

### Adaptive delegation

Let leaders decide whether a bounded objective needs direct work, parallel
investigation, a specialist, or no delegation. Base the choice on uncertainty,
independent work, risk, and expected validation value rather than fixed roles or
a mandatory agent count.

### Mission execution contract

Give each mission an explicit, durable contract containing the desired outcome,
accepted scope changes, constraints, required evidence, time or cost budget,
and escalation conditions. Keep this concise and user-visible. It should guide
scheduling and completion without becoming hidden reasoning.

### Relevant context handoffs

Build handoffs from the mission contract, accepted changes, relevant files and
decisions, current evidence, and unresolved questions. Prefer bounded summaries
and direct references over copying whole transcripts. Preserve the exact ACP
conversation as the source history.

### Resource and dependency scheduling

Model concrete resources such as worktree writer slots, base integration,
external environments, and task dependencies. Start work when its dependencies
and required resources are available. Keep admission, promotion, cancellation,
and recovery observable and durable.

### Evidence-based completion

Completion should state the claimed outcome and attach the evidence needed to
verify it: focused tests, build results, relevant diffs, reproduced behavior,
or an explicit limitation. A leader should close a mission only when this
evidence satisfies its contract, rather than because every child reported done.

### Model routing and escalation

Choose providers and models from task needs, configured policy, observed
reliability, latency, and cost. Record retry count, failure category, latency,
and token or monetary cost when available. Escalate after defined failures or
low-confidence evidence, with bounded retries and no silent provider switch that
loses conversation identity.

### Accessible operator decisions

Keep approvals, denials, charter reservations, accepted scope changes, mode
decisions, recovery choices, and closeout dispositions easy to find from the
mission and timeline. Present the decision, actor, time, reason, and affected
resource without requiring transcript archaeology.
