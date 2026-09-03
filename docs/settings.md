# Settings

Neta reads `$NETA_DIR/settings.json` (default `~/.neta`), then
`<root>/.neta/settings.json` under the workspace root on top. The two layers
are deep-merged with project keys winning: providers merge field by field,
`leader` merges field by field, and arrays replace rather than concatenate.
Both files are optional; the shipped defaults below apply where neither file
says otherwise. A malformed file is ignored, never fatal — a broken settings
file should not stop you leading a session. A wrong-typed field is dropped
with a warning, and the lower layer's value survives.

```json
{
  "providers": {
    "claude": { "command": "npx",
                "args": ["-y", "@agentclientprotocol/claude-agent-acp@0.68.0"],
                "defaultModel": "sonnet", "env": {} }
  },
  "leader": { "provider": "claude", "model": "sonnet" },
  "forbiddenModels": ["claude-fable-5"]
}
```

## providers

`providers` maps a name to a `ProviderSettings` object: how one ACP provider
process is launched. The shipped providers are `claude`, `codex` and
`opencode`, all with `resume: true`; a new name adds a provider, and setting
`disabled: true` removes one from selection. Every provider speaks ACP over
stdio.

| Key | Default | Meaning |
| --- | --- | --- |
| `command` | per provider (see below) | Executable that speaks ACP. |
| `args` | per provider (see below) | Its arguments. |
| `env` | `{}` | Extra environment for the provider process. |
| `readOnlyArgs` | `[]` | Extra arguments for a session without the writer slot. |
| `readWriteArgs` | `[]` | Extra arguments for a session that holds it. |
| `resume` | `true` | Whether a dead session may be resumed on its vendor conversation id. |
| `defaultModel` | per provider (see below) | Model id the provider starts on; `""` means whatever the provider already selected. |
| `disabled` | `false` | Set `true` to remove this provider from selection. An explicit request for it fails. |

Shipped providers:

| name | command | args | readOnlyArgs | readWriteArgs | defaultModel |
| --- | --- | --- | --- | --- | --- |
| `claude` | `npx` | `-y @agentclientprotocol/claude-agent-acp@0.68.0` | `[]` | `[]` | `sonnet` |
| `codex` | `npx` | `-y @agentclientprotocol/codex-acp@1.3.0` | `-c sandbox_mode="read-only" -c approval_policy="never"` | `-c sandbox_mode="workspace-write" -c approval_policy="never"` | `gpt-5.6-terra[medium]` |
| `opencode` | `opencode` | `acp` | `[]` | `[]` | `""` |

## leader

`leader` names the provider and model of every workspace leader.

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `claude` | Which provider leads. Must name an enabled entry from `providers`. |
| `model` | the provider's `defaultModel` | Model id the leader starts on. Omit it and the provider's default applies. |

## forbiddenModels

`forbiddenModels` is the operator's ban list: model ids no session may run on.

| Value | Meaning |
| --- | --- |
| `"<model id>"` | One entry per banned model, matched exactly. A request naming it — leader, lead or agent, explicit or defaulted — is rejected wherever it is requested. |

The default is `[]`.

Skills and charters are not configured here. Skills resolve from
`.neta/skills/` under the workspace root, then under `~/.neta/`; the charter
is `CHARTER.md` under the workspace root, then under `~/.neta/`, inlined with
the workspace copy first. Nothing about tiers, backends, roles, flavors or
multiplexers survives from v2: there is one model per session, access is a
launch argument, and the settings file names providers only.

## Environment

| Variable | Meaning |
| --- | --- |
| `NETA_DIR` | Overrides `~/.neta` (settings, socket, stores, skills, charter). |
| `NETA_SOCKET` | The Node socket path, set on every Neta-launched ACP process. |

The actor id and token travel in `neta mcp`'s argv (`mcp --actor <id>
--token <t>`), never the environment: process listings are the provider's own,
while the environment is inherited by everything the provider spawns.

Authority lives in `CHARTER.md`, not here. This file only says how providers
launch and who leads; what the team may do is the charter's call.
