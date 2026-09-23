# Direct OpenCode control

Decision for the OpenCode runtime: Neta should control its private OpenCode V2
servers through their native API and retire ACP from that execution path. The
current ACP bridge adapts OpenCode's own session API and event stream back into
ACP, which Neta then adapts into its conversation store. The native chat already
reads the private V2 API through a Neta gateway. The extra adapter owns no
mission state.

The direct adapter is implemented. New and restored OpenCode actors use it once
the Node runs this build; the live Node has not been restarted onto it. The
[manifesto](../../MANIFESTO.md) and current architecture docs now
describe the direct control path. ACP code remains only as a test fixture for
older coordination regressions and an exact-session migration test.

## Current responsibilities

| Responsibility | Current owner | Direct API path |
| --- | --- | --- |
| Workspace, mission, actor identity and writer lease | Neta Node | Neta Node |
| Private OpenCode process lifetime | ACP child started by Neta | Neta starts `opencode serve --stdio --port 0` and owns its lease pipe |
| Native session and transcript | OpenCode | OpenCode, using the saved vendor session ID |
| Prompt admission, inbox receipts and reset binding | Neta Node | Neta Node |
| Prompt, interrupt, model and agent selection | ACP calls OpenCode API | Neta calls OpenCode API |
| Tool registration | ACP calls directory scoped `mcp.add` | Neta calls `mcp.add` and reconciles it after location eviction |
| Permission requests and tool/turn events | ACP translates OpenCode events | Neta translates the same events into its existing durable conversation protocol |
| Per-actor tool authority | Private MCP proxy and actor token | Keep the private MCP proxy and actor token |
| Native chat gateway and notifications | Neta gateway and Node events | Keep the gateway and Node events |

The pinned V2 client exposes session create/get, prompt, interrupt, model and
agent changes, message history, permission replies, MCP list/add, and SSE event
subscription (`vendor/opencode/runtime/packages/client/src/promise/generated/client.ts`).
The current ACP adapter uses those APIs in
`vendor/opencode/runtime/packages/cli/src/acp/service.ts` and translates the
events in `vendor/opencode/runtime/packages/cli/src/acp/event.ts`. The private
server startup and authenticated readiness protocol are in
`vendor/opencode/runtime/packages/cli/src/services/standalone.ts`.
The isolated conformance test now starts a session through the old bridge,
stops its Node, attaches the direct adapter to that exact native session ID,
and exercises prompt, model, permission, cancellation, MCP registration, and
location eviction through a fake local provider.

## Preserve existing work

Neta's conversation ID and actor/mission records remain authoritative. Each
conversation metadata record already stores an OpenCode vendor session ID. For
an existing OpenCode conversation, start a private V2 server with the same data
directory, get that exact session ID, then attach to it. Do not create a new
session, replay a prompt, reset a conversation, or change the writer lease as a
side effect of migration. Keep the Neta transcript and OpenCode history intact.

Use one private OpenCode server per actor during this migration. V2 `mcp.add`
is directory scoped; sharing one server between two actors in the same worktree
would mix their MCP credentials. Keep all native writes behind the Neta Node's
session binding and generation checks. The TUI may read the selected session
through its scoped gateway; sends, cancellation, model changes, and reset still
enter through Neta.

The live audit on 2026-09-23 found two idle OpenCode leaders and no visible
active legacy-provider agents. Stored conversation metadata then contained 105
OpenCode, five Codex, and one Claude conversation. The six legacy histories
remain readable records. A retired runtime cannot silently create a new
OpenCode session under an old identity.

## Implementation and verification

The Node now uses `src/session/runtime.ts` and `src/opencode/direct-session.ts`.
It starts a private V2 server for each actor, verifies exact resume IDs, and
subscribes before prompt admission. The direct adapter translates events and
permission replies into Neta's existing durable conversation protocol. It
checks live MCP state before turns and after native attachment. On an uncertain
send or stream loss, it fences the private server and never replays the prompt.

The focused fake-provider conformance covers exact ID after Node restart,
two actors in one worktree with isolated tools, location eviction and
re-registration, model and agent controls, read-only policy, cancellation,
and native gateway admission. Historical records and mission ownership are
not rewritten. Live verification on existing NoScrubs actors remains a
separate cutover step, requiring a fresh service restart approval.

The broad coordination suite still uses its legacy fake wire fixture. Its
pre-existing failures must be reported separately from direct conformance;
the transport cutover cannot treat that suite as green without a passing run.
