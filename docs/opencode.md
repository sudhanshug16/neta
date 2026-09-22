# Native OpenCode terminal client

Neta's terminal client uses the Neta OpenCode fork, OpenTUI and SolidJS. OpenCode
owns the native composer, transcript, model catalog and model execution. Neta's
Node owns the workspace, leader, missions, agents, worktrees and writer leases.
The Claude SDK integration is deferred.

## Run from these checkouts

Keep the repositories side by side:

```text
workspace/neta            Node and orchestration
workspace/neta-opencode-v2  OpenCode V2 fork and terminal interface
```

In `neta`, run:

```sh
bun install --frozen-lockfile
bun run setup:opencode
bun run build
bun src/cli/main.ts tui
```

`setup:opencode` creates a missing checkout from the exact upstream commit and
reviewed source overlay in `vendor/opencode/integration.json`, verifies its
hashes, and installs locked dependencies. Set `NETA_OPENCODE_DIR` for a different
location. An existing checkout is checked, never reset or overwritten. Setup
reports source drift so local edits cannot disappear during an update.

Running `neta tui` starts a missing local Node, reuses a compatible one, and
replaces an outdated local Node when its actors are idle. An open mission alone
does not block an update. If actors are active on an older V2-compatible Node,
the TUI opens on that service and defers the update; it does not refuse to launch.
Automatic replacement uses the Node's conditional upgrade handshake. An older
V2 service without that handshake stays available until its next service restart.
Its plaintext standing instructions remain supported when it launches a new
OpenCode process, including after workspace reset. This compatibility path does
not claim generation verification or write a modern instruction receipt. A
partially specified modern binding never falls back to plaintext.
A pre-V2 engine without the upgrade handshake needs an explicit service update.
Remote machines still need a compatible engine installed by their operator.
Closing the TUI alone never stops the Node.

Bare `neta` in an interactive terminal opens the native client. `neta tui PATH`
explicitly opens a project; otherwise the last machine, workspace and selected
agent are restored. The old Toad workspace selection is imported on first use.
`neta chat` keeps the plain terminal client, and `neta tui --legacy` retains Toad
for rollback. Existing legacy conversations are not silently converted:
`neta tui --migrate` starts fresh OpenCode context while preserving Neta history,
leader identity and mission records. Migration is refused while that conversation
is busy. Old provider transcripts remain in Neta's conversation store; they are
not presented as native OpenCode history.

The fork can also launch the client with `bun run --cwd packages/cli ./src/index.ts neta`. If it must start the
Node itself, it uses the sibling `neta/dist/main.js` or `NETA_ENGINE_ENTRY`.

## V1 to V2 data

Managed V2 runtimes use `opencode-neta-v2.db` in OpenCode's data directory for
both source and compiled builds. On first start, V2 takes a SQLite snapshot of
`opencode-local.db`, `opencode-neta.db`, or `opencode.db` (in that order), then
runs upstream's history migration on the copy. The V1 database is not upgraded
or deleted. Set `NETA_OPENCODE_V1_DB` to select another source before first launch.
V2 retains imported session IDs; `/reset` remains an explicit fresh-context action.
The first import is a snapshot, not ongoing synchronization with the old runtime.

The previous `neta-opencode` checkout remains available for rollback with
`NETA_OPENCODE_DIR`; it is not changed by setup or build. No Claude SDK bridge
is added. V2 uses native integrations and credentials; account-specific model
access still depends on the connected provider.

## Controls

| Action | Control |
|---|---|
| Open spine help | Select **Help · actions** in the left spine or `/help` |
| Switch workspace | **Help · actions** or `/workspace` |
| Switch machine | **Help · actions** or `/machines` |
| Choose model/provider model | Native `/models` |
| Connect a model provider | Native `/connect` |
| Start fresh context | `/reset`, followed by confirmation |
| Recover a disconnected view | `/reconnect` |
| Inspect worker result delivery | `/delivery` |
| Open leader, mission lead, or active agent conversation | Select it in the left spine |
| Inspect inactive workers or archived conversations | **Help · actions** |

Mission rows and agent rows share status indicators. The left spine is the
only Neta navigation surface: mission leads and active agents stay visible;
other workers expand from their mission without duplicate rows. Running and starting actors use OpenCode's one-cell loader;
it respects the native animations setting. An open mission only animates when
one of its actors is working; otherwise it shows idle, queued, or interrupted.
Text labels remain visible alongside the marks.

| Mark | Status |
|---|---|
| Animated dots | Running or starting |
| `!` / `×` | Blocked / failed |
| `✓` / `□` | Completed / archived |
| `○` / `◷` / `‖` | Idle / queued / interrupted |
| `◇` / `◆` | Ready to close / merged, awaiting closeout |

Drafts survive switching tabs and workspaces within the client. Failed sends
restore the draft when the composer is empty. New text is never overwritten by
a delayed failure. No automatic retry submits a model turn.

The leader tab is keyed by workspace ownership, not provider session ID. Reset
replaces its session using the existing serialized Node reset operation; it does
not create another leader. Other connected clients follow an announced change.
Native actions that would create independent sessions, fork/revert Neta history,
or bypass Node ownership are unavailable in managed views. Standalone OpenCode
retains those actions.

Saved SSH machines come from Neta's `client-hosts.json`. The client forwards the
owning machine's Node socket and native loopback endpoint over SSH. A machine
must already have the migrated Node and fork installed. Unknown/offline machines
produce an error without closing the current chat. No remote install occurs.

## Integration contract, version 2

1. The Node starts one managed OpenCode ACP process per actor. ACP controls the
   **same native OpenCode session** rendered by the TUI; it does not forward
   turns to Codex CLI or a second model loop.
2. The fork advertises a private, authenticated native HTTP endpoint in ACP
   initialize metadata. The Node keeps provider credentials out of snapshots.
3. `conversation.native` creates an authenticated view gateway. Native reads and
   events use the V2 `/api` routes; the composer uses the private `neta-prompt`
   route so Neta owns message admission. Cancel and model changes also enter
   through Neta.
   The gateway scopes session reads, rejects stale bindings, and closes with its
   Node client connection. It does not own the provider process.
4. Tool discovery is deferred until the first turn, after the Node commits the
   actor record. This avoids a tools/list race during leader creation and reset.
   Each process has its own MCP configuration, so actors sharing a worktree do
   not overwrite one another's Neta credentials.
5. Native delegation is denied. Read-only Neta actors also cannot edit files or
   execute shell commands through OpenCode. Neta mission tools remain available
   and enforce their own scope/lease rules. An authorized Neta access change
   relaunches the runtime; native plan/build selection does not change that access.
6. Duplicate message IDs are deduplicated within a gateway attachment. This is
   not a durable exactly-once delivery protocol across Node restarts. Outcomes
   after a lost connection can be unknown, so the client never retries a send
   automatically.

The fork baseline is OpenCode commit
`7a31b5c0f76ce1c06befacc09b47b4fc3c71c408` (package version 2.0.3), recorded in
`neta-fork.json`. Keep the integration version aligned on both machines. The
initial implementation deliberately uses per-actor processes rather than a shared
OpenCode service: MCP configuration in this baseline is directory-scoped.

## Build and checks

```sh
# Node checkout
bun run typecheck
bun run test:opencode
NETA_TUI_SMOKE=1 bun test test/opencode-v2-native.test.ts
bun run build
bun run build:opencode

# Fork checkout
bun run --cwd packages/cli typecheck
bun run --cwd packages/tui typecheck
bun test --cwd packages/cli test/neta-database.test.ts test/acp/service.test.ts test/acp/error.test.ts
bun test --cwd packages/core test/permission.test.ts
```

The runtime fixture uses a local fake OpenAI-compatible server, a temporary Node,
private OpenCode directories and no real model credentials. The optional terminal
check uses an isolated tmux server and removes it on exit. It checks native
rendering, paths, workspace switching, draft retention and reopening the last workspace. The runtime check
also covers Neta MCP connection, read-only permissions, view detachment, leader
reset, cancellation, expired-sign-in errors and exact native identity after Node restart. The runtime fixture skips if
the sibling fork has not been installed; that skip is not a passing runtime gate.

`build:opencode` builds and stages the current platform's native executable under
`dist/opencode/PLATFORM-ARCH/`. A packaged Node bundle can find it without Bun or
the fork checkout. `NETA_OPENCODE_BIN` explicitly selects an executable. Source
checkouts prefer the source fork so a staged binary does not hide new edits.
The macOS arm64 executable has also passed the fixture with `NETA_OPENCODE_BIN`
pointing at the staged binary and `NETA_TUI_SMOKE=1`. The build uses the V2 CLI build pipeline.
Build each distribution on its target platform. Existing release automation is
not changed to publish this development migration; no version is bumped.

Provider sign-in and actual account/model entitlements remain OpenCode's native
responsibility. Fake-model tests do not prove subscription availability. The
Claude SDK path, cross-platform release certification, and a live remote-host
smoke test are separate follow-up work.

### Worker model selection and connection recovery

In an OpenCode workspace, workers always use the OpenCode runtime. Model choices
come from enabled models on connected integrations or providers with configured
credentials. Legacy `codex` and `claude` runtime selections are normalized to
OpenCode; an unavailable requested worker model is rejected instead of silently replaced. Use neta_status.modelCatalog to choose an exact connected model.

On authentication, quota, rate-limit, routing, transport, or provider-internal
failure before output or tools, the adapter tries another connected provider.
It prefers the configured default, then tool-capable models by context capacity
and release date. Each provider is attempted once, with at most three providers
per turn. The transcript names the failed connection, directs the user to
`/connect`, and names the replacement. Forbidden models stay excluded.
Cancellation, permission denials, policy refusals, turns that already produced
output, commands, skills, and attachment prompts are not automatically replayed.

### Reset choices

`/reset` offers **Reset chat** (blank selected conversation, missions unchanged)
and **Reset workspace** (archive all workspace missions and workers, stop their
sessions, return to a blank leader chat). Workspace reset preserves worktrees
and stored history; archived work is no longer active. Both choices describe
their effects before confirmation. A failed stop is reported rather than marking
that worker archived or releasing its writer lease.

Neta leaders use unrestricted provider access with a reminder injected each turn to keep sustained implementation in missions and coordinate writers. Read-only workers retain direct-edit denial but may use shell tools for inspection; their read-only shell behavior is instruction-based, not a filesystem sandbox. Native OpenCode subagents remain disabled so Neta owns the worker hierarchy.

Neta refreshes the actor working agreement, charter, skills, and mission context before each native prompt. OpenCode receives this as a dedicated system part through its context/generation hooks, not as a prefixed user message. Worker user messages contain the task only. Existing transcript entries are preserved; this does not rewrite old messages.

## Result supervision

Use `/updates` to catch up on completed workspace-leader replies inside the
existing OpenCode conversation. The view preserves reading position and read
markers and supports referenced replies through the native composer. See
[leader updates](updates.md) for controls, queue receipts and persistence scope.

Worker results are delivered to mission leaders, and mission leader results to
workspace leaders. The runtime wakes an idle parent; leaders do not poll or
call a wait tool. Inbox receipt does not mean a task is completed or reviewed.
The spine and `/delivery` distinguish queued, received, uncertain, and failed
parent delivery. Retry only resubmits unsent reports. An uncertain provider
prompt requires inspection of the parent conversation; it is not blindly replayed.

Staffing tools accept `fallbackModels`, an ordered list of exact permitted model
IDs. Omission means no substitution for that assignment. Requested and actual
models remain separate, including when a permitted alternative executes.

## Reproducible native releases

The source pairing is `vendor/opencode/integration.json` plus `overlay.patch`.
The overlay contains reviewed source files, tests and package manifests, never
ignored configuration, credentials, build output or dependency trees. After
reviewing fork changes, refresh it explicitly:

```sh
bun run export:opencode
NETA_RELEASE_BUILD=1 bun run build:opencode
bun run build
bun run test:conformance
```

Conformance requires the pinned fork, Node, and tmux. It runs source and staged
native paths against local fake models, then packs Neta and launches the package
from a temporary home with no sibling checkout or Bun on its execution PATH.
Missing required prerequisites fail; they are not counted as skipped passes.
The package check sends a fake-model prompt and reopens the saved workspace.
No account credentials or paid providers are used.

CI builds and certifies each supported macOS/Linux architecture. Every staged
native executable has a hash-checked build manifest and license. Publication
requires all four native artifacts and preserves the existing legacy runtime
artifacts. Local certification covers only the host platform; the CI matrix is
the evidence for the remaining platforms.

### Native prompt boundary

The V2 composer payload crosses Neta unchanged in one durable opaque envelope.
Neta owns admission, deduplication, and delivery receipts; it does not reconstruct
OpenCode text, file mentions, or skill selections. The ACP adapter unwraps the
payload and invokes OpenCode's prompt, command, or skill API. The adapter pins the
session and admission ID to the owning actor; OpenCode validates the native
payload and loads skills. Neta-owned delegation restrictions remain in force.
Legacy ACP prompts retain their existing conversion. Native skill/command/file
requests are not automatically replayed through model fallback.
