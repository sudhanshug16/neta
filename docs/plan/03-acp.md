# 03 — ACP runtime

`src/acp/` owns every provider process and every ACP conversation. Nothing above
it (Node, tools, modes, clients) speaks JSON-RPC to a provider or knows that one
provider needs a flag another does not. It depends only on `src/core/`.

Read first: `docs/plan/README.md`, `docs/plan/01-domain.md`,
`docs/plan/appendix-v2-engine.md` (Providers, ACP session handling),
`MANIFESTO.md` "Agents, skills, providers, and models" and "ACP, steering, and
recovery", and the directives atop `test/fixtures/fake-acp-agent.mjs`.

## Settings

`~/.neta/settings.json` (or `$NETA_DIR`) merged under
`<workspaceRoot>/.neta/settings.json`; the workspace layer wins. The schema is
the `Settings` type in T3.1. Shipped defaults, all with `resume: true`:

| name | command | args | readOnlyArgs | readWriteArgs | defaultModel |
|---|---|---|---|---|---|
| `claude` | `npx` | `-y @agentclientprotocol/claude-agent-acp@0.68.0` | `[]` | `[]` | `sonnet` |
| `codex` | `npx` | `-y @agentclientprotocol/codex-acp@1.3.0` | `-c sandbox_mode="read-only" -c approval_policy="never"` | `-c sandbox_mode="workspace-write" -c approval_policy="never"` | `gpt-5.6-terra[medium]` |
| `opencode` | `opencode` | `acp` | `[]` | `[]` | `""` |

`leader` defaults to `{ provider: "claude" }`; `forbiddenModels` to `[]` (v2
hard-coded a Claude Fable ban, v3 makes it the operator's list); `defaultModel:
""` means "run on whatever the provider already selected".

## Decisions this workstream encodes

- **Model is per session, never per tier**, and it survives resume.
- **Access is enforced twice**: launch args, then the permission answer.
- **Steering never injects**: cancel, wait for the boundary, prompt again.
- **Recovery does not replay**: a dead process gives one `interrupted` event
  with the last turn id; reviving is decided above this layer.
- **The session does not know what the tools are**: it forwards its
  `mcpServers` to `session/new` and never inspects them.
- **`src/acp/access.ts` is the only file that may branch on a provider name.**

## Tasks

Done when, for every task: `bun run check` and `bun test` pass, the named test
file exists and passes, no `any`, no inline imports, the commit is made as given,
and the tests talk only to `test/fixtures/fake-acp-agent.mjs`.

### T3.1 provider settings
Goal: load, merge and validate provider settings.
Reads: this file, `src/core/types.ts`.
Writes: `src/acp/settings.ts`, `test/acp-settings.test.ts`.
Contract:
```ts
export interface ProviderSettings { command: string; args: string[]; env?: Record<string, string>;
  readOnlyArgs?: string[]; readWriteArgs?: string[]; resume: boolean; defaultModel: string; disabled?: boolean }
export interface Settings { providers: Record<string, ProviderSettings>;
  leader: { provider: string; model?: string }; forbiddenModels: string[] }
export interface PartialSettings { providers?: Record<string, Partial<ProviderSettings>>;
  leader?: Partial<Settings["leader"]>; forbiddenModels?: string[] }
export const DEFAULT_PROVIDERS: Record<string, ProviderSettings>;
export const DEFAULT_SETTINGS: Settings;
export function mergeSettings(base: Settings, patch: PartialSettings): Settings;
export function loadSettings(o: { netaDir: string; workspaceRoot?: string }): { settings: Settings; warnings: string[] };
export function providerFor(s: Settings, name: string): ProviderSettings;
export function launchArgs(p: ProviderSettings, access: Access): string[];
export function isForbiddenModel(s: Settings, model: string): boolean;
export class UnknownProviderError extends Error { readonly provider: string }
```
Steps: 1. Ship the defaults table verbatim. 2. Merge per provider, field by
field; arrays replace, never concatenate; new providers are added.
3. `loadSettings` reads `<netaDir>/settings.json` then the workspace file, both
optional; bad JSON or a wrong-typed field is dropped with a `warnings` line,
never a throw; `providerFor` throws for missing or `disabled`.
Tests: defaults with no files; workspace beats user beats defaults; arrays
replace; bad JSON warns and keeps the lower layer; `disabled` throws;
`launchArgs` matches the access; `isForbiddenModel` is exact-match.
Commit: `feat(acp): provider settings`

### T3.2 provider process
Goal: spawn one provider, speak ACP over its stdio, and kill it for certain.
Reads: this file, `src/acp/settings.ts`, and `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` for the client API.
Writes: `src/acp/process.ts`, `test/acp-process.test.ts`, `package.json`.
Dependency: the first runtime dependency, `@agentclientprotocol/sdk` pinned exactly at `1.3.0`, in `dependencies` (the fixture already imports it).
Contract:
```ts
export interface ExitInfo { code: number | null; signal: string | null; at: IsoTime }
export interface ClientHandlers { onSessionUpdate(p: SessionNotification): void;   // SDK types
  requestPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> }
export interface SpawnOptions { provider: ProviderSettings; access: Access; cwd: string;
  handlers: ClientHandlers; env?: Record<string, string> }
export interface ProviderProcess { readonly pid: number; readonly connection: ClientConnection;
  readonly initialize: InitializeResponse; readonly exited: Promise<ExitInfo>;
  stderrTail(): string; kill(): Promise<ExitInfo> }
export const KILL_GRACE_MS = 2000;   // SIGTERM, then SIGKILL
export function spawnProvider(o: SpawnOptions): Promise<ProviderProcess>;
```
Steps: 1. Spawn `command` with `launchArgs(provider, access)`, `cwd`, env
`{...process.env, ...provider.env, ...opts.env}`, stdio piped. 2. Connect
`acp.client()` over `ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout))`,
forwarding `session/update` and `session/request_permission` to `handlers`.
3. `initialize` with `PROTOCOL_VERSION` and `fs.readTextFile`, `fs.writeTextFile`,
`terminal` all false; keep the response and the last 8 KB of stderr. 4. `kill()`
sends SIGTERM, waits `KILL_GRACE_MS`, then SIGKILL, resolves the same `ExitInfo`
as `exited`, and is safe to call twice.
Tests: the fixture completes `initialize` and reports its agent name; `kill()`
exits it on SIGTERM; after `TRAP_SIGTERM` only the SIGKILL escalation ends it;
a missing command rejects with the stderr tail.
Commit: `feat(acp): provider process transport`

### T3.3 block mapping
Goal: turn ACP session updates into domain `Block`s, purely.
Reads: this file, `docs/plan/01-domain.md` (Block, Role, BlockKind).
Writes: `src/acp/blocks.ts`, `test/acp-blocks.test.ts`.
Contract:
```ts
export interface BlockDraft { role: Role; kind: BlockKind; text: string; data?: Record<string, string | number | boolean | null> }
export type SessionSignal = { kind: "model"; model: string } | { kind: "mode"; modeId: string };
export function blocksFromUpdate(update: SessionUpdate): BlockDraft[];
export function signalFromUpdate(update: SessionUpdate): SessionSignal | undefined;
export function canCoalesce(prev: BlockDraft, next: BlockDraft): boolean;
export function diffSummary(path: string, oldText: string, newText: string): string;
```
Steps: 1. Map each `sessionUpdate` with role `agent`; anything unlisted gives
`[]`. `agent_message_chunk` → `text`; `agent_thought_chunk` → `thought`;
`tool_call` → `tool`, text = title, `data {toolCallId, toolKind, status}`, plus
one `diff` block per diff content item; `tool_call_update` → the same with the
new status; `usage_update` → `status` `"<used>/<size> tokens"` plus
`" · $<amount>"` when priced, `data {used, size, costAmount, costCurrency}`;
`config_option_update` → one `status` per changed option, `"<name>: <value>"`,
plus a `model` signal for a model option; `current_mode_update` → `status`
`"mode: <id>"` plus a `mode` signal. 2. `diffSummary` is `"<path> (+<added>
−<removed>)"` from a line comparison, full texts in `data.oldText` /
`data.newText`; no diff dependency. 3. `canCoalesce` holds only for two `text`
or two `thought` drafts, same role, neither carrying `data`.
Tests: one case per update kind from literal objects; a `tool_call` with a diff
yields two blocks in order; a changed model yields a status block and a model
signal; `canCoalesce` accepts two text chunks, rejects text beside thought.
Commit: `feat(acp): acp update to block mapping`

### T3.4 model negotiation
Goal: decide, purely, which model a session runs on and how to set it.
Reads: this file, `src/acp/settings.ts`, and `test/fixtures/fake-acp-agent.mjs` (its `configOptions` function and `session/new` response).
Writes: `src/acp/models.ts`, `test/acp-models.test.ts`.
Contract:
```ts
export interface ModelOption { id: string; name: string }   // ModelSource: which wire shape the provider speaks
export type ModelSource = "config" | "legacy" | "none";
export interface ModelState { source: ModelSource; current?: string; options: ModelOption[] }
export type ModelCall = { method: "session/set_model"; params: { modelId: string } }
  | { method: "session/set_config_option"; params: { configId: string; value: string } };
export interface ModelPlan { model?: string; call?: ModelCall }
export function modelStateFrom(response: unknown): ModelState;
export function planModel(s: ModelState, wanted: string | undefined, forbidden: readonly string[]): ModelPlan;
export class ForbiddenModelError extends Error { readonly model: string }
export class UnknownModelError extends Error { readonly model: string; readonly options: ModelOption[] }
```
Steps: 1. `modelStateFrom` reads a `session/new` or `session/resume` response,
preferring a `configOptions` entry with `category === "model"` (source
`config`, `configId` is its `id`), else `models.availableModels` with
`currentModelId` (`legacy`), else `none`. 2. `planModel`: no `wanted` keeps
`current` unless `current` is forbidden, then the first allowed option, else
`ForbiddenModelError`; a forbidden `wanted` throws the same; a `wanted` outside
the options throws `UnknownModelError` unless the source is `none`, where the
plan is empty; `wanted === current` plans no call. 3. The call is
`session/set_config_option` for `config`, else `session/set_model`.
Tests: the plain fixture gives `legacy` with `test-model` current,
`--config-options` gives `config`, `--bare` gives `none`; a Claude-shaped list
whose current is `claude-fable-5`, with that id forbidden, plans a switch to
the first allowed option; forbidden and unknown requests throw.
Commit: `feat(acp): model negotiation`

### T3.5 Neta tool proxy servers
Goal: describe the `neta mcp` stdio server a session hands to `session/new`.
Reads: this file, `docs/plan/README.md` (Processes).
Writes: `src/acp/mcp.ts`, `test/acp-mcp.test.ts`.
Contract:
```ts
export interface McpEnvVar { name: string; value: string }
export interface McpServerSpec { name: string; command: string; args: string[]; env: McpEnvVar[] }
export interface NetaBin { command: string; prefixArgs: string[] }
export const NETA_MCP_SERVER_NAME = "neta";
export function netaBin(env?: NodeJS.ProcessEnv): NetaBin;
export function netaMcpServer(o: { actorId: string; token: string; socketPath?: string; bin?: NetaBin }): McpServerSpec;
```
Steps: 1. `netaBin` is `{command: env.NETA_BIN, prefixArgs: []}` when `NETA_BIN`
is set, else `{command: process.execPath, prefixArgs: [argv[1]]}`, so a checkout
and an installed bundle both work. 2. `netaMcpServer` gives `name: "neta"`,
`args: [...prefixArgs, "mcp", "--actor", actorId, "--token", token]`, and `env`
carrying `NETA_SOCKET` when `socketPath` is given; never log the token.
Tests: `NETA_BIN` wins over `process.execPath`; argv order is exactly as above;
the socket path lands in `env`, not `args`; two actors give two specs.
Commit: `feat(acp): neta tool proxy server spec`

### T3.6 the session
Goal: one provider process plus one ACP conversation behind a small interface.
Reads: this file, `docs/plan/01-domain.md`, `src/acp/` (process, blocks, models, mcp), `test/fixtures/fake-acp-agent.mjs`.
Writes: `src/acp/session.ts`, `test/acp-session.test.ts`.
Contract:
```ts
export interface StartOptions { settings: Settings; provider: string; access: Access; cwd: string;
  model?: string; mcpServers?: McpServerSpec[]; resumeVendorSessionId?: string; sessionId?: SessionId }
export type SessionEvent = { type: "turn"; turn: Turn } | { type: "block"; block: Block }
  | { type: "turnEnd"; turnId: TurnId; stopReason: string; cancelled: boolean }
  | { type: "model"; model: string } | { type: "mode"; modeId: string }
  | { type: "interrupted"; turnId?: TurnId; exit: ExitInfo };
export interface AcpSession { readonly sessionId: SessionId; readonly vendorSessionId: string;
  readonly provider: string; readonly cwd: string; readonly access: Access; readonly model: string;
  readonly openTurnId?: TurnId; readonly configOptions: readonly ConfigOption[];   // SDK type
  prompt(text: string): TurnId; cancel(): Promise<void>; listModels(): ModelOption[];
  setModel(model: string): Promise<void>; setConfigOption(configId: string, value: string): Promise<void>;
  relaunch(access: Access): Promise<void>; close(): Promise<void>;
  events(): AsyncIterableIterator<SessionEvent> }
export function startSession(opts: StartOptions): Promise<AcpSession>;
export class TurnInProgressError extends Error { readonly turnId: TurnId }
export class ResumeFailedError extends Error { readonly vendorSessionId: string }
export class SessionClosedError extends Error {}
```
Steps: 1. Spawn for `access`, then `session/resume` when `resumeVendorSessionId`
is set and `resume: true` — a rejected resume throws `ResumeFailedError`, never
silently opening a new conversation — else `session/new` with `cwd` and
`mcpServers`. 2. Apply `planModel` over `modelStateFrom(response)` with
`opts.model ?? provider.defaultModel` and `settings.forbiddenModels`.
3. `prompt` throws `TurnInProgressError` mid-turn; else it mints a `turnId`,
emits `turn`, sends `session/prompt`, returns the id synchronously, and on the
result emits a `status` block for any usage then `turnEnd` (`"error"` plus a
status block with the message when the call rejects). 4. Drafts carry a
per-session `seq` from 1; one that `canCoalesce` with the last block appends to
it and re-emits at the same `seq`; signals also emit `model` / `mode` events.
5. Permissions follow `access`: `readWrite` takes the first `allow_once` (else
`allow_always`), `readOnly` the first `reject_once` (else the cancelled
outcome). 6. An unrequested exit emits `interrupted` with `openTurnId` and the
`ExitInfo`, ends the iterator, and replays nothing. 7. `relaunch` restarts the
process with the other access args, resuming `vendorSessionId`; `sessionId`, the
iterator and `seq` survive. 8. `events()` has one consumer and throws
`SessionClosedError` on a second call.
Tests: `STREAM` is one growing `text` block at one `seq`; `TOOL_STREAM` splits
into text, tool, text; `THINK`, `DIFF`, `USAGE` yield thought, tool plus diff,
and status blocks; `EDIT` allows on `readWrite` and rejects on `readOnly`; `MCP`
echoes the proxy server passed in; `MODE_UPDATE` gives a status block and a
typed event; a second `prompt` mid-turn throws; `HOLD_FOREVER` plus a kill emits
`interrupted` with that turn id; resuming a `--session-store` fixture answers
`HISTORY` with the earlier prompts, and `--reject-resume` throws.
Commit: `feat(acp): acp session`

### T3.7 access switching
Goal: move a live session between `readOnly` and `readWrite`, quirks and all.
Reads: this file, `src/acp/session.ts`, `src/acp/settings.ts`.
Writes: `src/acp/access.ts`, `test/acp-access.test.ts`.
Contract:
```ts
export interface AccessQuirk { configId: string; valueFor(access: Access): string }
export const ACCESS_QUIRKS: Record<string, AccessQuirk>;
export type AccessPlan = { kind: "none" } | { kind: "relaunch" } | { kind: "config"; configId: string; value: string };
export function planAccessSwitch(provider: string, current: Access, target: Access,
  options: readonly ConfigOption[]): AccessPlan;
export function switchAccess(session: AcpSession, target: Access): Promise<void>;
export class AccessSwitchUnsupportedError extends Error { readonly provider: string }
```
Steps: 1. `ACCESS_QUIRKS` names the live config option per shipped provider:
`claude` → `mode`, `plan` / `acceptEdits`; `codex` → `sandbox`, `read-only` /
`workspace-write`; `opencode` → `mode`, `plan` / `build`. 2. `planAccessSwitch`
gives `none` when `current === target`; `config` when the quirk's `configId` is
among the advertised options and that option offers the value; `relaunch`
otherwise. 3. `switchAccess` cancels any open turn, waits for the boundary, then
applies the plan: `config` calls `setConfigOption`; `relaunch` calls
`session.relaunch(target)` and throws `AccessSwitchUnsupportedError` when
`resume: false`; a failed `setConfigOption` falls back to `relaunch` once.
Tests: `planAccessSwitch` returns each of the three shapes; with
`--config-options` and a quirk pointed at an option the fixture has,
`switchAccess` takes the config path and reports the new access; with a plain
`--session-store` fixture it relaunches, keeping `sessionId`, `vendorSessionId`
and the `HISTORY`; `resume: false` with no usable option throws; an open turn is
cancelled first.
Commit: `feat(acp): access switching`

### T3.8 steering
Goal: the manifesto's steering rule as one function.
Reads: this file, `MANIFESTO.md` "ACP, steering, and recovery", `src/acp/session.ts`.
Writes: `src/acp/steer.ts`, `test/acp-steer.test.ts`.
Contract:
```ts
export const STEER_TIMEOUT_MS = 10000;
export function waitForTurnEnd(s: AcpSession, turnId: TurnId): Promise<{ stopReason: string; cancelled: boolean }>;
export function steer(session: AcpSession, text: string): Promise<TurnId>;
```
Steps: 1. With no turn open, `steer` is `session.prompt(text)`. 2. Otherwise it
calls `session.cancel()`, awaits the cancellation boundary — the `turnEnd` for
the open turn, never a timer — and only then prompts. 3. If the boundary does
not arrive within `STEER_TIMEOUT_MS` it rejects and sends no prompt: a
half-steered session is worse than a refused one. 4. `waitForTurnEnd` subscribes
through the session's single consumer and must not swallow events other readers
need; nothing here queues text.
Tests: steering an idle session prompts once; steering during `HOLD_FOREVER`
gives `turnEnd` with `cancelled: true` then exactly one new turn, in that order
(assert event order, not a sleep), and `HISTORY` shows both prompts on the same
vendor session; a session whose process is gone rejects rather than hangs.
Commit: `feat(acp): steering`

### T3.9 runtime
Goal: the workstream's public entry point for 04.
Reads: this file, every module in `src/acp/`.
Writes: `src/acp/runtime.ts`, `src/acp/index.ts`, `test/acp-runtime.test.ts`.
Contract:
```ts
export interface AcpRuntime { readonly settings: Settings; reloadSettings(): { warnings: string[] };
  start(opts: Omit<StartOptions, "settings">): Promise<AcpSession>; list(): AcpSession[];
  get(sessionId: SessionId): AcpSession | undefined;
  close(sessionId: SessionId): Promise<void>; closeAll(): Promise<void> }
export function createRuntime(o: { netaDir: string; workspaceRoot?: string }): AcpRuntime;
```
Steps: 1. `createRuntime` loads settings once; `reloadSettings` re-reads both
layers and affects only later sessions. 2. `start` fills in `settings` and
registers the session; a session that emits `interrupted` or is closed
deregisters itself. 3. `closeAll` closes every session concurrently and resolves
only once every process has exited. 4. `src/acp/index.ts` re-exports every
module in the workstream.
Tests: two concurrent sessions keep their blocks in their own streams; `get` and
`list` follow starts and closes; `closeAll` leaves no live child (assert each
recorded pid is gone); a session killed underneath the runtime leaves `list()`
clean and restarts with `resumeVendorSessionId`, whose `HISTORY` proves the same
vendor conversation and that nothing was replayed.
Commit: `feat(acp): acp runtime`
