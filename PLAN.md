# Neta plan and status

Design north star: [MANIFESTO.md](MANIFESTO.md). How the pieces fit:
[docs/how-it-works.md](docs/how-it-works.md).

The v2 architecture described here is **built**. This file records why it looks
the way it does, what is verified, and what is deliberately missing.

## Why this shape (decision record)

v1 wrapped a forked [pi](https://github.com/badlogic/pi-mono) TUI around
external agent CLIs over ACP. It worked on the Claude backend, and three
findings killed it:

1. **pi is built to own the agent loop, not to host someone else's.** Bridging
   external agents in as a fake pi "provider" left usage at zero, pi's own
   tools dead weight, and a bridge that broke on every upstream change.
2. **Codex's sandbox denies Unix-socket `connect()` (EPERM)** from model-run
   shell commands, even with `danger-full-access` configured. A CLI-only
   channel can never be reliable from inside sandboxed shells.
3. **A leader that cannot delegate may silently fake success** (observed: it
   substituted Codex-internal subagents and reported "Done — 3 workers
   completed"). Enforcement and honest failure reporting must not depend on the
   backend's cooperation alone.

v2 inverts the topology: the user lives in the **vendor's native TUI**. Neta is
an orchestrator behind it — it launches the leader with injected config,
exposes worker control as **MCP tools** (which run in the vendor host process,
outside any sandbox — dissolving finding 2), and enforces restrictions with
each **vendor's own mechanisms**, kernel sandbox where available.

## Settled decisions

- **No TUI of our own. No pi.** Plain TypeScript, two protocol deps pinned
  exact: `@agentclientprotocol/sdk` (workers) and `@modelcontextprotocol/sdk`
  (leader control plane).
- **Bun is the toolchain**: install, test, build. `bun build --target=node`
  bundles everything into one `dist/cli.js`, so what ships is a single file
  that runs on Node and pulls in no dependency tree of its own (1 MB, against
  30 MB across 93 packages when the SDKs were resolved at install time).
  Typechecking is `tsc --noEmit`, which Bun does not do.
- **Leader**: native vendor CLI, launched by `neta` with per-vendor config
  injection (instructions, MCP registration, write restrictions).
- **Workers**: headless over ACP — one transport for every backend.
- **Control plane**: MCP server over stdio wrapping the WorkerManager, started
  by the vendor CLI, living exactly as long as the leader session. No daemon.
  Sandboxed workers get a worker-side MCP server the same way, through ACP
  `session/new` `mcpServers`.
- **Unix socket + `neta` CLI stay** as the second door, for workers whose shell
  can reach it and for humans in another terminal. One manager behind both.
- **Cross-agent communication is blocking tool calls only** — never keystroke
  injection into panes.
- **Restrictions are vendor-native**: Codex kernel sandbox; Claude Code deny
  rules plus a PreToolUse bash hook; OpenCode permission config. The v1 hole
  (the ACP gate only saw typed file tools, so `sed -i` slipped through as an
  `execute` call) is closed for the leader on all three.
- **Panes by default**, via `zellij | tmux | none`, preferring an existing
  session. Panes show worker logs; the worker process itself stays under Neta's
  control. No forked or homegrown multiplexer — none exists in TS, and building
  one (node-pty + xterm headless + renderer) is out of scope.
- **Leader prompt hard rule** (from finding 3): if delegation fails, stop and
  report the blocker; never substitute the backend's internal subagents.
- **Cost visibility**: per-worker usage aggregated from ACP, shown in
  `neta workers`.

## What is built

| Area | Where |
| --- | --- |
| CLI router, launcher, backend detection | `src/cli.ts`, `src/launch.ts`, `src/detect.ts` |
| Leader adapters (Claude Code, Codex, OpenCode) | `src/adapters/` |
| MCP control plane and worker bridge | `src/mcp/` |
| Orchestrator: tiers, writer slot, rooms, logs, usage | `src/orchestrator/` |
| ACP worker transport and permission gate | `src/acp/` |
| Worker channel: protocol, socket server, CLI | `src/channel/` |
| Multiplexer adapters and panes | `src/mux/` |
| Bash guard (Claude hook, OpenCode patterns) | `src/guard.ts` |
| Session registry (`~/.neta/sessions`) | `src/session.ts` |
| Prompts: leader, roles, flavors, charter | `src/prompts/` |
| Settings | `src/settings.ts` |

## Verified how

Vendor mechanisms were checked against the installed CLIs before being coded,
not assumed:

- `claude --help`: `--append-system-prompt`, `--mcp-config`,
  `--strict-mcp-config`, `--settings` all exist.
- `codex debug prompt-input`: proved `$CODEX_HOME/AGENTS.md` reaches the model,
  that `project_doc_fallback_filenames` is ignored when a project `AGENTS.md`
  exists, and that `model_instructions_file` replaces base instructions (so it
  is not used). `-s read-only`, `-a never`, `-c` overrides come from `--help`.
- OpenCode binary: `OPENCODE_CONFIG_CONTENT`, and the `{type, command,
  environment}` shape of its MCP entries.
- ACP SDK types: `usage_update` and `PromptResponse.usage` for cost;
  `McpServerStdio` for worker MCP registration.
- tmux 3.4, live: the exact `new-session`/`split-window` argument forms Neta
  emits.

Automated coverage is in `test/`: unit tests for the pure parts, and
integration tests that run the real `neta mcp` process, spawn real ACP worker
processes (a fixture agent — no provider is ever called), talk over a real
socket, and drive it all through a real MCP client.

Zellij could not be exercised live (not installed here); its command
construction is unit-tested only.

## Acceptance

| Criterion | State |
| --- | --- |
| `neta` drops the user into the vendor UI with `neta_*` tools and no write access | built; launch path tested end to end with a fixture vendor CLI |
| Worker completion wakes the leader through blocking `neta_wait` with the worker's own summary | verified in the end-to-end test |
| A read-only worker's edits are rejected; the writer's are allowed | verified against a real ACP worker process |
| Second writer refused; junior `ask` refused | verified |
| Workers visible in panes; headless fallback | tmux verified live; zellij unit-tested |
| Delegation failure reported honestly rather than faked | prompt rule in place; no scripted model test (needs a paid run) |
| `neta workers` shows per-worker token usage | verified |
| Type-check and tests green, no real provider APIs in tests | yes |

## Deliberately not built

- A unified transcript view, a Neta-owned TUI, or a forked multiplexer.
- Keystroke injection into panes.
- Worker↔worker messaging outside rooms.
- Native-TUI workers (a worker you can type into). Panes show worker logs;
  workers stay unattended by design.
- Worker shell sandboxing by default — the flags each ACP bridge forwards
  differ and change, so `readOnlyArgs`/`writerArgs` are settings with
  documented examples rather than guesses baked into defaults.
- Any pi compatibility.
