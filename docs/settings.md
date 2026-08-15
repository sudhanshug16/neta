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
- `model` — that backend's own model id or alias. Dropped when the leader
  overrides the backend for one spawn, since model ids do not transfer between
  vendors.

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
on every backend. That does not cover the worker's shell. Where the backend's
ACP bridge accepts them, sandbox flags close that gap:

```json
{
  "backends": {
    "codex": {
      "readOnlyArgs": ["-c", "sandbox_mode=\"read-only\""],
      "writerArgs": ["-c", "sandbox_mode=\"workspace-write\""]
    }
  }
}
```

These are empty by default because the flags each ACP bridge forwards differ
and change; check your bridge's own documentation before setting them, and
verify with a worker that tries to write.

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
