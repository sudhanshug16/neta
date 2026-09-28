> Historical plan. Superseded by [the current tools and communication contract](tools-and-communication.md). This document is not an active implementation requirement.

# Neta chat, filter, and artifacts

Status: implementation in the local checkout, 2026-09-24. This records the
requested product direction and acceptance contract. The role, filter,
presentation, question, and artifact paths are implemented and covered by
focused fake-runtime tests. Full repository and native provider certification
remain separate from this local implementation.

## Goal and ownership

The user talks to **Neta**, a native OpenCode conversation. Neta may answer from
verified current state or send the user's instruction to the appropriate
workspace leader. Neta does not create missions, hire agents, take writer
authority, or grant permissions. The workspace leader owns work and creates
missions; each mission lead owns its workers. A separate internal **filter**
judges what information from the leader and its tree needs Neta's
attention. Neta Node owns durable transport, identity, evidence, and receipts.

The existing name **Neta Node** continues to mean the machine service. The
former user-facing label **Neta** is **Neta**. The filter is an internal
OpenCode session, not another user chat or another execution leader. The
filter's model can judge relevance, combine related updates, and ask for bounded
evidence. Node validation and delivery remain deterministic.

The operator chose **one Neta conversation per workspace copy on a machine**.
The filter also keeps separate session context and decisions for
that workspace/machine pair. Every record carries both identities. Two copies
of the same repository on different machines have distinct Neta chats,
leaders, routes, notices, and artifacts. No cross-workspace or cross-machine
evidence enters either model context. The user selects the machine copy before
routing work; an offline copy does not silently hand work to another machine.

```text
User <-> Neta -> workspace leader -> mission lead -> worker
          ^              |
          +-- filter <---+  (bounded evidence and artifact references)
```

The arrows express communication and authority, not a requirement to run a
model at every level for every result. Neta Node stores a worker's artifact
once. Parent agents and the filter receive its identity and a small preview.

Four invariants drive the design: only the leader tree starts execution;
user-relevant failures and questions remain pending until handled; no route
delivery or model assertion alone proves completion; and content crosses
levels by reference unless an actor deliberately opens it.

## Current pieces to extend

- `src/node/handlers-me.ts` saves routes with verbatim user text, a derived
  instruction, a destination leader, and a delivery receipt. The route's first
  leader reply is reconciled when Neta reads attention; a reply is not proof of
  completed work.
- `src/me/capture.ts` captures selected lifecycle events and completed
  reader-directed leader turns. A setup failure before mission registration
  produces no `mission.failed` event. Other useful turns can also miss this
  reader-directed capture rule.
- `src/me/curator.ts` and `src/me/runtime-curator.ts` already support an
  internal OpenCode classifier with `surface`, `update`, and `suppress`
  decisions. It is currently optional, machine-global, and separate from an
  automatic continuation of Neta's native chat.
- `src/me/store.ts` holds source, decision, route, inquiry, and checkpoint
  records. It does not yet record which evidence Neta actually presented in
  its chat. The native OpenCode transcript remains the conversation source of
  truth; Neta stores bounded pointers and receipts.
- Neta has conversation attachments, but no actor-scoped immutable artifact
  publication tool for a worker's table or file.
- The current native runtime can send with a stable `sourceId` and expose
  message/turn receipts. The implementation must prove that a notice can be
  matched to the persisted OpenCode turn after a crash before promising
  duplicate-free recovery.

## End-to-end contract

1. **Admit the user's instruction.** Save the exact user turn, selected
   workspace/machine, and stable route ID. Neta chooses whether it can answer
   from evidence or should route to the leader. Its interpretation travels
   beside the verbatim text and cannot replace it. A routed message can be
   admitted and delivered without a bound leader turn or completed work.
2. **Capture work as evidence.** Node records mission and actor lifecycle
   changes, completed leader turns, child reports, questions, setup failures,
   and artifact publication with stable source IDs. Capture occurs before
   advancing replay cursors. A source has workspace/machine, actor, parent,
   route, mission, turn, and artifact IDs where applicable. A failed mission
   setup is captured even though no mission record or agent exists.
3. **Classify incrementally.** On a meaningful source or a small batch of
   related sources, the filter receives bounded new evidence, current work
   state, and a compact ledger of source references in notices already
   presented through Neta. It
   chooses `surface`, `update`, `defer`, `resolve`, or `request_detail`, with
   source IDs, a concern key, a brief reason, and whether the user owes an
   answer. It cannot execute workspace tools, assign work, approve access, or
   treat a worker's text as the user's instruction.
4. **Present through native chat.** A `surface` or `update` decision creates
   one durable update notice to Neta's native OpenCode session. Neta writes the
   user-facing answer in its native chat and can open referenced artifacts.
   Node ties the notice and its saved evidence to that native turn automatically.
   The send carries a stable notice identity internally so recovery can inspect
   the exact turn. Only a completed turn with user-facing text records a
   presentation. An uncertain committed send is
   held for reconciliation rather than automatically repeated. The receipt
   points to the exact native message and stores its hash and a bounded digest
   of what Neta actually said, so the filter can distinguish an update from a
   repeated message. Delivery to Neta is not presentation to the user;
   presentation does not prove the user read the chat. The existing workspace
   navigation marks this Neta chat as needing attention until the client has
   a read receipt; it does not render a separate chat.
5. **Carry answers back down.** Neta links a user reply to a pending
   question/route ID before delivery to the workspace leader, then the leader
   passes it to the mission lead or worker through their existing parent chain.
   With multiple plausible pending questions, Neta asks which one the user
   meant before sending the answer. One answer cannot satisfy a different
   question. If the target has closed or changed, the leader receives the reply
   and resolves or reroutes it explicitly.

The filter's OpenCode session may produce ordinary text internally. Neta Node
must accept only a validated structured decision or tool result, and never
render that internal text as the Neta chat response. A failed, timed-out, or
invalid decision leaves the source pending for retry.

## Durable records and state

Use the existing route/inbox, event, and Me stores rather than a parallel chat
queue. Add bounded metadata records with these meanings:

| Record | Required fields and meaning |
| --- | --- |
| Route | ID, exact user turn, workspace/machine, leader, derived text, admission and delivery receipts, linked work IDs, latest work state. `delivered` means transport only. |
| Source | Stable ID and sequence, source kind, event/turn pointer, actor and parent, workspace/machine, route/mission IDs, session generation, short preview, artifact IDs, time. Source text is untrusted evidence. |
| Filter decision | Source IDs, action, concern key, reason, priority, user question state, model/turn ID, decision time. The Node validates evidence and audience. |
| Update notice | Source IDs, pending/queued/committed/resolved status, native Neta turn and message IDs, message hash, bounded presentation digest, committed time. A UI read receipt, if available, is a separate fact. |
| Artifact | Immutable ID, content hash, MIME type, byte size, title, producer actor/turn, workspace/machine/mission, storage location, bounded preview, creation time. |

Use source IDs and receipts for deduplication. Do not deduplicate by paraphrased
text. A route, leader acknowledgement, mission creation, lead result, and
final user report are distinct steps. Reconciliation after restart must be
idempotent; uncertain sends are inspected before replay and never blindly
duplicated.

The filter's context comes from these records, including bounded digests of
committed native replies, not unbounded transcript hydration. `presentedSources`
means Neta committed a cited native reply.
`readByUser` requires a separate client receipt and must remain unknown when
that receipt does not exist. Resetting or compacting an OpenCode chat does not
erase pending sources, route identity, or presentation history.

`leaderReceived` means the inbox admitted the message; `leaderProcessed`
requires a bound native leader turn. These are transport and execution facts,
not claims about the model's understanding. A filter decision may cite either,
but it cannot report completed work from `leaderReceived` alone.

## `artifacts` tool

Add a workspace-scoped MCP tool with publish and inspect/open actions. A worker or
lead may publish an artifact to Neta Node, but publication alone does not
expose it to the user or bypass the parent chain. The owner lead decides
whether it is valid for the task; the filter decides when its reference should
reach Neta. Neta may present it with a native file/link preview.

- `publish({path, title, mimeType})` copies a local file into private
  immutable storage and returns only `{id, hash, size, preview}`. This is the
  preferred path for tables: bytes never pass through model tool arguments.
- `publish({text, title, mimeType})` is allowed only for a small
  bounded text payload. Support UTF-8 plain text, Markdown, CSV, and JSON
  first. Large content must use a file; binary formats need a separate
  renderer/preview contract before enablement.
- Node resolves and checks the source path under the actor's assigned
  workspace/worktree, rejects symlink escapes and known secret/config paths,
  enforces type and byte caps, writes mode `0600`, and verifies the stored
  hash. Every actor in the workspace copy can read it, including across missions.
  Reads still check workspace and machine. A reference from
  an offline machine remains visible as unavailable, never an empty file.
- A correction creates a new artifact ID linked to the old one. Existing
  evidence and displayed user messages keep their original version. Retention
  must preserve cited and pending artifacts; cleanup must not remove them
  while a route or notice refers to them.

For a requested table: worker writes CSV once, publishes it, and reports the
artifact ID and a short finding to its mission lead. The mission lead reviews
it and reports upward. The filter sees the short finding and reference. Neta
retrieves the full CSV only to show or inspect it. A worker's unreviewed
artifact cannot claim mission completion.

## Attention rules

The filter chooses relevance, grouping, wording, and urgency. Node enforces
these minimum guarantees:

- Capture explicit user questions, blockers, startup/setup failures, permission
  records, uncertain execution, and terminal outcomes durably. The filter may
  suppress stale or already handled records after reading their actual evidence;
  source kinds alone do not force a chat update. An unanswered question or
  required user decision remains visible until answered or resolved.
- A route with no bound leader turn or work progress by its deadline creates
  an attention source. The source includes the actual leader/session state;
  delivery alone is never treated as progress. Slow active work uses its
  heartbeat and a later deadline rather than repeated alerts.
- Routine progress may be deferred or folded into a later update. Every
  `defer` has a reason and a recheck trigger or deadline. Repeated progress
  for one concern updates one notice rather than making new chat turns.
- A failure that recovers quickly can be presented together with its recovery,
  with both source IDs. A failure still active at its deadline is surfaced.
- The filter may request bounded detail by source/artifact ID. It cannot poll
  the whole transcript or recursively ask another model without a per-source
  budget. Model failure leaves the source pending; explicit urgent items use
  a minimal structured fallback notice so the user is not left unaware.
- Record source-to-notice latency, pending urgent age, retries, filter turns and
  tokens, and bytes opened at each level. Keep raw source text and artifact
  content out of diagnostic logs. Batch related sources to avoid one model
  call per tool event.
- A leader's immediate response to a route can be an acknowledgement. A
  terminal claim needs either a linked durable work outcome or an explicit
  leader report; the filter cannot infer completion from route delivery.
- `resolve` must cite a later source that actually answers a question or
  clears a blocker. A filter decision by itself cannot close either.

## Edge cases and expected behavior

| Case | Required behavior |
| --- | --- |
| Two identical user sends or route retry | One route per source user turn/idempotency key; preserve both distinct turns if the user really sent twice. |
| Ambiguous or offline workspace/machine | Neta names the uncertainty; no speculative leader target or silent execution on another machine. Queue only where an exact owner exists. |
| User talks directly to leader/lead/worker | Preserve that native chat. Capture consequential outcomes for attention, but do not claim Neta presented them. Do not treat agent text as user authorization. |
| User asks Neta again without a new work event | Neta can answer from current verified state and the presentation ledger; the filter does not block a fresh user question. |
| Neta or leader busy when a message arrives | Durable inbox serializes delivery; a pending message survives client closure and Node restart. No overlapping turns in one session. |
| Route delivered but leader stops before processing it | A progress deadline and session exit event create an attention source. The route remains unprocessed and may be resumed with the same identity. |
| Delivery receipt uncertain or old generation replies late | Reconcile by source ID, turn ID, and session generation before retry. Fence stale outcomes; no duplicate user notice or state rollback. |
| Mission setup fails before registration | Record `worktree.setupFailed` with number, partial worktree, bounded diagnostic and exact route; wake the filter/Neta. No false mission or launched lead. |
| Lead or worker result arrives before parent reads earlier result | Store each result separately; parent inbox has insertion and review receipts. No single pending slot can overwrite another. |
| Question passes through several actors | Keep one question ID, requesting actor, current owner, and answer status. Show one user question. Replies travel down through the leader and parent chain. |
| Multiple questions, late answer, or closed target | Correlate by exact ID; show stale/closed state and let the leader resolve. Never apply an answer to the newest unrelated question. |
| Conflicting actor reports or unverified completion claim | Retain both sources and ask the owning leader to reconcile; the filter cannot silently choose a winner or mark work complete. |
| Worker publishes an artifact but its lead disappears | Preserve the artifact and surface the stalled review. Do not claim the unreviewed artifact is a final result. |
| Permission already accepted or rejected by native policy | Carry the actual disposition. Do not ask the user to approve a request that has already been decided. |
| A native provider leaves permission awaiting the user | Neta shows the actual pending request and points to the owning native session. A chat reply to Neta is not a permission grant. The current OpenCode path auto-decides permissions, so it must not invent this state. |
| Model filter crashes, times out, or emits invalid decision | Keep source pending, retry with backoff, and surface urgent fallback. The internal text is not user-visible. |
| Filter says suppress for an unresolved failure/question | Reject the decision or convert it to deferred with a deadline; record the invalid decision for diagnosis. |
| Neta drafts but fails before its turn commits | Notice remains pending. Retry with the same source IDs after checking the native transcript. |
| User edits/cancels the request during execution | Append scope change/cancellation to the route; leader decides effect on work. Late outputs carry their original scope and cannot be reported as current without reconciliation. |
| Direct answer without mission | Leader turn can yield a cited result; route still gets a terminal outcome separate from its first acknowledgement. |
| Artifact large, duplicate, changed, missing, or malicious | Enforce caps/hash/access; same bytes may dedupe storage, but each publication retains provenance. A change is a new version. Missing bytes are a visible failure. |
| Artifact contains instructions or sensitive content | Treat bytes as untrusted data and scan/preview conservatively before user exposure. No execution from an artifact. |
| Neta chat reset or context compaction | Durable ledgers remain. New session resumes pending notices and reads a bounded summary; no historical instruction replay. |
| Model/Node outage or machine disconnect | Preserve sources and statuses; replay after recovery. Show machine offline, not completed or zero results. |
| User reads leader chat but not Neta chat | Track chat presentation separately from any UI read receipt. Do not infer user read state from leader turn capture. |

## Implementation order and acceptance

These are reviewable packages, not authorization to release or publish. Use
fake OpenCode sessions and local fixtures; tests make no real provider or
production calls. Preserve unrelated uncommitted work and stage only named
files if a later instruction authorizes a commit.

1. **Contract and naming.** Use one Neta conversation per workspace/machine
   pair. Update
   `MANIFESTO.md`, `docs/how-it-works.md`, role prompts, and user-visible
   labels together. Keep `Neta Node` distinct. Verify Neta has no mission,
   agent, writer, or approval tools; leader/lead authority stays intact.
2. **Source coverage and route lifecycle.** Extend existing event/capture
   records with exact route/work links and pre-mission setup failures. Capture
   meaningful leader turns regardless of whether a user or Neta started them.
   Separate admission, acknowledgement, running, blocked, ready, and terminal
   states. Test the mission #52 sequence and direct leader work.
3. **Presentation ledger and wake.** On completed leader turns and attention
   events, reconcile the matching route immediately and enqueue one Neta
   notice. A completed Neta native turn with a bound notice delivery writes the
   presentation receipt automatically.
   Prove the native `sourceId` to persisted message/turn mapping under a crash
   before enabling automatic retries. Test busy sessions, uncertain sends,
   restart, duplicate notifications, reset, and late/stale turns. A first
   leader acknowledgement cannot close a route.
4. **Filter session.** Adapt Luna's existing OpenCode classifier to the
   bounded per-workspace decision contract and read-only tool surface. Add
   `defer`, `resolve`, and `request_detail`, evidence validation, deadline,
   retry, and urgent fallback. Test model failure and invalid/suppressing
   decisions without paid model calls.
5. **Artifact publication.** Add private immutable storage, actor-scoped
   `artifacts`, metadata/previews, version links, access checks, and a
   native presentation path. Test a worker CSV moving by reference through
   lead, leader, filter, and Neta; assert the full bytes enter no parent model
   context merely because the reference traveled upward. A parent or Neta can
   explicitly open the artifact for review.
6. **Question round trip and final certification.** Correlate questions and
   answers across all levels, including stale/closed targets. Exercise the
   package in a real Node plus fake OpenCode stack. Run `bun run check`,
   `bun test`, and native integration gates without skipped required cases;
   report any environmental blocker as unverified rather than passed.

The release acceptance story is: a user requests a table; the leader starts a
mission; a worker publishes a CSV once; Neta shows the reviewed artifact and
one cited conclusion. A separate setup failure before mission registration
appears in Neta without polling. Node restarts or filter failure cannot erase
either pending item or create duplicate user messages.
