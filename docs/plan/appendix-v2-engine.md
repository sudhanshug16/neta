# Appendix — the retired v2 engine

Reference only. Paths and line numbers refer to tag `v2-final`. Nothing here
is imported into v3; read it for ideas and for the traps it recorded.

## Vocabulary
- Units were session → leader → workers, with rooms ("teams") and notes. No
  mission entity. `SessionGoal` (`src/types.ts:62`) was one objective per
  session with append-only revisions and discoveries.
- Tiers `apprentice|journeyman|expert|architect` were trust levels mapped to
  backends and models in settings (`src/settings.ts:73`); roles
  `scout|worker|reviewer|debater` (`src/prompts/roles.ts:58`). v3 drops both.
- Nine worker states (`src/types.ts:73`): starting, running, waiting (legacy),
  queued, blocked, done, failed, killed, interrupted. `blocked` was resumable
  by reviving the exact ACP session (`manager.ts:1906,1969`).

## Durable state
- `~/.neta/checkpoints-v6/<id>/manifest.json`: content-addressed blobs, active
  worker refs, sharded terminal index, atomic rename, 0700/0600
  (`src/checkpoint-store.ts:36-124`). Debounced writes 100 ms / 1 s
  (`checkpoint.ts:821`). Current-state only; the only event-shaped log was
  `writerQueueHistory`.
- Per-worker persisted: state, timings, log entries + cursor, pendingQuestion,
  usage, `vendorSessionId`, model/mode/agentInfo, archived, revivalCount.
- `~/.neta/sessions/<manager-id>.json` live lease (socket, token, pid); locks,
  claims, stopped dirs. `~/.neta/leader-sessions/<id>/` vendor overlay home.
  `~/.neta/workspace-bindings/<id>.json` Worktrunk restoration hint.
- Restart restored sessions but never restarted workers; non-terminal became
  `interrupted` with `stateBeforeStop`; the writer slot stayed held until a
  process-death barrier proved the old run dead (`docs/how-it-works.md:110`).

## Control plane
- `neta mcp` owned the `WorkerManager` and exposed MCP tools to the leader:
  `neta_goal, neta_delegate, neta_exec, neta_workers, neta_status,
  neta_attach, neta_inspect, neta_wait, neta_send, neta_kill, neta_note`
  (`src/mcp/leader.ts:301-670`).
- A Unix socket channel (`src/channel/server.ts`, `protocol.ts`), one NDJSON
  request per connection; token-authorised leader requests and unauthenticated
  worker requests (progress, blocked, room-post). `actor-snapshot` returned a
  full session snapshot; subscription was polling `tail` every 400 ms.
- No pub/sub, no push. `WorkerEvent = done|failed|blocked|discovery` resolved
  in-process waiters only.

## Authority
- The leader was permanently read-only: adapter permissions at launch
  (`src/adapters/claude.ts:54`, codex sandbox, `opencode.ts:104`), a PreToolUse
  guard hook (`src/guard.ts`), and prompt text. `neta_exec` was an ungated
  escape hatch. No modes.
- CHARTER.md was text inlined into the prompt (`src/prompts/charter.ts:23`);
  no parsing, no change tracking.
- Writer serialisation: one `activeWriter` + FIFO `writerQueue` in the manager
  (`manager.ts:532,547,3695`) with a staleness guard on dequeue.
- Worktrees were never created; `restoreWorkspace` shelled to Worktrunk
  (`wt switch <branch> --no-cd --format=json`, `workspace.ts:170`) and refused
  unless the exact recorded path returned.

## Providers
- Settings (`src/settings.ts:79`): `leader{backend}`, `tiers{...}`,
  `backends{name: {command, args, modelArgs, modelEnv, tierModels, env,
  readOnlyArgs, writerArgs, resume, detect, disabled}}`, merged
  `~/.neta/settings.json` then `.neta/settings.json`. Defaults for claude,
  codex, opencode ACP bridges.
- Spread policy: explicit backend → tier backend → diversity rules →
  round-robin over installed backends with persisted cursors
  (`manager.ts:3060`). Operator wanted 2:1 codex:claude weighting; never built.
- Models were negotiated per session via ACP `configOptions` or
  `session/set_model` (`src/acp/connection.ts:291-340`); `neta models` opened a
  session to list them. Model choice was per tier, never per session.
- Claude Fable models were policy-forbidden for workers (`settings.ts:88`).

## ACP session handling worth keeping in mind
- `AcpConnection` handled `initialize`, `session/new`, `session/resume`,
  `session/set_config_option`, `session/set_model`, `session/prompt`,
  `session/cancel`; streamed `agent_message_chunk`, `tool_call`,
  `tool_call_update`, `agent_thought_chunk`, `usage_update`,
  `config_option_update`, `current_mode_update`.
- The desktop leader session accumulated chunks and emitted one message per
  turn; v3 must stream blocks with turn ids instead.
- `test/fixtures/fake-acp-agent.mjs` implements all of the above and is driven
  by prompt directives (`EDIT, DELAYED_EDIT, FAIL, THINK, USAGE, MCP, STREAM,
  DIFF, TRAP_SIGTERM, CONFIG_UPDATE, MODE_UPDATE, HOLD_FOREVER, HISTORY,
  WAIT_FOR_BARRIER`) and flags (`--config-options, --bare, --session-store,
  --uuid-session, --unsupported-resume, --reject-resume, --launch-mcp`). It can
  persist sessions to a JSON store so cross-process resume is testable.

## Toolchain
- `build` = `bun build src/cli.ts --target=node --outdir=dist`; `typecheck` =
  `tsc --noEmit`; `check` = biome + typecheck; `test` = `bun test`.
- The desktop bridge was a second entry point compiled with `bun build
  --compile` outside package.json and copied into the app bundle by
  `apps/macos/scripts/build-app.sh`.
- CI ran on Linux only; the Swift app was never built or tested in CI.

## Traps recorded
- Nine worker states were collapsed to six for the desktop, losing blocked vs
  queued and killed vs failed.
- Per-session counters (`rw<n>`, `ro<n>`) were never global; v3 numbers
  missions per workspace in the store.
- No event log meant checkpoints on a timeline were impossible to reconstruct.
