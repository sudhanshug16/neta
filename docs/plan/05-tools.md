# 05 — Neta tools

`src/tools/` is the only surface an ACP session has on Neta: leader, mission
lead and ordinary agent see the same MCP server, differing in the tool list
they get and what the Node lets them do. It also owns the three working
agreements and the charter and skill text inlined beside them.

Read first: `docs/plan/README.md`, `docs/plan/01-domain.md`, `MANIFESTO.md`
sections Principles, Leaders and missions, Agents skills providers and models,
Mission lifecycle and closeout, The mission inbox, CHARTER.md. Depends on 01
(types), 02 (store), 03 (sessions), 04 (Node); calls into 06 (worktrees,
closeout) and 07 (modes) through the interfaces those files define. A task here
that cannot see one of them yet stops and says so.

## Actors and authority

`neta mcp --actor <id> --token <t>` is a stdio MCP server. The provider
launches one per ACP session that needs tools; it holds no state and makes no
decisions. Every `tools/list` and `tools/call` is forwarded to the Node over
`~/.neta/node.sock` with the actor's token. The Node authorises, by kind:

- `leader` — the workspace leader's session. Everything, including
  `neta_mission` and `neta_close`.
- `lead` — an Agent with `canSpawn: true`. Runs its mission: spawn agents,
  wait, steer, record scope, mark ready.
- `agent` — an ordinary Agent. Reports only: progress and done. It gets neither
  `neta_agent` nor `neta_ask` — the hierarchy cannot grow without bound and a
  stuck agent reports rather than asks; the router refuses both again anyway.

`actorId` is the leader's `sessionId` or the agent's `agentId`. The token is 32
random bytes, hex, minted by the Node when it launches that session, held in
Node memory only, never written to disk. After a Node restart sessions are
re-launched or `session/resume`d with a fresh token, so a stale proxy fails
closed with `notAuthorised`.

04 routes two more socket requests here, authorised by `actorId` + `token`, not
by the client token the CLI and desktop use: `tools.list` with params
`{actorId, token}`, and `tools.call` with `{actorId, token, name, arguments}`.
Each result is the MCP payload the proxy returns unchanged — a `tools` array of
`{name, description, inputSchema}`, or `{content: [{type: "text", text}],
isError}`.

## The tools

Thirteen tools, with the one-line description each is given to the model:

- leader only — `neta_mission` create and start a mission, the only way one
  starts · `neta_close` close it as merged or abandoned · `neta_pin` pin a turn.
- leader and lead — `neta_agent` add an agent · `neta_wait` block until an
  agent finishes, fails or asks · `neta_send` answer or redirect an agent ·
  `neta_scope` record accepted scope · `neta_ready` hand over, ready to close ·
  `neta_mode` switch Lead / Lead++ · `neta_status` open-mission state ·
  `neta_ask` ask the user.
- lead and agent — `neta_progress` a start, a major step or a surprise ·
  `neta_done` the final outcome.

Schemas are JSON Schema 2020-12 and are the single source for `tools/list` and
for validation. Every schema below, and every object inside one, carries
`"type":"object","additionalProperties":false`, omitted here for readability;
`$defs` are expanded into each tool's schema so it stands alone.

```jsonc
"$defs": {
 "ulid":   {"type":"string","pattern":"^[0-9A-HJKMNP-TV-Z]{26}$"},
 "access": {"type":"string","enum":["readOnly","readWrite"]},
 "skills": {"type":"array","maxItems":8,"items":{"type":"string","minLength":1}},
 "task":   {"type":"string","minLength":1,"maxLength":400},
 "leadSpec":  {"required":["task"],"properties":{"task":{"$ref":"#/$defs/task"},
   "provider":{"type":"string"},"model":{"type":"string"},"skills":{"$ref":"#/$defs/skills"}}},
 "agentSpec": {"required":["task","access"],"properties":{"task":{"$ref":"#/$defs/task"},
   "access":{"$ref":"#/$defs/access"},"provider":{"type":"string"},
   "model":{"type":"string"},"skills":{"$ref":"#/$defs/skills"}}},
 "decisionRecord": {…}},   // the `DecisionRecord` of 01: every field required
                          // but `worktreePath`, the two estimates integers

"neta_mission": {"required":["name","objective","access","lead"],"properties":{
   "name":{"type":"string","minLength":1,"maxLength":60},
   "objective":{"type":"string","minLength":1,"maxLength":2000},
   "access":{"$ref":"#/$defs/access"},
   "lead":{"oneOf":[{"const":"self"},{"$ref":"#/$defs/leadSpec"}]},
   "agents":{"type":"array","maxItems":8,"items":{"$ref":"#/$defs/agentSpec"}},
   "continues":{"$ref":"#/$defs/ulid"}}},
"neta_agent": {"required":["task","access"],"properties":{"task":{"$ref":"#/$defs/task"},
   "missionId":{"$ref":"#/$defs/ulid"},"access":{"$ref":"#/$defs/access"},
   "provider":{"type":"string"},"model":{"type":"string"},"skills":{"$ref":"#/$defs/skills"}}},
"neta_wait": {"properties":{"missionId":{"$ref":"#/$defs/ulid"},
   "agentIds":{"type":"array","maxItems":32,"items":{"$ref":"#/$defs/ulid"}},
   "timeoutMs":{"type":"integer","minimum":1000,"maximum":1800000}}},
"neta_send": {"required":["agentId","text"],"properties":{"agentId":{"$ref":"#/$defs/ulid"},
   "text":{"type":"string","minLength":1,"maxLength":4000}}},
"neta_scope": {"required":["missionId","text"],"properties":{"missionId":{"$ref":"#/$defs/ulid"},
   "text":{"type":"string","minLength":1,"maxLength":1000}}},
"neta_ready": {"required":["missionId","summary"],"properties":{
   "missionId":{"$ref":"#/$defs/ulid"},"summary":{"type":"string","minLength":1,"maxLength":2000}}},
"neta_close": {"required":["missionId","disposition","reason"],"properties":{
   "missionId":{"$ref":"#/$defs/ulid"},"evidence":{"type":"string","maxLength":1000},
   "disposition":{"type":"string","enum":["merged","abandoned"]},
   "reason":{"type":"string","minLength":1,"maxLength":1000}}},
"neta_mode": {"required":["mode"],"properties":{"mode":{"type":"string","enum":["lead","leadPlus"]},
   "record":{"$ref":"#/$defs/decisionRecord"}}},
"neta_pin": {"required":["turnId","text"],"properties":{"turnId":{"$ref":"#/$defs/ulid"},
   "text":{"type":"string","minLength":1,"maxLength":400}}},
"neta_status": {"properties":{}},
"neta_progress": {"required":["text"],"properties":{"text":{"$ref":"#/$defs/task"}}},
"neta_ask": {"required":["question"],"properties":{
   "question":{"type":"string","minLength":1,"maxLength":1000}}},
"neta_done": {"required":["outcome"],"properties":{
   "outcome":{"type":"string","minLength":1,"maxLength":4000}}}
```

## Responses

A successful call answers with one text block: compact JSON on the first line,
then the reminder. A failure answers `error <code>: <message>` and the same
reminder. Codes: `notAuthorised`, `badParams`, `notFound`, `refused`, `timeout`,
`missingSkill`, `unavailable`. The reminder goes to `leader` and `lead` actors
only, from `core/state.needsPerson`, at most eight missions a line:

```text
[neta] needs you: #14 payments retry — blocked: staging key · #9 flaky specs — ready to close
[neta] running: #15 docs pass · #16 lens port
[neta] Lead++ 12m active — retry backoff in #14. Return to Lead when the writing ends.
```

Empty lines are omitted, the whole block only when nothing is open and the
leader is in Lead. 07 supplies the third line, through its
`ModeService.decorate`, which every tool response passes through; the same function renders the
preamble the Node prefixes to a new leader turn, headed `Current mission
state:`.

## Prompts, charter, skills

`src/tools/prompts/` holds three short working agreements in manifesto
vocabulary: `leader.md` (≤ 40 lines), `lead.md` (≤ 30), `agent.md` (≤ 20).
`scout`, `worker`, `reviewer`, `debater`, `apprentice`, `journeyman`, `expert`,
`architect` and `tier` are banned words and a test enforces it.

Charter: `<workspace root>/CHARTER.md`, then `~/.neta/CHARTER.md` — both
inlined when both exist, workspace first, which wins on conflict. Its sha256
lives at `~/.neta/charters/<workspaceId>.hash`; when that differs the store
emits `charter.changed`. Charters reach `leader` and `lead` contexts only. Each
name in `skills` resolves `<workspace root>/.neta/skills/<name>.md`, then
`~/.neta/skills/<name>.md`, inlined into that agent's context; a missing skill
is a `missingSkill` error and the agent is not spawned.

## Tasks

Every task is done when `bun run check` and `bun test` pass, the test file it
names exists and passes, and its commit is made.

### T5.1 tool schemas and actor tool sets
Goal: one module owning every tool's name, description, schema and callers.
Reads: this file, `src/core/types.ts`.
Writes: `src/tools/schemas.ts`, `test/tools-schemas.test.ts`.
Contract: all exported — `type ActorKind = "leader" | "lead" | "agent"`; `type
ToolName` (the 13 names above); one exported params interface per tool, named
for it (`MissionParams` … `DoneParams`), plus `LeadSpec` and `AgentSpec`, and
`interface ToolParams` mapping name to interface; `interface ToolDef { name:
ToolName; description: string; inputSchema: JsonSchema; actors: ActorKind[] }`;
`const TOOLS: readonly ToolDef[]`; `function toolsFor(kind: ActorKind):
ToolDef[]`; `function validate<N extends ToolName>(name: N, args: unknown): {
ok: true; value: ToolParams[N] } | { ok: false; message: string }`.
Steps: transcribe the schema block with `$defs` expanded per tool so each
`inputSchema` stands alone; write `validate` by hand, no dependency, covering
every keyword the block uses.
Tests: every schema round-trips a valid literal of its params type and rejects
an unknown property, a missing required one and a wrong type;
`toolsFor("agent")` is exactly `neta_progress`, `neta_done`, `toolsFor("lead")`
excludes `neta_mission`, `neta_close`, `neta_pin`, and `toolsFor("leader")`
excludes `neta_progress`, `neta_done`.
Commit: `feat(tools): tool schemas and actor tool sets`

### T5.2 open-mission reminder
Goal: the reminder on leader and lead responses, and the turn preamble.
Reads: this file, `src/core/state.ts`, `src/core/types.ts`.
Writes: `src/tools/reminder.ts`, `test/tools-reminder.test.ts`.
Contract: all exported — `interface ReminderInput { missions: Mission[];
modeLine?: string }`; `function reminder(input: ReminderInput): string`;
`function preamble(input: ReminderInput): string`.
Steps: partition with `needsPerson`; needs-you entries render `#<number> <name>
— <state label>: <attention>` (attention omitted when absent), running entries
`#<number> <name>`; cap each line at eight with ` · +N more`; omit empty lines;
return `""` when there is nothing to say.
Tests: ordering (needs-you before running, by number); the cap and `+N more`;
every `MissionState` maps to its label; `modeLine` last; empty input gives
`""`; `preamble` adds the heading and nothing else.
Commit: `feat(tools): open-mission reminder`

### T5.3 tool router and authorisation
Goal: the Node-side entry point: resolve, authorise, validate, dispatch.
Reads: this file, `src/tools/schemas.ts`, `src/tools/reminder.ts`,
`docs/plan/02-store.md`.
Writes: `src/tools/router.ts`, `test/tools-router.test.ts`.
Contract: all exported — `type Actor = { kind: "leader"; workspaceId; sessionId }
| { kind: "lead" | "agent"; workspaceId; missionId; agentId; sessionId }`;
`type ToolErrorCode` (the seven codes above); `type ToolResult = { ok: true;
data: Record<string, unknown> } | { ok: false; code: ToolErrorCode; message:
string }`; `interface ToolContext { actor: Actor; deps: ToolDeps }`; `type
ToolHandlers = { [N in ToolName]: (ctx: ToolContext, args: ToolParams[N]) =>
Promise<ToolResult> }`; `createTokenTable(): TokenTable`, a `TokenTable` being
`{ mint(actorId): string; verify(actorId, token): boolean; revoke(actorId):
void }`; `createRouter(deps: ToolDeps, handlers: ToolHandlers, tokens:
TokenTable): { list(actorId, token): ToolDef[] | ToolResult; call(actorId,
token, name: string, args: unknown): Promise<McpToolResponse> }`.
Steps: verify the token in constant time; resolve the actor from the store
(leader by `sessionId`, agent by `agentId`, `kind: "lead"` when `canSpawn`);
refuse an unknown name or one outside `toolsFor(kind)` with `notAuthorised`;
validate; dispatch; render with `reminder` for leader and lead.
Tests: a wrong or stale token gives `notAuthorised` and never reaches a
handler; an ordinary agent calling `neta_agent` or `neta_ask` is refused; bad
params give `badParams` naming the failing property; a handler failure becomes
`isError: true`; leader and lead responses carry the reminder, an agent's does
not; `revoke` invalidates immediately.
Commit: `feat(tools): tool router and actor authorisation`

### T5.4 stdio MCP proxy
Goal: `neta mcp --actor <id> --token <t>`, forwarding every call to the Node.
Reads: this file, `docs/plan/04-node.md`.
Writes: `src/tools/proxy.ts`, `test/tools-proxy.test.ts`.
Contract: all exported — `interface ProxyOptions { actorId: string; token:
string; socketPath?: string; stdin?: Readable; stdout?: Writable }`; `async
function runProxy(options: ProxyOptions): Promise<number>`.
Steps: speak MCP over NDJSON on stdio — `initialize` answers `protocolVersion`,
`serverInfo { name: "neta", version }` and `capabilities.tools {}`;
`tools/list` and `tools/call` forward to `tools.list` and `tools.call` on the
socket; connect lazily, reconnect once per call; a socket failure answers
`isError: true` with `error unavailable: …`; exit 0 on stdin end, killing
nothing.
Tests: drive `runProxy` with in-memory streams against a stub socket server —
`tools/list` after `initialize` returns the stub's list, `tools/call` forwards
name, arguments, actor and token verbatim, a refused connection yields an
`unavailable` response rather than a crash, an unknown method JSON-RPC −32601.
Commit: `feat(tools): stdio MCP proxy`

### T5.5 mission and agent tools
Goal: `neta_mission` and `neta_agent`: one call creates, isolates, starts work.
Reads: this file, `docs/plan/06-worktrees.md`, `src/tools/router.ts`.
Writes: `src/tools/handlers/mission.ts`, `test/tools-mission.test.ts`.
Contract: all exported — `const missionHandlers: Pick<ToolHandlers,
"neta_mission" | "neta_agent">`; `neta_mission` returns `{number, id, worktree}`
(`null` in a folder workspace), `neta_agent` `{agentId, name, missionId}`.
Steps: allocate the next number from the store; create the worktree through 06's
`WorktreeService.prepare` when the workspace is git; `lead: "self"` sets `lead: { kind:
"leader" }` and the leader's `activeMissionId`, else starts a lead session with
`canSpawn: true` at the mission's access; spawn each `agents` entry at its own
access, never above the mission's; append `mission.created` then one
`agent.spawned` per session; a readWrite mission in a folder workspace that
cannot take the lease is created and queued as `{ queued: true }`; `continues`
sets `continuesMissionId`, `notFound` when unknown; `neta_agent` defaults
`missionId` to the caller's, refusing another mission for a lead.
Tests: a git workspace creates a worktree and a folder one does not; numbers
are monotonic and never reused; `mission.created` precedes every
`agent.spawned`; a readWrite agent in a readOnly mission, a lead naming another
mission, and a missing skill are each refused, the last spawning nothing.
Commit: `feat(tools): mission and agent creation tools`

### T5.6 waiting, steering and reporting tools
Goal: `neta_wait`, `neta_send`, `neta_progress`, `neta_ask`, `neta_done`.
Reads: this file, `docs/plan/03-acp.md`, `src/tools/router.ts`.
Writes: `src/tools/handlers/coordination.ts`,
`test/tools-coordination.test.ts`.
Contract: all exported — `const coordinationHandlers: Pick<ToolHandlers,
"neta_wait" | "neta_send" | "neta_progress" | "neta_ask" | "neta_done">`; the
first, second and last return `{ changed: Agent[]; timedOut: boolean }`,
`{ agentId, delivered: "answered" | "resteered" }` and `{ agentId, state }`.
Steps: `neta_wait` subscribes to agent state changes for the mission or the
listed ids, returns at once if one is already terminal or blocked, else blocks
to `timeoutMs` (default 600000) and returns `timedOut: true` with the current
records, never an error; `neta_send` answers a blocked agent by resolving its
pending question, and steers a running one by cancelling the turn, waiting for
the cancellation boundary, then prompting the same session (03);
`neta_progress` writes `activity`; `neta_ask` sets `pendingQuestion`, moves the
actor to `blocked`, emits `mission.blocked`; `neta_done` records `outcome`,
moves to `completed`, emits `agent.finished`, leaving a lead's mission open.
Tests: `neta_wait` returns immediately for an already blocked agent, when a
fake-agent session finishes, and on timeout with `timedOut: true` and no error;
`neta_send` to a blocked agent clears `pendingQuestion` and emits
`mission.unblocked`, and to a running one cancels before prompting (assert the
order against the fake agent); `neta_done` twice is refused.
Commit: `feat(tools): waiting, steering and reporting tools`

### T5.7 mission lifecycle tools
Goal: the six lifecycle and mode tools, `neta_scope` through `neta_mode`.
Reads: this file, `docs/plan/06-worktrees.md`, `docs/plan/07-modes.md`,
`src/tools/router.ts`.
Writes: `src/tools/handlers/lifecycle.ts`, `test/tools-lifecycle.test.ts`.
Contract: all exported — `const lifecycleHandlers: Pick<ToolHandlers,
"neta_scope" | "neta_ready" | "neta_close" | "neta_pin" | "neta_status" |
"neta_mode">`; `neta_status` returns `{ missions: { number, name, state,
attention?, agents: number }[], mode, modeActiveMs }`.
Steps: `neta_scope` appends a `MissionChange`, never edits `objective`, emits
`mission.changed`; `neta_ready` sets the ready flag and summary, emits
`mission.readyToClose`; `neta_close` delegates to 06's `WorktreeService.close` and refuses
when `disposition: "merged"` carries no `evidence`, when the mission is already
closed, or when 06 reports a dirty or unmerged worktree without explicit
abandonment; `neta_pin` emits `user.pinned`; `neta_mode` delegates to
07's `ModeService.requestLeadPlus`, returning its `Approval` verbatim.
Tests: scope is append-only (objective unchanged after two calls, order kept);
merged without evidence refused, with evidence closes and emits
`mission.closed`; abandoned needs none; closing twice, and a lead closing at
all, are refused; `neta_status` lists open missions only, needs-person first.
Commit: `feat(tools): mission lifecycle tools`

### T5.8 working agreements, charter and skills
Goal: the three prompts and the module composing a session's context.
Reads: this file, `MANIFESTO.md` sections Principles, Leaders and missions,
Agents skills providers and models, Mission lifecycle and closeout, CHARTER.md;
`CHARTER.example.md`; `AGENTS.md` Neta Operating Contract, for tone.
Writes: `src/tools/prompts/leader.md`, `src/tools/prompts/lead.md`,
`src/tools/prompts/agent.md`, `src/tools/context.ts`,
`test/tools-context.test.ts`.
Contract: all exported — `function agreement(kind: ActorKind): string`; `const
BANNED_WORDS: readonly string[]`; `interface Charter { text: string; hash:
string; sources: string[] }`; `function loadCharter(root: string, homeDir:
string): Charter | undefined`; `function loadSkills(names: string[], root:
string, homeDir: string): { ok: true; skills: { name: string; text: string }[] }
| { ok: false; missing: string; available: string[] }`; `function
composeContext(input: { kind: ActorKind; charter?: Charter; skills?: { name:
string; text: string }[]; mission?: Mission; task?: string }): string`.
Steps: leader.md — route sustained work into missions; a task that writes is a
mission even when you lead it; one tool creates and starts it; you own
closeout, nothing closes without a disposition and a reason, and you stay in
Lead until you say otherwise. lead.md — you run one mission, add and steer
agents, report at a start, a major step and a surprise, then mark ready with a
summary for the leader. agent.md — one bounded task and your access; you cannot
create agents; stuck means stop and report; finish with `neta_done`. Inline the
three as string imports so the bundle reads no files; charter and skill lookup
as above, sha256 from `node:crypto`, rejecting a name with `/` or `..`;
`composeContext` emits the agreement, the charter (leader and lead only), the
skills, the mission brief (objective, accepted changes, access, worktree path)
and the task.
Tests: each agreement is inside its line budget and free of banned words; the
agent agreement names neither `neta_agent` nor `neta_ask`; the workspace
charter precedes the user one and the hash changes when either file changes,
and no charter gives `undefined`; a missing skill reports the name and the
available list, a traversing name is rejected; an ordinary agent's context has
no charter text and the brief keeps accepted changes in order.
Commit: `feat(tools): working agreements, charter and skill context`

### T5.9 session wiring and end to end
Goal: the MCP config Neta hands a session, and an end-to-end proof through it.
Reads: this file, `docs/plan/03-acp.md`, `docs/plan/04-node.md`,
`test/fixtures/fake-acp-agent.mjs`.
Writes: `src/tools/launch.ts`, `test/tools-e2e.test.ts`.
Contract: all exported — `mcpServerFor(actorId, token, socketPath):
McpServerSpec`, 03's descriptor (`{name: "neta", command, args, env}`) built
through `netaMcpServer` in `src/acp/mcp.ts`; `toolHandlers(): ToolHandlers`
merging T5.5–T5.7.
Steps: `command` is `process.execPath`, `args` the resolved CLI entry then `mcp
--actor <id> --token <t>`, `env` carries `NETA_SOCKET` only; 03 passes the
config at `session/new` and again at `session/resume`; the Node mints the token
immediately before each launch and revokes the previous one.
Tests: start a Node on a temp `NETA_DIR` with a folder workspace and a leader
session on the fake agent with `--launch-mcp`; prompt `MCP` and assert the
echoed config carries the actor id, a fresh token and the socket path, and that
the fixture launched the proxy without it exiting; then drive the proxy as a
provider would — spawn, `initialize`, `tools/list` returns the leader set,
`tools/call neta_mission` with a two-agent brief returns `{ number: 1, id,
worktree: null }`, the mission is in `snapshot` with two agents, and the log
holds `mission.created` and two `agent.spawned`; a revoked token is refused.
Commit: `feat(tools): session tool wiring and end-to-end mission creation`
