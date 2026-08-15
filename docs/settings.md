# Settings

Neta reads `~/.neta/settings.json`, then `.neta/settings.json` in the project,
which wins key by key. Both are optional; the defaults are opinions, not
requirements. A malformed file is ignored rather than fatal — a broken settings
file should not stop you leading a session.

```json
{
  "leader": { "backend": "claude", "strictMcp": false },
  "mux": { "mode": "auto", "panes": true },
  "tiers": {
    "junior": { "backend": "claude", "model": "haiku" },
    "senior": { "backend": "claude", "model": "sonnet" },
    "staff":  { "backend": "claude", "model": "opus" }
  },
  "backends": {
    "claude":   { "command": "npx", "args": ["-y", "@zed-industries/claude-code-acp"], "modelEnv": "ANTHROPIC_MODEL" },
    "codex":    { "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"], "modelArgs": ["--model", "{model}"] },
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
| `mode` | `auto` | `zellij`, `tmux`, `none`, or `auto` (prefer Zellij, then tmux, then headless). If you are already inside a session, that one wins. |
| `panes` | `true` | Open a pane per worker. Set `false` to run every worker headless. |

An explicitly chosen multiplexer that is not installed falls back to headless
rather than failing the session.

## tiers

A tier is what you would trust a worker with, not how clever it is. The leader
picks tiers and never sees model names; this is where the names live.

- `backend` — a key from `backends`.
- `model` — that backend's own model id. Omit it and the backend's own idea of
  the tier applies, so pointing a tier at another vendor is one word:

```json
{ "tiers": { "staff": { "backend": "codex" } } }
```

gives you `gpt-5.6-sol[xhigh]` for staff work while juniors and seniors stay on
Claude. Shipped mappings:

| Tier | claude | codex |
| --- | --- | --- |
| junior | `haiku` | `gpt-5.6-luna[medium]` |
| senior | `sonnet` | `gpt-5.6-terra[high]` |
| staff | `default` (Opus) | `gpt-5.6-sol[xhigh]` |

Codex folds the reasoning level into the model id, so thinking depth is part of
the choice: `gpt-5.6-sol[max]` is the same model thinking harder. Naming a
family without a level (`gpt-5.6-sol`) takes that family's first level.

Run **`neta models`** to see what a backend actually offers — the ids come from
the backend itself, so they stay right when a vendor adds a model. OpenCode
ships no defaults here on purpose: it fronts many providers, and only you know
which one you logged into.

Neta selects the model over ACP (`session/set_model`), which is why this works
the same on every backend. It also picks the session's mode: a worker without
the writer slot gets the backend's read-only mode where one exists — on Codex
that is a kernel sandbox, which covers the worker's shell as well as its tools.

## backends

How a worker process is launched. Every worker speaks ACP over stdio.

| Key | Meaning |
| --- | --- |
| `command` | Executable that speaks ACP. |
| `args` | Its arguments. |
| `modelArgs` | Appended when a model is requested; `{model}` is substituted. |
| `modelEnv` | Environment variable carrying the model id, for backends with no model flag. |
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
| `NETA_SOCKET`, `NETA_WORKER_ID`, `NETA_SCRATCH` | Set on every worker process. |
| `NETA_LEADER_TOKEN` | Authorizes worker management; set on the leader's process only. |
