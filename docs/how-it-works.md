# How Neta works

The workspace leader is the user's assistant in native OpenCode chat for one workspace copy on one machine.
The coordinator has the fixed name **Coordinator** and owns execution. A mission lead directs a bounded mission;
workers carry out assignments within it. The Node owns sessions, durable messages,
worktrees and runtime activity. [MANIFESTO.md](../MANIFESTO.md) defines scope.

## Communication

```text
User → Workspace leader → send_message → Coordinator
                                ↓ dispatch_mission
                            Mission lead
                                ↓ spawn_agent
                              Worker

Worker final reply → Mission lead
Mission lead final reply → Coordinator
Coordinator final reply → Filter → Workspace leader → User
```

Commands, questions, clarifications and answers use the same message operation.
The workspace leader calls `send_message({text})`; its destination is always its coordinator.
Leaders call `send_message({agentId,text})` to address an authorized subordinate.
Node attaches the sender and native turn automatically. The original user message
travels with a relayed instruction, including its wording and constraints.

When a turn stops, Node forwards its final visible assistant message. Intermediate
commentary, reasoning and tool output remain in native history. Failed or interrupted
execution is labeled as such. A stopped turn does not close a mission or establish
that an assignment is complete. The parent decides what to do next.
Only the Workspace leader asks the user a question, in a final reply. The user
answers in the next ordinary chat message. Managed roles cannot use the native
question tool; other agents tell their parent what decision they need.

Messages are persisted before delivery. Internal reports enter a running OpenCode
execution at its next safe model step, with each report kept as a separate native
message. A user can explicitly queue a native message for later. If a report is
still unread when an agent stops, Node keeps that reply in history and resumes
the agent with the report before forwarding a final reply upward. Inbox admission
and final handoff are ordered together. Retries reuse the saved delivery identity;
uncertain provider acceptance is visible and is never blindly replayed. Parent
wakeups use the same writer admission path as other messages.
An explicit interruption pauses automatic continuation until a new message or
prompt arrives.

## Tools

Tool names have no role or product prefix. The MCP namespace is `neta`, for
example `tools.neta.send_message({text: "Investigate this"})`.

| Role | Available tools |
|---|---|
| Workspace leader | `missions`, `mission`, `send_message`, `artifacts` |
| Coordinator | `dispatch_mission`, `spawn_agent`, `send_message`, `close`, `mission_state`, `list_models`, `setup_diagnostic`, `artifacts`, `change_model` |
| Mission lead | `spawn_agent`, `send_message`, `mission_state`, `list_models`, `artifacts`, `change_model` |
| Worker | `artifacts`, `change_model` |

Node authenticates each actor before listing or executing tools. Mission leads
see own-mission tool schemas without a mission selector and can address their own workers.
Workers cannot create children or send new commands
upward; their final replies reach their parent automatically. Every actor in a
workspace copy can inspect and open its artifacts, including artifacts from other
missions. Other workspace copies cannot read them. Renamed tools retain their existing capabilities.
There are no legacy tool aliases or separate reporting tools.

## Filter

One internal OpenCode session per workspace copy decides what the workspace leader should receive.
It has one MCP tool, `send_message({text})`, addressed only to the workspace leader.
Its standing system prompt explains the two incoming message types. A completed
workspace leader turn sends the user and leader conversation update for context;
the filter takes no action on that turn. A completed coordinator reply asks the
filter to decide whether to call `send_message` once or end without a tool call.
The filter receives ordinary native chat messages, not a repeated JSON instruction
and response protocol.

Node verifies that `send_message` was called during a Coordinator decision turn,
then saves the update for durable delivery. No tool call records a suppressed
update. Node owns retry identity and delivery receipts; the model supplies no
evidence IDs or presentation acknowledgments. Large artifacts stay referenced
within their workspace copy. Filter errors remain visible and stop retrying after
three failed attempts. Provider acceptance and the workspace leader's eventual
reply are recorded separately; neither proves that the underlying work succeeded.

## Execution and writers

The coordinator has read-write access for review and integration. Mission
leads inherit the mission's assigned access; workers retain their assigned access,
which cannot exceed the mission's. Access is part of the assignment, not a leader mode.

Node acquires the write slot before admitting each writing turn. It releases the
slot only after that turn and execution stop. A resumed turn must acquire it again.
A writing lead can delegate to a writer, finish its turn, and let the queued worker
run. When the worker replies, the parent reacquires its slot before continuing.

Git missions get Worktrunk worktrees. Each worktree has one writer; the base checkout
has a separate slot for integration. Folder workspaces share one write slot.
Read-only work does not consume a write slot. Native edit permissions honor assigned
read-only access; shell use must also respect the assignment's constraints.

## Missions and activity

Mission lifecycle is **open / closed**. Close disposition is completed, merged or
abandoned. Integration evidence, runtime failures and archive facts are retained.
Scope changes live in conversation instead of separate change records.

The coordinator calls `close` after reviewing work. Closeout protects active
execution, dirty worktrees and unmerged work; removal is verified through Worktrunk.
A closed mission remains readable in history. Continuing work after its worktree
was removed creates a new mission linked to the previous one.

Activity labels are **Running / Not running**, based on execution. Internal queued,
starting, failed, interrupted and archived records describe mechanical facts.
A question or a final message does not assign a blocked/completed activity label.

## Native sessions and persistence

OpenCode owns chat, history, rendering and the composer. The Neta spine adds workspace
and mission navigation around native sessions. Its top entries are **Workspace leader**,
**Filter**, and **Coordinator**. All three use regular OpenCode chat; opening the
filter reuses its processing session without running a new turn. An authenticated HTTP gateway lets the
renderer read the owned session while sends and cancellation pass through Node.
Closing a client or gateway does not stop its runtime. Node listens on
`~/.neta/node.sock`; the CLI and per-actor MCP proxies speak to that service.

The Node preserves missions, worktrees, artifacts and transcripts across restarts.
It resumes exact native sessions and keeps a visible failure when restoration is
uncertain. Chat reset starts fresh conversations while retaining saved work and history.

The filter keeps its durable `filter/state.json` and native chat across restarts.
An existing Filter session relaunches once to add its MCP tool; later openings
reuse that session. Earlier JSON-format turns remain chat history, but the
standing prompt supersedes their instructions. Retained mission and agent records
are normalized on load; retired control fields are removed.

## Models, diagnostics and development

Children receive task difficulty (`effort: 1–5`) or an explicit user-selected model.
Routing resolves the whole staffing plan before side effects. Queued workers retain
the chosen model. `change_model` changes a model without replacing the conversation.
See [model routing](model-routing.md) and [worktree recovery](worktree-recovery.md).

The Node bundle targets Node.js; development uses Bun. Tests use fake runtimes,
never paid provider calls. Build and verify the native fork using
[OpenCode integration](opencode.md). Export managed fork edits before building.

Main ownership points:

- `src/tools/`: schemas, role restrictions, handlers and standing instructions.
- `src/node/`: admission, native runtime wiring, parent delivery and socket handlers.
- `src/me/`: filter capture, decisions, durable delivery and artifacts.
- `src/store/`: missions, native transcripts and durable inboxes.
- `src/worktrees/`: writer slots and verified Worktrunk closeout.
- `vendor/opencode/overlay.patch`: the maintained native integration.
