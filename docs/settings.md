# Settings

Neta reads `~/.neta/settings.json`, then `.neta/settings.json` in the project
on top. Each tier entry and each backend entry deep-merges: project fields
win, user fields survive, and a backend's `env` and `tierModels` maps merge
the same way. So with

```json
user:    { "backends": { "opencode": { "tierModels": { "journeyman": "opencode/deepseek-v4-flash-free" } } } }
project: { "backends": { "opencode": { "tierModels": { "architect": "openai/gpt-5.6-sol" } } } }
```

the session has both tier models. Both files are optional; the defaults are
opinions, not requirements. A malformed file is ignored rather than fatal — a
broken settings file should not stop you leading a session.

```json
{
  "leader": { "backend": "claude", "strictMcp": false },
  "mux": { "mode": "auto", "panes": true },
  "tiers": {
    "apprentice": { "backend": "claude", "model": "haiku" },
    "journeyman": { "backend": "claude", "model": "sonnet" },
    "expert": { "backend": "claude", "model": "opus[1m]" },
    "architect":  { "backend": "claude", "model": "claude-fable-5[1m]" }
  },
  "backends": {
    "claude":   { "command": "npx", "args": ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"], "modelEnv": "ANTHROPIC_MODEL" },
    "codex":    { "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp@1.3.0"], "modelArgs": ["--model", "{model}"] },
    "opencode": { "command": "opencode", "args": ["acp"], "modelArgs": ["--model", "{model}"] }
  }
}
```

## leader

| Key | Default | Meaning |
| --- | --- | --- |
| `backend` | ask | Which CLI leads when several are installed: `claude`, `codex` or `opencode`. `--leader` overrides it. |
| `strictMcp` | `false` | Pass `--strict-mcp-config` to Claude Code, hiding your own MCP servers from the leader. Off, because the leader should keep the tools you configured. |

## mux

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `zellij`, `tmux`, `none`, or `auto`. Under `auto`, a session you are already inside wins; otherwise it prefers Zellij, then tmux, then headless. An explicit choice picks that multiplexer regardless. |
| `panes` | `true` | Open a pane per worker. Set `false` to run every worker headless. |

An explicitly chosen multiplexer that is not installed falls back to headless
rather than failing the session.

## tiers

A tier is what you would trust a worker with, not how clever it is. The leader
picks tiers and never sees model names; this is where the names live.

- `backend` — a key from `backends`.
- `model` — that backend's own model id. Omit it and the backend's own idea of
  the tier applies.

**Tiers may be left unconfigured.** The shipped defaults are unconfigured, so
spread policy applies: Neta assigns workers deterministically round-robin across
installed backends (stable per session), and reviewer/debater roles prefer a
different backend than the most recent writer when multiple backends are
installed (diversity rule). Debaters in one room are spread across different
vendors automatically. Explicit overrides pass through `backend` on spawn; use
`neta_remember` to persist an override to `.neta/settings.json` (JSON rewrite;
comments not preserved). Point a tier at another vendor:

```json
{ "tiers": { "architect": { "backend": "codex" } } }
```

gives you `gpt-5.6-sol[max]` for architect work while the rest use spread policy.
Shipped mappings:

| Tier | claude | codex |
| --- | --- | --- |
| apprentice | `haiku` | `gpt-5.6-luna[high]` |
| journeyman | `sonnet` | `gpt-5.6-terra[medium]` |
| expert | `opus[1m]` | `gpt-5.6-sol[medium]` |
| architect | `claude-fable-5[1m]` | `gpt-5.6-sol[max]` |

Codex folds the reasoning level into the model id, so thinking depth is part of
the choice: `gpt-5.6-sol[max]` is the same model thinking harder. Naming a
family without a level (`gpt-5.6-sol`) takes that family's first level.

Run **`neta models`** to see what a backend actually offers — the ids come from
the backend itself, so they stay right when a vendor adds a model. OpenCode
ships no defaults here on purpose: it fronts many providers, and only you know
which one you logged into. Give its tiers meaning with `tierModels`:

```json
{
  "backends": {
    "opencode": {
      "tierModels": {
        "apprentice": "opencode/deepseek-v4-flash-free",
        "journeyman": "openai/gpt-5.4",
        "expert": "openai/gpt-5.6-sol",
        "architect": "openai/gpt-5.6-sol"
      }
    }
  }
}
```

OpenCode model ids are provider-qualified (`provider/model`); Neta passes them
through unchanged.

Old settings keys remain silent aliases: `intern` maps to `apprentice`,
`junior` to `journeyman`, `senior` to `expert`, and `staff` to `architect`.
When an old and new key both appear, the new key wins.

Neta selects the model over ACP, which is why this works the same on every
backend: `session/set_config_option` where the bridge supports it, falling
back to the legacy `session/set_model` extension where it does not. Codex's
composite ids are split — `gpt-5.6-sol[max]` becomes the model plus a
thought-level option, selected separately. Selection is negotiated, not
assumed: a model the backend does not offer, or a selection call that fails,
is loudly logged in the worker's log and the worker runs on the backend's
default — and listings show what actually ran, not what was asked for. Neta
also picks the session's mode: a worker without the writer slot gets the
backend's read-only mode where one is advertised — on Codex that is a kernel
sandbox, which covers the worker's shell as well as its tools.

## backends

How a worker process is launched. Every worker speaks ACP over stdio.

| Key | Meaning |
| --- | --- |
| `disabled` | Set `true` to remove this backend from automatic assignment and leader selection. An explicit request for it fails with a disabled-backend error; set `false` in project settings to re-enable a user-level disable. |
| `command` | Executable that speaks ACP. |
| `args` | Its arguments. |
| `modelArgs` | Appended when a model is requested; `{model}` is substituted. |
| `modelEnv` | Environment variable carrying the model id, for backends with no model flag. |
| `tierModels` | Which of this backend's models each tier means, used when a tier names this backend but no model. `neta models <backend>` lists the ids. |
| `env` | Extra environment for the worker process. |
| `readOnlyArgs` | Extra arguments for a worker without the writer slot. |
| `writerArgs` | Extra arguments for the worker that holds it. |

### Sandboxing workers

Neta rejects file-editing tool calls from a read-only worker at the ACP layer,
on every backend, and asks the session for the strictest mode it offers:

| Backend | Read-only worker | Writer |
| --- | --- | --- |
| Codex | `read-only` mode — a kernel sandbox, so the shell is covered too | `agent` |
| Claude Code | `default` mode; Neta answers its permission requests, denying edits | `acceptEdits` |
| OpenCode | whatever read-only mode it advertises, else `default` | `agent` |

Only Codex's is a sandbox. On the others a worker's *shell* could still write —
Neta's rejection covers typed tools, not `sed -i`. If that matters for your
work, put writers on Codex, or add backend flags of your own:

```json
{ "backends": { "codex": { "readOnlyArgs": ["-c", "sandbox_mode=\"read-only\""] } } }
```

## Roles and flavors

- Roles are prompts in `~/.neta/roles/<name>.md` or `.neta/roles/<name>.md`.
  The project copy wins. Shipped: `scout`, `worker`, `reviewer`, `debater`.
- Flavors are playbooks written to `~/.neta/skills/<name>/SKILL.md` on every
  launch. To edit one, copy it to `.neta/skills/<name>/SKILL.md` — the project
  copy wins and is never overwritten. Shipped: `implement`, `decide`,
  `investigate`.

## Environment

| Variable | Meaning |
| --- | --- |
| `NETA_DIR` | Overrides `~/.neta` (settings, roles, skills, session registry). |
| `NETA_SOCKET`, `NETA_WORKER_ID`, `NETA_WORKER_TOKEN`, `NETA_SCRATCH` | Set on every worker process. |
| `NETA_LEADER_TOKEN` | Authorizes worker management; set on the leader's process only. |
