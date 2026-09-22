# Neta reliability plan

Neta should retain its machine-local Node, native OpenCode execution, mission hierarchy, and file-backed records. The immediate investment is reliable ownership, delivery, and recovery. Omnigent supplies useful mechanisms and failure tests; adopting its broader multi-harness deployment architecture is unnecessary.

The recommended order is: establish a mandatory test baseline; fix result delivery and turn ownership; serialize session recovery and service replacement; preserve model and instruction intent; expose those guarantees in waiting and recovery controls; certify the packaged application. This is a proposed implementation plan, not a claim that these changes have shipped.

## Findings that change the priorities

Two defects are reproduced using Neta's actual `reportAgentRuntime` function with an in-memory store and a parent sender that fails. Turn A ends with an undelivered report. Turn B starts. Retrying A marks the actor interrupted even though B is running. If B also ends while the parent is unavailable, B replaces A in the single `pendingParentTurn` field. Both the state mutation and lost pending-report identity occur without a real provider.[^n-results]

```text
Action                         Pending report    Actor state
A delivery fails              A                 interrupted
B starts                      A                 running
A delivery retries            A                 interrupted
B delivery fails              B                 interrupted
```

Other findings are established by control-flow inspection, with deterministic reproductions proposed below. They must not be presented as observed live failures: automatic upgrade separates its idle check from its stop command; shared session recovery has no common in-flight reservation; model fallback ignores staffing constraints; gateway message deduplication lasts only for one attachment.[^n-startup][^n-session][^n-model][^n-gateway]

The current test baseline is useful but incomplete. Twenty-four focused tests across parent reporting, the durable inbox, conversation handlers, model selection, and workspace reset passed during this assessment. Those tests do not exercise the reproduced two-turn sequence or every crash boundary. The native integration fixture can skip when the sibling fork is absent, and the current release workflow does not build and certify the OpenCode artifact.[^n-tests][^n-ci]

## Preserve the work already done

| Existing behavior | Extension needed |
| --- | --- |
| One command starts a missing local Node and restores the saved workspace. Changed builds update an idle service. | Make ownership election and idle replacement safe under concurrent callers and newly admitted work. |
| Saved actor tabs resume the same session; an unavailable worktree opens the workspace leader with an explanation. | Share restoration serialization across attachment, parent wake, and workspace opening. |
| Runtime completion automatically reports workers to mission leads and mission leads to workspace leaders. | Retain every report, acknowledge insertion, and recover wake failures independently. |
| Inbox items persist as queued, delivering, delivered, or uncertain. | Preserve origin and stable operation identity; reconcile uncertainty without blind replay. |
| An exact requested worker model is checked initially; actual fallback models are reported. | Keep the requested model and permitted fallback choices across the whole assignment. |
| Standing instructions are delivered as a dedicated OpenCode system section. | Verify the applied revision across every role and lifecycle transition. |
| Reset distinguishes fresh chat from archiving workspace missions. | Reject late events and delivery retries from superseded executions. |

These extensions build on the present implementation. A rewrite of the store, a new model executor, or a second queue would create unnecessary migration work.[^n-results][^n-inbox][^n-context][^n-reset]

## Ownership and state contract

The runtime needs separate identities for an actor, its conversation binding, each turn, and each result delivery. A process is a temporary owner of a durable binding. An ended turn does not prove that an assignment or mission is complete. A result accepted into a parent inbox does not prove that the parent has reviewed it.

| Record | Required meaning |
| --- | --- |
| Actor | Stable workspace/mission ownership, task, access, requested model, permitted alternatives. |
| Session binding | Neta session ID, provider session ID, binding generation, current runtime instance. |
| Turn | Execution ID, binding generation, origin, current/terminal status, actual model and outcome. |
| Result delivery | Stable source ID, child actor/turn, parent actor, immutable payload reference, insertion receipt. |
| Parent inbox item | Source ID, provenance, admission/uncertainty state, associated parent turn when known. |

Persist only what is needed to recover these facts. Continue using the existing atomic file store unless measurement justifies a storage change. Reconnect still returns one authoritative snapshot followed by live events. The operator subsequently chose to remove `neta_wait`. Supervision uses durable result delivery and automatic parent wake; there is no new client-wide changes-since-revision protocol.

Standing role instructions belong in the system section. Child reports remain attributed runtime data, even when the provider transports them as messages. Preserve that origin through storage and replay; do not turn a worker's output into human authorization.

## Implementation sequence

The work packages below are ordered for review and validation. B and C can proceed independently after A establishes shared identities. D follows C's ownership model. E and F can proceed together once the bridge contract is defined. G consumes the resulting state; H is the final release gate. Existing public behavior remains available until its replacement is verified.

| Package | Area | Priority | Dependencies | Reviewable result |
| --- | --- | --- | --- | --- |
| A | Contract baseline and reproducible fixtures | First | None | Pinned integration pair, invariant checklist, failing regression probes. |
| B | Durable results and turn ownership | P1 | A | No lost child reports or old retries changing live state. |
| C | Shared session recovery | P1 | A | One runtime binding per session despite mixed concurrent callers. |
| D | Node ownership and conditional upgrade | P1 | A, C | Concurrent startup and update cannot stop newly admitted work. |
| E | Model selection and readiness | P1 | A | Fallback stays within assignment intent and reports the actual execution. |
| F | Instruction delivery and fork boundary | P1 | A | Current instructions are acknowledged and verified across lifecycle changes. |
| G | Automatic supervision and recovery UI | P2 | B, D, E, F | No wait tool; visible, actionable result delivery and recovery states. |
| H | Packaged conformance and release certification | Release gate | All | Clean installation passes required source and packaged tests. |

### A. Establish the contract baseline

**Problem and example.** A green unit suite can coexist with an unexercised native integration. A local sibling checkout also hides whether a clean installation contains all required integration changes.

**Change.** Record the exact Neta/OpenCode pairing, bridge version, and lockfiles used by the suite. Introduce one required conformance command that runs isolated Node and native OpenCode fixtures with a fake model endpoint. It should fail clearly when a required fixture or executable is missing. Optional exploratory runs may still skip, but release runs must not count skips as passes. Reuse the existing tests rather than constructing a second framework.

Freeze the shared identity and compatibility contract: actor identity, binding generation, existing turn ID as execution identity where appropriate, result source-ID schema, and reset semantics. B and C may then implement their portions independently. Specify defaults for old stored records and migration fixtures before adding required fields.

Create deterministic barriers for process ownership, session launch, inbox insertion, provider acceptance, result acknowledgment, and reset. A barrier lets a test crash or introduce a competing operation at a precise boundary instead of hoping a sleep triggers a race. Reconcile contradictory documentation about first-user prefixes and read-only shell access with the current implementation.

**Code anchors.** `test/opencode-v2-native.test.ts`, `test/opencode-cold-start.test.ts`, `test/node-runtime.test.ts`, `test/fixtures/fake-acp-agent.mjs`, `scripts/setup-opencode.ts`, `scripts/build-opencode.ts`, and the fork's `neta-fork.json`.[^n-tests][^n-build]

**Acceptance.** The two reproduced reporting defects become failing tests. Missing native prerequisites fail the required command. Tests run without user settings, provider credentials, or paid calls. Each result states whether it exercised source or packaged execution.

**Omnigent lesson.** Its conformance bench compares declared capabilities with observed behavior and treats unmeasured behavior separately from supported behavior. Adopt that distinction, not its full harness matrix.[^o-bench]

### B. Make child results durable and independent of live actor state

**Problem and example.** Two ended turns can compete for one pending-report slot. A retry of an earlier report runs the same code that changes the actor's state. Parent insertion, provider admission, and review are currently insufficiently separated.

**Change.** Replace the single pending field with a durable per-turn outbox. Use a stable source ID incorporating actor, binding generation, turn, and result revision. Store the stable parent actor identity and resolve its current conversation when dispatching. Add atomic `enqueueOnce(sourceId, payload, origin)` to the existing inbox store. A duplicate within the recovery contract must return the original receipt, including after retained transcript text has been compacted. Retain receipt identity until its producer can no longer retry, or preserve durable generation watermarks/tombstones that reject expired source IDs with a resynchronization result. An expired ID must never silently become a new insertion.

Freeze the report payload when recording the turn outcome, including that turn's actual model and result. Retries must not reconstruct it from the actor's current model or latest outcome. Use the persisted turn journal and a durable per-actor reconciliation cursor to recover a crash between recording turn end and creating the outbox entry; do not assume atomicity across separate files. Advance the cursor only after the outbox record is durable.

Durable parent-inbox insertion is sufficient to acknowledge the outbox; do not wait for the parent's model turn to finish. Keep wake/admission uncertainty on the inbox item. Reconcile uncertainty using persisted provider/conversation evidence or a verified idempotent provider operation. If neither can establish acceptance, show uncertainty and avoid replaying potentially executed work.

Separate recording a runtime event from retrying its delivery. Only an event matching the current execution and binding generation may change the actor's live state. Late events may complete their own turn record. Preserve `readerDirected` or a richer origin field through enqueue and delivery; the current queued path discards the supplied provenance.[^n-results][^n-inbox]

**Code anchors.** `src/core/types.ts`, `src/node/agent-runtime.ts`, `src/store/conversation-inbox.ts`, `src/node/lifecycle.ts`, `src/node/handlers-tools.ts`, and `src/node/workspace-reset.ts`.

**Acceptance.** Two reports survive parent failure and Node restart in order. A crash after durable turn end but before outbox insertion still recovers its report. A report from model A retains its payload after the actor runs another turn on model B. A crash between insertion and outbox acknowledgment creates no duplicate. Deduplication survives more than 100 later inbox records and receipt compaction; expired IDs produce a resynchronization response, never another insertion. Retrying A cannot interrupt B. Runtime origin survives all routes. Chat reset resolves pending results to the same parent actor's new session; workspace reset prevents archived missions from waking the new workspace leader while retaining their evidence. Parent acceptance followed by connection loss remains distinguishable from rejection before acceptance.

**Omnigent lesson.** Explicit delivery acknowledgments, stable source IDs, failed-wake recovery, and execution ownership checks are relevant. Its result recovery test deliberately restarts the runner before the parent drains the result.[^o-delivery][^o-post][^o-recovery]

### C. Serialize the shared session lifecycle

**Problem and example.** Workspace opening, a pending child report, and a native tab attachment can all attempt to resume the same cold session. The current native-attachment guard covers only one of those entry points.

**Change.** Move per-session in-flight reservation and lifecycle serialization into the shared ACP adapter boundary. Start, resume, relaunch, reset, and close must agree on binding generation and ownership. Recheck the durable binding before publishing a candidate process, its token, and its metadata. Dispose of a superseded candidate without changing the winning binding. Define lock ordering with Node admission to avoid deadlocks.

Ordinary resume preserves the exact conversation. Opening a view sends no assignment. A missing worktree continues to use the existing explicit unavailable-tab behavior; do not silently launch the task in the base checkout or replace its transcript.

**Code anchors.** `src/node/lifecycle.ts` around `ensureSession`, `start`, and `register`; `src/node/handlers-conversation.ts` `restoreNativeOwner`; `src/node/workspace-open.ts`; parent wake in `src/node/handlers-tools.ts`.[^n-session]

**Acceptance.** Race workspace open, parent wake, and native attach: exactly one fake ACP process and one provider session binding survive. Race resume against reset/close: no stale registration or resurrected old session. A failed candidate cannot revoke the winner's token. Repeated attachment generates zero prompts.

**Omnigent lesson.** Session identity and runner binding are distinct, and binding assignment is conditional. Neta needs the same ownership property inside its local Node; it does not need a central multi-host scheduler.[^o-launch]

### D. Make Node ownership and automatic upgrades atomic

**Problem and example.** A client checks that the old service is idle, then runs a separate stop command. Work can begin in that interval. Two starters can also race during stale-lock reclamation, and an old owner's unconditional cleanup can remove a successor's descriptor.[^n-startup][^n-lock]

**Change.** Give every Node instance a unique identity. Elect one process owner using a process-lifetime locking mechanism, with ownership-checked descriptor and socket cleanup. PID liveness alone is insufficient because PIDs are reused. Select the locking mechanism through a bounded macOS/Linux prototype: Node does not expose a portable built-in `flock`, so a native dependency must be evaluated explicitly rather than hidden in the implementation.

Add a conditional upgrade operation carrying the expected runtime instance and desired build. Inside the Node's admission boundary, verify no active turn, pending launch, or other operation that must finish; enter draining state before acknowledging. New work is durably queued or gets a retryable draining response. A stale request cannot stop a successor. Preflight the executable and bridge before draining; health-check the live replacement only after exclusive ownership handoff. Do not run two store-owning Nodes to validate an upgrade. Give the drain attempt an owner and deadline: if the updater disappears before retirement, restore admission when safe. If replacement startup fails after retirement, recover with the retained known-good build when safe, or persist a specific startup failure that the next command can recover. An automatic upgrade must not strand the service indefinitely in draining. Keep explicit operator `node stop` separate from automatic upgrade.

**Code anchors.** `src/node/lockfile.ts`, `src/node/lifecycle.ts`, `src/node/handlers-registry.ts`, fork `packages/neta-client/src/startup.ts` and `packages/cli/src/commands/handlers/neta.ts`.

**Acceptance.** Concurrent cold starts elect one owner. Concurrent stale-lock reclaim still elects one owner. Kill the owner and recover with one command. Old cleanup cannot remove new ownership records. A turn admitted between the client check and upgrade request causes deferral. Two upgraders cannot stop each other's replacement. Pending notifications survive draining. Candidate launch/handshake failure and updater disappearance recover admission or produce a durable recoverable startup outcome, including when work arrives during failure. Corrupt descriptors produce a classified recovery result.

**Omnigent lesson.** Process-lifetime locks and ownership-aware cleanup are useful precedents. Its configuration-change restart is not evidence of a safe draining protocol; Neta must implement and test that property itself.[^o-lock]

### E. Preserve staffing intent through model fallback

**Problem and example.** Initial validation honors an exact requested model, but the fallback adapter chooses the connected default or the largest-context/newest remaining model. A worker intentionally assigned a smaller model can still become a flagship after an authentication failure.[^n-model]

**Change.** Persist requested model separately from actual model. Give an assignment an explicit ordered set of permitted fallback alternatives, selected from OpenCode's catalog. Do not infer price or intelligence from context-window size. Generic chat can retain its authorized automatic fallback; constrained staffing must carry its constraint through fallback. If no permitted alternative is available, retain the assignment and show a connection repair or model-selection action.

Expose one versioned execution contract to both staffing and the UI. Include model/variant support, configured versus connected versus unknown readiness, and the last relevant failure. A configured credential or default model is not proof that a subscription is usable. OpenCode remains responsible for authentication, dynamic model facts, and execution. Neta controls assignment eligibility.

**Code anchors.** `src/node/worker-model.ts`, model-list mapping in `src/node/lifecycle.ts`, staffing in `src/node/handlers-tools.ts`, fork `packages/cli/src/acp/fallback.ts`, `service.ts`, and `catalog.ts` where applicable.

**Acceptance.** Provider A fails before output: permitted B executes, while unlisted flagship C never does. Requested and actual models remain consistent across snapshots, native chat, and parent reports. Failure after tool/output activity causes no replay. Reset and resume preserve assignment intent. Empty or unavailable catalogs are not represented as verified connections. Unsupported reasoning variants are rejected before launch.

**Omnigent lesson.** Declare capability/readiness uncertainty and verify requested-model behavior. Its code does not supply a ready-made cheap-model ranking; the permitted-alternative policy is a Neta-specific design.[^o-capabilities][^o-readiness]

### F. Verify current instructions and contain fork-specific code

**Problem and example.** Neta now injects a dedicated system section, but no applied context revision is acknowledged. Existing tests do not cover every role across reset, resume, compaction, and fallback. Neta-specific instruction logic also lives directly in OpenCode's general optimization plugin.[^n-context]

**Change.** Publish an instruction bundle atomically with actor identity, binding generation, role, revision/hash, and text. Have the adapter acknowledge the revision actually applied to a model request. Diagnostics expose the revision, not raw charter text. Missing, malformed, or mismatched context must produce a specific error rather than silently omit the standing instructions.

Move Neta-only injection/reminder code into a dedicated module with narrow registration hooks. Keep orchestration policy in Neta; preserve upstream ownership of native history, provider authentication, model execution, and the composer. Use the same typed bridge for capabilities, model constraints, instruction acknowledgment, and lifecycle events.

**Code anchors.** `src/acp/system-context.ts`, `src/node/handlers-conversation.ts` `sessionSystemContext`, `src/node/lifecycle.ts` prompt preparation, fork `packages/core/src/plugin/optimize.ts`, and the native fake-model fixture.

**Acceptance.** Inspect outgoing fake-model payloads for workspace leader, mission leader, and worker across first prompt, charter update, compaction, restart/resume, reset, and fallback. Each contains exactly one current Neta system section and no copied instruction prefix in user input. Chat reset preserves standing instructions but excludes prior conversation context. A stale bundle cannot be applied to a replacement binding.

**Omnigent lesson.** Instruction delivery has explicit lifecycle semantics. A declared per-turn system hook must be verified as such; it is not interchangeable with a first-user prefix.[^o-capabilities]

### G. Use automatic supervision and expose recovery controls

**Operator decision.** Remove `neta_wait`; do not introduce a cursor-based replacement. The original assessment found that polling returned the same settled actor repeatedly. Durable results and automatic parent wake now replace that workflow.

**Change.** Remove the tool name, schema, handler, Node adapter, generated tool lists, and active prompt instructions. Leaders should end their turn when delegated work is outstanding and continue when the runtime delivers results. `neta_status` remains an explicit status query, not a polling loop. Parent receipt never means the child assignment or mission is complete.

Expose concise delivery states in the existing spine and `/delivery`: result queued, received by parent inbox, delivery uncertain, and parent unavailable. The dialog opens the child or parent conversation and retries only pending outbox records. An uncertain provider prompt is never automatically resent. Include delivery failures in the attention filter, and show requested versus actual worker model. No second result queue or inbox-reading tool is needed.

Diagnostics should retain classified cause, runtime instance, actor/session/turn IDs, instruction revision, requested/actual model, and permitted recovery action. Redact credentials and preserve the full-snapshot reconnect contract. Runtime messages retain their provenance rather than becoming human authorization.

**Code anchors.** `src/tools/schemas.ts`, `src/tools/handlers/coordination.ts`, `src/tools/prompts`, `src/node/handlers-tools.ts`, `src/node/snapshot.ts`, existing `src/diagnostics`, fork `packages/tui/src/neta/shell.tsx`, `recovery.ts`, and `packages/neta-client`.

**Acceptance.** No actor is advertised `neta_wait`. A parent ending its turn still receives each child outcome. Delivery acceptance does not display as completed work. Worker review opens its mission lead; mission-lead review opens the workspace leader. Uncertain delivery offers inspection, never implicit replay. A safe retry cannot resend an uncertain provider prompt. Reconnect restores pending/uncertain states and current model facts.

**Omnigent lesson.** `sys_read_inbox` drains immediately; automatic wake starts an idle parent's turn. Adopt automatic supervision without adding a second queue or retaining a redundant blocking tool.[^o-inbox][^o-health]

### H. Certify the application that gets installed

**Problem and example.** The release workflow builds existing terminal artifacts but does not acquire and certify the native OpenCode pair. A successful local sibling checkout is not reproducible installation evidence.[^n-ci][^n-build]

**Change.** Add a pinned OpenCode checkout/build to CI and package its executable and required license material. Preserve existing intentional rollback functionality. Run the contract suite against both source and the staged binary. Test installation from the produced package in a clean temporary home without the sibling repository or Bun on the execution path. Keep platform claims limited to platforms exercised by the packaging matrix.

Each advertised capability maps to an exercised probe. Required probes fail if skipped. Include behavioral negatives: a permission denial passes only if a tool was actually attempted and did not execute; an instruction test examines the outgoing model payload; an exact-model test inspects the selected provider/model. The release gate uses fake providers. Actual account entitlements remain an independently observed operational fact, not a CI claim.

**Acceptance.** Bare `neta` cold-starts from the installed artifact, restores the workspace on reopen, and completes a fake-model turn without development dependencies. It passes the B–G failure matrix. Missing binaries, missing fork revisions, skipped required tests, and capability drift stop publication. Upstream rebases must pass the same gate before changing the pinned pair.

**Omnigent lesson.** Conformance is attached to the path actually exercised. Adopt a small native-OpenCode matrix and its separation of tested, failed, and unmeasured behavior.[^o-bench]

## Minimum failure matrix

| Scenario | Required invariant | Package |
| --- | --- | --- |
| Two child turns finish while parent is unavailable | Both results remain recoverable. | B |
| Retry old result while new turn runs | New turn remains running. | B |
| Crash after turn end, before outbox insertion | Journal reconciliation recovers the missing report. | B |
| Crash after inbox insertion, before result acknowledgment | One durable receipt, no duplicate execution request. | B |
| Retry after receipt compaction/expiry | Existing receipt or explicit resynchronization; no new insertion. | B |
| Retry old report after actor changes model | Original turn model and outcome remain intact. | B |
| Provider accepts prompt, connection drops before reply | Execution remains uncertain until evidence resolves it. | B |
| Chat reset while child report is pending | Report targets the current session of the same parent actor. | B |
| Workspace reset races child completion | Archived work cannot wake the new leader. | B |
| Workspace open, parent wake, and attach race | One provider process owns the binding. | C |
| Resume races reset or close | Old generation cannot publish itself. | C |
| Two cold starts reclaim a stale lock | Exactly one Node owns the store. | D |
| Late cleanup from old Node | Successor descriptor/socket survive. | D |
| Work begins after client idle check | Automatic upgrade defers. | D |
| Updater disappears or replacement fails | Admission recovers or next launch has a durable recovery path. | D |
| Cheap worker's connection fails | Only permitted alternatives can execute. | E |
| Provider fails after a tool ran | No automatic replay of the turn. | E |
| Compaction or fallback changes request construction | Exactly one current instruction bundle remains. | F |
| Leader ends its turn with children running | Runtime delivers results and resumes supervision. | G |
| Actor tool list and standing instructions are generated | No wait tool or polling instruction appears. | G |
| Client disconnects while agents run | Work survives; snapshot restores truthful state. | G |
| Native integration dependency missing in release run | Gate fails instead of skipping. | H |
| Clean packaged install without sibling checkout/Bun | One-command startup and fake turn succeed. | H |

## Boundaries and unresolved engineering choices

No new framework, centralized scheduler, cloud sandbox product, additional hierarchy, or Claude integration is required. OpenCode's native model loop remains the executor. Worktrunk remains responsible for Git worktree lifecycle. Neta retains machine-local execution and bounded snapshot hydration. Optional legacy paths are not removed by this plan.

Do not promise exactly-once model execution from an outbox alone. Neta can guarantee unique durable result insertion; uncertain provider acceptance still needs evidence or a proven provider idempotency contract. A result ledger also needs an explicit retention/compaction policy: retain source-ID receipts for the defined recovery window and reject expired retries through durable watermarks/tombstones; never discard pending or uncertain entries silently.

The principal implementation choices are the portable process-lock mechanism, the exact provider evidence available for ambiguous prompt admission, and the reset policy for already accepted but unreviewed parent results. Resolve these with bounded prototypes and failure tests before finalizing the affected storage migration. Default reset behavior follows the existing user-visible contract: chat reset changes conversation context; workspace reset archives mission work.

Success means an ordinary user can run `neta`, resume the same workspace, delegate, close the UI, reconnect, and obtain every worker outcome with the actual model and correct current instructions. Failures should preserve work and explain the next action. Passing a basic chat turn is necessary but insufficient.

## Implementation coverage in the working tree

All eight work packages are implemented. The operator's later decision replaces bounded waiting with durable automatic parent continuations; `neta_wait` is removed. The integration follows Omnigent's ownership and delivery mechanisms while keeping Neta's existing runtime and file store.

| Package | Implemented changes | Local verification |
| --- | --- | --- |
| A | Required conformance runner, pinned upstream source plus reviewed overlay, prerequisite and zero-skip gates. | Pin/overlay validation and required source fixtures pass. |
| B | Immutable per-turn results, permanent insertion receipts, parent-ordered retry, batched safe-boundary continuation, preserved origin, archive guards. Results persist before turn-end publication; restart also reconciles the actor's current-turn journal pointer. | Two-turn regression, crash before/after receipt, restart reconstruction, compaction, independent parents, busy-parent batching and reset tests pass. |
| C | Shared session lifecycle queue, generation-stamped events, retired-binding guards, shutdown that drains final persistence. | Mixed cold restores launch once; reset/close races, zero-prompt attachment, and gated shutdown tests pass. |
| D | Kernel-owned local ownership socket, checked cleanup, conditional upgrade admission with expiring reservations, authenticated startup probe. | Concurrent/stale ownership, owner death, successor cleanup, real-socket late-work admission and updater-expiry tests pass. |
| E | Ordered exact fallback choices, requested versus actual model, catalog readiness distinctions, policy preserved across promotion/resume/reset/relaunch. | Native fallback fixtures and fake-ACP assignment policy tests pass. Account authentication is not inferred from configured connections. |
| F | Atomic actor/generation-bound instruction bundles, dedicated OpenCode plugin, classified context failures, local application receipts and verified capabilities. | Role/hook matrix, native fake-model request assertions, replacement generations, and safe diagnostic receipt tests pass. Receipts prove request construction, not provider acceptance. |
| G | Automatic parent wake, `/delivery`, result attention states, safe pending retry, bounded runtime diagnostics, unresolved results retained in snapshots. | Tool, dispatcher, snapshot, diagnostics and native TUI fixtures pass. Uncertain execution is displayed and is not automatically replayed. |
| H | Pinned native build, license and artifact hashes, macOS/Linux CI matrix, clean packaged-install test without sibling checkout or Bun on its execution path. | Local source, staged native and isolated packaged cold-start/fake-turn/reopen checks pass. Final combined conformance run is recorded below; other platforms require CI execution. |

Receipt IDs are retained indefinitely; terminal outbox records shed their payload. There is no expiry path that can silently admit an old source ID again. New terminal results are durably recorded before their journal end, closing the cross-file crash window; current-turn journal reconciliation covers interrupted execution and older records missing their outbox entry. Legacy single pending reports are migrated on startup.

The native source overlay is frozen at SHA256 `81971dd4ca7c2351be51650ece15aaccf33b19577a18b1df401389015048ebe9`. It was applied to a clean pinned upstream base and its source manifest verified. Local certification is for `darwin-arm64`; the other matrix platforms are CI gates, not locally observed results. Existing user runtimes are not forcibly replaced: a legacy service without conditional-upgrade support remains usable and reports a deferred update until it exits.

Final combined local conformance: `bun run test:conformance` passed on September 14, 2026: 303 tests, zero failures and zero skips. This includes the pinned fork contracts, 144 source/runtime tests, the staged native fixture, and a packed installation that cold-starts, completes a fake-model turn, and restores its workspace without Bun or a sibling checkout on its execution path. Main typechecking, scoped formatting, and `git diff --check` also pass. The clean-home harness resolves the real Node executable rather than a host version-manager shim.

## Evidence scope and sources

Omnigent references are pinned to `b7626bbdbfbb600ae863a5215cfd9c3ef0269a83`. Neta references describe the working tree based on `a7ccc029b35523efd172fd10d3fcf2896dc135fe`; the OpenCode fork is based on `7a31b5c0f76ce1c06befacc09b47b4fc3c71c408`. Both Neta checkouts contain uncommitted migration work, so those base commits alone do not reproduce the inspected implementation. Assessment date: September 14, 2026. Omnigent code and tests are design evidence; its suite was not executed as part of this assessment. No live provider or production workload was used.

[^n-results]: Neta, [runtime result handling](/Users/sudhanshugautam/workspace/neta/src/node/agent-runtime.ts:29), [parent send and text-marker deduplication](/Users/sudhanshugautam/workspace/neta/src/node/handlers-tools.ts:617). The A/B sequence above was executed against the real function with in-memory fake ports.
[^n-startup]: Neta OpenCode fork, [client idle check and later replacement](/Users/sudhanshugautam/workspace/neta-opencode-v2/packages/neta-client/src/startup.ts:23), [replacement commands](/Users/sudhanshugautam/workspace/neta-opencode-v2/packages/cli/src/commands/handlers/neta.ts:50); Neta, [explicit stop handler](/Users/sudhanshugautam/workspace/neta/src/node/handlers-registry.ts:257).
[^n-session]: Neta, [shared ensureSession](/Users/sudhanshugautam/workspace/neta/src/node/lifecycle.ts:989), [native-only restore serialization](/Users/sudhanshugautam/workspace/neta/src/node/handlers-conversation.ts:105), [parent recovery caller](/Users/sudhanshugautam/workspace/neta/src/node/handlers-tools.ts:639).
[^n-model]: Neta, [initial worker selection](/Users/sudhanshugautam/workspace/neta/src/node/worker-model.ts:3), [model catalog mapping and configured-default fallback](/Users/sudhanshugautam/workspace/neta/src/node/lifecycle.ts:1380); OpenCode fork, [fallback selection](/Users/sudhanshugautam/workspace/neta-opencode-v2/packages/cli/src/acp/fallback.ts:18).
[^n-gateway]: Neta, [attachment-local message deduplication](/Users/sudhanshugautam/workspace/neta/src/opencode/gateway.ts:172).
[^n-tests]: Neta, [native fixture prerequisite skip](/Users/sudhanshugautam/workspace/neta/test/opencode-v2-native.test.ts:14), [current parent-report tests](/Users/sudhanshugautam/workspace/neta/test/agent-runtime.test.ts:1), [inbox tests](/Users/sudhanshugautam/workspace/neta/test/conversation-inbox.test.ts:1). Focused command: `bun test test/agent-runtime.test.ts test/conversation-inbox.test.ts test/node-conversation-handlers.test.ts test/worker-model.test.ts test/workspace-reset.test.ts` — 24 pass, 0 fail, 117 assertions.
[^n-ci]: Neta, [current CI and release jobs](/Users/sudhanshugautam/workspace/neta/.github/workflows/ci.yml:15).
[^n-inbox]: Neta, [inbox identity and retention](/Users/sudhanshugautam/workspace/neta/src/store/conversation-inbox.ts:10), [uncertain delivery and forced user-directed provenance](/Users/sudhanshugautam/workspace/neta/src/node/lifecycle.ts:524), [enqueue return semantics](/Users/sudhanshugautam/workspace/neta/src/node/lifecycle.ts:964).
[^n-context]: Neta, [context composition](/Users/sudhanshugautam/workspace/neta/src/node/handlers-conversation.ts:78), [prompt preparation](/Users/sudhanshugautam/workspace/neta/src/node/lifecycle.ts:1047); OpenCode fork, [current Neta system plugin](/Users/sudhanshugautam/workspace/neta-opencode-v2/packages/core/src/plugin/optimize.ts:63).
[^n-reset]: Neta, [workspace reset](/Users/sudhanshugautam/workspace/neta/src/node/workspace-reset.ts:19), [reset acceptance tests](/Users/sudhanshugautam/workspace/neta/test/workspace-reset.test.ts:1).
[^n-build]: Neta, [sibling setup](/Users/sudhanshugautam/workspace/neta/scripts/setup-opencode.ts:4), [OpenCode staging](/Users/sudhanshugautam/workspace/neta/scripts/build-opencode.ts:4), [integration documentation](/Users/sudhanshugautam/workspace/neta/docs/opencode.md:1).
[^n-lock]: Neta, [PID-based lock reclamation](/Users/sudhanshugautam/workspace/neta/src/node/lockfile.ts:116), [descriptor removal](/Users/sudhanshugautam/workspace/neta/src/node/lockfile.ts:82).
[^n-wait]: Neta, [current wait loop](/Users/sudhanshugautam/workspace/neta/src/node/handlers-tools.ts:957), [wait schema](/Users/sudhanshugautam/workspace/neta/src/tools/schemas.ts:238), [bounded snapshot](/Users/sudhanshugautam/workspace/neta/src/node/snapshot.ts:18).
[^o-bench]: Omnigent, [harness conformance bench](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/tests/harness_bench/README.md#L103-L139) and [capability drift verdicts](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/tests/harness_bench/verdict.py#L112-L136).
[^o-delivery]: Omnigent, [terminal result delivery acknowledgments](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/omnigent/runner/app.py#L1967-L2095), [execution ownership guards](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/omnigent/runner/app.py#L7056-L7114), [wake recovery](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/omnigent/runner/app.py#L7267-L7344).
[^o-post]: Omnigent, [stable event identity and delivery ambiguity](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/omnigent/native/_native_post_delivery.py#L1-L14).
[^o-recovery]: Omnigent, [subagent result recovery across runner restart](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/tests/e2e/test_subagent_restart_recovery_e2e.py).
[^o-launch]: Omnigent, [reuse or replace a runner binding](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/omnigent/host/daemon_launch.py#L235-L300).
[^o-lock]: Omnigent, [process-lifetime lock and ownership checks](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/omnigent/host/daemon_lifecycle.py#L142-L296), [lock tests](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/tests/host/test_daemon_lifecycle.py#L128-L154).
[^o-capabilities]: Omnigent, [instruction-delivery and execution capability declarations](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/omnigent/harness_capabilities.py#L91-L183).
[^o-readiness]: Omnigent, [readiness limits and unknown authentication state](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/omnigent/onboarding/harness_readiness.py#L1-L22).
[^o-inbox]: Omnigent, [immediate inbox drain](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/omnigent/tools/builtins/async_inbox.py#L252-L302), [automatic parent wake contract](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/omnigent/tools/builtins/spawn.py#L124-L161).
[^o-health]: Omnigent, [recent transport failure attribution](https://github.com/omnigent-ai/omnigent/blob/b7626bbdbfbb600ae863a5215cfd9c3ef0269a83/omnigent/native/_native_forwarder_health.py#L1-L20).
