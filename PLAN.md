# Neta v2 plan — native TUIs, Neta as orchestrator

Design north star: [MANIFESTO.md](MANIFESTO.md) (tiers, roles, single writer,
charter, leader never writes). This plan replaces the v1 plan (pi-fork build,
now archived in this repo's git history). It is written so a fresh agent can
execute any phase without prior context.

## Why v2 (decision record)

v1 wrapped a forked pi TUI around external agent CLIs via ACP. It worked on the
Claude backend, but three findings killed the architecture:

1. **pi is built to own the agent loop, not to host someone else's.** Bridging
   external agents in as a fake pi "provider" left usage at zero, pi's own
   tools dead weight, and a bridge that breaks on every upstream change.
2. **Codex's sandbox denies Unix-socket `connect()` (EPERM)** from model-run
   shell commands, even with `danger-full-access` configured. The `neta` CLI
   channel can never be reliable from inside sandboxed shells.
3. **A leader that cannot delegate may silently fake success** (observed: it
   substituted Codex-internal subagents and reported "Done — 3 workers
   completed"). Enforcement and honest failure reporting must not depend on
   the backend's cooperation alone.

v2 inverts the topology: the user lives in the **vendor's native TUI**
(Claude Code, Codex, or OpenCode). Neta is a CLI orchestrator behind it — it
launches the leader with injected config, exposes worker control as **MCP
tools** (runs in the vendor host process, outside any sandbox — dissolves
finding 2), and enforces restrictions with each **vendor's own native
mechanisms** (kernel sandbox where available — stronger than v1's cooperative
permission gate).

## Settled decisions

- **No TUI of our own. No pi.** Plain TypeScript/Node, bun-compiled single
  binary, same as before. Two protocol deps, pinned exact:
  `@agentclientprotocol/sdk` (workers), `@modelcontextprotocol/sdk` (leader
  control plane).
- **Leader**: native vendor TUI, launched by `neta` with per-vendor config
  injection (system prompt, MCP registration, write restrictions).
- **Workers**: headless over ACP — one `AcpConnection` code path for all
  backends (carried from v1, tested). Native-TUI workers in panes are a
  spawn-time option.
- **Control plane**: MCP server over stdio, wrapping the existing
  `WorkerManager`. Tools: `neta_spawn`, `neta_workers`, `neta_log`,
  `neta_wait` (blocking — this is how worker completion wakes the leader),
  `neta_send`, `neta_answer`, `neta_kill`, room tools. Sandboxed workers get
  the same MCP server via ACP `session/new` `mcpServers` (standard field).
- **Unix socket + `neta` CLI stay** for unsandboxed processes and for humans
  (`neta workers` from any terminal). Two doors, one manager.
- **Cross-agent communication is blocking tool calls only** — a worker's
  `neta_ask` blocks until the leader answers; the leader's `neta_wait` blocks
  until an event. Never keystroke injection into panes (the omnigent hack).
- **Restrictions are vendor-native**, per backend:
  - Codex: `sandbox_mode = "read-only"` (kernel-enforced, bash included),
    `approval_policy = "never"`.
  - Claude Code: permission deny rules (Write/Edit) + PreToolUse hook
    backstop + bash sandbox where available. ACP permission requests
    auto-answered by Neta policy — instant, no human, but the deny gate stays
    (a blanket `--dangerously-skip-permissions` would delete it).
  - OpenCode: `permission` block in generated config.
  - Known v1 gap, now closed by the above: the ACP permission gate only saw
    typed file tools; bash `sed -i` slipped through. Vendor sandboxes cover
    shells too.
- **Panes by default.** Multiplexer adapter: `zellij | tmux | none`.
  Preference order zellij → tmux → none (headless fallback when neither is
  installed). Neta generates a Zellij layout (leader large, workers tiling
  in) and drives panes via CLI actions. No forked or homegrown multiplexer —
  no maintained TS/JS terminal mux exists, and building one
  (node-pty + @xterm/headless + renderer) is explicitly post-v2 at most.
- **Leader prompt hard rule** (from finding 3): if delegation fails, stop and
  report the blocker. Never substitute the backend's internal subagents, and
  never claim worker results that did not come through Neta.
- **Cost visibility**: aggregate ACP usage updates per worker; surface in
  `neta workers` and the final report. (v1 had zero cost tracking — silent
  spend.)

## Phase 0 — repo reset (destructive; run only when the operator says go)

The GitHub repo `sudhanshug16/neta` is a **fork** of pi-mono. Detaching a fork
is support-ticket only (no API/CLI), so the path is delete + recreate.

Facts the executing agent must respect:

- **Deleting a fork is permanent.** No 90-day restore (that grace applies to
  non-fork repos only).
- **All v2 source material is uncommitted local work** in
  `~/workspace/neta` (`packages/coding-agent/src/neta/`, tests, docs). The
  local checkout must never be deleted; only the GitHub repo is.
- `gh repo delete` needs the `delete_repo` scope:
  `gh auth refresh -h github.com -s delete_repo`.

Steps:

1. Rename the local checkout: `~/workspace/neta` → `~/workspace/neta-pi`
   (archive + port source; keep forever until v2 ships).
2. Delete the GitHub fork: `gh repo delete sudhanshug16/neta --yes`.
3. Create a blank repo: `gh repo create sudhanshug16/neta --private` (visibility
   per operator preference).
4. `git init` a fresh `~/workspace/neta`, first commit carrying only:
   - `MANIFESTO.md`, `CHARTER.example.md` (verbatim from the archive)
   - `PLAN.md` (this file)
   - a fresh minimal `.gitignore` (node_modules, dist, .env, .DS_Store)
   - a stub `README.md` (seed from the archive's
     `packages/coding-agent/docs/neta.md`)
   - a new small `CLAUDE.md` written for this repo — do **not** copy the
     pi-mono one; its rules (test.sh, shrinkwrap, changelog, release) are
     pi-specific. Keep: conversational style, no emojis, pinned deps,
     no-inline-imports, commit hygiene.
5. Push `main`. Blank slate done; later phases port code from
   `~/workspace/neta-pi`.

## Target layout (new repo)

```
src/
  cli.ts              # entry: subcommand router
  detect.ts           # installed-backend detection (port of leader/detect.ts)
  orchestrator/       # WorkerManager, tiers, single-writer, rooms, scratch dirs
  channel/            # Unix socket server/client/protocol + CLI subcommands
  acp/                # AcpConnection (worker transport)
  mcp/                # MCP stdio server wrapping WorkerManager
  adapters/           # claude.ts, codex.ts, opencode.ts — launch argv +
                      # generated temp config (MCP reg, prompt, restrictions)
  mux/                # zellij.ts, tmux.ts, none.ts — layout + pane lifecycle
  prompts/            # leader prompt, role constants, shipped skills
  settings.ts         # ~/.neta/settings.json: tiers, multiplexer, launcher overrides
test/                 # ported vitest suites + fake-acp-agent fixture
```

## Port map (from `~/workspace/neta-pi/packages/coding-agent/`)

Carries near-verbatim (~2.5k lines + tests):

| From `src/neta/` | To | Notes |
| --- | --- | --- |
| `acp/connection.ts` | `src/acp/` | incl. `sanitizeInheritedEnv` |
| `channel/*` (protocol, server, client, leader-cli) | `src/channel/` | leader-cli becomes plain CLI subcommands |
| `worker/manager.ts`, `worker/acp.ts`, `worker/transport.ts` | `src/orchestrator/`, `src/acp/` | |
| `leader/detect.ts` | `src/detect.ts` | grow into per-backend spec incl. install actions (Toad's TOML idea) |
| `leader/shim.ts` | `src/cli-shim.ts` | still needed on worker PATH |
| `prompt.ts`, `roles.ts`, `settings.ts`, `skills.ts`, `types.ts`, `tools.ts` | `src/prompts/`, `src/settings.ts` | tools.ts reshapes into MCP tool defs |
| tests: `neta-channel`, `neta-manager`, `neta-acp`, `neta-leader-cli`, `fixtures/fake-acp-agent.mjs` | `test/` | drop pi-harness imports |

Dies with pi: `leader/provider.ts` (ACP↔pi bridge), `worker/pi.ts` (pi worker
backend), `index.ts` (pi extension wiring), `neta-leader-provider.test.ts`,
all fork edits to pi core.

## Build phases (after phase 0)

1. **Scaffold + port.** Package, tsconfig, vitest; move port-map code; ported
   tests green with no pi imports.
2. **MCP server.** `neta mcp` stdio mode wrapping `WorkerManager` in-process
   (the MCP server process is the orchestrator; no daemon — lifetime = leader
   session). Socket server for the second door. Tests against the MCP SDK
   client.
3. **Claude adapter — end-to-end MVP.** `neta` → detect → pick leader → temp
   config (`--append-system-prompt`, `--mcp-config` + `--strict-mcp-config`,
   deny rules + PreToolUse backstop) → exec `claude`. Manual smoke: leader
   spawns a worker, `neta_wait` wakes it, report cites real worker output.
4. **Codex + OpenCode adapters.** Codex via `-c` overrides (mcp_servers,
   sandbox, approvals); OpenCode via generated `opencode.json`. Verify every
   vendor flag against current docs at implementation time — do not trust
   this file's flag names blindly.
5. **Mux layer.** Zellij layout + pane lifecycle, tmux fallback, `none`
   headless; panes default; per-spawn native-TUI worker option.
6. **Usage/cost tracking.** Per-worker aggregation from ACP usage updates.
7. **Prompts, roles, skills, charter flow.** Port roles/skills; leader prompt
   with the hard honesty rule; CHARTER.md loading (leader prompt injection —
   no pi context loader anymore).
8. **Docs + smoke.** README, settings reference, scripted end-to-end smoke in
   a scratch repo on all installed backends.

## Acceptance (end state)

1. `neta` on a machine with Claude Code installed drops the user into the
   native Claude TUI; the leader has `neta_*` tools and cannot write files
   (deny rules verified by attempting an edit).
2. Leader spawns a read-only codex worker; the worker's shell genuinely
   cannot write (sandbox verified), yet its `neta` reporting works (MCP).
3. Worker completion wakes an idle leader through blocking `neta_wait`; the
   leader's report quotes the worker's actual summary.
4. A worker blocks on ask, the leader answers, the worker resumes. Second
   writer errors. Junior ask rejected.
5. Pane mode: workers appear as Zellij panes the user can enter; headless
   fallback works with no multiplexer installed.
6. Delegation-failure honesty: with the socket/MCP deliberately broken, the
   leader reports the blocker instead of claiming success (scripted prompt
   test).
7. `neta workers` shows per-worker token usage.
8. Type-check + tests green; no real provider APIs in tests (fake ACP agent
   fixture only).

## Non-goals (v2)

- No unified transcript view, no Neta-owned TUI, no forked/homegrown
  terminal multiplexer.
- No keystroke injection into panes; blocking tool calls only.
- No worker↔worker messaging outside rooms.
- No pi backend for workers (Claude/Codex/OpenCode only; revisit if a free
  local tier is wanted).
- No upstream pi compatibility of any kind.
